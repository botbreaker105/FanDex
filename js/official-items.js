"use strict";

// ============================================================
// OFFICIAL ITEMS + MEGA STONES + MEGA EVOLUTIONS (admin only) — data from PokéAPI.
//
//  Items   -> Firestore "items" collection, doc id  official-<pokeapi-name>, stamped official:true.
//  Megas   -> written onto the base entry's own  megas[]  array (official_mega / official_mega_x / ...),
//             each with its Mega Stone as activation.requiredItem. Primal Reversion (Groudon/Kyogre) uses the
//             Red/Blue Orb; Mega Rayquaza uses the "knows Dragon Ascent" trigger.
//  Everyone (not just admins) loads the official items at startup via loadOfficialItems(), version-gated with a
//  localStorage cache so a normal page view costs 1 read instead of ~1,000.
//
//  Real enforcement is in firestore.rules (official docs are admin-only); the UI checks are convenience.
// ============================================================

import { db } from "./firebase-config.js";
import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { applyAbilityRules } from "./official-abilities.js";
import { API, getJson, pool, titleCase, en, clean, isAdmin, KNOWN_TYPES, docIdFor, STAT_MAP } from "./official-import.js";

const ITEM_CACHE_KEY = "fandex_official_items_v1";
const META_REF = () => doc(db, "meta", "officialItems");
const slugName = n => String(n || "").toLowerCase().replace(/[^a-z0-9]+/g, "") || "item"; // same recipe as the Item form's slugify()

// Categories skipped by default (TMs/HMs are covered by the Move Dex; the rest don't do anything in a dex/battle sim).
const SKIP_CATEGORIES = new Set(["all-machines", "unused", "plot-advancement", "event-items", "gameplay", "all-mail", "data-cards",
  "tm-materials", "picnic", "sandwich-ingredients", "curry-ingredients", "dex-completion", "miracle-shooter", "apricorn-box"]);

// ---------- items that map onto REAL engine mechanics (engine.js effect actions); everything else is imported as text ----------
const fx = (trigger, action, value, extra) => Object.assign({ trigger, action, value, filterKind: "none", filterValue: "", priority: 0 }, extra || {});
const TYPE_ITEMS = {
  // +20% damage for one type (same shape as the engine's Fire Gem, but permanent)
  charcoal: "fire", "mystic-water": "water", magnet: "electric", "miracle-seed": "grass", "never-melt-ice": "ice", "black-belt": "fighting",
  "poison-barb": "poison", "soft-sand": "ground", "sharp-beak": "flying", "twisted-spoon": "psychic", "silver-powder": "bug", "hard-stone": "rock",
  "spell-tag": "ghost", "dragon-fang": "dragon", "black-glasses": "dark", "metal-coat": "steel", "silk-scarf": "normal", "fairy-feather": "fairy",
  "sea-incense": "water", "wave-incense": "water", "rock-incense": "rock", "odd-incense": "psychic", "rose-incense": "grass",
  "flame-plate": "fire", "splash-plate": "water", "zap-plate": "electric", "meadow-plate": "grass", "icicle-plate": "ice", "fist-plate": "fighting",
  "toxic-plate": "poison", "earth-plate": "ground", "sky-plate": "flying", "mind-plate": "psychic", "insect-plate": "bug", "stone-plate": "rock",
  "spooky-plate": "ghost", "draco-plate": "dragon", "dread-plate": "dark", "iron-plate": "steel", "pixie-plate": "fairy"
};
const MECHANICS = {
  "leftovers":     { type: "held", maxUses: 0, effects: [fx("turnEnd", "heal", 1 / 16)] },
  "focus-sash":    { type: "held", maxUses: 1, effects: [fx("onTakeDamage", "preventFaint", 1)] },
  "choice-scarf":  { type: "held", maxUses: 1, effects: [fx("battleStart", "boostStat", 2)] },
  "rocky-helmet":  { type: "held", maxUses: 0, effects: [fx("onTakeDamage", "recoil", 1 / 6, { filterKind: "tag", filterValue: "contact" })] },
  "life-orb":      { type: "held", maxUses: 0, effects: [fx("onDealDamage", "boostDamage", 0.3)] },            // recoil half not modelled
  "sitrus-berry":  { type: "consumable", maxUses: 1, flavor: "Sweet",  effects: [fx("onHpThreshold", "heal", 0.25)] },
  "lum-berry":     { type: "consumable", maxUses: 1, flavor: "Bitter", effects: [fx("onHpThreshold", "cureStatus", 1)] },
  "flame-orb":     { type: "held", maxUses: 1, effects: [fx("battleStart", "none", 0)], statusEffectOnUse: { effect: "burn", chance: 100, target: "self" } },
  "toxic-orb":     { type: "held", maxUses: 1, effects: [fx("battleStart", "none", 0)], statusEffectOnUse: { effect: "badlyPoisoned", chance: 100, target: "self" } }
};
function mechanicsFor(name) {
  if (MECHANICS[name]) return MECHANICS[name];
  if (TYPE_ITEMS[name]) return { type: "held", maxUses: 0, effects: [fx("onDealDamage", "boostDamage", 0.2, { filterKind: "type", filterValue: TYPE_ITEMS[name] })] };
  const g = name.match(/^([a-z]+)-gem$/);
  if (g && KNOWN_TYPES().includes(g[1])) return { type: "consumable", maxUses: 1, effects: [fx("onDealDamage", "boostDamage", 0.3, { filterKind: "type", filterValue: g[1] })] };
  return null;
}

