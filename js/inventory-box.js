"use strict";

import { auth } from './auth.js';
import { db } from './firebase-config.js';
import { doc, getDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { addTrainerExp } from './common/api-client.js';

const STARDUST_PER_LEVEL = 100; // Cost in Stardust to level up once
const LOADOUT_SIZE = 6;

// In-memory cache of the logged-in user's roster/stardust/loadout, refreshed
// whenever renderInventoryBox() runs (tab click, login/logout, external saves).
let cachedRoster = [];
let cachedLoadout = new Array(LOADOUT_SIZE).fill(null);
let cachedStardust = 0;
let expandedMoves = new Set(); // instanceIds whose move list is currently open

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

/**
 * A roster row only stores the mon's *instance* data (level, nickname, etc).
 * Its move list lives on the species definition over in the Complete Dex
 * (window.entries), so look that entry up by dexId first, falling back to
 * a name match for older roster rows that predate dexId.
 */
function findSpeciesEntry(mon) {
  const list = window.entries || [];
  if (mon.dexId != null) {
    const byId = list.find(e => String(e.id) === String(mon.dexId));
    if (byId) return byId;
  }
  return list.find(e => e.name === mon.name) || null;
}

function itemById(id) {
  if (!id) return null;
  return (window.items || []).find(i => String(i.id) === String(id)) || null;
}

function movesListHtml(mon) {
  const species = findSpeciesEntry(mon);
  const moves = (species && species.moves) || [];
  if (!moves.length) {
    return `<div class="mon-moves-empty">No moves logged for this species yet.</div>`;
  }
  return moves.map(m => {
    const dealsDamage = m.category === "Physical" || m.category === "Special";
    const pp = m.pp ?? m.maxPP ?? 15;
    return `
      <div class="mon-move-row">
        <span class="move-type-pill" style="background:var(--t-${esc(m.type)})">${esc(m.type)}</span>
        <span class="mon-move-name">${esc(m.name)}</span>
        <span class="mon-move-meta">${m.level ? `Lv. ${m.level} · ` : ""}${dealsDamage ? `Pwr ${m.basePower ?? "—"} · ` : ""}Acc ${Math.round((m.accuracy ?? 1) * 100)}% · ${pp} PP</span>
      </div>`;
  }).join("");
}

function itemSelectHtml(mon) {
  const allItems = window.items || [];
  const options = [`<option value="">— No held item —</option>`].concat(
    allItems.map(it => `<option value="${esc(it.id)}" ${String(mon.heldItemId || "") === String(it.id) ? "selected" : ""}>${esc(it.name)}</option>`)
  );
  return `<select class="held-item-select" data-id="${esc(mon.instanceId)}">${options.join("")}</select>`;
}

function monCardHtml(mon, opts) {
  const inLoadout = !!opts.inLoadout;
  const canEvolve = mon.evolvesAt && mon.level >= mon.evolvesAt && mon.evolvesInto;
  const canLevelUp = cachedStardust >= STARDUST_PER_LEVEL;
  const held = itemById(mon.heldItemId);
  const showMoves = expandedMoves.has(mon.instanceId);

  return `
    <div class="mon-card" data-id="${esc(mon.instanceId)}">
      <div class="mon-card-art">
        ${mon.imageUrl ? `<img src="${esc(mon.imageUrl)}" onerror="this.remove();">` : `<span class="mon-card-emoji">👾</span>`}
      </div>
      <div class="mon-card-name-row">
        <b class="mon-card-name">${esc(mon.name)}</b>
        <span class="mon-level-badge">Lv. ${mon.level}</span>
      </div>
      <div class="mon-card-sub">${esc(mon.rarity)}${held ? ` · holding <b>${esc(held.name)}</b>` : ""}</div>

      ${inLoadout ? `<label class="mon-item-label">Held Item ${itemSelectHtml(mon)}</label>` : ""}

      <button type="button" class="mon-moves-toggle" data-id="${esc(mon.instanceId)}">${showMoves ? "▾" : "▸"} Moves</button>
      ${showMoves ? `<div class="mon-moves-list">${movesListHtml(mon)}</div>` : ""}

      <div class="mon-card-actions">
        <button type="button" class="btn-secondary power-up-btn" data-id="${esc(mon.instanceId)}" ${!canLevelUp ? "disabled" : ""}>Power Up (${STARDUST_PER_LEVEL} ✨)</button>
        ${canEvolve ? `<button type="button" class="btn-primary evolve-btn" data-id="${esc(mon.instanceId)}">⚡ Evolve</button>` : ""}
        ${inLoadout
          ? `<button type="button" class="btn-secondary bench-btn" data-id="${esc(mon.instanceId)}">Bench</button>`
          : `<button type="button" class="btn-secondary add-loadout-btn" data-id="${esc(mon.instanceId)}" ${opts.loadoutFull ? `disabled title="Loadout is full — bench a mon first"` : ""}>+ Add to Loadout</button>`}
      </div>
    </div>`;
}

function emptySlotHtml(index) {
  return `
    <div class="loadout-slot is-empty" data-slot="${index}">
      <div class="slot-index-badge">${index + 1}</div>
      <div class="slot-empty-label">Empty Slot</div>
      <div class="slot-empty-hint">Add a mon from the Box below</div>
    </div>`;
}

function getBoxMons() {
  const loadoutIds = new Set(cachedLoadout.filter(Boolean));
  return cachedRoster.filter(m => !loadoutIds.has(m.instanceId));
}

function render() {
  const loadoutEl = document.getElementById('loadoutGrid');
  const boxEl = document.getElementById('boxGrid');
  const bagEl = document.getElementById('itemBagGrid');
  const stardustEl = document.getElementById('userStardustCount');

  if (stardustEl) stardustEl.textContent = cachedStardust;

  if (!auth.currentUser) {
    const msg = `<div class="field-hint">Log in to manage your Inventory &amp; Box.</div>`;
    if (loadoutEl) loadoutEl.innerHTML = msg;
    if (boxEl) boxEl.innerHTML = '';
    if (bagEl) bagEl.innerHTML = '';
    return;
  }

  if (loadoutEl) {
    loadoutEl.innerHTML = cachedLoadout.map((instanceId, idx) => {
      if (!instanceId) return emptySlotHtml(idx);
      const mon = cachedRoster.find(m => m.instanceId === instanceId);
      if (!mon) return emptySlotHtml(idx); // stale reference; heals on next save
      return monCardHtml(mon, { inLoadout: true });
    }).join('');
  }

  const boxMons = getBoxMons();
  const loadoutFull = cachedLoadout.every(Boolean);
  if (boxEl) {
    boxEl.innerHTML = boxMons.length
      ? boxMons.map(m => monCardHtml(m, { inLoadout: false, loadoutFull })).join('')
      : (cachedRoster.length
          ? `<div class="empty"><h3>Your box is empty</h3><p>Every mon you own is already in your Active Loadout.</p></div>`
          : `<div class="empty"><h3>No mons yet</h3><p>Catch or pull your first Fakemon from the Shop to get started.</p></div>`);
  }

  if (bagEl) {
    const allItems = window.items || [];
    bagEl.innerHTML = allItems.length
      ? allItems.map(it => `
          <div class="item-card">
            <div class="item-name">${esc(it.name)}</div>
            <div class="item-meta"><span>${esc(it.type)}</span></div>
            ${it.desc ? `<div class="item-desc">${esc(it.desc)}</div>` : ""}
          </div>`).join('')
      : `<div class="field-hint">No items logged yet — add some in the Item Dex tab, then equip them above.</div>`;
  }

  wireEvents();
}

function getUserRef() {
  return doc(db, "users", auth.currentUser.uid);
}

async function persistLoadout() {
  await updateDoc(getUserRef(), { loadout: cachedLoadout });
}

async function persistRosterAndStardust() {
  await updateDoc(getUserRef(), { roster: cachedRoster, stardust: cachedStardust });
}

function wireEvents() {
  document.querySelectorAll('.add-loadout-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.currentTarget.getAttribute('data-id');
      const emptyIdx = cachedLoadout.findIndex(s => !s);
      if (emptyIdx === -1) return;
      cachedLoadout[emptyIdx] = id;
      render();
      try { await persistLoadout(); } catch (err) { console.error('Failed to save loadout:', err); }
    });
  });

  document.querySelectorAll('.bench-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.currentTarget.getAttribute('data-id');
      cachedLoadout = cachedLoadout.map(s => s === id ? null : s);
      render();
      try { await persistLoadout(); } catch (err) { console.error('Failed to save loadout:', err); }
    });
  });

  document.querySelectorAll('.held-item-select').forEach(sel => {
    sel.addEventListener('change', async (e) => {
      const id = e.currentTarget.getAttribute('data-id');
      const itemId = e.currentTarget.value || null;
      cachedRoster = cachedRoster.map(m => m.instanceId === id ? { ...m, heldItemId: itemId } : m);
      render();
      try { await persistRosterAndStardust(); } catch (err) { console.error('Failed to save held item:', err); }
    });
  });

  document.querySelectorAll('.mon-moves-toggle').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.getAttribute('data-id');
      if (expandedMoves.has(id)) expandedMoves.delete(id); else expandedMoves.add(id);
      render();
    });
  });

  document.querySelectorAll('.power-up-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => { await powerUpMon(e.currentTarget.getAttribute('data-id')); });
  });

  document.querySelectorAll('.evolve-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => { await evolveMon(e.currentTarget.getAttribute('data-id')); });
  });
}

