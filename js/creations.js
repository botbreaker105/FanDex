"use strict";

import { db } from './firebase-config.js';
import { auth } from './auth.js';
import {
  collection,
  doc,
  getDocs,
  addDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import { addCreatureToRoster } from './roster.js';

// Same tiers ui-form-handler.js already uses for dex entries (RARITIES
// constant there, driven by the #f-rarity select in index.html) -- reused
// here so a creation's rarity means the same thing in both places.
const RARITIES = ["common", "uncommon", "rare", "legendary"];

// Pull odds by tier -- higher weight = more common. Tune to taste; these
// just need to be relative to each other, they don't need to sum to 100.
const RARITY_WEIGHTS = {
  common: 100,
  uncommon: 45,
  rare: 15,
  legendary: 4
};

/**
 * Shared, top-level pool of user-submitted creature designs.
 * Separate from the official dex (`dexEntries`) and from any one
 * user's roster -- this is the community gacha pool everyone pulls from.
 */
function getCreationsRef() {
  return collection(db, 'creations');
}

/**
 * Submit a hand-designed creature to the shared gacha pool.
 * design: { name, type(s), stats, icon/art, rarity, ...whatever the creator form collects }
 */
export async function submitCreation(design) {
  const user = auth.currentUser;
  if (!user) throw new Error("User must be logged in to submit a creation.");

  if (!design.name || !design.name.trim()) {
    throw new Error("Creation needs a name.");
  }

  const rarity = RARITIES.includes(design.rarity) ? design.rarity : "common";

  const creation = {
    name: design.name.trim(),
    types: design.types || [],
    stats: design.stats || {},
    rarity,
    icon: design.icon || null,
    customIconEmoji: design.customIconEmoji || null,
    imageUrl: design.imageUrl || null,
    desc: design.desc || "",
    evolvesInto: design.evolvesInto || null,
    evolvesAt: design.evolvesAt || null,
    creatorUid: user.uid,
    creatorName: user.displayName || "Anonymous Trainer",
    createdAt: serverTimestamp()
  };

  const docRef = await addDoc(getCreationsRef(), creation);
  return { id: docRef.id, ...creation };
}

/**
 * Edit a creation you submitted. Firestore rules already enforce that only
 * the original creatorUid can update its own doc (and that creatorUid can
 * never be reassigned) -- this check up front just gives a friendly error
 * instead of a raw permission-denied.
 */
export async function updateCreation(creationId, updates) {
  const user = auth.currentUser;
  if (!user) throw new Error("User must be logged in to edit a creation.");

  const ref = doc(db, "creations", creationId);
  const safeUpdates = { ...updates };
  delete safeUpdates.creatorUid; // ownership can never change via an edit
  delete safeUpdates.createdAt;

  await updateDoc(ref, safeUpdates);
}

/**
 * Delete a creation you submitted. Same ownership guarantee as above,
 * backed by the Firestore rule as the real source of truth.
 */
export async function deleteCreation(creationId) {
  const user = auth.currentUser;
  if (!user) throw new Error("User must be logged in to delete a creation.");

  await deleteDoc(doc(db, "creations", creationId));
}

/**
 * Fetch every creation in the shared pool. Fine for a small/medium pool;
 * once this gets large, swap to a paginated query or a server-side
 * random-pick (e.g. a Cloud Function) instead of pulling everything client-side.
 */
export async function getAllCreations() {
  try {
    const snapshot = await getDocs(getCreationsRef());
    return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (error) {
    console.error("Error fetching creations:", error);
    return [];
  }
}

/**
 * Pick one creation from the pool at random, weighted by RARITY_WEIGHTS
 * so commons come up far more often than legendaries.
 */
function weightedPick(pool) {
  const weighted = pool.map(c => ({
    entry: c,
    weight: RARITY_WEIGHTS[c.rarity] ?? RARITY_WEIGHTS.common
  }));
  const total = weighted.reduce((sum, w) => sum + w.weight, 0);
  let roll = Math.random() * total;
  for (const w of weighted) {
    roll -= w.weight;
    if (roll <= 0) return w.entry;
  }
  return weighted[weighted.length - 1].entry; // floating-point fallback
}

/**
 * Gacha pull: grab one creation from the shared pool, weighted by rarity,
 * and add it straight to the current user's roster/party, reusing the
 * existing roster.js flow so it shows up exactly like any other roster
 * addition.
 *
 * Returns { creation, rosterEntry } on success, or throws if the pool is empty.
 */
export async function pullGacha() {
  const pool = await getAllCreations();
  if (pool.length === 0) {
    throw new Error("No creations in the gacha pool yet -- be the first to submit one!");
  }

  const picked = weightedPick(pool);

  // addCreatureToRoster() already accepts a generic "base entry" shape
  // (id/dexId, name, evolvesInto, evolvesAt) -- a creation fits that shape
  // directly, so pulls land in the roster the same way a dex pick would.
  const rosterEntry = await addCreatureToRoster({
    id: picked.id,
    dexId: picked.id,
    name: picked.name,
    evolvesInto: picked.evolvesInto,
    evolvesAt: picked.evolvesAt
  });

  return { creation: picked, rosterEntry };
}