function mapItem(api, id, categoryName) {
  const nameObj = en(api.names);
  const eff = en(api.effect_entries);
  const attrs = (api.attributes || []).map(a => a.name);
  const name = nameObj ? nameObj.name : titleCase(api.name);
  const desc = clean(eff ? (eff.short_effect || eff.effect) : (en(api.flavor_text_entries) || {}).flavor_text) || name;
  const mech = mechanicsFor(api.name);
  const consumable = attrs.includes("consumable");
  const it = {
    id, name,
    type: mech ? mech.type : (consumable ? "consumable" : "held"),
    maxUses: mech ? mech.maxUses : (consumable ? 1 : 0),
    desc,
    effects: mech ? mech.effects.map(e => ({ ...e })) : [fx("battleStart", "none", 0)],
    imageUrl: (api.sprites && api.sprites.default) || "",
    itemCategory: categoryName || (api.category && api.category.name) || "",
    official: true, source: "pokeapi", apiName: api.name
  };
  if (mech && mech.flavor) it.flavor = mech.flavor;
  if (mech && mech.statusEffectOnUse) it.statusEffectOnUse = { ...mech.statusEffectOnUse };
  return it;
}
function toItemPayload(it) {
  const copy = JSON.parse(JSON.stringify(it));
  const n = (typeof window.normalizeItem === "function") ? window.normalizeItem(copy) : copy; // fills every field the engine expects
  return JSON.parse(JSON.stringify(n));
}

// ---------- everyone: load official items into the Item Dex ----------
function mergeOfficialItems(list) {
  if (typeof items === "undefined") return 0;
  let n = 0;
  list.forEach(raw => {
    const k = items.findIndex(x => x.id === raw.id);
    if (k > -1 && !items[k].official) return;               // never replace an item someone hand-built (e.g. your own Leftovers)
    const it = (typeof window.normalizeItem === "function") ? window.normalizeItem({ ...raw }) : { ...raw };
    if (k > -1) items[k] = it; else items.push(it);
    n++;
  });
  return n;
}
function refreshItemViews() {
  if (typeof renderItemGrid === "function") try { renderItemGrid(); } catch (e) {}
  if (typeof populateItemSelects === "function") try { populateItemSelects(); } catch (e) {}
}
async function loadOfficialItems() {
  try {
    let ver = null;
    try { const m = await getDoc(META_REF()); ver = m.exists() ? m.data().version : null; } catch (e) {}
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem(ITEM_CACHE_KEY) || "null"); } catch (e) {}
    let list;
    if (ver != null && cached && cached.version === ver && Array.isArray(cached.items)) list = cached.items;
    else {
      const snap = await getDocs(query(collection(db, "items"), where("official", "==", true)));
      list = snap.docs.map(d => { const o = { ...d.data(), firestoreId: d.id }; delete o.createdAt; return o; });
      try { localStorage.setItem(ITEM_CACHE_KEY, JSON.stringify({ version: ver, items: list })); } catch (e) {}
    }
    if (mergeOfficialItems(list)) refreshItemViews();
  } catch (e) { console.error("❌ Failed to load official items:", e); }
}
async function bumpVersion() { await setDoc(META_REF(), { version: Date.now() }); }

