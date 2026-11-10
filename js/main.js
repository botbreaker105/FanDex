"use strict";

import { db } from './firebase-config.js';
import { collection, getDocs, query, orderBy, limit, startAfter, where, getCountFromServer } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { onAuthChange, getUserProfile } from './auth.js';

// Global State
window.entries = window.entries || [];
window.currentUser = null;
window.userProfile = null;

// ================= LOADING SPINNER =================
// The spinner markup lives in index.html (#appLoader) and its CSS is in the
// <style> block there. Here we only hide it once the dex has loaded.
// A safety timer hides it anyway after 15 seconds, so it can never get stuck.
const loaderEl = document.getElementById("appLoader");

function hideLoader() {
  if (!loaderEl || loaderEl.classList.contains("hidden")) return;
  loaderEl.classList.add("hidden");
  // Remove from the page after the fade-out animation ends.
  setTimeout(() => loaderEl.remove(), 500);
}
setTimeout(hideLoader, 15000);

// ================= STATS & RENDER HELPERS =================
function updateHeaderStats() {
  const totalEl = document.getElementById("statTotal");
  const regionsEl = document.getElementById("statRegions");
  const legEl = document.getElementById("statLegendary");

  const currentEntries = window.entries || [];

  // While only a few entries are loaded, show the real totals counted by Firestore.
  // Once everything is loaded, count the real list (always exact).
  const useServer = !allLoaded;
  const total = (useServer && window.serverCounts) ? Math.max(window.serverCounts.total, currentEntries.length) : currentEntries.length;
  const legendary = (useServer && window.serverCounts) ? Math.max(window.serverCounts.legendary, currentEntries.filter(e => e.rarity === "legendary").length) : currentEntries.filter(e => e.rarity === "legendary").length;

  if (totalEl) totalEl.textContent = total;
  if (regionsEl && typeof regions !== "undefined") regionsEl.textContent = regions.length;
  if (legEl) legEl.textContent = legendary;
}

function renderAll() {
  if (typeof refreshRegionSelect === "function") refreshRegionSelect();
  if (typeof renderGrid === "function") renderGrid();
  // FIX: the favorites grid was missing here, so it never refreshed.
  if (typeof renderFavGrid === "function") renderFavGrid();

  updateHeaderStats();

  if (typeof window.renderMySuggestions === "function") window.renderMySuggestions();
}

// Attach renderAll to global window scope so other scripts can access it
window.renderAll = renderAll;
window.updateHeaderStats = updateHeaderStats;

// ================= PAGED FIRESTORE DEX LOADER =================
// Loads a few entries at a time (10 on phone, 15 on PC) and loads more while
// you scroll. This saves Firebase reads and makes the first open fast.
const PAGE_SIZE = window.matchMedia("(min-width: 900px)").matches ? 15 : 10; // PC : phone
let lastDoc = null;        // cursor: where the next page starts
let allLoaded = false;     // true when Firestore has no more entries
let loadingPage = false;   // stops two pages loading at the same time
let allPromise = null;     // shared promise for "load everything"

function mapDoc(doc) {
  const data = doc.data();
  return {
    ...data,
    firestoreId: doc.id,
    id: data.id !== undefined ? data.id : doc.id,
    name: data.name || "Unknown Creature",
    types: Array.isArray(data.types) ? data.types : (data.type ? [data.type] : ["normal"]),
    rarity: data.rarity || "common"
  };
}

// Adds new entries to the list (skips ones we already have).
function addEntries(newOnes) {
  const have = new Set((window.entries || []).map(e => e.firestoreId));
  const merged = [...(window.entries || []), ...newOnes.filter(e => !have.has(e.firestoreId))];
  window.entries = merged;
  if (typeof entries !== "undefined") {
    try { entries = merged; } catch (e) {}
  }
}

// Loads ONE page.
async function loadNextPage(size = PAGE_SIZE) {
  if (allLoaded || loadingPage) return;
  loadingPage = true;
  try {
    const col = collection(db, "entries");
    const q = lastDoc
      ? query(col, orderBy("id"), startAfter(lastDoc), limit(size))
      : query(col, orderBy("id"), limit(size));
    const snap = await getDocs(q);

    if (snap.size < size) allLoaded = true;
    if (snap.docs.length) lastDoc = snap.docs[snap.docs.length - 1];

    addEntries(snap.docs.map(mapDoc));
    console.log(`📦 Loaded ${snap.size} more entries (total ${window.entries.length})`);
    renderAll();
  } catch (error) {
    console.error("❌ Failed to load entries from Firebase:", error);
  } finally {
    loadingPage = false;
    // Hide the spinner whether loading worked or failed.
    hideLoader();
  }
}

// Loads everything that is still missing (Battle, Move Dex, search, etc.).
function ensureAllLoaded() {
  if (allLoaded) return Promise.resolve();
  if (allPromise) return allPromise;
  allPromise = (async () => {
    while (!allLoaded) {
      if (loadingPage) { await new Promise(r => setTimeout(r, 100)); continue; }
      await loadNextPage(100);
    }
  })().finally(() => { allPromise = null; });
  return allPromise;
}
window.ensureAllLoaded = ensureAllLoaded;

