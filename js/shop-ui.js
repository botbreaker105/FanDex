"use strict";

import { auth } from './auth.js';
// Make sure your dex/creations module exposes these helpers or replace them with your actual functions
import { pullGachaById, getRandomDexItems } from './creations.js';

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

const RARITY_LABEL = { 
  common: 'Common', 
  uncommon: 'Uncommon', 
  rare: 'Rare', 
  legendary: 'Legendary' 
};

/**
 * Define your max IDs for each rarity to pull by number without querying full lists.
 * Adjust these values based on your actual Dex database boundaries.
 */
const MAX_IDS = {
  common: 100,
  uncommon: 50,
  rare: 25,
  legendary: 5
};

/**
 * Loads a random selection of Dex items into the Shop UI.
 */
async function refreshShop() {
  const listEl = document.getElementById('creationsPoolList');
  if (!listEl) return;

  listEl.innerHTML = '<div class="field-hint">Loading shop items…</div>';

  try {
    // Fetch a random batch of items (e.g., 6 items) from your Dex
    const shopItems = await getRandomDexItems(6);

    if (!shopItems || shopItems.length === 0) {
      listEl.innerHTML = '<div class="field-hint">No shop items available right now.</div>';
      return;
    }

    listEl.innerHTML = shopItems.map(item => `
      <div style="background:var(--ink-2);border:1px solid var(--line);border-radius:10px;padding:10px 12px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
        <div>
          <b>${esc(item.name)}</b>
          <span style="color:var(--slate);font-size:12px;"> — ${esc(RARITY_LABEL[item.rarity] || item.rarity || 'Normal')}</span>
        </div>
        <div style="color:var(--slate);font-size:12px;font-weight:bold;">
          ${item.price ? esc(item.price) + ' Coins' : 'Price not set up'}
        </div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Error refreshing shop:', err);
    listEl.innerHTML = '<div class="field-hint">Couldn\'t load shop items right now.</div>';
  }
}

/**
 * Wire the Gacha button to pick a random ID within rarity boundaries.
 */
function wireGachaButton() {
  const btn = document.getElementById('pullGachaBtn');
  const resultEl = document.getElementById('gachaResult');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    if (!auth.currentUser) { 
      alert('Log in to pull.'); 
      return; 
    }

    btn.disabled = true;
    btn.textContent = 'Pulling…';
    resultEl.textContent = '';

    try {
      // 1. Determine rarity based on probability weights
      const rarity = determineRarity();

      // 2. Pick a random numerical ID up to that rarity's maximum ID limit
      const maxId = MAX_IDS[rarity] || 10;
      const randomId = Math.floor(Math.random() * maxId) + 1;

      // 3. Fetch single document read by numeric ID from database
      const creation = await pullGachaById(rarity, randomId);

      resultEl.innerHTML = `🎉 You pulled <b>${esc(creation.name)}</b> <span style="color:var(--slate);">(${esc(RARITY_LABEL[creation.rarity] || creation.rarity)})</span> — added to your roster!`;
    } catch (err) {
      console.error('Error pulling gacha:', err);
      resultEl.textContent = err.message || 'Something went wrong.';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Pull';
    }
  });
}

/**
 * Helper to pick a rarity key based on weighted odds.
 */
function determineRarity() {
  const rand = Math.random() * 100;
  if (rand < 60) return 'common';       // 60% chance
  if (rand < 85) return 'uncommon';     // 25% chance
  if (rand < 97) return 'rare';         // 12% chance
  return 'legendary';                   // 3% chance
}

document.addEventListener('DOMContentLoaded', () => {
  wireGachaButton();
  refreshShop();

  // Refresh shop listing when clicking the Shop tab
  const shopTabBtn = document.querySelector('[data-tab="shop"]');
  if (shopTabBtn) shopTabBtn.addEventListener('click', refreshShop);
});