// ---------- admin: import items ----------
async function importItems({ includeAll, dryRun, overwrite, log, progress }) {
  if (!isAdmin() || !window.currentUser) throw new Error("Admin login required.");
  const uid = window.currentUser.uid;

  progress("Reading item categories…");
  const cats = await getJson(`${API}/item-category?limit=200`);
  const chosen = cats.results.filter(c => includeAll || !SKIP_CATEGORIES.has(c.name));
  log(`${chosen.length} categories selected${includeAll ? " (ALL, incl. TMs/key items)" : ""}.`);

  const itemRefs = new Map(); // api name -> { url, category }
  let c = 0;
  await pool(chosen, 6, async cat => {
    const d = await getJson(cat.url);
    d.items.forEach(i => { if (!itemRefs.has(i.name)) itemRefs.set(i.name, { url: i.url, category: d.name }); });
    progress(`Reading categories… ${++c}/${chosen.length}`);
  });
  log(`${itemRefs.size} items to fetch.`);

  const failed = [], built = [], usedIds = new Set();
  let n = 0;
  const refs = [...itemRefs.entries()];
  const fetched = {};
  await pool(refs, 8, async ([name, ref]) => {
    try { fetched[name] = await getJson(ref.url); } catch (e) { failed.push(`${name}: ${e.message}`); }
    progress(`Fetching items… ${++n}/${refs.length}`);
  });
  // stable ids: sort by PokéAPI id so re-runs produce identical slugs
  Object.values(fetched).sort((a, b) => a.id - b.id).forEach(api => {
    let id = slugName((en(api.names) || {}).name || titleCase(api.name)), k = 1; const base = id;
    while (usedIds.has(id)) id = base + (++k);
    usedIds.add(id);
    built.push(mapItem(api, id, itemRefs.get(api.name).category));
  });
  const mech = built.filter(i => i.effects.some(e => e.action !== "none") || i.statusEffectOnUse).length;
  log(`Built ${built.length} items (${mech} with real battle mechanics, the rest are text-only).`);
  if (dryRun) { log("DRY RUN — nothing written."); if (failed.length) log("⚠ " + failed.join("; ")); return; }

  const existing = new Set((await getDocs(query(collection(db, "items"), where("official", "==", true)))).docs.map(d => d.id));
  let written = 0, skipped = 0, i = 0;
  await pool(built, 6, async it => {
    const docId = "official-" + it.apiName;
    try {
      if (existing.has(docId) && !overwrite) skipped++;
      else {
        await setDoc(doc(db, "items", docId), { ...toItemPayload(it), creatorUid: uid, creatorName: (window.userProfile && window.userProfile.displayName) || "Admin", createdAt: serverTimestamp() });
        written++;
      }
    } catch (e) { failed.push(`write ${it.apiName}: ${e.message}`); }
    progress(`Saving items… ${++i}/${built.length}`);
  });
  await bumpVersion();
  try { localStorage.removeItem(ITEM_CACHE_KEY); } catch (e) {}
  await loadOfficialItems();
  log(`Done. Written: ${written}, skipped (already existed): ${skipped}.`);
  const kept = built.filter(b => typeof items !== "undefined" && items.some(x => x.id === b.id && !x.official)).map(b => b.name);
  if (kept.length) log(`Your own hand-built versions stay active for: ${kept.join(", ")}`);
  if (failed.length) log(`⚠ ${failed.length} problem(s):\n  ` + failed.join("\n  "));
}

async function deleteAllOfficialItems(log, progress) {
  if (!isAdmin()) throw new Error("Admin login required.");
  const snap = await getDocs(query(collection(db, "items"), where("official", "==", true)));
  let i = 0;
  await pool(snap.docs, 6, async d => { await deleteDoc(d.ref); progress(`Deleting… ${++i}/${snap.size}`); });
  await bumpVersion();
  try { localStorage.removeItem(ITEM_CACHE_KEY); } catch (e) {}
  if (typeof items !== "undefined") for (let k = items.length - 1; k >= 0; k--) if (items[k].official) items.splice(k, 1);
  refreshItemViews();
  log(`Deleted ${snap.size} official items.`);
}

// ============================================================
// MEGAS
// ============================================================
const MEGA_RE = /^([a-z0-9-]+?)-(mega(?:-[xyz])?|primal)$/;
const prefixLen = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };

// Which Mega Stone belongs to "venusaur-mega" / "charizard-mega-x"? Match on the longest shared name prefix (+ the X/Y/Z suffix).
function matchStone(base, suffix, stones) {
  let best = null, bestLen = 0;
  stones.forEach(st => {
    const m = st.match(/^(.*?)(?:-([xyz]))?$/), stem = m[1], sfx = m[2] || "";
    if (sfx !== suffix) return;
    const len = prefixLen(stem, base);
    if (len > bestLen) { best = st; bestLen = len; }
  });
  return bestLen >= 4 ? best : null;
}

function statsOf(pokemon) {
  const st = {}; pokemon.stats.forEach(s => { const k = STAT_MAP[s.stat.name]; if (k) st[k] = s.base_stat; }); return st;
}
async function abilityOf(pokemon) {
  const a = pokemon.abilities.slice().sort((x, y) => x.slot - y.slot).find(x => !x.is_hidden) || pokemon.abilities[0];
  if (!a) return null;
  const ad = await getJson(a.ability.url);
  const eff = en(ad.effect_entries);
  return applyAbilityRules({ name: (en(ad.names) || {}).name || titleCase(a.ability.name), desc: clean(eff ? (eff.short_effect || eff.effect) : ""), hidden: false });
}