async function loadDex() {
  // Shared custom weathers (cloud-sync.js) must be registered before entries are rendered/normalized.
  if (window.weathersReady) { try { await window.weathersReady; } catch (e) {} }
  console.log("⚡ Loading first page from Cloud Firestore...");

  // Clear filters on initial load
  if (typeof window.filters !== "undefined") {
    window.filters.search = "";
    window.filters.type = "";
    window.filters.region = "";
  }

  // Count entries on the server (very cheap: about 1 read per 1000 entries), in parallel with page 1.
  const col = collection(db, "entries");
  const countPromise = Promise.all([
    getCountFromServer(col),
    getCountFromServer(query(col, where("rarity", "==", "legendary")))
  ]).then(([all, leg]) => {
    window.serverCounts = { total: all.data().count, legendary: leg.data().count };
    updateHeaderStats();
  }).catch(e => console.warn("Could not count entries:", e));

  await loadNextPage();
  await countPromise;

  // The editor's Pre-Evolution / Variant-of dropdowns list ALL entries. If only a few are loaded, saving
  // would silently drop those links. So load everything first, then open the editor.
  ["openEdit", "openAdd", "openFormEditor"].forEach((fn) => {
    const original = window[fn];
    if (typeof original !== "function") return;
    window[fn] = async function (...args) {
      await ensureAllLoaded();
      return original.apply(this, args);
    };
  });

  // Invisible marker under the grid: when you scroll near it, load the next page.
  const grid = document.getElementById("grid");
  if (grid) {
    const sentinel = document.createElement("div");
    sentinel.style.height = "1px";
    grid.after(sentinel);
    new IntersectionObserver((items) => {
      if (items[0].isIntersecting) loadNextPage();
    }, { rootMargin: "400px" }).observe(sentinel);
  }

  // These tabs need ALL entries, so load the rest only when you open them.
  const NEEDS_ALL = ["battle", "movedex", "abilitydex", "regions", "items"];
  document.querySelectorAll(".tabs button").forEach(btn => {
    btn.addEventListener("click", () => {
      if (NEEDS_ALL.includes(btn.dataset.tab)) {
        ensureAllLoaded().then(() => {
          renderAll();
          if (typeof updateViewVisibility === "function") updateViewVisibility();
        });
      }
    });
  });

  // Search and filters need all entries to give correct results.
  const needAll = () => ensureAllLoaded().then(renderAll);
  const searchBox = document.getElementById("searchInput");
  if (searchBox) searchBox.addEventListener("focus", needAll);
  document.addEventListener("click", (e) => {
    if (e.target.closest(".chip-btn")) needAll();
  });

  // Opening a link like #/dex/25 when that entry is not loaded yet.
  const openByHash = () => {
    const m = location.hash.match(/^#\/dex\/(?:mega-)?(\d+)/);
    if (m && !(window.entries || []).some(e => Number(e.id) === Number(m[1]))) {
      ensureAllLoaded().then(() => {
        if (typeof updateViewVisibility === "function") updateViewVisibility();
      });
    }
  };
  openByHash();
  window.addEventListener("hashchange", openByHash);
}

// ================= AUTHENTICATION LISTENERS =================
onAuthChange(async (user) => {
  const profileBar = document.getElementById("userProfileBar");
  const nameEl = document.getElementById("userDisplayName");
  const loginBtn = document.getElementById("openLoginBtn");

  if (user) {
    console.log("👤 User authenticated:", user.email);
    window.currentUser = user;

    // Fetch user profile from Firestore
    window.userProfile = await getUserProfile(user.uid);

    if (window.userProfile) {
      if (nameEl) nameEl.textContent = window.userProfile.displayName || "Trainer";
      if (profileBar) profileBar.style.display = "flex";
      if (loginBtn) loginBtn.style.display = "none";

      // Admin state styling toggle
      if (window.userProfile.isAdmin) {
        document.body.classList.add("is-admin");
      } else {
        document.body.classList.remove("is-admin");
      }
    }

  } else {
    console.log("👤 User signed out.");
    window.currentUser = null;
    window.userProfile = null;

    if (profileBar) profileBar.style.display = "none";
    if (loginBtn) loginBtn.style.display = "";
    document.body.classList.remove("is-admin");

  }
  window.dispatchEvent(new Event("fandex:authchanged")); // lets the Settings > Custom Weather Maker refresh its Edit/Delete buttons
});

// Initial setup triggers
if (typeof renderTypeGrid === "function") renderTypeGrid();
if (typeof renderEmojiRow === "function") renderEmojiRow();
if (typeof updateChipLabels === "function") updateChipLabels();
if (typeof updateViewVisibility === "function") updateViewVisibility();

// Load data from Firebase
loadDex();