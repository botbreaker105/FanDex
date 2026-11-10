"use strict";

// ============================================================
// OFFICIAL POKÉMON IMPORTER (admin only) — pulls real data from PokéAPI
// (https://pokeapi.co) and writes it to Firestore as "official" entries.
//
//  * Only visible/usable when document.body has .is-admin (set by main.js)
//    and window.userProfile.isAdmin is true. Real enforcement is in
//    firestore.rules (see firestore-official.rules.txt) — this UI check is
//    just convenience.
//  * Every record is stamped  official:true  +  creatorUid = the admin who
//    imported it, and written under a FIXED doc id (official-0025 = Pikachu),
//    so re-running never creates duplicates.
//  * Existing docs are skipped unless "Overwrite" is ticked, so manual
//    tweaks an admin made later are not clobbered.
//  * Images are never copied: we store PokéAPI's sprite/artwork URLs.
// ============================================================

import { db } from "./firebase-config.js";
import { applyAbilityRules, isRegenerable } from "./official-abilities.js";
import { mapMoveRich, creatureTagsFor, genderPoolFor, slugOfMoveName } from "./official-moves.js";
import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const API = "https://pokeapi.co/api/v2";

// National Dex ranges per region. Only Kanto is meant to be run for now; the rest are here for later.
const REGION_RANGES = {
  Kanto:  [1, 151],   Johto:  [152, 251], Hoenn:  [252, 386],
  Sinnoh: [387, 493], Unova:  [494, 649], Kalos:  [650, 721],
  Alola:  [722, 809], Galar:  [810, 905], Paldea: [906, 1025]
};

// Cartridge info for the Regions tab. Fixed ids (1001+) so every browser agrees on which region an entry belongs to
// (regions used to be per-browser localStorage ids, which can't work for shared official entries).
const REGION_META = {
  Kanto:  { id: 1001, key: "kanto",  color: "Crimson", subtitle: "Generation I · Red / Blue / Yellow" },
  Johto:  { id: 1002, key: "johto",  color: "Amber",   subtitle: "Generation II · Gold / Silver / Crystal" },
  Hoenn:  { id: 1003, key: "hoenn",  color: "Azure",   subtitle: "Generation III · Ruby / Sapphire / Emerald" },
  Sinnoh: { id: 1004, key: "sinnoh", color: "Slate",   subtitle: "Generation IV · Diamond / Pearl / Platinum" },
  Unova:  { id: 1005, key: "unova",  color: "Violet",  subtitle: "Generation V · Black / White" },
  Kalos:  { id: 1006, key: "kalos",  color: "Verdant", subtitle: "Generation VI · X / Y" },
  Alola:  { id: 1007, key: "alola",  color: "Amber",   subtitle: "Generation VII · Sun / Moon" },
  Galar:  { id: 1008, key: "galar",  color: "Azure",   subtitle: "Generation VIII · Sword / Shield" },
  Paldea: { id: 1009, key: "paldea", color: "Crimson", subtitle: "Generation IX · Scarlet / Violet" },
  Hisui:  { id: 1010, key: "hisui",  color: "Verdant", subtitle: "Legends: Arceus · Hisui (regional forms)" } // no Dex range: only used by Hisuian forms
};
const OLD_LOCAL_SUBTITLE = /^Official Pokémon/; // marker of the bare local regions the first version of this importer made

function regionRecord(name, uid) {
  const m = REGION_META[name];
  const palette = (typeof REGION_COLORS !== "undefined") ? REGION_COLORS : [];
  const color = palette.find(c => c.name === m.color) || { name: m.color, base: "#8a93a6", dark: "#454b58" };
  return { id: m.id, name, subtitle: m.subtitle, color, official: true, creatorUid: uid };
}
// Put a region into this browser's live `regions` list (and drop the old importer-made local duplicate of it).
function mergeRegionLocal(r) {
  if (typeof regions === "undefined") return;
  let removed = false;
  for (let i = regions.length - 1; i >= 0; i--) {
    const x = regions[i];
    if (x.id !== r.id && x.name === r.name && OLD_LOCAL_SUBTITLE.test(x.subtitle || "")) { regions.splice(i, 1); removed = true; }
  }
  const k = regions.findIndex(x => x.id === r.id);
  if (k > -1) regions[k] = { ...regions[k], ...r }; else regions.push(r);
  if (removed && typeof saveRegions === "function") saveRegions(regions);
}
function refreshRegionViews() {
  if (typeof refreshRegionSelect === "function") try { refreshRegionSelect(); } catch (e) {}
  if (typeof window.renderAll === "function") window.renderAll();
  if (typeof renderCartridges === "function") try { renderCartridges(); } catch (e) {}
}
async function writeRegionDoc(name, uid) {
  const rec = regionRecord(name, uid);
  const ref = doc(db, "regions", "official-" + REGION_META[name].key);
  const old = await getDoc(ref);
  await setDoc(ref, { ...rec, createdAt: old.exists() && old.data().createdAt ? old.data().createdAt : serverTimestamp() });
  mergeRegionLocal({ ...rec, createdAt: Date.now() });
}
// Runs for EVERYONE at startup: pulls the shared official regions so the Regions tab shows the cartridges.
async function loadOfficialRegions() {
  try {
    const snap = await getDocs(collection(db, "regions"));
    let n = 0;
    snap.forEach(d => {
      const r = d.data();
      if (!r || typeof r.id !== "number" || !r.name) return;
      mergeRegionLocal({ id: r.id, name: r.name, subtitle: r.subtitle || "", color: r.color, official: true,
        createdAt: r.createdAt && r.createdAt.toMillis ? r.createdAt.toMillis() : Date.now() });
      n++;
    });
    if (n) refreshRegionViews();
  } catch (e) { console.error("❌ Failed to load official regions:", e); }
}