async function importMegas({ dryRun, log, progress }) {
  if (!isAdmin() || !window.currentUser) throw new Error("Admin login required.");
  const uid = window.currentUser.uid;

  progress("Discovering Mega forms…");
  const list = await getJson(`${API}/pokemon?limit=3000`);
  const forms = list.results.map(r => ({ api: r.name, m: r.name.match(MEGA_RE) })).filter(x => x.m);
  log(`Found ${forms.length} Mega / Primal forms on PokéAPI.`);

  const stoneCat = await getJson(`${API}/item-category/mega-stones`);
  const stoneNames = stoneCat.items.map(i => i.name);

  // group by base species dex number
  const byDex = {}; const problems = [];
  let n = 0;
  await pool(forms, 6, async f => {
    try {
      const pokemon = await getJson(`${API}/pokemon/${f.api}`);
      const species = await getJson(pokemon.species.url);
      const dex = species.id, baseSlug = f.m[1], kind = f.m[2];
      const suffix = (kind.match(/-([xyz])$/) || [])[1] || "";
      let stone = null, requirement = "heldStone", triggerMoveName = "";
      if (kind === "primal") stone = baseSlug === "groudon" ? "red-orb" : baseSlug === "kyogre" ? "blue-orb" : null;
      else if (baseSlug === "rayquaza") { requirement = "triggerMove"; triggerMoveName = "Dragon Ascent"; }
      else stone = matchStone(baseSlug, suffix, stoneNames);
      if (!stone && requirement === "heldStone") problems.push(`No Mega Stone matched for ${f.api} — profile imported without an item requirement.`);
      (byDex[dex] = byDex[dex] || []).push({ api: f.api, kind, suffix, pokemon, species, stone, requirement, triggerMoveName });
    } catch (e) { problems.push(`${f.api}: ${e.message}`); }
    progress(`Reading Mega forms… ${++n}/${forms.length}`);
  });

  // stones -> item ids (and make sure the stone item docs exist)
  const stoneIds = {};
  const stoneApis = [...new Set(Object.values(byDex).flat().map(x => x.stone).filter(Boolean))];
  const stoneData = {};
  await pool(stoneApis, 6, async s => { stoneData[s] = await getJson(`${API}/item/${s}`); });
  const usedIds = new Set(); // slugs derived from English names; collisions with other items are resolved at items-import time using PokéAPI order
  stoneApis.forEach(s => { stoneIds[s] = slugName((en(stoneData[s].names) || {}).name || titleCase(s)); usedIds.add(stoneIds[s]); });

  const report = []; let written = 0, skippedBase = [];
  const dexList = Object.keys(byDex).map(Number).sort((a, b) => a - b);
  let k = 0;
  for (const dex of dexList) {
    progress(`Writing Megas… ${++k}/${dexList.length}`);
    const baseRef = doc(db, "entries", docIdFor(dex));
    const baseSnap = await getDoc(baseRef);
    const baseName = (en(byDex[dex][0].species.names) || {}).name || titleCase(byDex[dex][0].species.name);
    if (!baseSnap.exists()) { skippedBase.push(baseName); continue; }

    const profiles = [];
    for (const f of byDex[dex]) {
      const art = (f.pokemon.sprites.other && f.pokemon.sprites.other["official-artwork"]) || {};
      const label = f.kind === "primal" ? `Primal ${baseName}` : `Mega ${baseName}${f.suffix ? " " + f.suffix.toUpperCase() : ""}`;
      const types = f.pokemon.types.slice().sort((a, b) => a.slot - b.slot).map(t => t.type.name).filter(t => KNOWN_TYPES().includes(t));
      const stoneName = f.stone ? (en(stoneData[f.stone].names) || {}).name || titleCase(f.stone) : "";
      profiles.push({
        id: "official_" + (f.kind === "primal" ? "primal" : "mega" + (f.suffix ? "_" + f.suffix : "")),
        enabled: true, name: label,
        transformVerb: f.kind === "primal" ? "undergoes Primal Reversion into" : "Mega Evolves into",
        kind: f.kind === "primal" ? "other" : "mega",
        emoji: f.kind === "primal" ? "🌋" : "💠",
        types, stats: statsOf(f.pokemon),
        ability: await abilityOf(f.pokemon),
        moves: [],
        desc: f.kind === "primal" ? `${baseName} reverted to its Primal form by the power of the ${stoneName}.`
          : f.requirement === "triggerMove" ? `${baseName} Mega Evolves after using ${f.triggerMoveName}.`
          : `${baseName} Mega Evolves while holding ${stoneName || "its Mega Stone"}.`,
        images: { pixel: f.pokemon.sprites.front_default || "", pixelShiny: f.pokemon.sprites.front_shiny || "",
                  artwork: art.front_default || "", artworkShiny: art.front_shiny || "", focus: {} },
        imageUrl: art.front_default || "",
        activation: { requirement: f.requirement, triggerMoveName: f.triggerMoveName, triggerLabel: "", turnThreshold: 3,
                      requiredItem: f.stone ? stoneIds[f.stone] : "" },
        durationLimit: 0, reuseCooldown: 0
      });
    }
    report.push(`${baseName}: ${profiles.map(p => p.name).join(", ")}`);
    if (dryRun) continue;

    const data = baseSnap.data();
    const kept = (data.megas || []).filter(m => !/^official_(mega|primal)/.test(String(m.id || ""))); // keeps hand-made AND Dynamax/G-Max profiles
    // Megas drop base-movepool moves unless flagged megaUsable (engine.js), so flag the official movepool.
    const moves = (data.moves || []).map(m => ({ ...m, megaUsable: true }));
    // Mega Rayquaza triggers off knowing Dragon Ascent
    if (profiles.some(p => p.activation.requirement === "triggerMove") && !moves.some(m => m.name === "Dragon Ascent")) {
      try {
        const mv = await getJson(`${API}/move/dragon-ascent`);
        const mm = window.OfficialImport.mapMove(mv, 1, { fixedDamage: new Set(), partial: new Set() });
        moves.push({ ...mm, megaUsable: true });
        report.push("Added Dragon Ascent to Rayquaza's movepool (needed as its Mega trigger).");
      } catch (e) { problems.push("dragon-ascent: " + e.message); }
    }
    const payload = JSON.parse(JSON.stringify({ megas: [...kept, ...profiles], moves }));
    await updateDoc(baseRef, payload);
    written++;
    const live = (window.entries || []).find(x => x.firestoreId === docIdFor(dex));
    if (live) Object.assign(live, payload);
  }

  // make sure every referenced stone/orb exists as an item doc
  if (!dryRun) {
    for (const s of stoneApis) {
      const ref = doc(db, "items", "official-" + s);
      const snap = await getDoc(ref);
      if (!snap.exists()) {
        const it = mapItem(stoneData[s], stoneIds[s], s.endsWith("orb") ? "held-items" : "mega-stones");
        await setDoc(ref, { ...toItemPayload(it), creatorUid: uid, creatorName: (window.userProfile && window.userProfile.displayName) || "Admin", createdAt: serverTimestamp() });
        log(`Added missing item: ${it.name}`);
      }
    }
    await bumpVersion(); try { localStorage.removeItem(ITEM_CACHE_KEY); } catch (e) {}
    await loadOfficialItems();
    if (typeof window.renderAll === "function") window.renderAll();
  }
  report.forEach(r => log("  " + r));
  log(dryRun ? `DRY RUN — ${dexList.length - skippedBase.length} base entries would get Megas.` : `Done. Megas written onto ${written} base entries.`);
  if (skippedBase.length) log(`Skipped (base entry not imported yet — import its region, then run this again): ${skippedBase.join(", ")}`);
  if (problems.length) log(`⚠ ${problems.length} problem(s):\n  ` + problems.join("\n  "));
}

