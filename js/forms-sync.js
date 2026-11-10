"use strict";

// ============================================================
// COMMUNITY FORMS — the "anyone can add a Form (Mega Evolution, Alt Form,
// etc.) to ANY entry" feature. These live in their own Firestore
// subcollection (entries/{baseEntryId}/forms/{formId}), completely separate
// from the base entry's own document, so adding one never requires — and
// never grants — any ability to touch the base entry itself. Each form
// stamps its OWN creatorUid; only that person can edit/delete THAT form
// afterwards (see firestore.rules).
//
// engine.js's enabledMegasOf() merges these into the same rendering
// pipeline as the base entry owner's own authored Mega profiles — see the
// comment there for how the two pools combine.
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

/**
 * Load every community-submitted form across every entry in one query, and
 * group them by their parent entry's id into window.communityForms —
 * exactly the shape engine.js's enabledMegasOf() expects.
 */
export async function loadAllForms(){
  try {
    const snap = await getDocs(collectionGroup(db, "forms"));
    const byEntry = {};
    snap.forEach(docSnap=>{
      const baseEntryId = docSnap.ref.parent.parent.id; // .../entries/{baseEntryId}/forms/{formId}
      const data = { id: docSnap.id, firestoreId: docSnap.id, ...docSnap.data() };
      if(!byEntry[baseEntryId]) byEntry[baseEntryId] = [];
      byEntry[baseEntryId].push(data);
    });
    window.communityForms = byEntry;
    if(typeof window.renderAll === "function") window.renderAll();
  } catch (err) {
    console.error("❌ Failed to load community forms:", err);
    window.communityForms = window.communityForms || {};
  }
}

/**
 * Create or update a community form under a given base entry. Ownership is
 * enforced for real by firestore.rules; this check just gives a friendly
 * error instead of a raw permission-denied.
 */
export async function saveForm(baseEntryId, formData, existingFormId){
  const uid = currentUid();
  if(!uid) throw new Error("You need to be logged in to add a form.");
  if(existingFormId && formData.creatorUid && formData.creatorUid !== uid && !isAdmin()){
    throw new Error("You can only edit forms you created.");
  }

  const payload = { ...formData };
  delete payload.id;
  delete payload.firestoreId;
  delete payload.isCommunityForm; // implicit by virtue of living in this subcollection
  payload.creatorUid = formData.creatorUid || uid;
  payload.creatorName = formData.creatorName || (window.userProfile && window.userProfile.displayName) || "Anonymous Trainer";

  const formsRef = collection(db, "entries", baseEntryId, "forms");
  if(existingFormId){
    await updateDoc(doc(formsRef, existingFormId), payload);
    return existingFormId;
  } else {
    const ref = await addDoc(formsRef, { ...payload, createdAt: serverTimestamp() });
    return ref.id;
  }
}

/**
 * Delete a community form. Only its own creator (or an admin) may do this —
 * again, backed for real by firestore.rules.
 */
export async function deleteForm(baseEntryId, formId, creatorUid){
  const uid = currentUid();
  if(!uid || (creatorUid && creatorUid !== uid && !isAdmin())){
    throw new Error("You can only delete forms you created.");
  }
  await deleteDoc(doc(db, "entries", baseEntryId, "forms", formId));
}

window.FormsSync = { loadAllForms, saveForm, deleteForm };

// Load once at startup, same timing as the main Dex load.
loadAllForms();