// Which game's level-up learnset to use. Red/Blue is the classic Gen 1 list.
const LEARNSET_GROUPS = [
  ["auto", "Auto — each region's own games (Kanto: Red/Blue, Johto: Gold/Silver, Hoenn: Ruby/Sapphire)"],
  ["yellow", "Yellow (Gen 1)"],
  ["crystal", "Crystal (Gen 2)"],
  ["emerald", "Emerald (Gen 3)"],
  ["firered-leafgreen", "FireRed / LeafGreen"],
  ["ultra-sun-ultra-moon", "Ultra Sun / Ultra Moon"]
];
// Preference order for level-up learnsets: the chosen game, then the region's own games, then newer games as a last resort.
const NATIVE_GROUPS = {
  Kanto: ["red-blue", "yellow"], Johto: ["gold-silver", "crystal"], Hoenn: ["ruby-sapphire", "emerald"],
  Sinnoh: ["diamond-pearl", "platinum"], Unova: ["black-white", "black-2-white-2"], Kalos: ["x-y"],
  Alola: ["ultra-sun-ultra-moon", "sun-moon"], Galar: ["sword-shield"], Paldea: ["scarlet-violet"], Hisui: ["legends-arceus"]
};
const FALLBACK_GROUPS = ["lets-go-pikachu-lets-go-eevee", "firered-leafgreen", "heartgold-soulsilver", "emerald", "omega-ruby-alpha-sapphire", "ultra-sun-ultra-moon", "sword-shield", "scarlet-violet"];
function groupOrder(regionName, chosen) {
  const nat = NATIVE_GROUPS[regionName] || [];
  const first = (!chosen || chosen === "auto") ? nat : [chosen, ...nat];
  return { first, all: [...new Set([...first, ...FALLBACK_GROUPS])] };
}
const hasLevelUp = (pokemon, g) => pokemon.moves.some(mv => mv.version_group_details.some(v => v.version_group.name === g && v.move_learn_method.name === "level-up"));
function pickGroup(pokemon, order) { return order.all.find(g => hasLevelUp(pokemon, g)) || null; }

const TYPE_EMOJI = {
  normal:"🐾", fire:"🔥", water:"🌊", electric:"⚡", grass:"🍃", ice:"❄️", fighting:"🥊", poison:"☠️",
  ground:"⛰️", flying:"🐦", psychic:"🔮", bug:"🐛", rock:"🪨", ghost:"👻", dragon:"🐉", dark:"🌑",
  steel:"⚙️", fairy:"✨"
};
const STAT_MAP = { "hp":"hp", "attack":"atk", "defense":"def", "special-attack":"spa", "special-defense":"spd", "speed":"spe" };

// ---------- tiny helpers ----------
const pad4 = n => String(n).padStart(4, "0");
const docIdFor = n => `official-${pad4(n)}`;
const titleCase = s => String(s || "").split("-").map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(" ");
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
// TYPES is a global `const` from common.js (a classic script) — reachable as a bare name, but NOT as window.TYPES.
const KNOWN_TYPES = () => (typeof TYPES !== "undefined" ? TYPES : []);
const isAdmin = () => !!(window.userProfile && window.userProfile.isAdmin);
const en = list => (list || []).find(x => x.language && x.language.name === "en");
const idFromUrl = url => Number(String(url).replace(/\/+$/, "").split("/").pop());
const clean = s => String(s || "").replace(/[\n\f\r\u00ad]+/g, " ").replace(/\s+/g, " ").trim();

const cache = new Map();
async function getJson(url, tries = 4) {
  if (cache.has(url)) return cache.get(url);
  const p = (async () => {
    let lastErr;
    for (let i = 0; i < tries; i++) {
      try {
        const res = await fetch(url);
        if (res.ok) return await res.json();
        if (res.status === 404) throw new Error("404 " + url);
        lastErr = new Error(`HTTP ${res.status} for ${url}`);
      } catch (e) { lastErr = e; if (/^404/.test(e.message)) break; }
      await new Promise(r => setTimeout(r, 500 * (i + 1) ** 2));
    }
    throw lastErr;
  })();
  cache.set(url, p);
  try { return await p; } catch (e) { cache.delete(url); throw e; }
}

async function pool(items, limit, worker) {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await worker(items[idx], idx); }
  });
  await Promise.all(runners);
}

// ---------- mapping: PokéAPI move -> this app's move shape (engine.js normalizeMove) ----------
const STATUS_MAP = { paralysis:"paralysis", burn:"burn", poison:"poison", sleep:"sleep", freeze:"frostbite" };
const MAPPED_STATS = new Set(["atk","def","spa","spd","spe"]);