// ============================================================
// DYNAMAX + GIGANTAMAX — triggered by the "Wishing Star" held item (the same way a Mega Stone triggers a Mega).
//   * Dynamax: 3 turns, once per battle, HP x2 and a big stat boost, and EVERY move becomes a Max Move of its type.
//   * Gigantamax: same, for Pokémon that have a G-Max form: its own artwork and its G-Max signature move.
// Needs engine.js's maxMoves / hpMultiplier support (see the patched engine.js).
// ============================================================
const DYNAMAX_BOOST = { hp: 2, atk: 1.5, def: 1.5, spa: 1.5, spd: 1.5, spe: 1.25 };   // tweak to taste
const DYNAMAX_TURNS = 3;
const WISHING_STAR_ID = "wishingstar";
const NO_DYNAMAX_DEX = new Set([888, 889, 890]);                                      // Zacian, Zamazenta, Eternatus
const statmod = (target, statKey, statStage) => ({ type: "statmod", chance: 100, target, statKey, statStage });
const MAX_MOVES = {
  normal:   { name: "Max Strike",     effects: [statmod("opponent", "spe", -1)] },
  fire:     { name: "Max Flare",      weather: "sun" },
  water:    { name: "Max Geyser",     weather: "rain" },
  electric: { name: "Max Lightning",  field: "electric" },
  grass:    { name: "Max Overgrowth", field: "grassy" },
  ice:      { name: "Max Hailstorm",  weather: "snow" },
  fighting: { name: "Max Knuckle",    effects: [statmod("self", "atk", 1)] },
  poison:   { name: "Max Ooze",       effects: [statmod("self", "spa", 1)] },
  ground:   { name: "Max Quake",      effects: [statmod("self", "spd", 1)] },
  flying:   { name: "Max Airstream",  effects: [statmod("self", "spe", 1)] },
  psychic:  { name: "Max Mindstorm",  field: "psychic" },
  bug:      { name: "Max Flutterby",  effects: [statmod("opponent", "spa", -1)] },
  rock:     { name: "Max Rockfall",   weather: "sand" },
  ghost:    { name: "Max Phantasm",   effects: [statmod("opponent", "def", -1)] },
  dragon:   { name: "Max Wyrmwind",   effects: [statmod("opponent", "atk", -1)] },
  dark:     { name: "Max Darkness",   effects: [statmod("opponent", "spd", -1)] },
  steel:    { name: "Max Steelspike", effects: [statmod("self", "def", 1)] },
  fairy:    { name: "Max Starfall",   field: "misty" }
};
// PokéAPI pokemon name (minus "-gmax") -> its G-Max signature move
const GMAX_MOVES = {
  venusaur: "g-max-vine-lash", charizard: "g-max-wildfire", blastoise: "g-max-cannonade", butterfree: "g-max-befuddle", pikachu: "g-max-volt-crash",
  meowth: "g-max-gold-rush", machamp: "g-max-chi-strike", gengar: "g-max-terror", kingler: "g-max-foam-burst", lapras: "g-max-resonance",
  eevee: "g-max-cuddle", snorlax: "g-max-replenish", garbodor: "g-max-malodor", melmetal: "g-max-meltdown", rillaboom: "g-max-drum-solo",
  cinderace: "g-max-fireball", inteleon: "g-max-hydrosnipe", corviknight: "g-max-wind-rage", orbeetle: "g-max-gravitas", drednaw: "g-max-stonesurge",
  coalossal: "g-max-volcalith", flapple: "g-max-tartness", appletun: "g-max-sweetness", sandaconda: "g-max-sandblast", "toxtricity-amped": "g-max-stun-shock",
  centiskorch: "g-max-centiferno", hatterene: "g-max-smite", grimmsnarl: "g-max-snooze", alcremie: "g-max-finale", copperajah: "g-max-steelsurge",
  duraludon: "g-max-depletion", "urshifu-single-strike": "g-max-one-blow"
};
// Official Max Move power from the source move's base power (Fighting/Poison use the lower table)
function maxBp(bp, type) {
  const low = type === "fighting" || type === "poison";
  const tiers = [[40, 90, 70], [50, 100, 75], [60, 110, 80], [70, 120, 85], [110, 130, 90], [140, 140, 95], [Infinity, 150, 100]];
  for (const [lim, hi, lo] of tiers) if (bp <= lim) return low ? lo : hi;
  return 150;
}
const normMove = m => JSON.parse(JSON.stringify(typeof window.normalizeMove === "function" ? window.normalizeMove(m) : m));