async function powerUpMon(instanceId) {
  if (cachedStardust < STARDUST_PER_LEVEL) {
    alert("Not enough Stardust!");
    return;
  }
  cachedRoster = cachedRoster.map(mon => mon.instanceId === instanceId ? { ...mon, level: mon.level + 1 } : mon);
  cachedStardust -= STARDUST_PER_LEVEL;
  render();
  try {
    await persistRosterAndStardust();
    await addTrainerExp(auth.currentUser.uid, 10);
  } catch (err) {
    console.error('Failed to power up:', err);
  }
}

function triggerEvolutionAnimation(prevMonName, prevImageUrl, newMonName, newImageUrl) {
  return new Promise((resolve) => {
    const modal = document.getElementById('evolutionModal');
    const title = document.getElementById('evoTitle');
    const subtext = document.getElementById('evoSubtext');
    const sprite = document.getElementById('evoSprite');
    const closeBtn = document.getElementById('closeEvoModalBtn');
    if (!modal || !title || !subtext || !sprite || !closeBtn) { resolve(); return; }

    title.textContent = "Something is happening…";
    subtext.textContent = `Your ${prevMonName} is evolving!`;
    sprite.src = prevImageUrl || '';
    sprite.className = "evo-sprite";
    closeBtn.style.display = "none";
    modal.style.display = "flex";

    setTimeout(() => { sprite.classList.add('glowing'); }, 800);

    setTimeout(() => {
      sprite.className = "evo-sprite";
      sprite.src = newImageUrl || prevImageUrl;
      sprite.classList.add('revealed');
      title.textContent = "Congratulations!";
      subtext.textContent = `Your ${prevMonName} evolved into ${newMonName}!`;
      closeBtn.style.display = "inline-block";
    }, 2200);

    const handleClose = () => {
      modal.style.display = "none";
      closeBtn.removeEventListener('click', handleClose);
      resolve();
    };
    closeBtn.addEventListener('click', handleClose);
  });
}