function mapMoveLegacy(api, level, report) {   // kept for reference; replaced by official-moves.js

  const category = ({ physical:"Physical", special:"Special", status:"Status" })[api.damage_class && api.damage_class.name] || "Status";
  const dealsDamage = category !== "Status";
  const meta = api.meta || {};
  const typeName = api.type && api.type.name;
  const type = KNOWN_TYPES().includes(typeName) ? typeName : "normal";
  const effText = en(api.effect_entries);
  const desc = clean((effText && (effText.short_effect || effText.effect) || "").replace(/\$effect_chance/g, api.effect_chance != null ? api.effect_chance : ""))
    || clean((en(api.flavor_text_entries) || {}).flavor_text);

  const m = {
    name: (en(api.names) || {}).name || titleCase(api.name),
    level: Math.max(1, level || 1),
    type, category, desc,
    accuracy: api.accuracy == null ? 1 : clamp(api.accuracy / 100, 0, 1),
    maxPP: api.pp || 5,
    basePower: dealsDamage ? (api.power || 0) : 0,
    priority: clamp(api.priority || 0, -3, 3),
    effects: [],
    tags: []
  };

  if (dealsDamage && api.power == null && !(meta.category && meta.category.name === "ohko")) {
    report.fixedDamage.add(m.name); // Seismic Toss / Counter / Super Fang... need hand-built mechanics
  }
  if (meta.category && meta.category.name === "ohko") m.ohko = true;
  if (meta.crit_rate > 0) m.critRateMode = "high";
  if (meta.max_hits && meta.max_hits > 1) {
    const lo = meta.min_hits || meta.max_hits;
    m.hits = clamp(Math.floor((lo + meta.max_hits) / 2), 1, 5);
  }
  if (meta.drain < 0) m.recoilPercent = -meta.drain;

  // --- status ailments ---
  const ailName = meta.ailment && meta.ailment.name;
  let status = STATUS_MAP[ailName];
  if (status === "poison" && /^(toxic|poison-fang)$/.test(api.name)) status = "badlyPoisoned";
  if (status) {
    if (category === "Status") {
      m.action = "status"; m.statusEffect = status;
    } else if (meta.ailment_chance > 0) {
      m.effects.push({ type: "status", chance: meta.ailment_chance, target: "opponent", statusEffect: status,
        statusDurationMode: "random", statusDurationMin: 2, statusDurationMax: 4 });
    }
  }
  // --- healing (Recover, Softboiled...) ---
  if (category === "Status" && meta.healing > 0) {
    m.action = "heal"; m.healType = "percent"; m.healValue = meta.healing; m.healTarget = "self";
  }
  // --- stat stage changes (Growl, Swords Dance, Psychic's SpD drop...) ---
  const selfTarget = api.target && api.target.name === "user";
  (api.stat_changes || []).forEach(sc => {
    const key = STAT_MAP[sc.stat && sc.stat.name];
    if (!key || !MAPPED_STATS.has(key) || !sc.change) return;
    m.effects.push({
      type: "statmod", chance: dealsDamage ? (meta.stat_chance || 100) : 100,
      target: selfTarget || (dealsDamage && meta.stat_chance === 0 && sc.change > 0) ? "self" : "opponent",
      statKey: key, statStage: clamp(sc.change, -3, 3)
    });
  });
  if (meta.flinch_chance > 0 || (meta.ailment && ["confusion","trap","leech-seed","infatuation","disable","yawn"].includes(ailName))) {
    report.partial.add(m.name); // flavour text is kept, but that secondary effect isn't auto-mapped
  }
  return m;
}

function mapMove(api, level, report) { return mapMoveRich(api, level, report); }

function rarityFor(species, bst) {
  if (species.is_legendary || species.is_mythical) return "legendary";
  if (bst >= 480) return "rare";
  if (bst >= 380) return "uncommon";
  return "common";
}

function mapEvo(d) {
  if (!d) return { type: "item", value: "Unknown" };
  if (d.min_level) return { type: "level", value: d.min_level };
  if (d.item) return { type: "item", value: titleCase(d.item.name) };           // evolution stones etc.
  const trig = d.trigger && d.trigger.name;
  // everything else (friendship, trades, location/time/move/party conditions...) becomes a readable text rule
  let base;
  if (trig === "trade") base = d.trade_species ? "Trade for " + titleCase(d.trade_species.name) : "Trade";
  else if (trig === "level-up" || !trig) base = "Level up";
  else base = titleCase(trig);
  const bits = [];
  if (d.held_item) bits.push("holding " + titleCase(d.held_item.name));
  if (d.min_happiness) bits.push("with high friendship");
  if (d.min_affection) bits.push("with high affection");
  if (d.min_beauty) bits.push("with high beauty");
  if (d.known_move) bits.push("knowing " + titleCase(d.known_move.name));
  if (d.known_move_type) bits.push("knowing a " + titleCase(d.known_move_type.name) + "-type move");
  if (d.location) bits.push("at " + titleCase(d.location.name));
  if (d.time_of_day) bits.push("during the " + d.time_of_day);
  if (d.party_species) bits.push("with " + titleCase(d.party_species.name) + " in the party");
  if (d.party_type) bits.push("with a " + titleCase(d.party_type.name) + "-type in the party");
  if (d.needs_overworld_rain) bits.push("while it rains");
  if (d.turn_upside_down) bits.push("with the console held upside down");
  if (d.gender === 1) bits.push("(female only)");
  if (d.gender === 2) bits.push("(male only)");
  if (d.relative_physical_stats === 1) bits.push("(Attack > Defense)");
  if (d.relative_physical_stats === -1) bits.push("(Defense > Attack)");
  if (d.relative_physical_stats === 0) bits.push("(Attack = Defense)");
  return { type: "item", value: [base, ...bits].join(" ") };
}

// Walk an evolution chain -> { [dexNumber]: { parent: dexNumber|null, evo } }
function indexChain(node, parent, out) {
  const dex = idFromUrl(node.species.url);
  out[dex] = { parent, evo: parent ? mapEvo((node.evolution_details || [])[0]) : null };
  (node.evolves_to || []).forEach(ch => indexChain(ch, dex, out));
}