/** One Max Move per type the Pokémon has a damaging move of (status moves have no Max form here). gmax = {name, type, desc} or null. */
function buildMaxKit(moves, gmax) {
  const byType = {};
  (moves || []).forEach(m => {
    if (!m || !m.name || m.category === "Status" || !(m.basePower > 0) || !MAX_MOVES[m.type]) return;
    const t = byType[m.type] = byType[m.type] || { bp: 0, phys: 0, spec: 0, pp: 0 };
    t.bp = Math.max(t.bp, m.basePower); t.pp = Math.max(t.pp, m.maxPP || 0);
    if (m.category === "Physical") t.phys += m.basePower; else t.spec += m.basePower;
  });
  const kit0 = Object.entries(byType).map(([type, t]) => {
    const def = MAX_MOVES[type], isG = !!(gmax && gmax.type === type);
    const mv = {
      name: isG ? gmax.name : def.name, type, category: t.phys >= t.spec ? "Physical" : "Special",
      basePower: isG ? 150 : maxBp(t.bp, type), accuracy: 1, maxPP: t.pp || 10, pp: t.pp || 10, priority: 0,
      desc: isG ? (gmax.desc || "G-Max Move.") : `Max Move: the ${titleCase(type)}-type Max Move.${def.weather ? " Sets " + def.weather + "." : ""}${def.field ? " Sets " + def.field + " terrain." : ""}`,
      tags: ["max"], effects: (def.effects || []).map(e => ({ ...e }))
    };
    if (!isG && def.weather) { mv.setsWeather = true; mv.weather = def.weather; mv.weatherDuration = 5; }
    if (!isG && def.field) { mv.setsField = true; mv.field = def.field; mv.fieldDuration = 5; }
    return normMove(mv);
  });
  // status moves become Max Guard (a protect stance, +3 priority), once
  if ((moves || []).some(m => m && m.name && m.category === "Status")) {
    kit0.push(normMove({ name: "Max Guard", type: "normal", category: "Status", basePower: 0, accuracy: 1, maxPP: 10, pp: 10, priority: 3,
      desc: "Max Move: protects the user from every attack this turn.", tags: ["max", "Defending"],
      effects: [{ type: "shield", chance: 100, target: "self", shieldHitCapacity: 99, shieldDuration: 1, shieldTriggerType: "any", shieldTypeFilter: "any", shieldReaction: "none" }] }));
  }
  return kit0;
}
function boostedStats(stats) {
  const out = {};
  Object.keys(DYNAMAX_BOOST).forEach(k => { out[k] = Math.round((Number(stats && stats[k]) || 50) * DYNAMAX_BOOST[k]); });
  return out;
}

