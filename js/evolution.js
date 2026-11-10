"use strict";

// ================= EVOLUTION ELIGIBILITY =================
// Checks whether a roster mon currently satisfies its species' evolution
// condition. This does NOT check the trigger type on its own -- the caller
// decides what to do with that. leveling.js only auto-applies "level" type
// evolutions; "item" type evolutions stay dormant until the player actively
// uses the item, via checkItemEvolution() below.
export function canEvolve(rosterRow, dexEntry){
  const rule = dexEntry.evolvesAt;
  if(!rule || !dexEntry.evolvesInto) return false;

  switch(rule.type){
    case "level":
      return rosterRow.level >= rule.value;
    case "item":
      // Being "eligible" here just means this species HAS an item evolution
      // defined at all -- the real gate is whether the right item gets used,
      // which is checked separately in checkItemEvolution.
      return true;
    default:
      return false;
  }
}

// Looks up the dex entry a species evolves into.
// NOTE: species/dex data in this app lives in the global `entries` array
// (loaded from Firestore by main.js's loadDex()) -- it is NOT served by the
// REST api-client.js (that getDexEntryById() hits a /api/dex/entries/:id
// endpoint this app doesn't actually use for its live dex data). Doing a
// plain synchronous entries.find() here matches every other lookup in the
// app (regionById, preEvo resolution, etc.) and avoids an unnecessary async
// round-trip for data that's already sitting in memory.
export function getEvolutionTarget(dexEntry){
  if(!dexEntry.evolvesInto) return null;
  return (window.entries || []).find(e=>e.id===dexEntry.evolvesInto) || null;
}

// ================= APPLYING EVOLUTION =================
// Mutates the roster row in place: swaps its species reference to the
// evolved form. Level, exp, nickname, held item, and favorite status all
// carry over untouched -- evolution changes stats/appearance/movepool
// access, not the mon's identity or progress.
export function applyEvolution(rosterRow, targetDexEntry){
  rosterRow.speciesId = targetDexEntry.id;

  // If you want evolved forms to be unable to keep moves the new species
  // could never learn, filter here. Left off by default since most fan-dex
  // setups let a mon keep everything it already knew after evolving.
  // rosterRow.moves = rosterRow.moves.filter(m => isMoveValidFor(targetDexEntry, m));

  return rosterRow;
}

// ================= ITEM-TRIGGERED EVOLUTION =================
// Call this from ui-roster.js when a player uses an item on a specific mon.
// Returns a result object if the item caused an evolution, or null if that
// item doesn't do anything for this mon (so the UI can show "nothing happened").
export function checkItemEvolution(rosterRow, dexEntry, itemId){
  const rule = dexEntry.evolvesAt;
  if(!rule || rule.type !== "item" || rule.value !== itemId) return null;

  const target = getEvolutionTarget(dexEntry);
  if(!target) return null;

  applyEvolution(rosterRow, target);
  return { evolvedInto: target.id };
}

// ================= LEVEL-UP TRIGGERED EVOLUTION =================
// Called by leveling.js right after a level-up loop finishes. Keeps the
// "level" evolution rule check in one place instead of duplicating the
// canEvolve/getEvolutionTarget/applyEvolution sequence inside leveling.js.
// Returns a result object if the mon evolved, or null otherwise.
export function checkLevelEvolution(rosterRow, dexEntry){
  const rule = dexEntry.evolvesAt;
  if(!rule || rule.type !== "level") return null;
  if(!canEvolve(rosterRow, dexEntry)) return null;

  const target = getEvolutionTarget(dexEntry);
  if(!target) return null;

  applyEvolution(rosterRow, target);
  return { evolvedInto: target.id };
}
