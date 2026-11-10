roster.js
import { db, auth } from './auth.js';
import { 
  collection, 
  doc, 
  getDocs, 
  addDoc, 
  updateDoc, 
  deleteDoc, 
  serverTimestamp 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

import { addExp } from './leveling.js';

/**
 * Helper to get user roster collection reference
 */
function getRosterRef() {
  const user = auth.currentUser;
  if (!user) throw new Error("User must be logged in to access roster.");
  return collection(db, 'users', user.uid, 'roster');
}

/**
 * Fetch all creatures in current user's roster
 */
export async function getUserRoster() {
  try {
    const snapshot = await getDocs(getRosterRef());
    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
  } catch (error) {
    console.error("Error fetching roster:", error);
    return [];
  }
}

/**
 * Add a new creature to the user's roster
 */
export async function addCreatureToRoster(baseEntry) {
  try {
    const newCreature = {
      dexId: baseEntry.id || baseEntry.dexId,
      nickname: baseEntry.name,
      level: 1,
      currentXP: 0,
      evolvesInto: baseEntry.evolvesInto || null,
      evolvesAt: baseEntry.evolvesAt || null,
      acquiredAt: serverTimestamp()
    };

    const docRef = await addDoc(getRosterRef(), newCreature);
    return { id: docRef.id, ...newCreature };
  } catch (error) {
    console.error("Error adding creature to roster:", error);
    throw error;
  }
}

/**
 * Award XP to a creature, check for level up & evolution triggers
 */
export async function awardCreatureXP(rosterDocId, xpGained) {
  const user = auth.currentUser;
  if (!user) return null;

  const creatureRef = doc(db, 'users', user.uid, 'roster', rosterDocId);

  // Note: Pass current creature data from your UI/state to save extra reads, 
  // or fetch fresh data here:
  const roster = await getUserRoster();
  const creature = roster.find(c => c.id === rosterDocId);

  if (!creature) throw new Error("Creature not found in roster.");

  // The species' dex entry (evolvesInto/evolvesAt/etc.) is what
  // evolution.js needs to know whether this creature is ready to evolve.
  // Dex entries live in the shared window.entries array -- see the note in
  // evolution.js's getEvolutionTarget() for why that's the array to use.
  const dexEntries = window.entries || [];
  const dexEntry = dexEntries.find(e => e.id === creature.dexId);
  if (!dexEntry) {
    console.warn(`awardCreatureXP: no dex entry found for dexId "${creature.dexId}" -- awarding XP with no evolution check.`);
  }

  // addExp()/checkLevelEvolution() (leveling.js / evolution.js) use their
  // own field names -- rosterRow.xp and rosterRow.speciesId -- which don't
  // match this Firestore roster document's currentXP/dexId. Bridge with a
  // small adapter object rather than renaming either side's schema.
  const adapter = { level: creature.level, xp: creature.currentXP || 0, speciesId: creature.dexId };
  const result = addExp(adapter, dexEntry || {}, xpGained);

  const updates = {
    currentXP: adapter.xp,
    level: adapter.level
  };
  if (result.evolution) {
    // applyEvolution() (inside checkLevelEvolution) updated adapter.speciesId in place.
    updates.dexId = adapter.speciesId;
  }

  await updateDoc(creatureRef, updates);

  return {
    rosterDocId,
    updatedCreature: { ...creature, ...updates },
    didLevelUp: result.leveledUp,
    evolutionDetails: result.evolution // returns info if it evolved
  };
}

/**
 * Evolve a creature into its next form
 */
export async function evolveCreatureInRoster(rosterDocId, targetDexEntry) {
  const user = auth.currentUser;
  if (!user) return;

  const creatureRef = doc(db, 'users', user.uid, 'roster', rosterDocId);

  const updates = {
    dexId: targetDexEntry.id,
    nickname: targetDexEntry.name, // optional default rename
    evolvesInto: targetDexEntry.evolvesInto || null,
    evolvesAt: targetDexEntry.evolvesAt || null
  };

  await updateDoc(creatureRef, updates);
  return updates;
}