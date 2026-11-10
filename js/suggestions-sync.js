"use strict";

// ============================================================
// SUGGESTIONS — the "propose a Mega/Form, an Evolution, or Art for someone
// else's entry, they review and accept it, you get credited" feature.
//
// Lives in its own subcollection, entries/{baseEntryId}/suggestions/{id},
// separate from both the base entry AND the community-forms subcollection.
// A suggestion always starts "pending" and can only be flipped to
// "accepted"/"rejected" by the base entry's owner (enforced by
// firestore.rules, which reads the parent entry's creatorUid to check that).
//
// Acceptance behavior differs by type — see acceptSuggestion() below for why.
// ============================================================

import { db } from "./firebase-config.js";
import {
  collection,
  collectionGroup,
  doc,
  getDocs,
  addDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

function currentUid(){ return window.currentUser ? window.currentUser.uid : null; }
function isAdmin(){ return !!(window.userProfile && window.userProfile.isAdmin); }
function displayName(){ return (window.userProfile && window.userProfile.displayName) || "Anonymous Trainer"; }

/**
 * Load every suggestion across every entry in one query. Splits them into
 * two buckets on window:
 *  - window.suggestionsByEntry[baseEntryId] = ALL suggestions for that entry
 *    (pending/accepted/rejected) — what the owner's review panel reads.
 *  - window.acceptedMegaSuggestions[baseEntryId] = just the accepted "mega"
 *    ones, pre-shaped for engine.js's enabledMegasOf() to merge in directly.
 *  - window.mySuggestions = every suggestion authored by the current user,
 *    across all entries — what the "My Suggestions" publish-prompt reads.
 */
export async function loadAllSuggestions(){
  try {
    const snap = await getDocs(collectionGroup(db, "suggestions"));
    const byEntry = {};
    const acceptedMegas = {};
    const mine = [];
    const uid = currentUid();

    snap.forEach(docSnap=>{
      const baseEntryId = docSnap.ref.parent.parent.id;
      const data = { id: docSnap.id, firestoreId: docSnap.id, baseEntryId, ...docSnap.data() };

      if(!byEntry[baseEntryId]) byEntry[baseEntryId] = [];
      byEntry[baseEntryId].push(data);

      if(data.status === "accepted" && data.type === "mega" && data.megaData){
        if(!acceptedMegas[baseEntryId]) acceptedMegas[baseEntryId] = [];
        acceptedMegas[baseEntryId].push({
          ...data.megaData,
          id: data.id,
          creatorUid: data.authorUid,
          creatorName: data.authorName
        });
      }

      if(uid && data.authorUid === uid) mine.push(data);
    });

    window.suggestionsByEntry = byEntry;
    window.acceptedMegaSuggestions = acceptedMegas;
    window.mySuggestions = mine;
    if(typeof window.renderAll === "function") window.renderAll();
  } catch (err) {
    console.error("❌ Failed to load suggestions:", err);
    window.suggestionsByEntry = window.suggestionsByEntry || {};
    window.acceptedMegaSuggestions = window.acceptedMegaSuggestions || {};
    window.mySuggestions = window.mySuggestions || [];
  }
}

/**
 * Submit a new suggestion. type is "mega" | "evolution" | "art" — pass the
 * matching payload key (megaData / evolutionDraft / imagesData), the others
 * left undefined.
 */
export async function submitSuggestion(baseEntryId, { type, note, megaData, evolutionDraft, imagesData }){
  const uid = currentUid();
  if(!uid) throw new Error("You need to be logged in to suggest something.");

  const payload = {
    type,
    status: "pending",
    authorUid: uid,
    authorName: displayName(),
    note: note || "",
    megaData: type === "mega" ? megaData : null,
    evolutionDraft: type === "evolution" ? evolutionDraft : null,
    imagesData: type === "art" ? imagesData : null,
    createdAt: serverTimestamp()
  };

  await addDoc(collection(db, "entries", baseEntryId, "suggestions"), payload);
}

/**
 * Accept a suggestion. What "accepting" actually DOES depends on the type:
 *  - "mega": nothing more than flipping status — enabledMegasOf() already
 *    picks up any suggestion with status "accepted" directly, no data needs
 *    to move anywhere.
 *  - "art": also writes the proposed images onto the base entry itself
 *    (the OWNER is doing this write, to their OWN entry, so no permission
 *    conflict) and appends an art-credit entry.
 *  - "evolution": ALSO just flips status. Firestore rules mean only the
 *    suggestion's own author can ever be the creatorUid of a brand new
 *    entries/ doc — so this step only approves the concept. The actual new
 *    Dex entry gets published by the suggester themselves afterward (see
 *    "My Suggestions" / publishAcceptedEvolution in ui-form-handler.js),
 *    which is also what makes them its real, credited creator.
 */
export async function acceptSuggestion(suggestion){
  const uid = currentUid();
  const baseEntry = (window.entries||[]).find(e=>e.id===suggestion.baseEntryId);
  if(!uid || !baseEntry || (baseEntry.creatorUid !== uid && !isAdmin())){
    throw new Error("Only this entry's creator can accept a suggestion on it.");
  }

  await updateDoc(doc(db, "entries", suggestion.baseEntryId, "suggestions", suggestion.id), { status: "accepted" });

  if(suggestion.type === "art" && suggestion.imagesData && window.CloudSync){
    const artCredits = Array.isArray(baseEntry.artCredits) ? [...baseEntry.artCredits] : [];
    if(!artCredits.some(c=>c.uid===suggestion.authorUid)){
      artCredits.push({ uid: suggestion.authorUid, name: suggestion.authorName });
    }
    await window.CloudSync.saveEntryToCloud({
      ...baseEntry,
      images: suggestion.imagesData,
      artCredits
    });
  }

  await loadAllSuggestions();
}

export async function rejectSuggestion(suggestion){
  const uid = currentUid();
  const baseEntry = (window.entries||[]).find(e=>e.id===suggestion.baseEntryId);
  if(!uid || !baseEntry || (baseEntry.creatorUid !== uid && !isAdmin())){
    throw new Error("Only this entry's creator can decide on a suggestion for it.");
  }
  await updateDoc(doc(db, "entries", suggestion.baseEntryId, "suggestions", suggestion.id), { status: "rejected" });
  await loadAllSuggestions();
}

/** The suggestion's own author can withdraw it while it's still pending. */
export async function withdrawSuggestion(suggestion){
  const uid = currentUid();
  if(!uid || suggestion.authorUid !== uid) throw new Error("You can only withdraw your own suggestions.");
  await deleteDoc(doc(db, "entries", suggestion.baseEntryId, "suggestions", suggestion.id));
  await loadAllSuggestions();
}

window.SuggestionsSync = { loadAllSuggestions, submitSuggestion, acceptSuggestion, rejectSuggestion, withdrawSuggestion };

loadAllSuggestions();
