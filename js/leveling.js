"use strict";

import { checkLevelEvolution } from './evolution.js';

// ================= XP CURVE =================
// How much XP a roster mon needs, TOTAL, to go from `level` to `level+1`.
// Cubic-ish curve so early levels are cheap and later ones stretch out --
// tune the multiplier/exponent to taste, nothing else depends on the shape
// of this formula, only that it's monotonically increasing.
const MAX_LEVEL = 100;
export function xpToNextLevel(level){
  return Math.floor(50 * Math.pow(level, 1.5));
}

// For UI progress bars: how far into the current level a mon is.
// Returns { current, needed, pct } -- needed is 0 at MAX_LEVEL (nothing left to show).
export function xpProgress(rosterRow){
  if(rosterRow.level >= MAX_LEVEL) return { current: 0, needed: 0, pct: 100 };
  const needed = xpToNextLevel(rosterRow.level);
  const current = rosterRow.xp || 0;
  return { current, needed, pct: Math.min(100, Math.floor((current/needed)*100)) };
}

// ================= AWARDING XP =================
// Call this after a battle/raid resolves, once per mon that should get XP
// (e.g. every mon that fought, or just the active one -- your call site
// decides who qualifies). Handles multi-level jumps in one call (a big XP
// reward can carry a mon up several levels at once) and, if the mon crosses
// into a level-based evolution threshold, hands off to checkLevelEvolution()
// from evolution.js so the two systems don't duplicate that logic.
//
// Mutates rosterRow in place (level, xp, and possibly speciesId if it
// evolves). Caller is responsible for persisting the updated roster row
// afterward (Firestore write / saveRoster / whatever the actual roster
// storage layer ends up being) -- this function only touches the in-memory
// object.
//
// Returns:
//   {
//     leveledUp: boolean,
//     levelsGained: number,
//     newLevel: number,
//     evolution: { evolvedInto: <speciesId> } | null
//   }
export function addExp(rosterRow, dexEntry, amount){
  if(!amount || amount <= 0){
    return { leveledUp:false, levelsGained:0, newLevel: rosterRow.level, evolution:null };
  }

  rosterRow.xp = (rosterRow.xp || 0) + amount;
  let levelsGained = 0;

  while(rosterRow.level < MAX_LEVEL && rosterRow.xp >= xpToNextLevel(rosterRow.level)){
    rosterRow.xp -= xpToNextLevel(rosterRow.level);
    rosterRow.level++;
    levelsGained++;
  }

  // At the level cap, stop banking leftover xp -- nothing left to spend it on.
  if(rosterRow.level >= MAX_LEVEL) rosterRow.xp = 0;

  let evolution = null;
  if(levelsGained > 0 && typeof checkLevelEvolution === "function"){
    evolution = checkLevelEvolution(rosterRow, dexEntry);
  }

  return {
    leveledUp: levelsGained > 0,
    levelsGained,
    newLevel: rosterRow.level,
    evolution
  };
}