// ---------- the import ----------
async function buildEntries({ start, end, group, regionId, regionName, offset, uid, userName, knownDex, log, progress }) {
  const order = groupOrder(regionName, group);
  const isKnown = d => (d >= start && d <= end) || (knownDex && knownDex.has(d)); // in this batch, or already imported earlier
  const report = { fixedDamage: new Set(), partial: new Set(), noEffect: new Set(), noLearnset: [], failed: [] };
  const dexNums = Array.from({ length: end - start + 1 }, (_, i) => start + i);
  const raw = {};                       // dex -> { pokemon, species }
  const chains = new Map();             // chain url -> index

  let done = 0;
  await pool(dexNums, 6, async n => {
    try {
      const [pokemon, species] = await Promise.all([getJson(`${API}/pokemon/${n}`), getJson(`${API}/pokemon-species/${n}`)]);
      raw[n] = { pokemon, species };
      if (!chains.has(species.evolution_chain.url)) {
        const chain = await getJson(species.evolution_chain.url);
        const idx = {}; indexChain(chain.chain, null, idx);
        chains.set(species.evolution_chain.url, idx);
      }
    } catch (e) { report.failed.push(`#${n}: ${e.message}`); }
    progress(`Fetching Pokémon… ${++done}/${dexNums.length}`);
  });

  // unique moves + abilities
  const moveUrls = new Set(), abilityUrls = new Set();
  Object.values(raw).forEach(({ pokemon }) => {
    pokemon.abilities.forEach(a => abilityUrls.add(a.ability.url));
    const g = pickGroup(pokemon, order);
    if (!g) return;
    pokemon.moves.forEach(mv => {
      if (mv.version_group_details.some(v => v.version_group.name === g && v.move_learn_method.name === "level-up")) moveUrls.add(mv.move.url);
    });
  });

  const moveData = {}, abilityData = {};
  let mdone = 0; const mtotal = moveUrls.size + abilityUrls.size;
  await pool([...moveUrls], 6, async url => {
    try { moveData[url] = await getJson(url); } catch (e) { report.failed.push("move " + url + ": " + e.message); }
    progress(`Fetching moves & abilities… ${++mdone}/${mtotal}`);
  });
  await pool([...abilityUrls], 6, async url => {
    try { abilityData[url] = await getJson(url); } catch (e) { report.failed.push("ability " + url + ": " + e.message); }
    progress(`Fetching moves & abilities… ${++mdone}/${mtotal}`);
  });

  const mappedMoveCache = {};
  const entriesOut = [];
  for (const n of dexNums) {
    const r = raw[n]; if (!r) continue;
    const { pokemon, species } = r;

    const stats = {};
    pokemon.stats.forEach(s => { const k = STAT_MAP[s.stat.name]; if (k) stats[k] = s.base_stat; });
    const bst = Object.values(stats).reduce((a, b) => a + b, 0);

    const types = pokemon.types.slice().sort((a, b) => a.slot - b.slot).map(t => t.type.name).filter(t => KNOWN_TYPES().includes(t));
    const nameObj = en(species.names);
    const genus = en(species.genera);
    const flavors = species.flavor_text_entries.filter(f => f.language.name === "en");
    const flavor = flavors.find(f => f.version.name === "firered") || flavors[flavors.length - 1];

    const abilities = pokemon.abilities.slice().sort((a, b) => a.slot - b.slot).map(a => {
      const ad = abilityData[a.ability.url];
      const eff = ad && en(ad.effect_entries);
      const nm = ad && en(ad.names);
      return applyAbilityRules({ name: nm ? nm.name : titleCase(a.ability.name), desc: clean(eff ? (eff.short_effect || eff.effect) : (ad && en(ad.flavor_text_entries) || {}).flavor_text), hidden: !!a.is_hidden });
    });

    const learnFor = g => {
      const list = [];
      pokemon.moves.forEach(mv => {
        const lv = mv.version_group_details.filter(v => v.version_group.name === g && v.move_learn_method.name === "level-up").map(v => v.level_learned_at);
        if (lv.length) list.push({ url: mv.move.url, level: Math.min(...lv) || 1 });
      });
      return list;
    };
    const usedGroup = pickGroup(pokemon, order);
    let learn = usedGroup ? learnFor(usedGroup) : [];
    if (usedGroup && !order.first.includes(usedGroup)) report.noLearnset.push(`${nameObj ? nameObj.name : n} (${usedGroup})`);
    if (!usedGroup) report.noLearnset.push(`${nameObj ? nameObj.name : n} (NO level-up moves found)`);
    learn.sort((a, b) => a.level - b.level);
    const moves = learn.filter(l => moveData[l.url]).map(l => {
      const key = l.url + "@" + l.level;
      return mappedMoveCache[key] || (mappedMoveCache[key] = mapMove(moveData[l.url], l.level, report));
    }).map(m => JSON.parse(JSON.stringify(m)));

    // evolution links (only to species that are in this batch or already imported)
    const idx = chains.get(species.evolution_chain.url) || {};
    const me = idx[n] || { parent: null, evo: null };
    const parentOk = !!(me.parent && isKnown(me.parent));
    const children = Object.entries(idx).filter(([, v]) => v.parent === n).map(([k, v]) => ({ dex: Number(k), evo: v.evo }))
      .filter(c => isKnown(c.dex)).sort((a, b) => a.dex - b.dex);

    const art = pokemon.sprites.other && pokemon.sprites.other["official-artwork"] || {};
    const entry = {
      id: n + offset, regionId, regionName,
      name: nameObj ? nameObj.name : titleCase(pokemon.name),
      category: genus ? genus.genus : "",
      creator: "Pokémon (via PokéAPI)",
      types: types.length ? types : ["normal"],
      icon: TYPE_EMOJI[types[0]] || "🐾", customIconEmoji: "",
      images: { pixel: pokemon.sprites.front_default || "", pixelShiny: pokemon.sprites.front_shiny || "",
                artwork: art.front_default || "", artworkShiny: art.front_shiny || "", focus: {} },
      imageUrl: art.front_default || "",
      height: pokemon.height / 10, weight: pokemon.weight / 10,
      rarity: rarityFor(species, bst),
      abilities, moves,
      desc: clean(flavor && flavor.flavor_text) || `${nameObj ? nameObj.name : pokemon.name}, a ${genus ? genus.genus : "Pokémon"}.`,
      stats,
      tags: creatureTagsFor(nameObj ? nameObj.name : pokemon.name, species, abilities),
      genderPool: genderPoolFor(species),
      preEvo: parentOk ? me.parent + offset : null,
      preEvoMethod: parentOk && me.evo ? String(me.evo.value) : "",
      evolvesInto: children.length ? children[0].dex + offset : null,
      evolvesAt: children.length ? children[0].evo : null,
      variantOf: null,
      official: true, source: "pokeapi", nationalDex: n,
      creatorUid: uid, creatorName: userName
    };
    // remember the evo type for the child too (the form stores it on the parent; we do both)
    entry._parentEvo = parentOk ? me.evo : null;
    entry._parentDex = parentOk ? me.parent : null;
    // links that point at entries imported in an EARLIER run: those old docs need their reverse link patched after saving
    entry._externalLinks = {
      parent: parentOk && !(me.parent >= start && me.parent <= end) ? { dex: me.parent, evo: me.evo } : null,
      children: children.filter(c => !(c.dex >= start && c.dex <= end))
    };
    entriesOut.push(entry);
  }
  return { entries: entriesOut, report };
}

