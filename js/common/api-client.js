"use strict";

import { db } from "../firebase-config.js";
import { collection, addDoc, doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import {
  clearSession,
  getAuthToken,
  getUser,
  isAuthenticated,
  setAuthToken,
  setUser,
} from "./session-state.js";

const DEFAULT_API_BASE = "/api";

/** @type {Map<string, object>} */
const dexEntryCache = new Map();

export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, body?: unknown }} [details]
   */
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status ?? 0;
    this.body = body ?? null;
  }
}

function resolveApiBase() {
  if (typeof window !== "undefined" && window.FIELDDEX_API_BASE) {
    return String(window.FIELDDEX_API_BASE).replace(/\/+$/, "");
  }
  return DEFAULT_API_BASE;
}

function resolveUrl(path) {
  if (/^https?:\/\//i.test(path)) return path;
  const base = resolveApiBase();
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalized}`;
}

/**
 * @param {unknown} body
 * @returns {string}
 */
function extractErrorMessage(body) {
  if (!body) return "Request failed.";
  if (typeof body === "string") return body;

  if (typeof body === "object" && body !== null) {
    const record = /** @type {Record<string, unknown>} */ (body);
    if (typeof record.error === "string" && record.error) return record.error;
    if (typeof record.message === "string" && record.message) return record.message;

    if (Array.isArray(record.errors) && record.errors.length) {
      const parts = record.errors
        .map((item) => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object" && typeof item.message === "string") return item.message;
          return null;
        })
        .filter(Boolean);
      if (parts.length) return parts.join("; ");
    }
  }

  return "Request failed.";
}

/**
 * @param {Response} response
 * @returns {Promise<unknown|null>}
 */
async function parseResponseBody(response) {
  if (response.status === 204) return null;

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

/**
 * @param {string} method
 * @param {string} path
 * @param {{ body?: unknown, headers?: Record<string, string>, signal?: AbortSignal }} [options]
 */
async function request(method, path, options = {}) {
  const { body, headers = {}, signal } = options;
  const token = getAuthToken();

  /** @type {Record<string, string>} */
  const requestHeaders = { ...headers };
  if (token) requestHeaders.Authorization = `Bearer ${token}`;
  if (body !== undefined && !requestHeaders["Content-Type"]) {
    requestHeaders["Content-Type"] = "application/json";
  }

  const response = await fetch(resolveUrl(path), {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });

  const parsed = await parseResponseBody(response);

  if (!response.ok) {
    throw new ApiError(extractErrorMessage(parsed), {
      status: response.status,
      body: parsed,
    });
  }

  return parsed;
}

export function get(path, options) {
  return request("GET", path, options);
}

export function post(path, body, options = {}) {
  return request("POST", path, { ...options, body });
}

export function put(path, body, options = {}) {
  return request("PUT", path, { ...options, body });
}

export function del(path, options) {
  return request("DELETE", path, options);
}

export const api = { get, post, put, delete: del };

export function cacheDexEntry(entry) {
  if (entry && entry.id != null) dexEntryCache.set(String(entry.id), entry);
}

export function clearDexEntryCache() {
  dexEntryCache.clear();
}

/**
 * Fetch a dex entry by id, with an in-memory cache for repeat lookups.
 * @param {string|number} id
 */
export async function getDexEntryById(id) {
  const key = String(id);
  if (dexEntryCache.has(key)) return dexEntryCache.get(key);

  const data = await get(`/dex/entries/${encodeURIComponent(key)}`);
  const entry =
    data && typeof data === "object" && "entry" in data
      ? /** @type {Record<string, unknown>} */ (data).entry
      : data;

  if (entry && typeof entry === "object") {
    cacheDexEntry(/** @type {object} */ (entry));
    return entry;
  }

  throw new ApiError(`Dex entry "${key}" was not found.`, { status: 404, body: data });
}

// ==========================================
// USER PROFILE FIRESTORE METHODS
// ==========================================

/**
 * Fetch full user profile data from Firestore (trainerLevel, description, sns, coins)
 * @param {string} uid
 */
export async function getUserProfile(uid) {
  if (!uid) return null;
  const userRef = doc(db, "users", uid);
  const snap = await getDoc(userRef);

  if (snap.exists()) {
    return snap.data();
  } else {
    return {
      coins: 100,
      trainerLevel: 1,
      description: "",
      sns: []
    };
  }
}

/**
 * Save or update Trainer Level, Description, and SNS Links in Firestore
 * @param {string} uid
 * @param {object} profileData
 */
export async function updateUserProfile(uid, profileData) {
  if (!uid) throw new Error("User must be logged in to update profile");

  const userRef = doc(db, "users", uid);

  await setDoc(userRef, {
    trainerLevel: profileData.trainerLevel ?? 1,
    description: profileData.description || "",
    sns: profileData.sns || [],
    updatedAt: new Date().toISOString()
  }, { merge: true });
}

/**
 * Directly uploads JSON entries (creatures OR items) into a specified Cloud Firestore collection.
 * Pass the collection name explicitly so creatures and items never land in the same place.
 * @param {Array|Object} jsonData - an array of records, or an object with an .entries/.items array
 * @param {string} [collectionName="entries"] - Firestore collection to write into (e.g. "entries" or "items")
 */
export async function uploadDirectToFirestore(jsonData, collectionName = "entries") {
  if (!jsonData) {
    console.error("❌ No data provided to uploadDirectToFirestore.");
    return;
  }

  const list = Array.isArray(jsonData)
    ? jsonData
    : (jsonData.entries || jsonData.items || []);

  if (!list || !Array.isArray(list) || list.length === 0) {
    console.error("❌ Invalid format or empty list.");
    return;
  }

  console.log(`🚀 Starting Firestore import of ${list.length} item(s) into "${collectionName}"...`);

  for (const item of list) {
    try {
      const docRef = await addDoc(collection(db, collectionName), item);
      console.log(`✅ Saved: ${item.name || 'Unnamed'} (ID: ${docRef.id})`);
    } catch (err) {
      console.error(`❌ Upload error for ${item.name || 'Unnamed'}:`, err);
    }
  }

  console.log(`🎉 All ${list.length} item(s) added to "${collectionName}"!`);
}

if (typeof window !== "undefined") {
  window.FanDexApi = {
    api,
    get,
    post,
    put,
    delete: del,
    getDexEntryById,
    getUserProfile,
    updateUserProfile,
    cacheDexEntry,
    clearDexEntryCache,
    uploadDirectToFirestore,
    ApiError,
  };
  window.FanDexSession = {
    getAuthToken,
    setAuthToken,
    getUser,
    setUser,
    clearSession,
    isAuthenticated,
  };
  window.getDexEntryById = getDexEntryById;
  window.getUserProfile = getUserProfile;
  window.updateUserProfile = updateUserProfile;
  window.uploadDirectToFirestore = uploadDirectToFirestore;
}