async function importDynamax({ dryRun, log, progress }) {
  if (!isAdmin() || !window.currentUser) throw new Error("Admin login required.");
  const uid = window.currentUser.uid;

  // ---- 1. G-Max forms ----
  progress("Discovering Gigantamax forms…");
  const list = await getJson(`${API}/pokemon?limit=3000`);
  const gNames = list.results.map(r => r.name).filter(n => /-gmax$/.test(n) && !/eternamax/.test(n));
  const gBySpecies = {}; const problems = [];
  let n = 0;
  await pool(gNames, 6, async name => {
    try {
      const key = name.replace(/-gmax$/, "");
      const pokemon = await getJson(`${API}/pokemon/${name}`);
      const species = await getJson(pokemon.species.url);
      if (gBySpecies[species.id]) return;                                   // e.g. Urshifu / Toxtricity: first variant wins
      const mvName = GMAX_MOVES[key];
      let move = null;
      if (mvName) { try { const api = await getJson(`${API}/move/${mvName}`); move = { name: (en(api.names) || {}).name || titleCase(mvName), type: api.type.name, desc: clean((en(api.effect_entries) || {}).short_effect || (en(api.flavor_text_entries) || {}).flavor_text) }; } catch (e) { problems.push(`${mvName}: ${e.message}`); } }
      else problems.push(`No G-Max signature move known for ${name} — it gets Max Moves only.`);
      gBySpecies[species.id] = { name, pokemon, species, move };
    } catch (e) { problems.push(`${name}: ${e.message}`); }
    progress(`Reading Gigantamax forms… ${++n}/${gNames.length}`);
  });
  log(`${Object.keys(gBySpecies).length} Gigantamax species found.`);

  // ---- 2. the Wishing Star item ----
  if (!dryRun) {
    const star = toItemPayload({
      id: WISHING_STAR_ID, name: "Wishing Star", type: "held", maxUses: 0,
      desc: `Lets the holder Dynamax (or Gigantamax) once per battle: ${DYNAMAX_TURNS} turns of huge stats, doubled HP, and every move becomes a Max Move.`,
      effects: [fx("battleStart", "none", 0)], official: true, source: "custom", apiName: "wishing-star", itemCategory: "dynamax"
    });
    await setDoc(doc(db, "items", "official-wishing-star"), { ...star, creatorUid: uid, creatorName: (window.userProfile && window.userProfile.displayName) || "Admin", createdAt: serverTimestamp() });
    await bumpVersion(); try { localStorage.removeItem(ITEM_CACHE_KEY); } catch (e) {}
    await loadOfficialItems();
    log("Wishing Star item saved.");
  }

  // ---- 3. profiles onto every official entry ----
  progress("Reading official entries…");
  const snap = await getDocs(collection(db, "entries"));
  const docs = snap.docs.filter(d => /^official-(\d+|form-.+)$/.test(d.id));
  let dyn = 0, gmx = 0, skipped = 0, i = 0; const live = window.entries || [];
  for (const d of docs) {
    progress(`Writing Dynamax profiles… ${++i}/${docs.length}`);
    const data = d.data(); const dex = data.nationalDex;
    if (NO_DYNAMAX_DEX.has(dex)) { skipped++; continue; }
    const g = !data.isRegionalForm ? gBySpecies[dex] : null;
    const gmaxMove = g && g.move ? g.move : null;
    const kit = buildMaxKit(data.moves, gmaxMove);
    if (!kit.length) { skipped++; log(`  skipped ${data.name}: no moves to convert`); continue; }
    const act = { requirement: "heldStone", triggerMoveName: "", triggerLabel: "", turnThreshold: 3, requiredItem: WISHING_STAR_ID };
    let profile;
    if (g) {
      const art = (g.pokemon.sprites.other && g.pokemon.sprites.other["official-artwork"]) || {};
      profile = { id: "official_gmax", enabled: true, name: `Gigantamax ${data.name}`, transformVerb: "Gigantamaxes into", kind: "dynamax", emoji: "🌟",
        types: null, stats: boostedStats(data.stats), ability: null, moves: kit,
        desc: `${data.name} Gigantamaxes: ${DYNAMAX_TURNS} turns of enormous power. Its moves become Max Moves${gmaxMove ? ", and its " + gmaxMove.type + " Max Move becomes " + gmaxMove.name : ""}.`,
        images: { pixel: g.pokemon.sprites.front_default || "", pixelShiny: g.pokemon.sprites.front_shiny || "", artwork: art.front_default || "", artworkShiny: art.front_shiny || "", focus: {} },
        imageUrl: art.front_default || "", maxMoves: true, hpMultiplier: DYNAMAX_BOOST.hp, activation: act, durationLimit: DYNAMAX_TURNS, reuseCooldown: 0 };
      gmx++;
    } else {
      profile = { id: "official_dynamax", enabled: true, name: `Dynamax ${data.name}`, transformVerb: "Dynamaxes into", kind: "dynamax", emoji: "⭐",
        types: null, stats: boostedStats(data.stats), ability: null, moves: kit,
        desc: `${data.name} Dynamaxes: ${DYNAMAX_TURNS} turns of enormous power. Its moves become Max Moves.`,
        images: null, imageUrl: "", maxMoves: true, hpMultiplier: DYNAMAX_BOOST.hp, activation: act, durationLimit: DYNAMAX_TURNS, reuseCooldown: 0 };
      dyn++;
    }
    if (dryRun) continue;
    const megas = (data.megas || []).filter(m => !/^official_(dynamax|gmax)$/.test(String(m.id || ""))).concat([JSON.parse(JSON.stringify(profile))]);
    try {
      await updateDoc(d.ref, { megas });
      const k = live.findIndex(x => x.firestoreId === d.id); if (k > -1) live[k].megas = megas;
    } catch (e) { problems.push(`${d.id}: ${e.message}`); }
  }
  if (!dryRun && typeof window.renderAll === "function") window.renderAll();
  log(dryRun ? `DRY RUN — would add ${dyn} Dynamax and ${gmx} Gigantamax profiles (${skipped} skipped).`
             : `Done. ${dyn} Dynamax and ${gmx} Gigantamax profiles written (${skipped} skipped).`);
  if (problems.length) log(`⚠ ${problems.length} problem(s):\n  ` + problems.join("\n  "));
}