function toFirestorePayload(entry) {
  const e = { ...entry };
  delete e._parentEvo; delete e._parentDex; delete e._externalLinks;
  const migrated = (typeof window.migrateEntry === "function") ? window.migrateEntry(e) : e; // fills every field the engine expects
  return JSON.parse(JSON.stringify(migrated)); // Firestore rejects undefined/NaN
}

async function runImport(opts) {
  const { log, progress } = opts;
  if (!isAdmin() || !window.currentUser) throw new Error("Admin login required.");
  const [start, end] = REGION_RANGES[opts.regionName];
  const uid = window.currentUser.uid;
  const userName = (window.userProfile && window.userProfile.displayName) || "Admin";

  const regionId = REGION_META[opts.regionName].id; // shared, fixed id — see REGION_META

  // --- preflight: ID collisions with other people's creations + which official docs already exist ---
  progress("Checking existing entries…");
  const snap = await getDocs(collection(db, "entries"));
  const existingOfficial = new Set(); const conflicts = [];
  snap.forEach(d => {
    const data = d.data();
    if (d.id.startsWith("official-")) { existingOfficial.add(d.id); return; }
    if (typeof data.id === "number" && data.id >= start + opts.offset && data.id <= end + opts.offset) conflicts.push(`${data.name || d.id} (id ${data.id})`);
  });
  if (conflicts.length) {
    throw new Error(`ID conflict: ${conflicts.length} existing non-official entries already use ids in ${start + opts.offset}–${end + opts.offset}, e.g. ${conflicts.slice(0, 5).join(", ")}. Raise the "ID offset" (e.g. 10000) and try again.`);
  }

  const knownDex = new Set([...existingOfficial].map(id => Number(id.replace("official-", ""))));
  const { entries: built, report } = await buildEntries({ start, end, group: opts.group, knownDex, regionId, regionName: opts.regionName, offset: opts.offset, uid, userName, log, progress });
  log(`Built ${built.length} entries. Total moves mapped: ${built.reduce((s, e) => s + e.moves.length, 0)}.`);

  if (opts.dryRun) {
    log("DRY RUN — nothing was written.");
    return summarize(built, report, log, 0, 0);
  }

  await writeRegionDoc(opts.regionName, uid); // the cartridge on the Regions tab, shared with everyone
  log(`Region cartridge "${opts.regionName}" saved.`);

  let written = 0, skipped = 0, i = 0; const writtenDex = new Set();
  await pool(built, 5, async entry => {
    const docId = docIdFor(entry.nationalDex);
    const ref = doc(db, "entries", docId);
    const payload = toFirestorePayload(entry);
    try {
      if (existingOfficial.has(docId) && !opts.overwrite) { skipped++; }
      else {
        let createdAt = serverTimestamp();
        if (existingOfficial.has(docId)) { const old = await getDoc(ref); if (old.exists() && old.data().createdAt) createdAt = old.data().createdAt; }
        await setDoc(ref, { ...payload, createdAt });
        written++; writtenDex.add(entry.nationalDex);
      }
    } catch (e) { report.failed.push(`write #${entry.nationalDex}: ${e.message}`); }
    progress(`Saving to Firestore… ${++i}/${built.length}`);
  });

  // --- patch the reverse evolution links on docs imported in EARLIER runs
  //     (Golbat -> Crobat, Pikachu <- Pichu, Eevee -> Espeon...). Only fills EMPTY links, never overwrites one. ---
  const patches = {}; // docId -> fields
  const patchLive = (docId, fields) => { patches[docId] = { ...(patches[docId] || {}), ...fields }; };
  for (const e of built) {
    if (!writtenDex.has(e.nationalDex)) continue;
    const ext = e._externalLinks || {};
    try {
      if (ext.parent) {
        const pid = docIdFor(ext.parent.dex), snapP = await getDoc(doc(db, "entries", pid));
        if (snapP.exists() && snapP.data().evolvesInto == null) {
          const f = { evolvesInto: e.id, evolvesAt: ext.parent.evo };
          await updateDoc(snapP.ref, f); patchLive(pid, f); log(`Linked #${ext.parent.dex} → #${e.nationalDex}.`);
        }
      }
      for (const c of (ext.children || [])) {
        const cid = docIdFor(c.dex), snapC = await getDoc(doc(db, "entries", cid));
        if (snapC.exists() && snapC.data().preEvo == null) {
          const f = { preEvo: e.id, preEvoMethod: c.evo ? String(c.evo.value) : "" };
          await updateDoc(snapC.ref, f); patchLive(cid, f); log(`Linked #${e.nationalDex} → #${c.dex}.`);
        }
      }
    } catch (err) { report.failed.push(`link for #${e.nationalDex}: ${err.message}`); }
  }

  // --- show them right away in this tab ---
  const live = window.entries || [];
  built.filter(e => writtenDex.has(e.nationalDex)).forEach(e => {
    const p = { ...toFirestorePayload(e), firestoreId: docIdFor(e.nationalDex) };
    const k = live.findIndex(x => x.firestoreId === p.firestoreId);
    if (k > -1) live[k] = p; else live.push(p);
  });
  Object.entries(patches).forEach(([docId, f]) => { const k = live.findIndex(x => x.firestoreId === docId); if (k > -1) Object.assign(live[k], f); });
  window.entries = live;
  if (typeof window.renderAll === "function") window.renderAll();

  return summarize(built, report, log, written, skipped);
}

