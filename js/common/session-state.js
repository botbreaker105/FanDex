"use strict";

/** @typedef {{ id?: string|number, email?: string, displayName?: string, [key: string]: unknown }} SessionUser */

let authToken = null;
/** @type {SessionUser|null} */
let currentUser = null;

export function getAuthToken() {
  return authToken;
}

export function setAuthToken(token) {
  authToken = token ? String(token) : null;
}

export function getUser() {
  return currentUser;
}

/** @param {SessionUser|null} user */
export function setUser(user) {
  currentUser = user && typeof user === "object" ? { ...user } : null;
}

export function clearSession() {
  authToken = null;
  currentUser = null;
}

export function isAuthenticated() {
  return Boolean(authToken);
}