async function evolveMon(instanceId) {
  const mon = cachedRoster.find(m => m.instanceId === instanceId);
  if (!mon || !mon.evolvesInto) return;

  const prevName = mon.name;
  const prevImg = mon.imageUrl;
  const nextName = mon.evolvesInto;
  const nextImg = mon.evolvedImageUrl || mon.imageUrl;

  await triggerEvolutionAnimation(prevName, prevImg, nextName, nextImg);

  cachedRoster = cachedRoster.map(m => m.instanceId === instanceId ? {
    ...m,
    name: nextName,
    imageUrl: nextImg,
    evolvesAt: m.nextEvolvesAt || null,
    evolvesInto: m.nextEvolvesInto || null
  } : m);

  render();
  try {
    await persistRosterAndStardust();
    await addTrainerExp(auth.currentUser.uid, 50);
  } catch (err) {
    console.error('Failed to evolve:', err);
  }
}

/**
 * Loads the user's roster/stardust/loadout from Firestore and renders the
 * Loadout / Box / Item Bag grids. Safe to call repeatedly (tab click, login,
 * or any time the app wants the view refreshed).
 */
export async function renderInventoryBox() {
  if (!auth.currentUser) { render(); return; }

  try {
    const snap = await getDoc(getUserRef());
    const data = snap.exists() ? snap.data() : {};

    cachedRoster = Array.isArray(data.roster) ? data.roster : [];
    cachedStardust = data.stardust || 0;

    const rosterIds = new Set(cachedRoster.map(m => m.instanceId));
    let loadout = Array.isArray(data.loadout) ? data.loadout.slice(0, LOADOUT_SIZE) : [];
    while (loadout.length < LOADOUT_SIZE) loadout.push(null);
    // Drop any slot pointing at a mon that no longer exists in the roster.
    loadout = loadout.map(id => (id && rosterIds.has(id)) ? id : null);
    cachedLoadout = loadout;

    render();
  } catch (err) {
    console.error('Error loading Inventory & Box:', err);
    const loadoutEl = document.getElementById('loadoutGrid');
    if (loadoutEl) loadoutEl.innerHTML = `<div class="field-hint">Failed to load your roster.</div>`;
  }
}

window.renderInventoryBox = renderInventoryBox;

document.addEventListener('DOMContentLoaded', () => {
  const tabBtn = document.querySelector('[data-tab="mydex"]');
  if (tabBtn) tabBtn.addEventListener('click', renderInventoryBox);
});