function summarize(built, report, log, written, skipped) {
  log(`Done. Written: ${written}, skipped (already existed): ${skipped}.`);
  if (report.noLearnset.length) log(`Learnset came from a different game than expected (game in brackets): ${report.noLearnset.join(", ")}`);
  if (report.fixedDamage.size) log(`Damaging moves with no fixed Base Power (need hand-built mechanics, currently 0 BP): ${[...report.fixedDamage].sort().join(", ")}`);
  if (report.partial.size) log(`Moves with a part that has no engine equivalent (trap/disable/accuracy stages...): ${[...report.partial].sort().join(", ")}`);
  if (report.noEffect && report.noEffect.size) log(`Status moves still WITHOUT any mechanic (text only): ${[...report.noEffect].sort().join(", ")}`);
  if (report.failed.length) log(`⚠ ${report.failed.length} problem(s):\n  ` + report.failed.join("\n  "));
  return report;
}

// Non-destructive repair: creates the shared region docs and points already-imported official entries at them.
async function syncRegionsOnly(log, progress) {
  if (!isAdmin() || !window.currentUser) throw new Error("Admin login required.");
  const uid = window.currentUser.uid;
  progress("Scanning official entries…");
  const snap = await getDocs(collection(db, "entries"));
  const byRegion = {};
  snap.forEach(d => {
    if (!d.id.startsWith("official-")) return;
    const dex = Number(d.id.replace("official-", ""));
    const name = Object.keys(REGION_RANGES).find(k => dex >= REGION_RANGES[k][0] && dex <= REGION_RANGES[k][1]);
    if (name) (byRegion[name] = byRegion[name] || []).push(d);
  });
  const live = window.entries || [];
  for (const [name, docs] of Object.entries(byRegion)) {
    const m = REGION_META[name];
    await writeRegionDoc(name, uid);
    let fixed = 0;
    for (const d of docs) {
      if (d.data().regionId !== m.id || d.data().regionName !== name) {
        await updateDoc(d.ref, { regionId: m.id, regionName: name }); fixed++;
        const k = live.findIndex(x => x.firestoreId === d.id);
        if (k > -1) { live[k].regionId = m.id; live[k].regionName = name; }
      }
    }
    log(`${name}: cartridge saved, ${docs.length} entries checked, ${fixed} re-pointed.`);
  }
  if (!Object.keys(byRegion).length) log("No official entries found yet — import first.");
  refreshRegionViews();
}

// Repair for entries imported BEFORE ability rules existed (they all carried the engine's default "Negate Damage" rule).
// Only regenerates abilities nobody hand-edited, on official entries and on their official Mega profiles.
async function rebuildAbilities(log, progress) {
  if (!isAdmin() || !window.currentUser) throw new Error("Admin login required.");
  progress("Reading official entries…");
  const snap = await getDocs(collection(db, "entries"));
  const docs = snap.docs.filter(d => d.id.startsWith("official-"));
  const live = window.entries || [];
  let touched = 0, mapped = 0, textOnly = 0, kept = 0, i = 0;
  const unmappedNames = new Set();
  const redo = a => {
    if (!isRegenerable(a)) { kept++; return a; }
    const r = applyAbilityRules({ name: a.name, desc: a.desc, hidden: a.hidden });
    if (r.descOnly) { textOnly++; unmappedNames.add(r.name); } else mapped++;
    return r;
  };
  await pool(docs, 5, async d => {
    try {
      const data = d.data(), upd = {};
      if (Array.isArray(data.abilities) && data.abilities.length) upd.abilities = data.abilities.map(redo);
      if (Array.isArray(data.megas) && data.megas.length) {
        upd.megas = data.megas.map(m => (String(m.id || "").startsWith("official_") && m.ability) ? { ...m, ability: redo(m.ability) } : m);
      }
      if (Object.keys(upd).length) {
        const clean_ = JSON.parse(JSON.stringify(upd));
        await updateDoc(d.ref, clean_); touched++;
        const k = live.findIndex(x => x.firestoreId === d.id);
        if (k > -1) Object.assign(live[k], clean_);
      }
    } catch (e) { log(`⚠ ${d.id}: ${e.message}`); }
    progress(`Rebuilding abilities… ${++i}/${docs.length}`);
  });
  if (typeof window.renderAll === "function") window.renderAll();
  log(`Done. ${touched} entries updated. Abilities with real battle rules: ${mapped}; description-only: ${textOnly}; hand-edited (left alone): ${kept}.`);
  if (unmappedNames.size) log(`Still description-only (no matching engine mechanic): ${[...unmappedNames].sort().join(", ")}`);
}