// ---------- admin panel ----------
function mountPanel() {
  const host = document.getElementById("view-settings");
  if (!host || document.getElementById("officialItemsPanel")) return;
  const style = document.createElement("style");
  style.textContent = `#officialItemsPanel{display:none !important}
    body.is-admin #officialItemsPanel{display:block !important}
    #officialItemsPanel{margin-top:24px;padding:16px;border:1px solid rgba(128,128,128,.4);border-radius:12px}
    #officialItemsPanel .oi-row{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:8px 0}
    #officialItemsPanel pre{max-height:260px;overflow:auto;white-space:pre-wrap;font-size:12px;padding:8px;border:1px solid rgba(128,128,128,.3);border-radius:8px}`;
  document.head.appendChild(style);
  const panel = document.createElement("section");
  panel.id = "officialItemsPanel";
  panel.innerHTML = `
    <h3 style="margin-top:0">🎒 Official Items, Mega Stones &amp; Megas <small style="font-weight:400;opacity:.7">(admin only · PokéAPI)</small></h3>
    <p style="opacity:.8;font-size:13px;margin:0 0 8px">Items import first (Mega Stones are part of them). Then import Megas: it finds every Mega/Primal form, attaches it to its base entry (import the base's region first) and ties it to its stone. Safe to re-run.</p>
    <div class="oi-row">
      <label><input id="oiiDry" type="checkbox" checked> Dry run</label>
      <label><input id="oiiOverwrite" type="checkbox"> Overwrite existing official items</label>
      <label title="Adds TM/HM discs, key items, event items, mail etc. (1,000+ extra docs)"><input id="oiiAll" type="checkbox"> Include TMs, key &amp; event items</label>
    </div>
    <div class="oi-row">
      <button type="button" id="oiiItems">1 · Import items</button>
      <button type="button" id="oiiMegas">2 · Import Megas</button>
      <button type="button" id="oiiDyna" title="Adds the Wishing Star item and a Dynamax (or Gigantamax) profile to every official entry">3 · Dynamax &amp; Gigantamax</button>
      <button type="button" id="oiiDelete">Delete all official items</button>
      <span id="oiiProgress" style="font-size:13px;opacity:.8"></span>
    </div>
    <pre id="oiiLog">Ready. Start with a dry run.</pre>`;
  host.appendChild(panel);
  const $ = sel => panel.querySelector(sel), logEl = $("#oiiLog");
  const log = m => { logEl.textContent += "\n" + m; logEl.scrollTop = logEl.scrollHeight; };
  const progress = m => { $("#oiiProgress").textContent = m; };
  const lock = on => panel.querySelectorAll("button,input").forEach(e => e.disabled = on);
  const run = async (label, fn, needConfirm) => {
    const dry = $("#oiiDry").checked;
    if (needConfirm && !dry && !confirm(`${label}: write to the live database?`)) return;
    logEl.textContent = `${label}${dry ? " (dry run)" : ""}…`; lock(true);
    try { await fn(dry); } catch (e) { console.error(e); log("❌ " + e.message); } finally { lock(false); progress(""); }
  };
  $("#oiiItems").addEventListener("click", () => run("Import items", dry => importItems({ includeAll: $("#oiiAll").checked, dryRun: dry, overwrite: $("#oiiOverwrite").checked, log, progress }), true));
  $("#oiiMegas").addEventListener("click", () => run("Import Megas", dry => importMegas({ dryRun: dry, log, progress }), true));
  $("#oiiDyna").addEventListener("click", () => run("Import Dynamax & Gigantamax", dry => importDynamax({ dryRun: dry, log, progress }), true));
  $("#oiiDelete").addEventListener("click", async () => {
    if (!confirm("Delete ALL official items (including any admin edits)? Mega profiles will point at missing stones until you re-import.")) return;
    lock(true); try { await deleteAllOfficialItems(log, progress); } catch (e) { log("❌ " + e.message); } finally { lock(false); progress(""); }
  });
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountPanel); else mountPanel();

loadOfficialItems(); // everyone, every page load (1 read when the cache is current)

window.OfficialItems = { mapItem, mechanicsFor, matchStone, MEGA_RE, loadOfficialItems, maxBp, buildMaxKit, boostedStats, MAX_MOVES };