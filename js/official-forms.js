"use strict";

// ============================================================
// OFFICIAL REGIONAL FORMS (admin only) — Alolan / Galarian / Hisuian / Paldean forms from PokéAPI.
//
// Each form becomes its OWN entry (like any variant in your app) with  variantOf = its base entry's id, so it shows
// up in the base creature's Variants tab. Docs live at  entries/official-form-<pokeapi-name>  (e.g. official-form-rattata-alola),
// stamped official:true, so the same admin-only rules protect them. Entry ids are 100000 + PokéAPI form id (+ ID offset).
//
// The base creature must already be imported (forms of un-imported species are skipped and listed in the log).
// ============================================================

import { db } from "./firebase-config.js";
import { collection, doc, getDoc, getDocs, setDoc, deleteDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { applyAbilityRules } from "./official-abilities.js";
import { creatureTagsFor, genderPoolFor } from "./official-moves.js";
import {
  API, getJson, pool, titleCase, en, clean, isAdmin, KNOWN_TYPES, STAT_MAP, mapMove, rarityFor, mapEvo, indexChain,
  TYPE_EMOJI, groupOrder, pickGroup, toFirestorePayload, REGION_META, writeRegionDoc, refreshRegionViews
} from "./official-import.js";

const FORM_RE = /^(.+?)-(alola|galar|hisui|paldea)(?:-(standard|combat-breed|blaze-breed|aqua-breed))?$/;
const REGION_OF = { alola: "Alola", galar: "Galar", hisui: "Hisui", paldea: "Paldea" };
const DEMONYM = { alola: "Alolan", galar: "Galarian", hisui: "Hisuian", paldea: "Paldean" };
const FLAVOR_VERSIONS = { alola: ["ultra-sun", "ultra-moon", "sun", "moon"], galar: ["shield", "sword"], hisui: ["legends-arceus"], paldea: ["scarlet", "violet"] };
const ID_BASE = 100000;
const formDocId = apiName => "official-form-" + apiName;

async function buildForms({ offset, uid, userName, baseDex, log, progress }) {
  const report = { fixedDamage: new Set(), partial: new Set(), noEffect: new Set(), noLearnset: [], failed: [], skippedBase: [] };
  progress("Discovering regional forms…");
  const list = await getJson(`${API}/pokemon?limit=3000`);
  const found = list.results.map(r => ({ api: r.name, m: r.name.match(FORM_RE) })).filter(x => x.m && !/-(totem|cap|gmax|starter)/.test(x.api));
  log(`Found ${found.length} regional forms on PokéAPI.`);

  const raw = []; let n = 0;
  await pool(found, 6, async f => {
    try {
      const pokemon = await getJson(`${API}/pokemon/${f.api}`);
      const species = await getJson(pokemon.species.url);
      if (!baseDex.has(species.id)) { report.skippedBase.push(`${f.api} (needs #${species.id})`); }
      else {
        const item = { f, pokemon, species, idx: {} };   // keep OUR OWN reference (raw[raw.length-1] is wrong when 6 run at once)
        raw.push(item);
        const chain = await getJson(species.evolution_chain.url);
        const idx = {}; indexChain(chain.chain, null, idx); item.idx = idx;
      }
    } catch (e) { report.failed.push(`${f.api}: ${e.message}`); }
    progress(`Fetching forms… ${++n}/${found.length}`);
  });

  const moveUrls = new Set(), abilityUrls = new Set();
  raw.forEach(r => {
    r.region = REGION_OF[r.f.m[2]]; r.order = groupOrder(r.region, "auto");
    r.pokemon.abilities.forEach(a => abilityUrls.add(a.ability.url));
    r.group = pickGroup(r.pokemon, r.order);
    if (r.group) r.pokemon.moves.forEach(mv => {
      if (mv.version_group_details.some(v => v.version_group.name === r.group && v.move_learn_method.name === "level-up")) moveUrls.add(mv.move.url);
    });
  });
  const moveData = {}, abilityData = {}; let d = 0; const total = moveUrls.size + abilityUrls.size;
  await pool([...moveUrls], 6, async u => { try { moveData[u] = await getJson(u); } catch (e) { report.failed.push("move " + u); } progress(`Fetching moves & abilities… ${++d}/${total}`); });
  await pool([...abilityUrls], 6, async u => { try { abilityData[u] = await getJson(u); } catch (e) { report.failed.push("ability " + u); } progress(`Fetching moves & abilities… ${++d}/${total}`); });

  // (species id, region) -> entry id, so Alolan Rattata <-> Alolan Raticate can be chained
  const formId = {};
  raw.forEach(r => { formId[`${r.species.id}|${r.f.m[2]}`] = ID_BASE + r.pokemon.id + offset; });

  const out = [], moveCache = {};
  for (const r of raw) {
    const { f, pokemon, species } = r, region = f.m[2];
    const baseName = (en(species.names) || {}).name || titleCase(species.name);
    const breed = f.m[3] && f.m[3] !== "standard" ? ` (${titleCase(f.m[3])})` : "";
    const stats = {}; pokemon.stats.forEach(s => { const k = STAT_MAP[s.stat.name]; if (k) stats[k] = s.base_stat; });
    const bst = Object.values(stats).reduce((a, b) => a + b, 0);
    const types = pokemon.types.slice().sort((a, b) => a.slot - b.slot).map(t => t.type.name).filter(t => KNOWN_TYPES().includes(t));

    const abilities = pokemon.abilities.slice().sort((a, b) => a.slot - b.slot).map(a => {
      const ad = abilityData[a.ability.url], eff = ad && en(ad.effect_entries), nm = ad && en(ad.names);
      return applyAbilityRules({ name: nm ? nm.name : titleCase(a.ability.name), desc: clean(eff ? (eff.short_effect || eff.effect) : ""), hidden: !!a.is_hidden });
    });
    const learn = [];
    if (r.group) pokemon.moves.forEach(mv => {
      const lv = mv.version_group_details.filter(v => v.version_group.name === r.group && v.move_learn_method.name === "level-up").map(v => v.level_learned_at);
      if (lv.length) learn.push({ url: mv.move.url, level: Math.min(...lv) || 1 });
    });
    if (!r.group) report.noLearnset.push(`${f.api} (NO level-up moves found)`);
    else if (!r.order.first.includes(r.group)) report.noLearnset.push(`${f.api} (${r.group})`);
    learn.sort((a, b) => a.level - b.level);
    const moves = learn.filter(l => moveData[l.url]).map(l => {
      const k = l.url + "@" + l.level;
      return JSON.parse(JSON.stringify(moveCache[k] || (moveCache[k] = mapMove(moveData[l.url], l.level, report))));
    });

    const flavors = species.flavor_text_entries.filter(x => x.language.name === "en");
    const prefer = FLAVOR_VERSIONS[region] || [];
    const flavor = prefer.map(v => flavors.find(x => x.version.name === v)).find(Boolean) || flavors[flavors.length - 1];
    const genus = en(species.genera);
    const art = (pokemon.sprites.other && pokemon.sprites.other["official-artwork"]) || {};

    // same-region evolution partners only (Alolan Rattata -> Alolan Raticate); links to non-form species are left to the base entry
    const me = r.idx[species.id] || { parent: null, evo: null };
    const parentForm = me.parent ? formId[`${me.parent}|${region}`] : null;
    const childDex = Object.entries(r.idx).filter(([, v]) => v.parent === species.id).map(([k, v]) => ({ dex: Number(k), evo: v.evo }))
      .find(c => formId[`${c.dex}|${region}`]);

    out.push({
      id: ID_BASE + pokemon.id + offset,
      regionId: REGION_META[REGION_OF[region]].id, regionName: REGION_OF[region],
      name: `${DEMONYM[region]} ${baseName}${breed}`,
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
      desc: clean(flavor && flavor.flavor_text) || `${DEMONYM[region]} form of ${baseName}.`,
      stats,
      tags: creatureTagsFor(baseName, species, abilities),
      genderPool: genderPoolFor(species),
      preEvo: parentForm || null, preEvoMethod: parentForm && me.evo ? String(mapEvoText(me.evo)) : "",
      evolvesInto: childDex ? formId[`${childDex.dex}|${region}`] : null,
      evolvesAt: childDex ? childDex.evo : null,
      variantOf: species.id + offset,                       // <- puts it in the base creature's Variants tab
      official: true, isRegionalForm: true, formRegion: region, source: "pokeapi",
      nationalDex: species.id, apiName: f.api,
      creatorUid: uid, creatorName: userName
    });
  }
  return { entries: out, report };
}
const mapEvoText = evo => (evo && evo.value != null) ? evo.value : "";

async function importForms({ offset, dryRun, overwrite, log, progress }) {
  if (!isAdmin() || !window.currentUser) throw new Error("Admin login required.");
  const uid = window.currentUser.uid, userName = (window.userProfile && window.userProfile.displayName) || "Admin";

  progress("Checking existing entries…");
  const snap = await getDocs(collection(db, "entries"));
  const baseDex = new Set(), existingForms = new Set(), conflicts = [];
  snap.forEach(dn => {
    const data = dn.data();
    if (dn.id.startsWith("official-form-")) existingForms.add(dn.id);
    else if (/^official-\d+$/.test(dn.id)) baseDex.add(Number(dn.id.replace("official-", "")));
    else if (typeof data.id === "number" && data.id >= ID_BASE + offset && data.id < ID_BASE + 20000 + offset) conflicts.push(`${data.name || dn.id} (id ${data.id})`);
  });
  if (conflicts.length) throw new Error(`ID conflict: existing non-official entries use ids ≥ ${ID_BASE + offset}, e.g. ${conflicts.slice(0, 5).join(", ")}. Raise the ID offset and retry.`);
  if (!baseDex.size) throw new Error("No official base entries found — import a region first.");

  const { entries: built, report } = await buildForms({ offset, uid, userName, baseDex, log, progress });
  log(`Built ${built.length} regional forms.`);
  built.forEach(e => log(`  ${e.name}  → variant of #${e.variantOf - offset}`));
  if (report.skippedBase.length) log(`Skipped (base creature not imported yet — import its region, then re-run): ${report.skippedBase.join(", ")}`);
  if (dryRun) { log("DRY RUN — nothing written."); if (report.failed.length) log("⚠ " + report.failed.join("; ")); return; }

  for (const regionName of [...new Set(built.map(e => e.regionName))]) await writeRegionDoc(regionName, uid);

  let written = 0, skipped = 0, i = 0; const writtenIds = new Set();
  await pool(built, 5, async e => {
    const id = formDocId(e.apiName), ref = doc(db, "entries", id);
    try {
      if (existingForms.has(id) && !overwrite) skipped++;
      else {
        let createdAt = serverTimestamp();
        if (existingForms.has(id)) { const old = await getDoc(ref); if (old.exists() && old.data().createdAt) createdAt = old.data().createdAt; }
        await setDoc(ref, { ...toFirestorePayload(e), createdAt }); written++; writtenIds.add(id);
      }
    } catch (err) { report.failed.push(`write ${e.apiName}: ${err.message}`); }
    progress(`Saving forms… ${++i}/${built.length}`);
  });

  const live = window.entries || [];
  built.filter(e => writtenIds.has(formDocId(e.apiName))).forEach(e => {
    const p = { ...toFirestorePayload(e), firestoreId: formDocId(e.apiName) };
    const k = live.findIndex(x => x.firestoreId === p.firestoreId); if (k > -1) live[k] = p; else live.push(p);
  });
  window.entries = live; refreshRegionViews();
  log(`Done. Written: ${written}, skipped (already existed): ${skipped}.`);
  if (report.noLearnset.length) log(`Learnset came from a different game than expected: ${report.noLearnset.join(", ")}`);
  if (report.fixedDamage.size) log(`Damaging moves with no fixed Base Power (need hand-built mechanics): ${[...report.fixedDamage].sort().join(", ")}`);
  if (report.failed.length) log(`⚠ ${report.failed.length} problem(s):\n  ` + report.failed.join("\n  "));
}

async function deleteForms(log, progress) {
  if (!isAdmin()) throw new Error("Admin login required.");
  const snap = await getDocs(collection(db, "entries"));
  const docs = snap.docs.filter(d => d.id.startsWith("official-form-")); let i = 0;
  await pool(docs, 5, async d => { await deleteDoc(d.ref); progress(`Deleting… ${++i}/${docs.length}`); });
  if (Array.isArray(window.entries)) for (let k = window.entries.length - 1; k >= 0; k--) if (String(window.entries[k].firestoreId || "").startsWith("official-form-")) window.entries.splice(k, 1);
  refreshRegionViews(); log(`Deleted ${docs.length} regional forms.`);
}

function mountPanel() {
  const host = document.getElementById("view-settings");
  if (!host || document.getElementById("officialFormsPanel")) return;
  const style = document.createElement("style");
  style.textContent = `#officialFormsPanel{display:none !important}
    body.is-admin #officialFormsPanel{display:block !important}
    #officialFormsPanel{margin-top:24px;padding:16px;border:1px solid rgba(128,128,128,.4);border-radius:12px}
    #officialFormsPanel .oi-row{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:8px 0}
    #officialFormsPanel pre{max-height:260px;overflow:auto;white-space:pre-wrap;font-size:12px;padding:8px;border:1px solid rgba(128,128,128,.3);border-radius:8px}`;
  document.head.appendChild(style);
  const panel = document.createElement("section"); panel.id = "officialFormsPanel";
  panel.innerHTML = `
    <h3 style="margin-top:0">🌍 Official Regional Forms <small style="font-weight:400;opacity:.7">(admin only · Alolan / Galarian / Hisuian / Paldean)</small></h3>
    <p style="opacity:.8;font-size:13px;margin:0 0 8px">Each form is imported as its own entry, linked to its base creature as a Variant. Import the base Pokémon's region first — forms whose base isn't imported are skipped and listed.</p>
    <div class="oi-row">
      <label><input id="ofDry" type="checkbox" checked> Dry run</label>
      <label><input id="ofOverwrite" type="checkbox"> Overwrite existing official forms</label>
      <label title="Only needed if the ID offset used for the main import was non-zero">ID offset <input id="ofOffset" type="number" value="0" min="0" step="1" style="width:90px"></label>
    </div>
    <div class="oi-row">
      <button type="button" id="ofRun">Import regional forms</button>
      <button type="button" id="ofDelete">Delete all regional forms</button>
      <span id="ofProgress" style="font-size:13px;opacity:.8"></span>
    </div>
    <pre id="ofLog">Ready. Start with a dry run.</pre>`;
  host.appendChild(panel);
  const $ = sel => panel.querySelector(sel), logEl = $("#ofLog");
  const log = m => { logEl.textContent += "\n" + m; logEl.scrollTop = logEl.scrollHeight; };
  const progress = m => { $("#ofProgress").textContent = m; };
  const lock = on => panel.querySelectorAll("button,input").forEach(e => e.disabled = on);
  $("#ofRun").addEventListener("click", async () => {
    const dry = $("#ofDry").checked;
    if (!dry && !confirm("Write official regional forms to the live database?")) return;
    logEl.textContent = `Importing regional forms${dry ? " (dry run)" : ""}…`; lock(true);
    try { await importForms({ offset: Math.max(0, Number($("#ofOffset").value) || 0), dryRun: dry, overwrite: $("#ofOverwrite").checked, log, progress }); }
    catch (e) { console.error(e); log("❌ " + e.message); } finally { lock(false); progress(""); }
  });
  $("#ofDelete").addEventListener("click", async () => {
    if (!confirm("Delete ALL official regional forms (including admin edits)?")) return;
    lock(true); try { await deleteForms(log, progress); } catch (e) { log("❌ " + e.message); } finally { lock(false); progress(""); }
  });
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountPanel); else mountPanel();

window.OfficialForms = { FORM_RE };