// Regenerates moves (+ creature tags + gender pool) on every official entry with the rich mapper in official-moves.js.
// Only moves flagged autoRule — or, with includeLegacy, the plain ones from older imports — are replaced; a move someone
// hand-edited afterwards (no autoRule flag after saving through the editor) is kept when includeLegacy is off.
async function rebuildMoves(log, progress, includeLegacy) {
  if (!isAdmin() || !window.currentUser) throw new Error("Admin login required.");
  progress("Reading official entries…");
  const snap = await getDocs(collection(db, "entries"));
  const docs = snap.docs.filter(d => /^official-(\d+|form-.+)$/.test(d.id));
  const slugs = new Set(), dexSet = new Set();
  docs.forEach(d => { const x = d.data(); if (x.nationalDex) dexSet.add(x.nationalDex); (x.moves || []).forEach(m => { if (includeLegacy || m.autoRule) slugs.add(slugOfMoveName(m.name)); }); });
  const apiBySlug = {}, speciesBy = {}, missing = [];
  let n = 0;
  await pool([...slugs], 8, async s => { try { apiBySlug[s] = await getJson(`${API}/move/${s}`); } catch (e) { missing.push(s); } progress(`Fetching moves… ${++n}/${slugs.size}`); });
  n = 0;
  await pool([...dexSet], 8, async id => { try { speciesBy[id] = await getJson(`${API}/pokemon-species/${id}`); } catch (e) {} progress(`Fetching species… ${++n}/${dexSet.size}`); });

  const report = { fixedDamage: new Set(), partial: new Set(), noEffect: new Set() };
  const live = window.entries || [];
  let regen = 0, kept = 0, i = 0, entriesUpdated = 0;
  const norm = m => JSON.parse(JSON.stringify(typeof window.normalizeMove === "function" ? window.normalizeMove(m) : m));
  await pool(docs, 4, async d => {
    try {
      const x = d.data(), upd = {};
      upd.moves = (x.moves || []).map(old => {
        const api = apiBySlug[slugOfMoveName(old.name)];
        if (!api || !(includeLegacy || old.autoRule)) { kept++; return old; }
        const fresh = mapMoveRich(api, old.level, report);
        fresh.megaUsable = !!old.megaUsable;
        regen++; return norm(fresh);
      });
      const sp = speciesBy[x.nationalDex];
      const baseName = String(x.name || "");
      upd.tags = [...new Set([...(x.tags || []), ...creatureTagsFor(baseName, sp, x.abilities)])];
      if (sp) upd.genderPool = genderPoolFor(sp);
      const payload = JSON.parse(JSON.stringify(upd));
      await updateDoc(d.ref, payload); entriesUpdated++;
      const k = live.findIndex(e => e.firestoreId === d.id); if (k > -1) Object.assign(live[k], payload);
    } catch (e) { log(`⚠ ${d.id}: ${e.message}`); }
    progress(`Rebuilding moves… ${++i}/${docs.length}`);
  });
  if (typeof window.renderAll === "function") window.renderAll();
  log(`Done. ${entriesUpdated} entries updated · ${regen} moves regenerated · ${kept} left as they were.`);
  if (missing.length) log(`Couldn't find on PokéAPI (kept as-is): ${missing.join(", ")}`);
  if (report.fixedDamage.size) log(`Damaging moves with NO fixed power and no mechanic yet: ${[...report.fixedDamage].sort().join(", ")}`);
  if (report.noEffect.size) log(`Status moves still WITHOUT any mechanic (text only): ${[...report.noEffect].sort().join(", ")}`);
  if (report.partial.size) log(`Moves with a part that has no engine equivalent: ${[...report.partial].sort().join(", ")}`);
  log("Next: re-run 3 · Dynamax & Gigantamax so the Max Move kits are rebuilt from the new moves.");
}

async function undoRange(regionName, log) {
  if (!isAdmin()) throw new Error("Admin login required.");
  const [start, end] = REGION_RANGES[regionName];
  let n = 0;
  for (let d = start; d <= end; d++) {
    const ref = doc(db, "entries", docIdFor(d));
    const s = await getDoc(ref);
    if (s.exists()) { await deleteDoc(ref); n++; }
  }
  if (Array.isArray(window.entries)) {
    for (let k = window.entries.length - 1; k >= 0; k--) {
      const fid = window.entries[k].firestoreId || "";
      const m = fid.match(/^official-(\d+)$/);
      if (m && Number(m[1]) >= start && Number(m[1]) <= end) window.entries.splice(k, 1);
    }
    if (typeof window.renderAll === "function") window.renderAll();
  }
  log(`Deleted ${n} official ${regionName} entries.`);
}

