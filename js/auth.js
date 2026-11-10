"use strict";

import { app, db } from "./firebase-config.js";
import {
  getAuth,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  updateProfile
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  doc,
  getDoc,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// Reuses the same Firebase app instance every other file already initializes
export const auth = getAuth(app);

// 🔴 ADD YOUR ADMIN EMAIL(S) HERE IN LOWERCASE
const ADMIN_EMAILS = [
  "andres.yuuta1005@gmail.com" // <-- Replace with your actual email!
];

/**
 * Creates the Firestore user profile doc the first time someone signs up.
 * Sets isAdmin = true and role = "admin" if the email matches ADMIN_EMAILS.
 */
async function createUserProfile(user, displayName) {
  const ref = doc(db, "users", user.uid);
  const existing = await getDoc(ref);
  if (existing.exists()) return;

  const userEmail = (user.email || "").toLowerCase();
  const isAdmin = ADMIN_EMAILS.includes(userEmail);

  await setDoc(ref, {
    displayName: displayName || (user.email ? user.email.split("@")[0] : "Trainer"),
    email: user.email,
    role: isAdmin ? "admin" : "trainer",
    isAdmin: isAdmin,
    createdAt: serverTimestamp()
  });
}

/**
 * Creates a brand-new Firebase Auth account (email/password) and seeds their
 * Firestore profile doc. Throws on failure.
 */
export async function signUp(email, password, displayName) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  if (displayName) {
    await updateProfile(cred.user, { displayName });
  }
  await createUserProfile(cred.user, displayName);
  return cred.user;
}

/**
 * Signs an existing user in. Throws on bad credentials.
 */
export async function signIn(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

export async function logOut() {
  await signOut(auth);
}

export function getCurrentUser() {
  return auth.currentUser;
}

/**
 * Fires cb(user) immediately with the current auth state, then again on
 * every future login/logout.
 */
export function onAuthChange(cb) {
  return onAuthStateChanged(auth, cb);
}

/**
 * Reads a user's Firestore profile doc (displayName, isAdmin, etc.).
 */
export async function getUserProfile(uid) {
  const ref = doc(db, "users", uid);
  const snap = await getDoc(ref);
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

/**
 * Convenience helper to check if a specific user is an admin
 */
export async function checkIsAdmin(uid) {
  const profile = await getUserProfile(uid);
  return profile ? Boolean(profile.isAdmin) : false;
}

// Global window exposure for browser testing / non-module scripts
if (typeof window !== "undefined") {
  window.FanDexAuth = {
    auth,
    signUp,
    signIn,
    logOut,
    getCurrentUser,
    onAuthChange,
    getUserProfile,
    checkIsAdmin
  };
}