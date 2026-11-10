"use strict";

// ============================================================
// CLOUD SYNC — makes saveEntries()/saveItems() (engine.js) actually reach
// Firestore, and stamps + enforces creatorUid so only the person who made
// a creature/item can edit or delete it later.
//
// engine.js's saveEntries()/saveItems() only ever wrote to localStorage —
// this file is the missing "also push to Firestore" half. It's a module
// (needs Firestore imports) but ui-form-handler.js / ui-dex-renderer.js
// are classic scripts, so everything here is exposed on window.CloudSync
// for them to call.
// ============================================================

import { db } from "./firebase-config.js";
import {
  collection,
  doc,
  getDocs,
  addDoc,
  updateDoc,
  deleteDoc,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

function currentUid() {
  return window.currentUser ? window.currentUser.uid : null;
}

function isAdmin() {
  return !!(window.userProfile && window.userProfile.isAdmin);
}

/**
 * Can the current user edit/delete this record (an entry or item)?
 * True if they created it, or if they're an admin. Records with no
 * creatorUid at all (legacy local data from before cloud sync existed)
 * can only be managed by an admin, since nobody "owns" them.
 */
export function canManageRecord(record) {
  if (!window.currentUser) return false;
  if (isAdmin()) return true;
  if (record && record.official) return false; // official (PokéAPI-imported) records: admins only
  return !!(record && record.creatorUid && record.creatorUid === currentUid());
}

// Official items are cached per-browser (official-items.js) and re-downloaded only when this stamp changes,
// so any admin edit/delete of an official item must bump it.
async function bumpOfficialItemsVersion(record, collectionName) {
  if (collectionName !== "items" || !(record && record.official)) return;
  try { await setDoc(doc(db, "meta", "officialItems"), { version: Date.now() }); }
  catch (e) { console.warn("Couldn't bump official items version:", e); }
}

async function saveRecordToCloud(record, collectionName) {
  const uid = currentUid();
  if (!uid) throw new Error("You need to be logged in to save that.");

  if (record.official && !isAdmin()) {
    throw new Error("Official entries can only be edited by an admin.");
  }
  if (record.creatorUid && record.creatorUid !== uid && !isAdmin()) {
    throw new Error("You can only edit things you created.");
  }

  const payload = { ...record };
  const docId = payload.firestoreId;
  delete payload.firestoreId;
  payload.creatorUid = record.creatorUid || uid;

  if (docId) {
    await updateDoc(doc(db, collectionName, docId), payload);
    await bumpOfficialItemsVersion(payload, collectionName);
    return docId;
  } else {
    const ref = await addDoc(collection(db, collectionName), {
      ...payload,
      createdAt: serverTimestamp()
    });
    return ref.id;
  }
}

async function deleteRecordFromCloud(record, collectionName) {
  if (!canManageRecord(record)) {
    throw new Error("You can only delete things you created.");
  }
  if (record.firestoreId) {
    await deleteDoc(doc(db, collectionName, record.firestoreId));
    await bumpOfficialItemsVersion(record, collectionName);
  }
}

export function saveEntryToCloud(entry) { return saveRecordToCloud(entry, "entries"); }
export function deleteEntryFromCloud(entry) { return deleteRecordFromCloud(entry, "entries"); }
export function saveItemToCloud(item) { return saveRecordToCloud(item, "items"); }
export function deleteItemFromCloud(item) { return deleteRecordFromCloud(item, "items"); }

// ---- Custom Weathers (made in Settings -> Custom Weather Maker): shared in the "weathers" collection so a Fakemon
// that uses a brand-new weather works for everybody. Same ownership rule as entries/items: only the creator (or an
// admin) can edit or delete a weather. Each loaded weather is registered into engine.js's weather list. ----
export function saveWeatherToCloud(weather) { return saveRecordToCloud(weather, "weathers"); }
export function deleteWeatherFromCloud(weather) { return deleteRecordFromCloud(weather, "weathers"); }

export async function loadAllWeathers() {
  try {
    const snap = await getDocs(collection(db, "weathers"));
    let n = 0;
    snap.forEach(d => {
      if (typeof window.registerCustomWeather === "function" &&
          window.registerCustomWeather({ ...d.data(), firestoreId: d.id })) n++;
    });
    if (typeof window.saveCustomWeathers === "function") window.saveCustomWeathers(); // cache for offline use
    console.log(`🌦 Loaded ${n} shared custom weather${n === 1 ? "" : "s"} from the cloud.`);
  } catch (err) {
    console.error("❌ Failed to load custom weathers:", err);
  }
  window.dispatchEvent(new Event("customweathers:loaded"));
}

window.CloudSync = {
  canManageRecord,
  saveEntryToCloud,
  deleteEntryFromCloud,
  saveItemToCloud,
  deleteItemFromCloud,
  saveWeatherToCloud,
  deleteWeatherFromCloud,
  loadAllWeathers
};

// main.js waits for this before it renders the Dex, so abilities/moves that use a shared weather find it registered.
window.weathersReady = loadAllWeathers();