// ---------- admin-only panel (injected into the Settings tab) ----------
function mountPanel() {
  const host = document.getElementById("view-settings");
  if (!host || document.getElementById("officialImportPanel")) return;

  const style = document.createElement("style");
  style.textContent = `#officialImportPanel{display:none !important}
    body.is-admin #officialImportPanel{display:block !important}
    #officialImportPanel{margin-top:24px;padding:16px;border:1px solid rgba(128,128,128,.4);border-radius:12px}
    #officialImportPanel .oi-row{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:8px 0}
    #officialImportPanel pre{max-height:260px;overflow:auto;white-space:pre-wrap;font-size:12px;padding:8px;border:1px solid rgba(128,128,128,.3);border-radius:8px}`;
  document.head.appendChild(style);

  const panel = document.createElement("section");
  panel.id = "officialImportPanel";
  panel.innerHTML = `
    <h3 style="margin-top:0">🛡️ Official Pokémon Import <small style="font-weight:400;opacity:.7">(admin only · data from PokéAPI)</small></h3>
    <p style="opacity:.8;font-size:13px;margin:0 0 8px">Imports official species with stats, types, abilities, level-up moves, evolutions and sprite URLs. Imported entries can only be edited or deleted by admins. Safe to re-run: existing entries are skipped unless you tick Overwrite.</p>
    <div class="oi-row">
      <label>Region <select id="oiRegion">${Object.entries(REGION_RANGES).map(([k, [a, b]]) => `<option value="${k}">${k} (#${a}–${b})</option>`).join("")}</select></label>
      <label>Learnset <select id="oiGroup">${LEARNSET_GROUPS.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select></label>
      <label title="Entry id = National Dex # + offset. Leave 0 unless existing community entries already use those ids.">ID offset <input id="oiOffset" type="number" value="0" min="0" step="1" style="width:90px"></label>
    </div>
    <div class="oi-row">
      <label><input id="oiDry" type="checkbox" checked> Dry run (fetch + check only, write nothing)</label>
      <label><input id="oiOverwrite" type="checkbox"> Overwrite existing official entries</label>
    </div>
    <div class="oi-row">
      <button type="button" id="oiRun">Import</button>
      <button type="button" id="oiSync" title="Creates the shared Regions-tab cartridges and re-points already-imported entries at them. Safe, doesn't touch anything else.">Sync region cartridges</button>
      <button type="button" id="oiAbilities" title="Gives imported abilities real battle rules where the engine supports them; the rest are marked description-only. Never touches abilities you edited by hand.">Rebuild abilities</button>
      <button type="button" id="oiMoves" title="Regenerates moves with real mechanics (self-destruct, tags, drain, Protect, Fly...), plus creature tags and gender pool">Rebuild moves &amp; tags</button>
      <button type="button" id="oiUndo" title="Deletes the official entries in the chosen region's range">Delete this region's official entries</button>
      <span id="oiProgress" style="font-size:13px;opacity:.8"></span>
    </div>
    <pre id="oiLog">Ready. Start with a dry run.</pre>`;
  host.appendChild(panel);

  const $ = id => panel.querySelector(id);
  const logEl = $("#oiLog");
  const log = msg => { logEl.textContent += "\n" + msg; logEl.scrollTop = logEl.scrollHeight; };
  const progress = msg => { $("#oiProgress").textContent = msg; };
  const lock = on => panel.querySelectorAll("button,select,input").forEach(el => el.disabled = on);

  $("#oiRun").addEventListener("click", async () => {
    const dry = $("#oiDry").checked;
    const region = $("#oiRegion").value;
    if (!dry && !confirm(`Write official ${region} entries to the live database?`)) return;
    logEl.textContent = `Starting ${dry ? "dry run" : "import"} for ${region}…`;
    lock(true);
    try {
      await runImport({ regionName: region, group: $("#oiGroup").value, offset: Math.max(0, Number($("#oiOffset").value) || 0),
        dryRun: dry, overwrite: $("#oiOverwrite").checked, log, progress });
    } catch (e) { console.error(e); log("❌ " + e.message); }
    finally { lock(false); progress(""); }
  });

  $("#oiSync").addEventListener("click", async () => {
    lock(true);
    try { await syncRegionsOnly(log, progress); } catch (e) { console.error(e); log("❌ " + e.message); } finally { lock(false); progress(""); }
  });

  $("#oiAbilities").addEventListener("click", async () => {
    if (!confirm("Rebuild ability rules on all official entries? (Abilities you edited by hand are skipped.)")) return;
    lock(true);
    try { await rebuildAbilities(log, progress); } catch (e) { console.error(e); log("❌ " + e.message); } finally { lock(false); progress(""); }
  });

  $("#oiMoves").addEventListener("click", async () => {
    const legacy = confirm("Rebuild moves on ALL official entries?\n\nOK = replace every move, including ones from the first import (and any you edited by hand since).\nCancel = go back.");
    if (!legacy) return;
    lock(true);
    try { await rebuildMoves(log, progress, true); } catch (e) { console.error(e); log("❌ " + e.message); } finally { lock(false); progress(""); }
  });

  $("#oiUndo").addEventListener("click", async () => {
    const region = $("#oiRegion").value;
    if (!confirm(`Delete ALL official ${region} entries from the database? This also removes any admin edits made to them.`)) return;
    lock(true);
    try { await undoRange(region, log); } catch (e) { log("❌ " + e.message); } finally { lock(false); }
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountPanel); else mountPanel();

// exposed for testing
loadOfficialRegions(); // everyone, every page load

window.OfficialImport = { mapMove, mapEvo, rarityFor, indexChain, REGION_RANGES };

// shared with official-items.js
export { API, getJson, pool, titleCase, en, clean, clamp, idFromUrl, isAdmin, KNOWN_TYPES, docIdFor, REGION_RANGES, STAT_MAP,
  mapMove, rarityFor, mapEvo, indexChain, TYPE_EMOJI, groupOrder, pickGroup, toFirestorePayload, REGION_META, writeRegionDoc, refreshRegionViews };