"use strict";

// ---- Safety net: the "Trap Opponent" ability UI below needs TRAP_SCOPES, which normally comes from engine.js.
// If engine.js doesn't define it, Log Creature would crash while building the ability rows. This only fills the
// gap when it is missing (a real definition in engine.js always wins). ----
if (typeof window.TRAP_SCOPES === "undefined") {
  window.TRAP_SCOPES = [["all", "Every opponent"], ["filtered", "Only opponents matching the types/tags below"]];
}

// ================= TAG PICKER (dropdown of tags already in use) =================
// Any <input data-tagkind="creature|move"> gets a dropdown under it listing the tags already used, so tags can be
// reused instead of retyped. "creature" inputs only list Fakemon tags (entry.tags); "move" inputs only list move
// tags — the two lists are never mixed. Synonyms collapse into one canonical tag (e.g. buried -> grounded).
function tagsInUse(kind){
  const seen = new Map();
  const add = t => { const c = canonTag(t), k = c.toLowerCase(); if(c && !seen.has(k)) seen.set(k, c); };
  const list = (typeof entries !== "undefined" && entries) || window.entries || [];
  if(kind === "creature"){
    ["grounded","levitating","genderfluid"].forEach(add);
    list.forEach(e => (e.tags||[]).forEach(add));
  } else {
    ["Slash","Punch","Kick","Bite","Draining","Defending","unavoidable","undodgeable","powder","projectile","blade"].forEach(add);
    list.forEach(e => (e.moves||[]).forEach(m => { if(m && Array.isArray(m.tags)) m.tags.forEach(add); }));
  }
  return [...seen.values()].sort((a,b)=>a.localeCompare(b));
}
function renderTagPicker(input, onlyIfMissing){
  let box = input.nextElementSibling;
  const had = !!(box && box.classList && box.classList.contains("tag-picker"));
  if(had && onlyIfMissing) return;
  if(!had){ box = document.createElement("div"); box.className = "tag-picker"; box.style.margin = "4px 0 2px"; input.insertAdjacentElement("afterend", box); }
  const esc2 = s => String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const have = new Set(input.value.split(",").map(t => canonTag(t).toLowerCase()).filter(Boolean));
  box.innerHTML = `<select class="tag-pick-select"><option value="">＋ Add a tag already in use…</option>`
    + tagsInUse(input.dataset.tagkind).map(t => `<option value="${esc2(t)}" ${have.has(t.toLowerCase())?"disabled":""}>${esc2(t)}</option>`).join("")
    + `</select>`;
}
function refreshAllTagPickers(onlyIfMissing){ document.querySelectorAll("input[data-tagkind]").forEach(el => renderTagPicker(el, onlyIfMissing)); }
document.addEventListener("focusin", ev => { if(ev.target && ev.target.matches && ev.target.matches("input[data-tagkind]")) renderTagPicker(ev.target, false); });
document.addEventListener("change", ev => {
  const s = ev.target;
  if(!s || !s.classList || !s.classList.contains("tag-pick-select")) return;
  const input = s.parentElement.previousElementSibling;
  if(s.value && input){
    const cur = input.value.split(",").map(t => t.trim()).filter(Boolean);
    if(!cur.some(t => canonTag(t).toLowerCase() === canonTag(s.value).toLowerCase())) cur.push(s.value);
    input.value = cur.join(", ");
    input.dispatchEvent(new Event("input", { bubbles:true }));
  }
  if(input) renderTagPicker(input, false);
});
// New rows (moves, abilities...) are built from templates, so add pickers to any new tag input as it appears.
{
  let tagPickTimer = null;
  new MutationObserver(() => { clearTimeout(tagPickTimer); tagPickTimer = setTimeout(() => refreshAllTagPickers(true), 50); })
    .observe(document.body || document.documentElement, { childList:true, subtree:true });
  setTimeout(() => refreshAllTagPickers(true), 0);
}
// ============================================================================
// UI FORM HANDLER — creature (Fakemon) create/edit form + item form + region
// form + import pickers.
//
// The "Log New Fakemon" form in index.html is split into:
//   1. Always-visible required fields: Name, Type, Description.
//   2. Collapsed <details> sections for everything optional, ordered from
//      "commonly used soon" (More Details, Base Stats) to "rarely touched,
//      do this last" (Mega Evolutions / Other Forms, at the very bottom).
// None of the JS below cares where a field physically sits in the form —
// every field is grabbed with document.getElementById(...), so moving a
// <div class="field"> block around in the HTML is always safe.
//
// Where things live in THIS file:
//   - Validation for what's actually required to save an entry: search for
//     "REQUIRED FIELD CHECKS" (inside the pokeForm submit handler below).
//   - Mega/Other Forms row builder: megaProfileBlockHtml() / addMegaProfileRow(),
//     right below this comment.
//   - Add/Edit modal open + reset logic: resetForm() / openAdd() / openEdit().
//   - Final save (what gets written to an entry): the "payload" object
//     inside the pokeForm submit handler.
// ============================================================================
  function megaProfileBlockHtml(prefix, data){
    return `
      <div class="field">
        <label style="margin-top:10px;">Mega Form Name</label>
        <input type="text" class="${prefix}-name" placeholder="e.g. Mega X, Mega Y, Alolan Mega" value="${esc(data.name)}">
        <label style="margin-top:10px;">Transformation Verb Phrase</label>
        <div class="field-hint">Battle log reads "[Name] [this phrase] [New Form Name]!" — write whatever fits: "Mega Evolves into", "Dynamaxes into", "Gigantamaxes into", "Transforms into", etc. This one field is what lets this same profile represent any transformation type with no code changes.</div>
        <input type="text" class="${prefix}-transformverb" placeholder="e.g. Mega Evolves into" value="${esc(data.transformVerb)}">
        <label style="margin-top:10px;">Transformation Type</label>
        <div class="field-hint">Controls how the engine treats "Can Be Used In Mega Evolution" on base-movepool moves. Mega Evolution (default): only moves flagged "Can Be Used In Mega Evolution" carry over, same as classic Mega behavior. Dynamax: ignores that restriction entirely — every base move carries over unchanged, matching normal Dynamax move behavior. Other: behaves like Mega Evolution.</div>
        <select class="${prefix}-kind">
          <option value="mega" ${data.kind==="mega"?"selected":""}>Mega Evolution (move-restricted)</option>
          <option value="dynamax" ${data.kind==="dynamax"?"selected":""}>Dynamax (ignores Mega move restriction)</option>
          <option value="other" ${data.kind==="other"?"selected":""}>Other / Custom Transformation</option>
        </select>
        <label style="margin-top:10px;">Mega Emoji Badge</label>
        <div class="emoji-row ${prefix}-emoji"></div>
        <label style="margin-top:10px;">Mega Images</label>
        <div class="field-hint">Same fallback order as a base entry: Pixel Sprite → Official Artwork → the emoji badge above. Leave all four blank to just use the emoji.</div>
        <div class="img-slot-grid">
          <div class="field">
            <label style="font-size:12px;">Pixel Sprite</label>
            <input type="text" class="${prefix}-image-pixel" placeholder="https://… small pixel-art sprite" value="${esc((data.images&&data.images.pixel)||"")}">
            <div class="crop-picker ${prefix}-image-pixel-crop" style="display:none;"></div>
          </div>
          <div class="field">
            <label style="font-size:12px;">Pixel Sprite (Shiny)</label>
            <input type="text" class="${prefix}-image-pixel-shiny" placeholder="https://… shiny pixel sprite" value="${esc((data.images&&data.images.pixelShiny)||"")}">
            <div class="crop-picker ${prefix}-image-pixel-shiny-crop" style="display:none;"></div>
          </div>
          <div class="field">
            <label style="font-size:12px;">Official Artwork</label>
            <input type="text" class="${prefix}-image-artwork" placeholder="https://… full-size artwork" value="${esc((data.images&&data.images.artwork)||data.imageUrl||"")}">
            <div class="crop-picker ${prefix}-image-artwork-crop" style="display:none;"></div>
          </div>
          <div class="field">
            <label style="font-size:12px;">Official Artwork (Shiny)</label>
            <input type="text" class="${prefix}-image-artwork-shiny" placeholder="https://… shiny artwork" value="${esc((data.images&&data.images.artworkShiny)||"")}">
            <div class="crop-picker ${prefix}-image-artwork-shiny-crop" style="display:none;"></div>
          </div>
        </div>
        <label style="margin-top:10px;">Mega Types</label>
        <div class="type-grid ${prefix}-types"></div>
        <label style="margin-top:10px;">Mega Base Stats</label>
        <div class="${prefix}-stats"></div>
        <label style="margin-top:10px;">Independent Mega Lore / Description</label>
        <textarea class="${prefix}-desc" rows="3" placeholder="Describe the Mega Form's behavior, appearance changes, lore…">${esc(data.desc)}</textarea>
        <label style="margin-top:10px;">Dedicated Mega Custom Ability</label>
        <div class="field-hint">Fully independent from this creature's normal ability list — built with the exact same Ability Rule Builder.</div>
        <div class="dyn-list ${prefix}-ability-list"></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" class="add-row-btn ${prefix}-add-ability-btn">＋ Set Mega Ability</button>
          <button type="button" class="add-row-btn ${prefix}-import-ability-btn">⤵ Import from Ability Dex</button>
        </div>
        <label style="margin-top:10px;">Special Mega Move Slots</label>
        <div class="field-hint">A separate movepool used only while this Mega is active; falls back to the base movepool if left empty.</div>
        <div class="dyn-list ${prefix}-move-list"></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" class="add-row-btn ${prefix}-add-move-btn">＋ Add Mega Move</button>
          <button type="button" class="add-row-btn ${prefix}-import-move-btn">⤵ Import from Move Dex</button>
        </div>
      </div>
      <div class="rule-sub">
        <p class="rule-sub-title">Activation Requirement</p>
        <div class="field-hint">What must be true mid-battle before THIS Mega profile can trigger. The arena checks every enabled profile on a fighter each turn, in order, and swaps into the first one whose requirement is met.</div>
        <div class="rule-row">
          <label class="rule-label">Requirement</label>
          <select class="${prefix}-act-requirement">
            <option value="heldStone" ${data.activation.requirement==="heldStone"?"selected":""}>Held Mega Stone (per-round arena chance)</option>
            <option value="triggerMove" ${data.activation.requirement==="triggerMove"?"selected":""}>Specific Trigger Move</option>
            <option value="turnThreshold" ${data.activation.requirement==="turnThreshold"?"selected":""}>Turn Threshold</option>
            <option value="triggerEffect" ${data.activation.requirement==="triggerEffect"?"selected":""}>Trigger Alternate Form effect (any move or ability)</option>
          </select>
        </div>
        <div class="rule-row ${prefix}-act-move-row">
          <label class="rule-label">Trigger Move Name</label>
          <input type="text" class="${prefix}-act-movename" placeholder="e.g. Mega Burst" value="${esc(data.activation.triggerMoveName)}">
        </div>
        <div class="rule-row ${prefix}-act-label-row">
          <label class="rule-label">Form Label (optional)</label>
          <input type="text" class="${prefix}-act-label" placeholder="e.g. Evolve (blank = any Trigger Alternate Form effect)" value="${esc(data.activation.triggerLabel)}">
        </div>
        <div class="rule-row ${prefix}-act-turn-row">
          <label class="rule-label">Activates On Turn #</label>
          <input type="number" class="${prefix}-act-turn" min="1" step="1" value="${data.activation.turnThreshold}">
        </div>
        <div class="rule-row">
          <label class="rule-label">Required Held Item</label>
          <select class="${prefix}-act-requireditem">
            <option value="">None (no item required)</option>
            ${items.map(it=>`<option value="${it.id}" ${data.activation.requiredItem===it.id?"selected":""}>${esc(it.name)}</option>`).join("")}
          </select>
        </div>
        <div class="field-hint">Separate from — and in addition to — the Requirement above. If set, this fighter must be holding EXACTLY this item (picked from the Battle Prep Held Item dropdown) or this profile can never Mega Evolve / Transform, no matter how many times its Requirement condition is met. Leave on "None" to keep the old behavior.</div>
      </div>
      <div class="rule-sub">
        <p class="rule-sub-title">Duration &amp; Reuse</p>
        <div class="field-hint">How long this transformation lasts once triggered, and how soon it can be used again after reverting. See the Advanced Battle Systems Reference for the full revert/cooldown lifecycle.</div>
        <div class="rule-row">
          <label class="rule-label">Duration (Turns)</label>
          <input type="number" class="${prefix}-duration-limit" min="0" step="1" value="${data.durationLimit}">
        </div>
        <div class="field-hint">0 = permanent for the rest of the battle. A number greater than 0 (e.g. 3) auto-reverts to base form after that many turns transformed.</div>
        <div class="rule-row">
          <label class="rule-label">Reuse Cooldown (Turns)</label>
          <input type="number" class="${prefix}-reuse-cooldown" min="0" step="1" value="${data.reuseCooldown}">
        </div>
        <div class="field-hint">Only matters once Duration above is greater than 0, since a permanent transformation never reverts. 0 = can never transform again this battle once reverted. A number greater than 0 (e.g. 3) = must wait that many turns in base form before transforming again.</div>
      </div>`;
  }

  // ---- Reusable image-slot + crop/focus picker, generalized so it can be attached to ANY prefix's 4
  // image inputs — used by both a Mega/Form profile row here (addMegaProfileRow below) and the standalone
  // "Add a Form" modal (js/form-editor.js), which reuses this exact row builder pointed at a different
  // container. Mirrors the base creature form's own picker (ui-form-handler.js top) but scoped to a row
  // instead of fixed global element IDs, since a form can have several of these on screen at once. ----
  function wireImageSlotPicker(row, prefix, initialImages){
    const SLOTS = {
      pixel: `${prefix}-image-pixel`,
      pixelShiny: `${prefix}-image-pixel-shiny`,
      artwork: `${prefix}-image-artwork`,
      artworkShiny: `${prefix}-image-artwork-shiny`
    };
    let focusState = {};
    const els = {};

    Object.entries(SLOTS).forEach(([slot, cls])=>{
      const input = row.querySelector(`.${cls}`);
      const picker = row.querySelector(`.${cls}-crop`);
      if(!input || !picker) return;
      picker.innerHTML = `
        <div class="crop-preview"><div class="crop-marker"></div></div>
        <div class="crop-controls">
          <span class="field-hint" style="margin:0;">Zoom</span>
          <input type="range" min="1" max="3" step="0.05" value="1">
          <button type="button" class="crop-reset-btn">Reset</button>
        </div>
        <div class="field-hint" style="margin-top:4px;">Click the spot on this image that's actually this form.</div>
      `;
      const preview = picker.querySelector(".crop-preview");
      const marker = picker.querySelector(".crop-marker");
      const zoomInput = picker.querySelector('input[type="range"]');
      const resetBtn = picker.querySelector(".crop-reset-btn");
      els[slot] = { input, picker, preview, marker, zoomInput };

      function placeMarker(x,y){ marker.style.left=x+"%"; marker.style.top=y+"%"; marker.style.display="block"; }

      function refresh(){
        const url = input.value.trim();
        if(url){
          picker.style.display = "block";
          preview.style.backgroundImage = `url("${url}")`;
        } else {
          picker.style.display = "none";
          delete focusState[slot];
          marker.style.display = "none";
          zoomInput.value = 1;
        }
      }
      input.addEventListener("input", refresh);

      preview.addEventListener("click", (ev)=>{
        const rect = preview.getBoundingClientRect();
        const x = Math.max(0, Math.min(100, ((ev.clientX-rect.left)/rect.width)*100));
        const y = Math.max(0, Math.min(100, ((ev.clientY-rect.top)/rect.height)*100));
        const zoom = parseFloat(zoomInput.value) || 1;
        focusState[slot] = { x: Math.round(x), y: Math.round(y), zoom };
        placeMarker(x,y);
      });
      zoomInput.addEventListener("input", ()=>{
        const zoom = parseFloat(zoomInput.value) || 1;
        const existing = focusState[slot];
        focusState[slot] = { x: existing?.x ?? 50, y: existing?.y ?? 50, zoom };
        placeMarker(focusState[slot].x, focusState[slot].y);
      });
      resetBtn.addEventListener("click", ()=>{
        delete focusState[slot];
        marker.style.display = "none";
        zoomInput.value = 1;
      });

      refresh();
      const saved = initialImages && initialImages.focus && initialImages.focus[slot];
      if(saved && input.value.trim()){
        focusState[slot] = { ...saved };
        marker.style.left = saved.x+"%"; marker.style.top = saved.y+"%"; marker.style.display="block";
        zoomInput.value = saved.zoom || 1;
      }
    });

    return {
      getImages(){
        const out = {
          pixel: els.pixel ? els.pixel.input.value.trim() : "",
          pixelShiny: els.pixelShiny ? els.pixelShiny.input.value.trim() : "",
          artwork: els.artwork ? els.artwork.input.value.trim() : "",
          artworkShiny: els.artworkShiny ? els.artworkShiny.input.value.trim() : ""
        };
        out.focus = Object.fromEntries(Object.entries(focusState).filter(([slot])=>!!out[slot]));
        return out;
      }
    };
  }

  function addMegaProfileRow(data, targetEl){
    targetEl = targetEl || megaProfilesEl;
    data = normalizeMegaProfile(data || { enabled:true });
    const prefix = "mg" + Math.random().toString(36).slice(2,7);
    const row = document.createElement("div"); row.className = "dyn-row";
    row.dataset.megaId = data.id;
    row.dataset.megaPrefix = prefix;
    row.innerHTML = `
      <div class="dyn-row-top">
        <input type="text" class="${prefix}-name-top" placeholder="Mega Form" value="${esc(data.name)}" disabled style="opacity:.6">
        <span class="dyn-row-collapsed-preview"></span>
        <button type="button" class="dyn-row-collapse" title="Minimize/Expand">▲</button>
        <button type="button" class="dyn-row-remove" title="Remove this Mega form">×</button>
      </div>
      <div class="dyn-row-body">${megaProfileBlockHtml(prefix, data)}</div>`;
    row.querySelector(".dyn-row-remove").addEventListener("click", ()=>row.remove());

    const imagePicker = wireImageSlotPicker(row, prefix, data.images);
    row._getMegaImages = ()=>imagePicker.getImages();


    // ---- Type grid (max 2, same picker behavior as the base creature's own type grid) ----
    const typesEl = row.querySelector(`.${prefix}-types`);
    let pickedTypes = [...(data.types || [])];
    TYPES.forEach(t=>{
      if(t===FANMADE_TYPE_LIST[0]) typesEl.appendChild(fanmadeTypesHeaderEl());
      const label = document.createElement("label");
      label.className = "type-check"; label.dataset.type = t;
      if(FANMADE_TYPES[t]) label.title = typeCreditTitle(t);
      label.innerHTML = `<input type="checkbox" value="${t}" ${pickedTypes.includes(t)?"checked":""}> ${t}`;
      label.addEventListener("click", (ev)=>{
        ev.preventDefault();
        const idx = pickedTypes.indexOf(t);
        if(idx>-1){ pickedTypes.splice(idx,1); } else { if(pickedTypes.length>=2) return; pickedTypes.push(t); }
        syncTypeGrid();
      });
      typesEl.appendChild(label);
    });
    function syncTypeGrid(){
      [...typesEl.children].forEach(el=>{
        const t = el.dataset.type; const on = pickedTypes.includes(t);
        el.classList.toggle("picked", on);
        el.style.background = on ? `var(--t-${t})` : "";
        el.style.borderColor = on ? `var(--t-${t})` : "";
      });
    }
    syncTypeGrid();
    row._getMegaTypes = ()=>[...pickedTypes];

    // ---- Emoji badge picker ----
    const emojiEl = row.querySelector(`.${prefix}-emoji`);
    let pickedEmoji = data.emoji || EMOJIS[0];
    EMOJIS.forEach(em=>{
      const d = document.createElement("div"); d.className = "emoji-choice"; d.textContent = em;
      d.addEventListener("click", ()=>{ pickedEmoji = em; syncEmojiRow(); });
      emojiEl.appendChild(d);
    });
    function syncEmojiRow(){ [...emojiEl.children].forEach(el=>{ el.classList.toggle("picked", el.textContent === pickedEmoji); }); }
    syncEmojiRow();
    row._getMegaEmoji = ()=>pickedEmoji;

    // ---- Base stat sliders ----
    const statsEl = row.querySelector(`.${prefix}-stats`);
    const statVals = {};
    STAT_KEYS.forEach(([key,label])=>{
      statVals[key] = (data.stats && data.stats[key]) || 50;
      const r = document.createElement("div"); r.className = "stat-field";
      r.innerHTML = `<label>${label}</label><input type="range" min="1" max="150" value="${statVals[key]}" data-key="${key}"><div class="val">${statVals[key]}</div>`;
      const range = r.querySelector("input"); const val = r.querySelector(".val");
      range.addEventListener("input", ()=>{ statVals[key] = Number(range.value); val.textContent = range.value; });
      statsEl.appendChild(r);
    });
    row._getMegaStats = ()=>({...statVals});

    // ---- Dedicated Mega Custom Ability + Special Mega Move Slots reuse the exact same repeater builders
    // as the base creature's Ability/Move panels, just pointed at this profile's own containers ----
    const megaAbilityFieldsEl = row.querySelector(`.${prefix}-ability-list`);
    const megaMoveFieldsEl = row.querySelector(`.${prefix}-move-list`);
    if(data.ability) addAbilityRow(data.ability, megaAbilityFieldsEl);
    row.querySelector(`.${prefix}-add-ability-btn`).addEventListener("click", ()=>{
      // ---- "Dedicated" (singular) Mega Ability per profile: clear any existing row first ----
      megaAbilityFieldsEl.innerHTML = "";
      addAbilityRow(null, megaAbilityFieldsEl);
    });
    (data.moves||[]).forEach(m=>addMoveRow(m, megaMoveFieldsEl));
    row.querySelector(`.${prefix}-add-move-btn`).addEventListener("click", ()=>addMoveRow(null, megaMoveFieldsEl));
    row.querySelector(`.${prefix}-import-ability-btn`).addEventListener("click", ()=>openImportPicker("ability", megaAbilityFieldsEl, true));
    row.querySelector(`.${prefix}-import-move-btn`).addEventListener("click", ()=>openImportPicker("move", megaMoveFieldsEl, false));

    // ---- Activation Requirement: show only the fields relevant to the chosen requirement type ----
    function syncActivationRows(){
      const req = row.querySelector(`.${prefix}-act-requirement`).value;
      row.querySelector(`.${prefix}-act-move-row`).style.display = req==="triggerMove" ? "flex" : "none";
      row.querySelector(`.${prefix}-act-turn-row`).style.display = req==="turnThreshold" ? "flex" : "none";
      row.querySelector(`.${prefix}-act-label-row`).style.display = req==="triggerEffect" ? "flex" : "none";
    }
    row.querySelector(`.${prefix}-act-requirement`).addEventListener("change", syncActivationRows);
    syncActivationRows();

    // ---- Collapsible Builder Block: starts collapsed whenever we're populating an EXISTING profile (has
    // a name already), and left expanded for a freshly-added blank one so it can be filled in right away —
    // same UX rule now applied to Ability/Move rows below. ----
    if(data.name) row.classList.add("dyn-row-collapsed");
    wireRowCollapse(row, ()=> row.querySelector(`.${prefix}-name`).value.trim() || "Untitled Mega Form");
    row.querySelector(`.${prefix}-name`).addEventListener("input", (ev)=>{ row.querySelector(`.${prefix}-name-top`).value = ev.target.value; });

    targetEl.appendChild(row);
    return row;
  }
  document.getElementById("addMegaProfileBtn").addEventListener("click", ()=>addMegaProfileRow());

  function resetMegaProfiles(){ megaProfilesEl.innerHTML = ""; }
  function populateMegaProfiles(megas){
    megaProfilesEl.innerHTML = "";
    (megas||[]).forEach(mg=>addMegaProfileRow(mg));
  }
  function collectMegas(containerEl){
    containerEl = containerEl || megaProfilesEl;
    return [...containerEl.querySelectorAll(":scope > .dyn-row")].map(row=>{
      const p = row.dataset.megaPrefix;
      return normalizeMegaProfile({
        id: row.dataset.megaId,
        enabled: true,
        name: row.querySelector(`.${p}-name`).value.trim(),
        transformVerb: row.querySelector(`.${p}-transformverb`).value,
        kind: row.querySelector(`.${p}-kind`).value,
        emoji: row._getMegaEmoji(),
        types: row._getMegaTypes(),
        stats: row._getMegaStats(),
        ability: (collectAbilities(row.querySelector(`.${p}-ability-list`))[0]) || null,
        moves: collectMoves(row.querySelector(`.${p}-move-list`)),
        desc: row.querySelector(`.${p}-desc`).value.trim(),
        images: row._getMegaImages(),
        activation: {
          requirement: row.querySelector(`.${p}-act-requirement`).value,
          triggerMoveName: row.querySelector(`.${p}-act-movename`).value.trim(),
          turnThreshold: Number(row.querySelector(`.${p}-act-turn`).value),
          triggerLabel: row.querySelector(`.${p}-act-label`).value.trim(),
          requiredItem: row.querySelector(`.${p}-act-requireditem`).value
        },
        durationLimit: Number(row.querySelector(`.${p}-duration-limit`).value),
        reuseCooldown: Number(row.querySelector(`.${p}-reuse-cooldown`).value)
      });
    }).filter(mg=>mg.name);
  }

  // ================= COMMUNITY "ADD A FORM" MODAL =================
  // The "anyone can add a Mega/Alt Form" feature — reuses the exact same
  // row builder as the base entry owner's own Mega Profiles editor above,
  // just pointed at this modal's own container instead of the big creature
  // form, and saved to a separate Firestore subcollection (js/forms-sync.js)
  // that never touches the base entry's own document.
  const formEditorOverlay = document.getElementById("formEditorOverlay");
  const formEditorRowContainer = document.getElementById("formEditorRowContainer");
  const formEditorTitle = document.getElementById("formEditorTitle");
  let formEditorBaseEntryId = null;
  let formEditorExistingFormId = null;
  let formEditorExistingCreatorUid = null;

  function openFormEditor(baseEntryId, existingRawForm){
    if(!window.currentUser){ alert("Log in to add a form."); return; }
    formEditorBaseEntryId = baseEntryId;
    formEditorExistingFormId = existingRawForm ? existingRawForm.id : null;
    formEditorExistingCreatorUid = existingRawForm ? existingRawForm.creatorUid : null;
    formEditorTitle.textContent = existingRawForm ? "Edit This Form" : "Add a Form";
    formEditorRowContainer.innerHTML = "";
    addMegaProfileRow(existingRawForm || null, formEditorRowContainer);
    formEditorOverlay.classList.add("open");
  }
  window.openFormEditor = openFormEditor;

  function closeFormEditor(){ formEditorOverlay.classList.remove("open"); }
  document.getElementById("closeFormEditor").addEventListener("click", closeFormEditor);
  document.getElementById("cancelFormEditor").addEventListener("click", closeFormEditor);
  formEditorOverlay.addEventListener("click", (e)=>{ if(e.target===formEditorOverlay) closeFormEditor(); });

  document.getElementById("saveFormEditor").addEventListener("click", async ()=>{
    const rows = collectMegas(formEditorRowContainer);
    const formData = rows[0];
    if(!formData){ alert("This form needs a name before it can be saved."); return; }
    if(formEditorExistingFormId) formData.creatorUid = formEditorExistingCreatorUid;

    const btn = document.getElementById("saveFormEditor");
    btn.disabled = true; const originalLabel = btn.textContent; btn.textContent = "Saving…";
    try{
      await window.FormsSync.saveForm(formEditorBaseEntryId, formData, formEditorExistingFormId);
      closeFormEditor();
      await window.FormsSync.loadAllForms();
      location.hash = "#/dex/" + formEditorBaseEntryId;
    }catch(err){
      console.error("❌ Error saving form:", err);
      alert(err.message || "Couldn't save this form.");
    }finally{
      btn.disabled = false; btn.textContent = originalLabel;
    }
  });
  // ============================================================

  // ================= SUGGEST SOMETHING MODAL =================
  const suggestOverlay = document.getElementById("suggestOverlay");
  let suggestBaseEntryId = null;
  let suggestType = "mega";

  // ---- Evolution suggestion's Type 1/2 selects (a plain pair of dropdowns, deliberately NOT sharing
  // the big form's type-grid/selectedTypes state — this is a separate, independent draft) ----
  const sugEvoType1 = document.getElementById("sug-evo-type1");
  const sugEvoType2 = document.getElementById("sug-evo-type2");
  sugEvoType1.innerHTML += typeOptionsHtml();
  sugEvoType2.innerHTML += typeOptionsHtml();

  // ---- Evolution suggestion's ballpark stats: plain number inputs, not the slider system, since this
  // is just a rough pitch — the creator refines real numbers when they publish the accepted concept ----
  const sugEvoStatsGrid = document.getElementById("sugEvoStatsGrid");
  const sugEvoStatInputs = {};
  STAT_KEYS.forEach(([key,label])=>{
    const wrap = document.createElement("div"); wrap.className = "stat-field-mini";
    wrap.innerHTML = `<label>${label}</label><input type="number" min="1" max="255" value="50">`;
    sugEvoStatsGrid.appendChild(wrap);
    sugEvoStatInputs[key] = wrap.querySelector("input");
  });

  // ---- Reuse the same generalized image-slot picker as Mega Forms for both the Art suggestion's 4
  // slots and the Evolution suggestion's smaller 2-slot art preview ----
  const suggestArtPicker = wireImageSlotPicker(document.getElementById("suggestArtSection"), "sugart", null);
  const suggestEvoArtPicker = wireImageSlotPicker(document.getElementById("suggestEvolutionSection"), "sugevo", null);

  function setSuggestType(type){
    suggestType = type;
    document.querySelectorAll("#suggestTypeTabs .auth-tab").forEach(btn=>btn.classList.toggle("active", btn.dataset.type===type));
    document.getElementById("suggestMegaSection").style.display = type==="mega" ? "block" : "none";
    document.getElementById("suggestEvolutionSection").style.display = type==="evolution" ? "block" : "none";
    document.getElementById("suggestArtSection").style.display = type==="art" ? "block" : "none";
  }
  document.querySelectorAll("#suggestTypeTabs .auth-tab").forEach(btn=>{
    btn.addEventListener("click", ()=>setSuggestType(btn.dataset.type));
  });

  function openSuggestModal(baseEntryId){
    if(!window.currentUser){ alert("Log in to suggest something."); return; }
    suggestBaseEntryId = baseEntryId;
    setSuggestType("mega");
    document.getElementById("suggestMegaContainer").innerHTML = "";
    addMegaProfileRow(null, document.getElementById("suggestMegaContainer"));
    document.getElementById("sug-evo-name").value = "";
    document.getElementById("sug-evo-category").value = "";
    document.getElementById("sug-evo-method").value = "";
    document.getElementById("sug-evo-desc").value = "";
    STAT_KEYS.forEach(([key])=>{ sugEvoStatInputs[key].value = 50; });
    document.getElementById("suggestNote").value = "";
    suggestOverlay.classList.add("open");
  }
  window.openSuggestModal = openSuggestModal;

  function closeSuggestModal(){ suggestOverlay.classList.remove("open"); }
  document.getElementById("closeSuggestModal").addEventListener("click", closeSuggestModal);
  document.getElementById("cancelSuggestModal").addEventListener("click", closeSuggestModal);
  suggestOverlay.addEventListener("click", (e)=>{ if(e.target===suggestOverlay) closeSuggestModal(); });

  document.getElementById("submitSuggestion").addEventListener("click", async ()=>{
    const note = document.getElementById("suggestNote").value.trim();
    let payload = { type: suggestType, note };

    if(suggestType === "mega"){
      const rows = collectMegas(document.getElementById("suggestMegaContainer"));
      const megaData = rows[0];
      if(!megaData || !megaData.name){ alert("This form needs a name before it can be sent."); return; }
      payload.megaData = megaData;
    } else if(suggestType === "evolution"){
      const name = document.getElementById("sug-evo-name").value.trim();
      if(!name){ alert("The evolved form needs a name before it can be sent."); return; }
      const types = [sugEvoType1.value, sugEvoType2.value].filter(Boolean);
      const stats = {}; STAT_KEYS.forEach(([key])=>{ stats[key] = Number(sugEvoStatInputs[key].value) || 50; });
      payload.evolutionDraft = {
        name, category: document.getElementById("sug-evo-category").value.trim(),
        types, stats,
        preEvoMethod: document.getElementById("sug-evo-method").value.trim(),
        desc: document.getElementById("sug-evo-desc").value.trim(),
        images: suggestEvoArtPicker.getImages()
      };
    } else if(suggestType === "art"){
      const images = suggestArtPicker.getImages();
      if(!images.pixel && !images.artwork){ alert("Add at least one image before sending this suggestion."); return; }
      payload.imagesData = images;
    }

    const btn = document.getElementById("submitSuggestion");
    btn.disabled = true; const originalLabel = btn.textContent; btn.textContent = "Sending…";
    try{
      await window.SuggestionsSync.submitSuggestion(suggestBaseEntryId, payload);
      closeSuggestModal();
      alert("Suggestion sent! The creator will see it on this entry's page.");
    }catch(err){
      console.error("❌ Error sending suggestion:", err);
      alert(err.message || "Couldn't send this suggestion.");
    }finally{
      btn.disabled = false; btn.textContent = originalLabel;
    }
  });
  // ============================================================

  // ================= MY SUGGESTIONS PANEL (Settings) =================
  function renderMySuggestions(){
    const block = document.getElementById("mySuggestionsBlock");
    const list = document.getElementById("mySuggestionsList");
    if(!block || !list) return;
    const mine = window.mySuggestions || [];
    if(!window.currentUser || !mine.length){ block.style.display = "none"; return; }
    block.style.display = "block";

    list.innerHTML = mine.map(s=>{
      const baseEntry = entries.find(e=>e.id===s.baseEntryId);
      const entryName = baseEntry ? baseEntry.name : "an entry";
      const title = s.type==="mega" ? (s.megaData&&s.megaData.name) : s.type==="evolution" ? (s.evolutionDraft&&s.evolutionDraft.name) : "Art suggestion";
      let statusLine, actionBtn = "";
      if(s.status==="pending") statusLine = `Waiting on ${esc(entryName)}'s creator`;
      else if(s.status==="rejected") statusLine = `Declined for ${esc(entryName)}`;
      else if(s.status==="accepted" && s.type==="evolution"){
        statusLine = `🎉 Accepted for ${esc(entryName)} — publish it to make it official`;
        actionBtn = `<button type="button" class="btn-primary publish-evolution-btn" data-id="${esc(s.id)}">Publish as New Entry</button>`;
      } else if(s.status==="accepted"){
        statusLine = `✅ Accepted — now live on ${esc(entryName)}'s page`;
      }
      return `
        <div style="background:var(--ink-2);border:1px solid var(--line);border-radius:10px;padding:10px 12px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;" data-suggestion-id="${esc(s.id)}">
          <div>
            <b>${esc(title || "Untitled")}</b>
            <div style="color:var(--slate);font-size:12px;">${statusLine}</div>
          </div>
          <div style="display:flex;gap:6px;">
            ${actionBtn}
            ${s.status==="pending" ? `<button type="button" class="btn-secondary withdraw-suggestion-btn" data-id="${esc(s.id)}">Withdraw</button>` : ``}
          </div>
        </div>`;
    }).join("");

    list.querySelectorAll(".withdraw-suggestion-btn").forEach(btn=>{
      btn.addEventListener("click", async ()=>{
        const s = mine.find(x=>x.id===btn.dataset.id);
        if(!s || !confirm("Withdraw this suggestion?")) return;
        try{ await window.SuggestionsSync.withdrawSuggestion(s); }
        catch(err){ console.error(err); alert(err.message || "Couldn't withdraw this suggestion."); }
      });
    });
    list.querySelectorAll(".publish-evolution-btn").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const s = mine.find(x=>x.id===btn.dataset.id);
        if(s) publishAcceptedEvolution(s);
      });
    });
  }
  window.renderMySuggestions = renderMySuggestions;

  /**
   * "Publish as New Entry" for an accepted evolution suggestion. Firestore
   * rules mean only the suggestion's own author can be the creatorUid of a
   * brand new entries/ doc — so this is what actually makes the suggester
   * the entry's real, credited creator, rather than the accepting owner
   * creating it on their behalf. Auto-fills the fields we're 100% sure of
   * (name/category/desc/pre-evolution link+method/images); types and base
   * stats are shown back to the person so they can drop them into the type
   * grid and stat sliders themselves, rather than risk silently mis-filling
   * either through a guessed field mapping.
   */
  function publishAcceptedEvolution(suggestion){
    const baseEntry = entries.find(e=>e.id===suggestion.baseEntryId);
    const draft = suggestion.evolutionDraft || {};
    openAdd(baseEntry ? baseEntry.regionId : undefined);

    document.getElementById("f-name").value = draft.name || "";
    document.getElementById("f-category").value = draft.category || "";
    document.getElementById("f-desc").value = draft.desc || "";
    if(draft.images){
      document.getElementById("f-image-pixel").value = draft.images.pixel || "";
      document.getElementById("f-image").value = draft.images.artwork || "";
      refreshIconPreview();
    }
    if(baseEntry){
      const preEvoSelect = document.getElementById("f-preevo");
      preEvoSelect.value = String(baseEntry.id);
      preEvoSelect.dispatchEvent(new Event("change"));
      const evoType = document.getElementById("f-preevo-type");
      const evoValue = document.getElementById("f-preevo-value");
      const method = (draft.preEvoMethod||"").toLowerCase();
      evoType.value = /item|stone|trade/.test(method) ? "item" : "level";
      evoValue.value = draft.preEvoMethod || "";
    }

    const statsList = STAT_KEYS.map(([key,label])=>`${label} ${draft.stats && draft.stats[key] || 50}`).join(", ");
    const typesList = (draft.types||[]).map(t=>cap(t)).join(" / ") || "(none set)";
    alert(`Name, description, evolution link, and art are filled in for you.\n\nSet these yourself in the form:\nTypes: ${typesList}\nSuggested stats: ${statsList}\n\nAdd any abilities/moves, then hit Save — this entry will be yours.`);
  }
  // ============================================================

  // ================= FORM: ABILITY / MOVE REPEATERS =================
  const abilityFieldsEl = document.getElementById("abilityFields");
  const moveFieldsEl = document.getElementById("moveFields");
  const tagMatchupFieldsEl = document.getElementById("tagMatchupFields");

  // ---- Dynamic Multi-Effect Sequence Array: one reusable nested-row builder shared by Moves + Abilities ----
  function createEffectNode(listEl, data){
    data = normalizeEffect(data || {});
    const row = document.createElement("div"); row.className = "dyn-row effect-row";
    row.innerHTML = `
      <div class="dyn-row-top">
        <select class="fx-type">${EFFECT_TYPES.map(([v,l])=>`<option value="${v}" ${v===data.type?"selected":""}>${l}</option>`).join("")}</select>
        <select class="fx-target">${HEAL_TARGETS.map(([v,l])=>`<option value="${v}" ${v===data.target?"selected":""}>${l}</option>`).join("")}</select>
        <button type="button" class="dyn-row-remove" title="Remove effect">×</button>
      </div>
      <div class="rule-row fx-hazard-row">
        <label class="rule-label">Hazard</label>
        <select class="fx-hazardtype">${HAZARD_TYPES.map(([v,l])=>`<option value="${v}" ${v===data.hazardType?"selected":""}>${l}</option>`).join("")}</select>
      </div>
      <div class="rule-row fx-heal-row">
        <label class="rule-label">Heal Amount</label>
        <div class="heal-toggle fx-healtype">
          <button type="button" data-v="percent" class="${data.healType==="percent"?"picked":""}">[% Base]</button>
          <button type="button" data-v="flat" class="${data.healType==="flat"?"picked":""}">[Flat #]</button>
        </div>
        <input type="number" class="fx-healvalue" min="0" step="1" value="${data.healValue}">
      </div>
      <div class="rule-row fx-statmod-row">
        <label class="rule-label">Stat / Stage</label>
        <select class="fx-statkey">${STAT_STAGE_KEYS.map(([v,l])=>`<option value="${v}" ${v===data.statKey?"selected":""}>${l}</option>`).join("")}</select>
        <select class="fx-statstage">${STAT_STAGE_VALUES.map(v=>`<option value="${v}" ${v===data.statStage?"selected":""}>${v>0?"+"+v:v}</option>`).join("")}</select>
      </div>
      <div class="field fx-omniboost-row">
        <label class="rule-label">Stats to Modify Together (pick 2+ — all fire off this ONE roll, same direction) / Stage</label>
        <div class="type-checks fx-omniboost-statkeys">
          ${STAT_STAGE_KEYS.map(([v,l])=>`<label class="type-check"><input type="checkbox" class="fx-omniboost-statkey" value="${v}" ${(data.statKeys||[]).includes(v)?"checked":""}> ${l}</label>`).join("")}
        </div>
        <select class="fx-omniboost-stage">${STAT_STAGE_VALUES.map(v=>`<option value="${v}" ${v===data.statStage?"selected":""}>${v>0?"+"+v:v}</option>`).join("")}</select>
      </div>
      <div class="rule-row fx-weightmod-row">
        <label class="rule-label">Modify Weight By (kg, temporary battle weight)</label>
        <input type="number" class="fx-weightmod-value" step="1" value="${data.weightModValue}">
      </div>
      <div class="rule-row fx-accuracymod-row">
        <label class="rule-label">Modify Accuracy By % (negative lowers hit chance, positive raises it — applies to the Target's own accuracy for the rest of the battle)</label>
        <input type="number" class="fx-accuracymod-value" min="-100" max="100" step="5" value="${data.accuracyModValue}">
      </div>
      <div class="rule-row fx-clearstatmod-row">
        <label class="rule-label">Clear Stat Modifiers</label>
        <select class="fx-clearstatmod-mode">${CLEAR_STATMOD_MODES.map(([v,l])=>`<option value="${v}" ${v===data.clearStatModMode?"selected":""}>${l}</option>`).join("")}</select>
      </div>
      <div class="rule-row fx-clearhazards-row">
        <label class="rule-label">Clear Field Hazards</label>
        <select class="fx-clearhazards-scope">${HAZARD_CLEAR_SCOPES.map(([v,l])=>`<option value="${v}" ${v===data.hazardClearScope?"selected":""}>${l}</option>`).join("")}</select>
      </div>
      <div class="rule-row fx-switchout-row">
        <label class="rule-label">Switch Out (Team / Random Battle only)</label>
        <select class="fx-switch-target" title="Who leaves the field. Resolves after the move, so a damaging move still hits first.">${SWITCH_TARGETS.map(([v,l])=>`<option value="${v}" ${v===data.switchTarget?"selected":""}>${l}</option>`).join("")}</select>
        <select class="fx-switch-pick" title="How the replacement is chosen">${SWITCH_PICKS.map(([v,l])=>`<option value="${v}" ${v===data.switchPick?"selected":""}>${l}</option>`).join("")}</select>
      </div>
      <div class="rule-row fx-clearstatus-row">
        <label class="rule-label">Cure Status Condition(s)</label>
        <select class="fx-clearstatus-scope">${STATUS_CLEAR_SCOPES.map(([v,l])=>`<option value="${v}" ${v===data.statusClearScope?"selected":""}>${l}</option>`).join("")}</select>
      </div>
      <div class="rule-row fx-ppcost-row">
        <label class="rule-label">Increase Target's Selected Move PP Cost By (Spite)</label>
        <input type="number" class="fx-ppspite-amount" min="0" step="1" value="${data.ppSpiteAmount}">
      </div>
      <div class="rule-sub fx-shield-row">
        <p class="rule-sub-title">Generate Shield</p>
        <div class="rule-row">
          <label class="rule-label">Hit Count Capacity (direct attacks absorbed before breaking)</label>
          <input type="number" class="fx-shield-capacity" min="1" step="1" value="${data.shieldHitCapacity}">
        </div>
        <div class="rule-row">
          <label class="rule-label">Blocks Hits Of Category</label>
          <select class="fx-shield-triggertype">${SHIELD_TRIGGER_TYPES.map(([v,l])=>`<option value="${v}" ${v===data.shieldTriggerType?"selected":""}>${l}</option>`).join("")}</select>
        </div>
        <div class="rule-row">
          <label class="rule-label">Blocks Hits Of Type</label>
          <select class="fx-shield-typefilter">${SHIELD_TYPE_FILTERS.map(([v,l])=>`<option value="${v}" ${v===data.shieldTypeFilter?"selected":""}>${l}</option>`).join("")}</select>
        </div>
        <div class="rule-row">
          <label class="dyn-hidden-check"><input type="checkbox" class="fx-shield-unignorable" ${data.shieldUnignorable?"checked":""}> Unignorable Shield (Bypass Protection Override — this shield can never be skipped by a move's "Ignore Defenses/Shields" attribute)</label>
        </div>
        <p class="rule-sub-title" style="margin-top:6px;">Reactive Trigger (Punish An Attacker On Block)</p>
        <div class="rule-row">
          <label class="rule-label">Reaction</label>
          <select class="fx-shield-reaction">${SHIELD_REACTION_TYPES.map(([v,l])=>`<option value="${v}" ${v===data.shieldReaction?"selected":""}>${l}</option>`).join("")}</select>
        </div>
        <div class="rule-row fx-shield-reaction-damage-row">
          <label class="rule-inline-label">Reflects <input type="number" class="fx-shield-reaction-value" min="0" step="0.5" value="${data.shieldReactionValue}"> % of Owner's Max HP onto the attacker</label>
        </div>
        <div class="rule-row fx-shield-reaction-status-row">
          <label class="rule-label">Inflict Status</label>
          <select class="fx-shield-reaction-status">${STATUS_EFFECTS.filter(s=>s[0]!=="none").map(([v,l])=>`<option value="${v}" ${v===data.shieldReactionStatus?"selected":""}>${l}</option>`).join("")}</select>
          <label class="rule-inline-label">Chance % <input type="number" class="fx-shield-reaction-chance" min="0" max="100" step="5" value="${data.shieldReactionChance}"></label>
        </div>
        <div class="rule-row fx-shield-reaction-scope-row">
          <label class="dyn-hidden-check"><input type="checkbox" class="fx-shield-reaction-contactonly" ${data.shieldReactionContactOnly?"checked":""}> Contact Only (the reaction only fires against incoming moves tagged "contact" — leave unchecked to also punish ranged/special hits)</label>
        </div>
        <div class="rule-row">
          <label class="rule-inline-label">Shield Duration <input type="number" class="fx-shield-duration" min="0" step="1" value="${data.shieldDuration}"> Turns (0 = no turn limit, only hit capacity matters)</label>
        </div>
        <div class="rule-row">
          <label class="rule-label">Shield Element Weakness (a move of this type shatters the shield instantly, regardless of remaining hits)</label>
          <select class="fx-shield-weakness">
            <option value="none" ${data.shieldWeaknessType==="none"?"selected":""}>— None —</option>
            ${TYPES.map(t=>`<option value="${t}" ${t===data.shieldWeaknessType?"selected":""}>${cap(t)}</option>`).join("")}
          </select>
        </div>
        <div class="rule-row">
          <label class="rule-label">Vulnerable to Tags (comma-separated custom tags — any of these present on the incoming move's own Tags field triggers the Tag Vulnerability Outcome below, independent of the Type filter above)</label>
          <input type="text" class="fx-shield-vulntags" placeholder="e.g. contact, sound" value="${esc((data.vulnerableToTags||[]).join(", "))}">
        </div>
        <div class="rule-row">
          <label class="rule-label">Tag Vulnerability Outcome</label>
          <select class="fx-shield-vulnoutcome">${SHIELD_VULN_OUTCOMES.map(([v,l])=>`<option value="${v}" ${v===data.vulnerableTagOutcome?"selected":""}>${l}</option>`).join("")}</select>
        </div>
        <div class="rule-row fx-shield-vulnbonus-row">
          <label class="rule-inline-label">Bonus Hits/Durability Removed <input type="number" class="fx-shield-vulnbonus" min="1" step="1" value="${data.vulnerableTagBonusHits}"> (on top of the normal 1 hit, for tagged hits under Bonus Depletion)</label>
        </div>
        <div class="rule-row fx-shield-vulnmult-row">
          <label class="rule-inline-label">Tagged-Hit Durability Damage Multiplier <input type="number" class="fx-shield-vulnmult" min="0" step="0.1" value="${data.vulnerableTagMultiplier}"> (for tagged hits under Damage Multiplier)</label>
        </div>
      </div>
      <div class="rule-row fx-statmoddur-row">
        <label class="rule-label">Stat Modification Duration (Turns, 0 = Permanent)</label>
        <input type="number" class="fx-statmod-duration" min="0" step="1" value="${data.statModDuration}">
        <div class="heal-toggle fx-statmod-expiremode">
          <button type="button" data-v="decay" class="${data.statModExpireMode==="decay"?"picked":""}">[ Decay / Disappear ]</button>
          <button type="button" data-v="revert" class="${data.statModExpireMode==="revert"?"picked":""}">[ Revert to Original ]</button>
        </div>
      </div>
      <div class="rule-row fx-status-row">
        <label class="rule-label">Status</label>
        <select class="fx-statuseffect">${STATUS_EFFECTS.filter(s=>s[0]!=="none").map(([v,l])=>`<option value="${v}" ${v===data.statusEffect?"selected":""}>${l}</option>`).join("")}</select>
        <div class="heal-toggle fx-statusdurmode">
          <button type="button" data-v="random" class="${data.statusDurationMode==="random"?"picked":""}">[Random Range]</button>
          <button type="button" data-v="fixed" class="${data.statusDurationMode==="fixed"?"picked":""}">[Fixed Turns]</button>
        </div>
        <label class="rule-inline-label fx-statusdur-random">Min <input type="number" class="fx-statusdur-min" min="1" step="1" value="${data.statusDurationMin}"></label>
        <label class="rule-inline-label fx-statusdur-random">Max <input type="number" class="fx-statusdur-max" min="1" step="1" value="${data.statusDurationMax}"></label>
        <label class="rule-inline-label fx-statusdur-fixedwrap">Turns <input type="number" class="fx-statusdur-fixed" min="1" step="1" value="${data.statusDurationFixed}"></label>
        <label class="rule-inline-label">Mirror Damage Reflection % <input type="number" class="fx-mirrorpercent" min="0" max="100" step="5" value="${data.mirrorReflectPercent}" title="Only used when Status = Mirror Stance"></label>
        <div class="rule-row" style="margin-top:8px;">
          <label class="dyn-hidden-check"><input type="checkbox" class="fx-statusfallback-enabled" ${data.statusFallbackEnabled?"checked":""}> If It Can't Be Statused (already has a status, or is immune), Do This Instead:</label>
        </div>
        <div class="rule-row fx-statusfallback-fields-row">
          <label class="rule-label">Fallback Stat / Stage</label>
          <select class="fx-statusfallback-statkey">${STAT_STAGE_KEYS.map(([v,l])=>`<option value="${v}" ${v===data.statusFallbackStatKey?"selected":""}>${l}</option>`).join("")}</select>
          <select class="fx-statusfallback-statstage">${STAT_STAGE_VALUES.map(v=>`<option value="${v}" ${v===data.statusFallbackStatStage?"selected":""}>${v>0?"+"+v:v}</option>`).join("")}</select>
        </div>
      </div>
      <div class="rule-sub fx-evade-row">
        <p class="rule-sub-title">Evade Inaccurate Attacks</p>
        <div class="field-hint">For the chosen number of turns (this turn counts), any attack aimed at the user whose Accuracy is BELOW the % you set automatically misses. 100 = every attack that is not 100% accurate. Never-miss moves, and targets of "Root Down", are not dodged. Add a Speed stat-stage effect to the same move for a "speed up + dodge" move. Always affects the user.</div>
        <div class="rule-row"><label class="rule-label">Turns</label><input type="number" class="fx-evade-turns" min="1" max="10" value="${data.evadeTurns}"></div>
        <div class="rule-row"><label class="rule-label">Dodge attacks with accuracy below (%)</label><input type="number" class="fx-evade-below" min="1" max="100" value="${data.evadeBelowAcc}"></div>
      </div>
      <div class="rule-sub fx-root-row">
        <p class="rule-sub-title">Root Down</p>
        <div class="field-hint">Pins the target for the chosen number of turns (this turn counts). "Forces grounded": it counts as grounded whatever its type or tags (Terrain applies, Ground-type moves can hit Flying types, any lift ends). "Accuracy checks skipped": every move used against it ignores accuracy and dodging, so its dodge rate is effectively 0%. Pick the target above (Opponent = Root Down).</div>
        <div class="rule-row"><label class="rule-label">Turns</label><input type="number" class="fx-root-turns" min="1" max="10" value="${data.rootTurns}"></div>
        <div class="rule-row"><label class="rule-label">Forces grounded</label><input type="checkbox" class="fx-root-ground" ${data.rootGround!==false?"checked":""}></div>
        <div class="rule-row"><label class="rule-label">Accuracy checks skipped (can't dodge)</label><input type="checkbox" class="fx-root-sure" ${data.rootSureHit!==false?"checked":""}></div>
      </div>
      <div class="rule-sub fx-bond-row">
        <p class="rule-sub-title">Bond</p>
        <div class="field-hint">Links the user to the CURRENT opponent. Tick the checks you want: On Faint (if the foe knocks the user out, the foe faints too — Destiny Bond), On Damage (the foe takes a % of the damage it deals to the user), On Status (a status the user gets is also given to the foe). The bond ends when the turns run out, the user faints, or either Fakemon leaves the field.</div>
        <div class="rule-row"><label class="rule-label">Bond Turns (this turn counts)</label><input type="number" class="fx-bond-turns" min="1" max="10" value="${data.bondTurns}"></div>
        <div class="rule-row"><label class="rule-label">Check: On Faint</label><input type="checkbox" class="fx-bond-faint" ${data.bondOnFaint!==false?"checked":""}></div>
        <div class="rule-row"><label class="rule-label">Check: On Damage</label><input type="checkbox" class="fx-bond-damage" ${data.bondOnDamage?"checked":""}> <input type="number" class="fx-bond-damagepct" min="1" max="100" value="${data.bondDamagePct}"> % shared</div>
        <div class="rule-row"><label class="rule-label">Check: On Status</label><input type="checkbox" class="fx-bond-status" ${data.bondOnStatus?"checked":""}></div>
      </div>
      <div class="rule-sub fx-metronome-row">
        <p class="rule-sub-title">Metronome</p>
        <div class="field-hint">When this move is used, it is replaced by a random move taken from EVERY Fakemon in the roster (never another Metronome or Snatch move). The chosen move runs exactly as normal with the user's own stats. This move pays the PP.</div>
        <div class="rule-row"><label class="rule-label">Pick From</label><select class="fx-metronome-pool"><option value="roster" ${data.metronomePool!=="own"?"selected":""}>Every move in the whole roster (Metronome)</option><option value="own" ${data.metronomePool==="own"?"selected":""}>Only this Fakemon's own other moves (Assist / Sleep Talk-style)</option></select></div>
      </div>
      <div class="rule-sub fx-substitute-row">
        <p class="rule-sub-title">Substitute</p>
        <div class="field-hint">The user pays this % of its max HP to put up a decoy with that much HP. Damaging hits hit the decoy instead (moves that Ignore Defenses/Shields still hit the user), and harmful effects aimed at the user (stat drops, statuses...) are blocked while it stands. It fails if the user has too little HP or already has one. Lost on switching out. Always affects the user.</div>
        <div class="rule-row"><label class="rule-label">HP Cost % (of max HP)</label><input type="number" class="fx-sub-pct" min="1" max="50" value="${data.subHpPct}"></div>
      </div>
      <div class="rule-sub fx-lift-row">
        <p class="rule-sub-title">Lift / Airborne</p>
        <div class="field-hint">The target floats off the ground for the chosen number of turns (this turn counts): Terrain effects skip it. When it ends, the log says "&lt;move&gt; wears off, &lt;name&gt; is back on the ground!". Pick the target above: Self = Magnetic Lift, Opponent = Telekinesis. Add "grounded" to this move's "Fails Against Fakemon Tags" so a buried Fakemon can't be lifted (set "Check the user's tags" for a self-lift).</div>
        <div class="rule-row"><label class="rule-label">Turns Airborne</label><input type="number" class="fx-lift-turns" min="1" max="10" value="${data.liftTurns}"></div>
        <div class="rule-row"><label class="rule-label">Immune to Ground-type moves while airborne</label><input type="checkbox" class="fx-lift-ground" ${data.liftGroundImmune!==false?"checked":""}></div>
      </div>
      <div class="rule-sub fx-doom-row">
        <p class="rule-sub-title">Doom Countdown</p>
        <div class="field-hint">The target faints at the end of its Nth turn (this turn counts) unless it switches out, which saves it. The bot switches doomed Fakemon out as a top priority. Pick the target above (Opponent = Perish Song-style on the foe).</div>
        <div class="rule-row"><label class="rule-label">Turns Until Faint</label><input type="number" class="fx-doom-turns" min="1" max="10" value="${data.doomTurns}"></div>
      </div>
      <div class="rule-sub fx-wish-row">
        <p class="rule-sub-title">Wish</p>
        <div class="field-hint">The user's side heals this % of max HP after the chosen number of turns. The heal goes to whoever is on the field then, so switching passes it on. Always affects the user's side.</div>
        <div class="rule-row"><label class="rule-label">Heal % of Max HP</label><input type="number" class="fx-wish-pct" min="1" max="100" value="${data.wishPct}"></div>
        <div class="rule-row"><label class="rule-label">After How Many Turns</label><input type="number" class="fx-wish-turns" min="1" max="10" value="${data.wishTurns}"></div>
      </div>
      <div class="rule-sub fx-revive-row">
        <p class="rule-sub-title">Revive a Fainted Teammate</p>
        <div class="field-hint">Team battles only. Revives one fainted teammate at this % of its max HP. The bot picks the strongest fainted teammate (highest total stats). Always affects the user's side.</div>
        <div class="rule-row"><label class="rule-label">Revive HP %</label><input type="number" class="fx-revive-pct" min="1" max="100" value="${data.revivePct}"></div>
      </div>
      <div class="rule-sub fx-snatch-row">
        <p class="rule-sub-title">Snatch</p>
        <div class="field-hint">Until the end of the turn, the user steals the foe's next STATUS move: that move's Additional Effects apply to the user instead, and the foe's turn is spent. Give this move a high Priority (e.g. +4) so it goes first. Only the stolen move's Additional Effects are copied.</div>
      </div>
      <div class="rule-sub fx-switchin-row">
        <p class="rule-sub-title">Switch In</p>
        <div class="field-hint">The Fakemon that owns this ability forcibly enters the field right after the current action, replacing the active teammate. Only works on an ability whose Trigger is "When a Teammate Takes a Huge Hit" (it fires from the bench), in team battles.</div>
      </div>
      <div class="rule-sub fx-triggerform-row">
        <p class="rule-sub-title">Trigger Alternate Form</p>
        <div class="field-hint">When this effect fires, the user switches into one of its OWN alternate forms (a form whose Activation Requirement is "Trigger Alternate Form effect"). Nothing is set here, so you can import this move or ability onto any Fakemon that has an alt form. If the user has none, nothing happens. Always affects the user.</div>
        <div class="rule-row">
          <label class="rule-label">Form Label (optional)</label>
          <input type="text" class="fx-triggerform-label" placeholder="e.g. Evolve (leave blank to trigger any alt form)" value="${esc(data.triggerFormLabel)}">
        </div>
      </div>
      <div class="rule-sub fx-changeform-row">
        <p class="rule-sub-title">Change Form in Battle (Standalone Transformation)</p>
        <div class="field-hint">Swaps the target's form the instant this effect fires — no "Allow Mega Evolution" toggle, Mega Bracelet, or Held Item requirement needed. Use this to build moves like Dragon Ascent (Rayquaza-style) or any other move-triggered stance/form change. Leave a field blank/unpicked to keep the fighter's current value for it (e.g. don't pick any Types to keep the current typing); a fighter that's already transformed (Mega or a prior Form Change) can't be transformed again by this effect until it reverts.</div>
        <div class="rule-row">
          <label class="rule-label">Target Form / Alt Form Name</label>
          <input type="text" class="fx-changeform-name" placeholder="e.g. Mega Rayquaza, Sky Forme" value="${esc(data.changeFormName)}">
        </div>
        <div class="rule-row">
          <label class="rule-label">Transformation Log Line Phrase</label>
          <input type="text" class="fx-changeform-verb" placeholder="e.g. transforms into" value="${esc(data.changeFormVerb)}">
        </div>
        <div class="field-hint">Battle log reads "✨ [Fighter] [this phrase] [Form Name]!" — e.g. "✨ Rayquaza transforms into Mega Rayquaza!"</div>
        <label style="margin-top:10px;">New Form Emoji Badge</label>
        <div class="emoji-row fx-changeform-emoji"></div>
        <label style="margin-top:10px;">New Form Image URL / Canvas Placeholder</label>
        <input type="text" class="fx-changeform-image" placeholder="https://… link to form art (optional; falls back to the emoji badge)" value="${esc(data.changeFormImageUrl)}">
        <label style="margin-top:10px;">New Form Types (leave unpicked to keep current typing)</label>
        <div class="type-grid fx-changeform-types"></div>
        <div class="rule-row" style="margin-top:10px;">
          <label class="dyn-hidden-check"><input type="checkbox" class="fx-changeform-statsoverride" ${data.changeFormStats?"checked":""}> Override Base Stats on Transform</label>
        </div>
        <div class="fx-changeform-stats"></div>
        <label style="margin-top:10px;">New Form Ability (optional — replaces the user's ability list while transformed)</label>
        <div class="field-hint">Fully independent from this creature's normal ability list — built with the exact same Ability Rule Builder as a Mega Evolution's Dedicated Mega Ability.</div>
        <div class="dyn-list fx-changeform-ability-list"></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" class="add-row-btn fx-changeform-add-ability-btn">＋ Set Form Ability</button>
          <button type="button" class="add-row-btn fx-changeform-import-ability-btn">⤵ Import from Ability Dex</button>
        </div>
      </div>
      <div class="rule-row rule-chance-row">
        <label class="rule-label">Effect Chance %</label>
        <input type="number" class="fx-chance" min="0" max="100" step="5" value="${data.chance}">
      </div>
      <div class="rule-sub fx-matrix-row">
        <p class="rule-sub-title">Advanced Rule Matrix</p>
        <div class="rule-row">
          <label class="rule-label">WHO</label>
          <select class="fx-who">${MATRIX_WHO.map(([v,l])=>`<option value="${v}" ${v===data.who?"selected":""}>${l}</option>`).join("")}</select>
        </div>
        <div class="rule-row">
          <label class="rule-label">WHAT</label>
          <select class="fx-what">${MATRIX_WHAT.map(([v,l])=>`<option value="${v}" ${v===data.what?"selected":""}>${l}</option>`).join("")}</select>
        </div>
        <div class="rule-row">
          <label class="rule-label">WHEN</label>
          <select class="fx-when">${MATRIX_WHEN.map(([v,l])=>`<option value="${v}" ${v===data.when?"selected":""}>${l}</option>`).join("")}</select>
        </div>
        <div class="rule-row fx-compare-row">
          <label class="dyn-hidden-check"><input type="checkbox" class="fx-compare-enabled" ${data.compareEnabled?"checked":""}> Gate on Stat Comparison</label>
        </div>
        <div class="rule-row fx-compare-fields-row">
          <label class="rule-label">If</label>
          <select class="fx-compare-whoa">${STAT_COMPARE_WHO.map(([v,l])=>`<option value="${v}" ${v===data.compareWhoA?"selected":""}>${l}</option>`).join("")}</select>
          <select class="fx-compare-stata">${STAT_STAGE_KEYS.map(([v,l])=>`<option value="${v}" ${v===data.compareStatA?"selected":""}>${l}</option>`).join("")}</select>
          <select class="fx-compare-op">${STAT_COMPARE_OPS.map(([v,l])=>`<option value="${v}" ${v===data.compareOp?"selected":""}>${l}</option>`).join("")}</select>
          <select class="fx-compare-whob">${STAT_COMPARE_WHO.map(([v,l])=>`<option value="${v}" ${v===data.compareWhoB?"selected":""}>${l}</option>`).join("")}</select>
          <select class="fx-compare-statb">${STAT_STAGE_KEYS.map(([v,l])=>`<option value="${v}" ${v===data.compareStatB?"selected":""}>${l}</option>`).join("")}</select>
        </div>
        <div class="rule-row fx-matrix-statkey-row">
          <label class="rule-label">Stat (for Stat Change)</label>
          <select class="fx-matrix-statkey">${STAT_STAGE_KEYS.map(([v,l])=>`<option value="${v}" ${v===data.matrixStatKey?"selected":""}>${l}</option>`).join("")}</select>
        </div>
        <div class="rule-row fx-matrix-typefilter-row">
          <label class="rule-label">Type (for Type-Damage Multiplier)</label>
          <select class="fx-matrix-typefilter">${TYPES.map(t=>`<option value="${t}" ${t===data.matrixTypeFilter?"selected":""}>${cap(t)}</option>`).join("")}</select>
        </div>
        <div class="rule-row fx-matrix-statusfilter-row">
          <label class="rule-label">Status (for Negate Status / While-Under-Status)</label>
          <select class="fx-matrix-statusfilter">${STATUS_EFFECTS.filter(s=>s[0]!=="none").map(([v,l])=>`<option value="${v}" ${v===data.matrixStatusFilter?"selected":""}>${l}</option>`).join("")}</select>
        </div>
        <div class="rule-row fx-matrix-threshold-row">
          <label class="rule-label">HP % Threshold (for HP Threshold trigger)</label>
          <input type="number" class="fx-matrix-threshold" min="0" max="100" step="5" value="${data.matrixThresholdPct}">
        </div>
        <div class="rule-row">
          <label class="rule-label">HOW (Magnitude Basis)</label>
          <select class="fx-matrix-howbasis">${MATRIX_HOW_BASIS.map(([v,l])=>`<option value="${v}" ${v===data.matrixHowBasis?"selected":""}>${l}</option>`).join("")}</select>
          <input type="number" class="fx-matrix-magnitude" step="0.1" value="${data.matrixMagnitude}" title="Flat magnitude, or multiplier applied to the scaled basis">
        </div>
      </div>
      <div class="rule-sub fx-delayqueue-row">
        <p class="rule-sub-title">Delayed Effect Queue</p>
        <div class="rule-row">
          <label class="rule-label">Trigger</label>
          <div class="heal-toggle fx-delayq-trigger">
            <button type="button" data-v="countdown" class="${data.delayQueueTrigger==="countdown"?"picked":""}">[ Fixed Countdown ]</button>
            <button type="button" data-v="chargeRelease" class="${data.delayQueueTrigger==="chargeRelease"?"picked":""}">[ On Charge-Release ]</button>
          </div>
          <label class="rule-inline-label fx-delayq-turns-wrap">Turns <input type="number" class="fx-delayq-turns" min="1" step="1" value="${data.delayQueueTurns}"></label>
        </div>
        <div class="rule-row">
          <label class="rule-label">Releases</label>
          <select class="fx-delayq-payload">${DELAYQUEUE_PAYLOADS.map(([v,l])=>`<option value="${v}" ${v===data.delayQueuePayload?"selected":""}>${l}</option>`).join("")}</select>
        </div>
        <div class="rule-row fx-delayq-damage-row">
          <label class="rule-inline-label">Delayed Damage <input type="number" class="fx-delayq-damagepct" min="0" max="100" step="5" value="${data.delayQueueDamagePct}"> % of Target's Max HP</label>
        </div>
        <div class="rule-row fx-delayq-status-row">
          <label class="rule-label">Status Mark to Apply</label>
          <select class="fx-delayq-statuseffect">${STATUS_EFFECTS.filter(s=>s[0]!=="none").map(([v,l])=>`<option value="${v}" ${v===data.delayQueueStatusEffect?"selected":""}>${l}</option>`).join("")}</select>
        </div>
        <div class="rule-row fx-delayq-statchange-row">
          <label class="rule-label">Stat / Stage</label>
          <select class="fx-delayq-statkey">${STAT_STAGE_KEYS.map(([v,l])=>`<option value="${v}" ${v===data.delayQueueStatKey?"selected":""}>${l}</option>`).join("")}</select>
          <select class="fx-delayq-statstage">${STAT_STAGE_VALUES.map(v=>`<option value="${v}" ${v===data.delayQueueStatStage?"selected":""}>${v>0?"+"+v:v}</option>`).join("")}</select>
        </div>
        <div class="rule-row fx-delayq-heal-row">
          <label class="rule-inline-label">Delayed Heal <input type="number" class="fx-delayq-healpct" min="0" max="100" step="5" value="${data.delayQueueHealPct}"> % of Max HP (Wish-style)</label>
        </div>
        <div class="rule-row">
          <label class="dyn-hidden-check"><input type="checkbox" class="fx-delayq-ignoreswitch" ${data.delayQueueIgnoreSwitch?"checked":""}> Still Resolves Even If the Original Target Has Switched Out (Doom Desire-style; otherwise it fizzles like Future Sight)</label>
        </div>
      </div>
      <div class="rule-sub fx-drainburnout-row">
        <p class="rule-sub-title">Multi-Turn Drain &amp; Burnout</p>
        <div class="rule-row">
          <label class="rule-label">Siphon Resource</label>
          <select class="fx-drain-resource">${DRAIN_RESOURCES.map(([v,l])=>`<option value="${v}" ${v===data.drainResource?"selected":""}>${l}</option>`).join("")}</select>
        </div>
        <div class="rule-row fx-drain-statkey-row">
          <label class="rule-label">Stat to Siphon</label>
          <select class="fx-drain-statkey">${STAT_STAGE_KEYS.map(([v,l])=>`<option value="${v}" ${v===data.drainStatKey?"selected":""}>${l}</option>`).join("")}</select>
        </div>
        <div class="rule-row">
          <label class="rule-inline-label">Siphon <input type="number" class="fx-drain-percent" min="0" step="0.5" value="${data.drainPercent}"> % per Turn</label>
          <label class="rule-inline-label">Lasts <input type="number" class="fx-drain-duration" min="0" step="1" value="${data.drainDuration}"> Turns (0 = until switch/faint)</label>
        </div>
        <div class="rule-row">
          <label class="rule-label">Direction</label>
          <div class="heal-toggle fx-drain-direction">
            <button type="button" data-v="targetToUser" class="${data.drainDirection==="targetToUser"?"picked":""}">[ Target → User ]</button>
            <button type="button" data-v="userToTarget" class="${data.drainDirection==="userToTarget"?"picked":""}">[ User → Target ]</button>
          </div>
        </div>
        <div class="rule-row">
          <label class="dyn-hidden-check"><input type="checkbox" class="fx-burnout-enabled" ${data.burnoutEnabled?"checked":""}> Type Burnout: Strips the User's Type the Instant This Move Executes</label>
        </div>
        <div class="rule-row fx-burnout-fields-row">
          <label class="rule-label">Strip</label>
          <select class="fx-burnout-scope">${BURNOUT_SCOPES.map(([v,l])=>`<option value="${v}" ${v===data.burnoutScope?"selected":""}>${l}</option>`).join("")}</select>
          <select class="fx-burnout-type">${TYPES.map(t=>`<option value="${t}" ${t===data.burnoutType?"selected":""}>${cap(t)}</option>`).join("")}</select>
        </div>
        <div class="rule-row fx-burnout-fields-row">
          <label class="dyn-hidden-check"><input type="checkbox" class="fx-burnout-becomenormal" ${data.burnoutBecomeNormal?"checked":""}> Replace the Stripped Type With Normal (instead of just removing it)</label>
        </div>
      </div>
      <div class="rule-sub fx-customhazard-row">
        <p class="rule-sub-title">Custom Entry Hazard Builder</p>
        <div class="rule-row">
          <label class="rule-label">Hazard Name</label>
          <input type="text" class="fx-hz-name" placeholder="e.g. Corrosive Mist, Thorn Patch" value="${esc(data.hzName)}">
          <label class="dyn-hidden-check"><input type="checkbox" class="fx-hz-stacking" ${data.hzStacking?"checked":""}> Stackable (up to 3 layers, like Spikes)</label>
        </div>
        <div class="rule-row">
          <label class="rule-label">Entry Damage</label>
          <div class="heal-toggle fx-hz-dmgmode">
            ${HAZARD_DAMAGE_MODES.map(([v,l])=>`<button type="button" data-v="${v}" class="${data.hzDamageMode===v?"picked":""}">[ ${l} ]</button>`).join("")}
          </div>
        </div>
        <div class="rule-row fx-hz-dmgvalue-row">
          <label class="rule-inline-label">Amount <input type="number" class="fx-hz-dmgvalue" min="0" step="0.5" value="${data.hzDamageValue}"></label>
        </div>
        <div class="rule-row fx-hz-dmgtype-row">
          <label class="rule-label">Hazard Element (for Type-Scaled multiplier vs. the entrant's types)</label>
          <select class="fx-hz-dmgtype">${TYPES.map(t=>`<option value="${t}" ${t===data.hzDamageType?"selected":""}>${cap(t)}</option>`).join("")}</select>
        </div>
        <div class="rule-row">
          <label class="rule-label">Entry Status</label>
          <select class="fx-hz-statuseffect">${STATUS_EFFECTS.map(([v,l])=>`<option value="${v}" ${v===data.hzStatusEffect?"selected":""}>${l}</option>`).join("")}</select>
          <label class="rule-inline-label fx-hz-statuschance-row">Chance % <input type="number" class="fx-hz-statuschance" min="0" max="100" step="5" value="${data.hzStatusChance}"></label>
        </div>
        <div class="rule-row">
          <label class="rule-label">Entry Stat Debuff (Sticky Web-style)</label>
          <select class="fx-hz-statkey">${STAT_STAGE_KEYS.map(([v,l])=>`<option value="${v}" ${v===data.hzStatKey?"selected":""}>${l}</option>`).join("")}</select>
          <select class="fx-hz-statstage">${STAT_STAGE_VALUES.map(v=>`<option value="${v}" ${v===data.hzStatStage?"selected":""}>${v>0?"+"+v:v}</option>`).join("")}</select>
        </div>
        <div class="rule-row">
          <label class="dyn-hidden-check"><input type="checkbox" class="fx-hz-turnbased-enabled" ${data.hzTurnBasedEnabled?"checked":""}> Turn-Based Field Hazard (also applies every turn the occupant remains on this field, not just on entry)</label>
        </div>
        <div class="rule-row fx-hz-turnbased-fields-row">
          <label class="rule-inline-label">Per-Turn Damage <input type="number" class="fx-hz-turndmgpct" min="0" max="100" step="1" value="${data.hzTurnDamagePct}"> % Max HP</label>
        </div>
        <div class="rule-row fx-hz-turnbased-fields-row">
          <label class="rule-label">Per-Turn Stat Penalty</label>
          <select class="fx-hz-turnstatkey">${STAT_STAGE_KEYS.map(([v,l])=>`<option value="${v}" ${v===data.hzTurnStatKey?"selected":""}>${l}</option>`).join("")}</select>
          <select class="fx-hz-turnstatstage">
            <option value="0" ${data.hzTurnStatStage===0?"selected":""}>— None —</option>
            ${STAT_STAGE_VALUES.map(v=>`<option value="${v}" ${v===data.hzTurnStatStage?"selected":""}>${v>0?"+"+v:v}</option>`).join("")}
          </select>
        </div>
      </div>
      <div class="rule-row fx-recycle-row">
        <label class="rule-inline-label">Efficiency <input type="number" class="fx-recycle-efficiency" min="0" max="100" step="5" value="${data.recycleEfficiencyPct}"> % (100 = full strength; lower values permanently reduce the recovered item's effects for the rest of the battle)</label>
      </div>`;
    row.querySelector(".dyn-row-remove").addEventListener("click", ()=>row.remove());
    function sync(){
      const t = row.querySelector(".fx-type").value;
      row.querySelector(".fx-hazard-row").style.display = t==="hazard" ? "flex" : "none";
      row.querySelector(".fx-heal-row").style.display = t==="heal" ? "flex" : "none";
      row.querySelector(".fx-statmod-row").style.display = t==="statmod" ? "flex" : "none";
      row.querySelector(".fx-omniboost-row").style.display = t==="omniBoost" ? "flex" : "none";
      row.querySelector(".fx-statmoddur-row").style.display = (t==="statmod" || t==="omniBoost") ? "flex" : "none";
      row.querySelector(".fx-status-row").style.display = t==="status" ? "flex" : "none";
      row.querySelector(".fx-matrix-row").style.display = t==="matrix" ? "flex" : "none";
      row.querySelector(".fx-weightmod-row").style.display = t==="weightmod" ? "flex" : "none";
      row.querySelector(".fx-accuracymod-row").style.display = t==="accuracyMod" ? "flex" : "none";
      row.querySelector(".fx-clearstatmod-row").style.display = t==="clearstatmod" ? "flex" : "none";
      row.querySelector(".fx-clearhazards-row").style.display = t==="clearFieldHazards" ? "flex" : "none";
      row.querySelector(".fx-switchout-row").style.display = t==="switchOut" ? "flex" : "none";
      row.querySelector(".fx-clearstatus-row").style.display = t==="clearStatusEffects" ? "flex" : "none";
      row.querySelector(".fx-ppcost-row").style.display = t==="ppcost" ? "flex" : "none";
      row.querySelector(".fx-shield-row").style.display = t==="shield" ? "flex" : "none";
      if(t==="shield"){
        const vulnOutcome = row.querySelector(".fx-shield-vulnoutcome").value;
        row.querySelector(".fx-shield-vulnbonus-row").style.display = vulnOutcome==="bonusDeplete" ? "flex" : "none";
        row.querySelector(".fx-shield-vulnmult-row").style.display = vulnOutcome==="damageMult" ? "flex" : "none";
        const reaction = row.querySelector(".fx-shield-reaction").value;
        row.querySelector(".fx-shield-reaction-damage-row").style.display = reaction==="damage" ? "flex" : "none";
        row.querySelector(".fx-shield-reaction-status-row").style.display = reaction==="status" ? "flex" : "none";
        row.querySelector(".fx-shield-reaction-scope-row").style.display = reaction!=="none" ? "flex" : "none";
      }
      row.querySelector(".fx-delayqueue-row").style.display = t==="delayedQueue" ? "flex" : "none";
      row.querySelector(".fx-drainburnout-row").style.display = t==="persistentDrain" ? "flex" : "none";
      row.querySelector(".fx-customhazard-row").style.display = t==="customHazard" ? "flex" : "none";
      row.querySelector(".fx-recycle-row").style.display = t==="recycleItem" ? "flex" : "none";
      row.querySelector(".fx-changeform-row").style.display = t==="changeForm" ? "block" : "none";
      row.querySelector(".fx-triggerform-row").style.display = t==="triggerForm" ? "block" : "none";
      row.querySelector(".fx-switchin-row").style.display = t==="switchIn" ? "block" : "none";
      row.querySelector(".fx-doom-row").style.display = t==="doom" ? "block" : "none";
      row.querySelector(".fx-substitute-row").style.display = t==="substitute" ? "block" : "none";
      row.querySelector(".fx-lift-row").style.display = t==="lift" ? "block" : "none";
      row.querySelector(".fx-bond-row").style.display = t==="bond" ? "block" : "none";
      row.querySelector(".fx-evade-row").style.display = t==="evadeInaccurate" ? "block" : "none";
      row.querySelector(".fx-root-row").style.display = t==="rootDown" ? "block" : "none";
      row.querySelector(".fx-metronome-row").style.display = t==="metronome" ? "block" : "none";
      row.querySelector(".fx-wish-row").style.display = t==="wish" ? "block" : "none";
      row.querySelector(".fx-revive-row").style.display = t==="reviveAlly" ? "block" : "none";
      row.querySelector(".fx-snatch-row").style.display = t==="snatch" ? "block" : "none";
      row.querySelector(".fx-target").style.display = ["triggerForm","switchIn","wish","reviveAlly","snatch","substitute","bond","metronome","evadeInaccurate"].includes(t) ? "none" : "";
      if(t==="changeForm"){
        row.querySelector(".fx-changeform-stats").style.display = row.querySelector(".fx-changeform-statsoverride").checked ? "block" : "none";
      }
      const mode = row.querySelector(".fx-statusdurmode .picked")?.dataset.v || "random";
      row.querySelectorAll(".fx-statusdur-random").forEach(el=>el.style.display = (t==="status" && mode==="random") ? "inline-flex" : "none");
      row.querySelector(".fx-statusdur-fixedwrap").style.display = (t==="status" && mode==="fixed") ? "inline-flex" : "none";
      row.querySelector(".fx-statusfallback-fields-row").style.display = (t==="status" && row.querySelector(".fx-statusfallback-enabled").checked) ? "flex" : "none";
      if(t==="delayedQueue"){
        const trigger = row.querySelector(".fx-delayq-trigger .picked")?.dataset.v || "countdown";
        const payload = row.querySelector(".fx-delayq-payload").value;
        row.querySelector(".fx-delayq-turns-wrap").style.display = trigger==="countdown" ? "inline-flex" : "none";
        row.querySelector(".fx-delayq-damage-row").style.display = payload==="damage" ? "flex" : "none";
        row.querySelector(".fx-delayq-status-row").style.display = payload==="statusMark" ? "flex" : "none";
        row.querySelector(".fx-delayq-statchange-row").style.display = payload==="statChange" ? "flex" : "none";
        row.querySelector(".fx-delayq-heal-row").style.display = payload==="heal" ? "flex" : "none";
      }
      if(t==="persistentDrain"){
        row.querySelector(".fx-drain-statkey-row").style.display = row.querySelector(".fx-drain-resource").value==="stat" ? "flex" : "none";
        row.querySelectorAll(".fx-burnout-fields-row").forEach(el=>{
          el.style.display = row.querySelector(".fx-burnout-enabled").checked ? "flex" : "none";
        });
      }
      if(t==="customHazard"){
        const dmgMode = row.querySelector(".fx-hz-dmgmode .picked")?.dataset.v || "none";
        row.querySelector(".fx-hz-dmgvalue-row").style.display = dmgMode==="none" ? "none" : "flex";
        row.querySelector(".fx-hz-dmgtype-row").style.display = dmgMode==="typescaled" ? "flex" : "none";
        row.querySelector(".fx-hz-statuschance-row").style.display = row.querySelector(".fx-hz-statuseffect").value!=="none" ? "inline-flex" : "none";
        row.querySelectorAll(".fx-hz-turnbased-fields-row").forEach(el=>{
          el.style.display = row.querySelector(".fx-hz-turnbased-enabled").checked ? "flex" : "none";
        });
      }
      if(t==="matrix"){
        const what = row.querySelector(".fx-what").value;
        const when = row.querySelector(".fx-when").value;
        row.querySelector(".fx-matrix-statkey-row").style.display = what==="statChange" ? "flex" : "none";
        row.querySelector(".fx-matrix-typefilter-row").style.display = (what==="typeDamageMult" || when==="onHitByType" || when==="onDealByType") ? "flex" : "none";
        row.querySelector(".fx-matrix-statusfilter-row").style.display = (what==="negateStatus" || when==="onStatusActive") ? "flex" : "none";
        row.querySelector(".fx-matrix-threshold-row").style.display = when==="onHpThreshold" ? "flex" : "none";
        // ---- Stat Comparison Trigger: gate row is always visible in matrix mode; the actual comparison
        // dropdowns only reveal once the "Gate on Stat Comparison" checkbox is ticked ----
        row.querySelector(".fx-compare-row").style.display = "flex";
        row.querySelector(".fx-compare-fields-row").style.display = row.querySelector(".fx-compare-enabled").checked ? "flex" : "none";
      }
    }
    row.querySelector(".fx-type").addEventListener("change", sync);
    row.querySelector(".fx-what").addEventListener("change", sync);
    row.querySelector(".fx-when").addEventListener("change", sync);
    row.querySelector(".fx-compare-enabled").addEventListener("change", sync);
    row.querySelector(".fx-delayq-payload").addEventListener("change", sync);
    row.querySelector(".fx-drain-resource").addEventListener("change", sync);
    row.querySelector(".fx-burnout-enabled").addEventListener("change", sync);
    row.querySelector(".fx-hz-statuseffect").addEventListener("change", sync);
    row.querySelector(".fx-hz-turnbased-enabled").addEventListener("change", sync);
    row.querySelector(".fx-shield-vulnoutcome").addEventListener("change", sync);
    row.querySelector(".fx-shield-reaction").addEventListener("change", sync);
    row.querySelector(".fx-changeform-statsoverride").addEventListener("change", sync);
    row.querySelector(".fx-statusfallback-enabled").addEventListener("change", sync);
    row.querySelectorAll(".heal-toggle").forEach(tg=>{
      tg.querySelectorAll("button").forEach(btn=>{
        btn.addEventListener("click", ()=>{ tg.querySelectorAll("button").forEach(b=>b.classList.toggle("picked", b===btn)); sync(); });
      });
    });

    // ---- In-Battle Form Change (Standalone Mega Mechanics): Types grid / Emoji badge / Base Stats
    // sliders / Dedicated Ability, wired the exact same way as a Mega Evolution profile's own pickers
    // (see addMegaProfileRow above) — just scoped to this single effect row instead of a mega profile. ----
    const cfTypesEl = row.querySelector(".fx-changeform-types");
    let cfPickedTypes = [...(data.changeFormTypes || [])];
    TYPES.forEach(t=>{
      if(t===FANMADE_TYPE_LIST[0]) cfTypesEl.appendChild(fanmadeTypesHeaderEl());
      const label = document.createElement("label");
      label.className = "type-check"; label.dataset.type = t;
      if(FANMADE_TYPES[t]) label.title = typeCreditTitle(t);
      label.innerHTML = `<input type="checkbox" value="${t}" ${cfPickedTypes.includes(t)?"checked":""}> ${t}`;
      label.addEventListener("click", (ev)=>{
        ev.preventDefault();
        const idx = cfPickedTypes.indexOf(t);
        if(idx>-1){ cfPickedTypes.splice(idx,1); } else { if(cfPickedTypes.length>=2) return; cfPickedTypes.push(t); }
        syncCfTypeGrid();
      });
      cfTypesEl.appendChild(label);
    });
    function syncCfTypeGrid(){
      [...cfTypesEl.children].forEach(el=>{
        const t = el.dataset.type; const on = cfPickedTypes.includes(t);
        el.classList.toggle("picked", on);
        el.style.background = on ? `var(--t-${t})` : "";
        el.style.borderColor = on ? `var(--t-${t})` : "";
      });
    }
    syncCfTypeGrid();
    row._getChangeFormTypes = ()=>[...cfPickedTypes];

    const cfEmojiEl = row.querySelector(".fx-changeform-emoji");
    let cfPickedEmoji = data.changeFormEmoji || "";
    EMOJIS.forEach(em=>{
      const d = document.createElement("div"); d.className = "emoji-choice"; d.textContent = em;
      d.addEventListener("click", ()=>{ cfPickedEmoji = (cfPickedEmoji===em) ? "" : em; syncCfEmojiRow(); });
      cfEmojiEl.appendChild(d);
    });
    function syncCfEmojiRow(){ [...cfEmojiEl.children].forEach(el=>{ el.classList.toggle("picked", el.textContent === cfPickedEmoji); }); }
    syncCfEmojiRow();
    row._getChangeFormEmoji = ()=>cfPickedEmoji;

    const cfStatsEl = row.querySelector(".fx-changeform-stats");
    const cfStatVals = {};
    STAT_KEYS.forEach(([key,label])=>{
      cfStatVals[key] = (data.changeFormStats && data.changeFormStats[key]) || 50;
      const r = document.createElement("div"); r.className = "stat-field";
      r.innerHTML = `<label>${label}</label><input type="range" min="1" max="150" value="${cfStatVals[key]}" data-key="${key}"><div class="val">${cfStatVals[key]}</div>`;
      const range = r.querySelector("input"); const val = r.querySelector(".val");
      range.addEventListener("input", ()=>{ cfStatVals[key] = Number(range.value); val.textContent = range.value; });
      cfStatsEl.appendChild(r);
    });
    row._getChangeFormStats = ()=>({...cfStatVals});

    const cfAbilityListEl = row.querySelector(".fx-changeform-ability-list");
    if(data.changeFormAbility) addAbilityRow(data.changeFormAbility, cfAbilityListEl);
    row.querySelector(".fx-changeform-add-ability-btn").addEventListener("click", ()=>{
      // ---- Single dedicated Form Ability per effect node: clear any existing row first ----
      cfAbilityListEl.innerHTML = "";
      addAbilityRow(null, cfAbilityListEl);
    });
    row.querySelector(".fx-changeform-import-ability-btn").addEventListener("click", ()=>openImportPicker("ability", cfAbilityListEl, true));

    sync();
    listEl.appendChild(row);
  }
  function collectEffects(listEl){
    return [...listEl.querySelectorAll(".effect-row")].map(row=>({
      type: row.querySelector(".fx-type").value,
      target: row.querySelector(".fx-target").value,
      chance: Number(row.querySelector(".fx-chance").value),
      hazardType: row.querySelector(".fx-hazardtype").value,
      healType: row.querySelector(".fx-healtype .picked")?.dataset.v || "percent",
      healValue: Number(row.querySelector(".fx-healvalue").value),
      statKey: row.querySelector(".fx-statkey").value,
      statStage: row.querySelector(".fx-type").value==="omniBoost" ? Number(row.querySelector(".fx-omniboost-stage").value) : Number(row.querySelector(".fx-statstage").value),
      statKeys: [...row.querySelectorAll(".fx-omniboost-statkey:checked")].map(el=>el.value),
      statModDuration: Number(row.querySelector(".fx-statmod-duration").value) || 0,
      statModExpireMode: row.querySelector(".fx-statmod-expiremode .picked")?.dataset.v || "decay",
      statusEffect: row.querySelector(".fx-statuseffect").value,
      statusFallbackEnabled: row.querySelector(".fx-statusfallback-enabled").checked,
      statusFallbackStatKey: row.querySelector(".fx-statusfallback-statkey").value,
      statusFallbackStatStage: Number(row.querySelector(".fx-statusfallback-statstage").value),
      statusDurationMode: row.querySelector(".fx-statusdurmode .picked")?.dataset.v || "random",
      statusDurationMin: Number(row.querySelector(".fx-statusdur-min").value) || 1,
      statusDurationMax: Number(row.querySelector(".fx-statusdur-max").value) || 3,
      statusDurationFixed: Number(row.querySelector(".fx-statusdur-fixed").value) || 5,
      who: row.querySelector(".fx-who").value,
      what: row.querySelector(".fx-what").value,
      when: row.querySelector(".fx-when").value,
      matrixStatKey: row.querySelector(".fx-matrix-statkey").value,
      matrixMagnitude: Number(row.querySelector(".fx-matrix-magnitude").value),
      matrixHowBasis: row.querySelector(".fx-matrix-howbasis").value,
      matrixTypeFilter: row.querySelector(".fx-matrix-typefilter").value,
      matrixStatusFilter: row.querySelector(".fx-matrix-statusfilter").value,
      matrixThresholdPct: Number(row.querySelector(".fx-matrix-threshold").value),
      weightModValue: Number(row.querySelector(".fx-weightmod-value").value),
      accuracyModValue: Number(row.querySelector(".fx-accuracymod-value").value),
      clearStatModMode: row.querySelector(".fx-clearstatmod-mode").value,
      hazardClearScope: row.querySelector(".fx-clearhazards-scope").value,
      switchTarget: row.querySelector(".fx-switch-target").value,
      switchPick: row.querySelector(".fx-switch-pick").value,
      statusClearScope: row.querySelector(".fx-clearstatus-scope").value,
      ppSpiteAmount: Number(row.querySelector(".fx-ppspite-amount").value),
      shieldHitCapacity: Number(row.querySelector(".fx-shield-capacity").value),
      shieldTriggerType: row.querySelector(".fx-shield-triggertype").value,
      shieldTypeFilter: row.querySelector(".fx-shield-typefilter").value,
      shieldUnignorable: row.querySelector(".fx-shield-unignorable").checked,
      shieldReaction: row.querySelector(".fx-shield-reaction").value,
      shieldReactionValue: Number(row.querySelector(".fx-shield-reaction-value").value),
      shieldReactionStatus: row.querySelector(".fx-shield-reaction-status").value,
      shieldReactionChance: Number(row.querySelector(".fx-shield-reaction-chance").value),
      shieldReactionContactOnly: row.querySelector(".fx-shield-reaction-contactonly").checked,
      shieldDuration: Number(row.querySelector(".fx-shield-duration").value),
      shieldWeaknessType: row.querySelector(".fx-shield-weakness").value,
      vulnerableToTags: row.querySelector(".fx-shield-vulntags").value.split(",").map(t=>t.trim()).filter(Boolean),
      vulnerableTagOutcome: row.querySelector(".fx-shield-vulnoutcome").value,
      vulnerableTagBonusHits: Number(row.querySelector(".fx-shield-vulnbonus").value),
      vulnerableTagMultiplier: Number(row.querySelector(".fx-shield-vulnmult").value),
      mirrorReflectPercent: Number(row.querySelector(".fx-mirrorpercent").value),
      compareEnabled: row.querySelector(".fx-compare-enabled").checked,
      compareWhoA: row.querySelector(".fx-compare-whoa").value,
      compareStatA: row.querySelector(".fx-compare-stata").value,
      compareOp: row.querySelector(".fx-compare-op").value,
      compareWhoB: row.querySelector(".fx-compare-whob").value,
      compareStatB: row.querySelector(".fx-compare-statb").value,
      delayQueueTurns: Number(row.querySelector(".fx-delayq-turns").value),
      delayQueueTrigger: row.querySelector(".fx-delayq-trigger .picked")?.dataset.v || "countdown",
      delayQueuePayload: row.querySelector(".fx-delayq-payload").value,
      delayQueueDamagePct: Number(row.querySelector(".fx-delayq-damagepct").value),
      delayQueueStatusEffect: row.querySelector(".fx-delayq-statuseffect").value,
      delayQueueStatKey: row.querySelector(".fx-delayq-statkey").value,
      delayQueueStatStage: Number(row.querySelector(".fx-delayq-statstage").value),
      delayQueueHealPct: Number(row.querySelector(".fx-delayq-healpct").value),
      delayQueueIgnoreSwitch: row.querySelector(".fx-delayq-ignoreswitch").checked,
      drainResource: row.querySelector(".fx-drain-resource").value,
      drainStatKey: row.querySelector(".fx-drain-statkey").value,
      drainPercent: Number(row.querySelector(".fx-drain-percent").value),
      drainDuration: Number(row.querySelector(".fx-drain-duration").value),
      drainDirection: row.querySelector(".fx-drain-direction .picked")?.dataset.v || "targetToUser",
      burnoutEnabled: row.querySelector(".fx-burnout-enabled").checked,
      burnoutScope: row.querySelector(".fx-burnout-scope").value,
      burnoutType: row.querySelector(".fx-burnout-type").value,
      burnoutBecomeNormal: row.querySelector(".fx-burnout-becomenormal").checked,
      hzName: row.querySelector(".fx-hz-name").value,
      hzStacking: row.querySelector(".fx-hz-stacking").checked,
      hzDamageMode: row.querySelector(".fx-hz-dmgmode .picked")?.dataset.v || "none",
      hzDamageValue: Number(row.querySelector(".fx-hz-dmgvalue").value),
      hzDamageType: row.querySelector(".fx-hz-dmgtype").value,
      hzStatusEffect: row.querySelector(".fx-hz-statuseffect").value,
      hzStatusChance: Number(row.querySelector(".fx-hz-statuschance").value),
      hzStatKey: row.querySelector(".fx-hz-statkey").value,
      hzStatStage: Number(row.querySelector(".fx-hz-statstage").value),
      hzTurnBasedEnabled: row.querySelector(".fx-hz-turnbased-enabled").checked,
      hzTurnDamagePct: Number(row.querySelector(".fx-hz-turndmgpct").value),
      hzTurnStatKey: row.querySelector(".fx-hz-turnstatkey").value,
      hzTurnStatStage: Number(row.querySelector(".fx-hz-turnstatstage").value),
      // ---- In-Battle Form Change (Standalone Mega Mechanics) ----
      changeFormName: row.querySelector(".fx-changeform-name").value.trim(),
      changeFormVerb: row.querySelector(".fx-changeform-verb").value.trim(),
      changeFormEmoji: row._getChangeFormEmoji ? row._getChangeFormEmoji() : "",
      changeFormImageUrl: row.querySelector(".fx-changeform-image").value.trim(),
      changeFormTypes: row._getChangeFormTypes ? row._getChangeFormTypes() : [],
      changeFormStats: (row.querySelector(".fx-changeform-statsoverride").checked && row._getChangeFormStats) ? row._getChangeFormStats() : null,
      changeFormAbility: (collectAbilities(row.querySelector(".fx-changeform-ability-list"))[0]) || null,
      recycleEfficiencyPct: Number(row.querySelector(".fx-recycle-efficiency").value),
      triggerFormLabel: row.querySelector(".fx-triggerform-label").value.trim(),
      doomTurns: Number(row.querySelector(".fx-doom-turns").value),
      wishPct: Number(row.querySelector(".fx-wish-pct").value),
      wishTurns: Number(row.querySelector(".fx-wish-turns").value),
      revivePct: Number(row.querySelector(".fx-revive-pct").value),
      subHpPct: Number(row.querySelector(".fx-sub-pct").value),
      liftTurns: Number(row.querySelector(".fx-lift-turns").value),
      liftGroundImmune: row.querySelector(".fx-lift-ground").checked,
      bondTurns: Number(row.querySelector(".fx-bond-turns").value),
      bondOnFaint: row.querySelector(".fx-bond-faint").checked,
      bondOnDamage: row.querySelector(".fx-bond-damage").checked,
      bondDamagePct: Number(row.querySelector(".fx-bond-damagepct").value),
      bondOnStatus: row.querySelector(".fx-bond-status").checked,
      metronomePool: row.querySelector(".fx-metronome-pool").value,
      evadeTurns: Number(row.querySelector(".fx-evade-turns").value),
      evadeBelowAcc: Number(row.querySelector(".fx-evade-below").value),
      rootTurns: Number(row.querySelector(".fx-root-turns").value),
      rootGround: row.querySelector(".fx-root-ground").checked,
      rootSureHit: row.querySelector(".fx-root-sure").checked
    })).map(normalizeEffect);
  }
  function effectsBlockHtml(){
    return `
      <div class="field effects-block">
        <label class="rule-label">Additional Effects (unlimited, run every activation)</label>
        <div class="dyn-list effects-list"></div>
        <button type="button" class="add-row-btn add-effect-btn">＋ Add Effect</button>
      </div>`;
  }
  function wireEffectsBlock(row, data){
    const listEl = row.querySelector(".effects-list");
    (data.effects || []).forEach(fx=>createEffectNode(listEl, fx));
    row.querySelector(".add-effect-btn").addEventListener("click", ()=>createEffectNode(listEl));
  }

  // ==================== TAG-BASED MOVE TRANSFORMATIONS (MULTI-TAG STACKING) ====================
  // A small dyn-list, structurally identical in pattern to the Additional Effects list above, but each
  // node is a single Tag Rule ({tag, effect, convertType}) instead of a full secondary effect. Unlimited
  // rules per move; every rule is resolved independently and non-destructively (see applyMoveTagRules()
  // in the simulator core), so stacking a [blade]->Steel conversion with a [projectile] invuln-bypass on
  // the same move Just Works — neither rule can see or clobber the other's output.
  function createTagRuleNode(listEl, data){
    data = normalizeTagRule(data || {});
    const row = document.createElement("div"); row.className = "dyn-row tagrule-row";
    row.innerHTML = `
      <div class="dyn-row-top">
        <input type="text" class="tr-tag" placeholder="Tag to match, e.g. blade, projectile, powder" value="${esc(data.tag)}">
        <button type="button" class="dyn-row-remove" title="Remove tag rule">×</button>
      </div>
      <div class="rule-row">
        <label class="rule-label">Effect</label>
        <select class="tr-effect">${TAG_RULE_EFFECTS.map(([v,l])=>`<option value="${v}" ${v===data.effect?"selected":""}>${l}</option>`).join("")}</select>
      </div>
      <div class="rule-row tr-converttype-row">
        <label class="rule-label">Convert Execution Type To</label>
        <select class="tr-converttype">${TYPES.map(t=>`<option value="${t}" ${t===data.convertType?"selected":""}>${cap(t)}</option>`).join("")}</select>
      </div>`;
    row.querySelector(".dyn-row-remove").addEventListener("click", ()=>row.remove());
    function sync(){
      row.querySelector(".tr-converttype-row").style.display = row.querySelector(".tr-effect").value==="convertType" ? "flex" : "none";
    }
    row.querySelector(".tr-effect").addEventListener("change", sync);
    sync();
    listEl.appendChild(row);
  }
  function tagRulesBlockHtml(){
    return `
      <div class="field tagrules-block">
        <label class="rule-label">Tag-Based Transformations (unlimited, resolved non-destructively per use)</label>
        <div class="dyn-list tagrules-list"></div>
        <button type="button" class="add-row-btn add-tagrule-btn">＋ Add Tag Rule</button>
      </div>`;
  }
  function wireTagRulesBlock(row, data){
    const listEl = row.querySelector(".tagrules-list");
    (data.tagRules || []).forEach(tr=>createTagRuleNode(listEl, tr));
    row.querySelector(".add-tagrule-btn").addEventListener("click", ()=>createTagRuleNode(listEl));
  }
  function collectTagRules(listEl){
    return [...listEl.querySelectorAll(".tagrule-row")].map(row=>({
      tag: row.querySelector(".tr-tag").value,
      effect: row.querySelector(".tr-effect").value,
      convertType: row.querySelector(".tr-converttype").value
    })).map(normalizeTagRule);
  }

  // ==================== MOVE-LEVEL "EFFECTIVENESS VS POKÉMON TAGS" ====================
  // Same dyn-list pattern as Tag Rules above, and the same {tag, multiplier} shape as the entry-level Tag
  // Matchups further below — but the matching direction is reversed: THIS list lives on the MOVE and is
  // checked against the DEFENDER's own Pokémon Tags (entry.tags/fighters[side].tags), not the move's own
  // tags. Lets a move be built as, say, useless against anything tagged "heavyweight" regardless of type
  // (e.g. a Flying move that's fully walled by "heavyweight"-tagged targets). See
  // moveVsCreatureTagMultiplier() in the simulator core for how multiple matching rows stack.
  function createVsTagNode(listEl, data){
    data = normalizeTagMatchup(data || {});
    const row = document.createElement("div"); row.className = "dyn-row vstag-row";
    row.innerHTML = `
      <div class="dyn-row-top">
        <input type="text" class="vt-tag" placeholder="Pokémon Tag to match, e.g. heavyweight, boss" value="${esc(data.tag)}">
        <button type="button" class="dyn-row-remove" title="Remove tag effectiveness rule">×</button>
      </div>
      <div class="rule-row">
        <label class="rule-inline-label">Damage Multiplier <input type="number" class="vt-multiplier" min="0" step="0.1" value="${data.multiplier}"> (0.5 = not very effective, 2 = super effective, 0 = no effect/immune)</label>
      </div>`;
    row.querySelector(".dyn-row-remove").addEventListener("click", ()=>row.remove());
    listEl.appendChild(row);
  }
  function moveVsTagsBlockHtml(){
    return `
      <div class="field vstags-block">
        <label class="rule-label">Effectiveness vs Pokémon Tags (unlimited; checks the TARGET's own Pokémon Tags, not this move's own Tags)</label>
        <div class="field-hint">Independent of the Type Chart — stacks with it. E.g. give a Flying move a 0 multiplier against "heavyweight" to make it always whiff on heavyweight-tagged targets, no matter their type.</div>
        <div class="dyn-list vstags-list"></div>
        <button type="button" class="add-row-btn add-vstag-btn">＋ Add Tag Effectiveness</button>
      </div>`;
  }
  function wireVsTagsBlock(row, data){
    const listEl = row.querySelector(".vstags-list");
    (data.vsTags || []).forEach(vt=>createVsTagNode(listEl, vt));
    row.querySelector(".add-vstag-btn").addEventListener("click", ()=>createVsTagNode(listEl));
  }
  function collectVsTags(listEl){
    return [...listEl.querySelectorAll(".vstag-row")].map(row=>({
      tag: row.querySelector(".vt-tag").value,
      multiplier: Number(row.querySelector(".vt-multiplier").value)
    })).map(normalizeTagMatchup);
  }

  // ==================== ENTRY-LEVEL TAG MATCHUPS (WEAKNESSES & STRENGTHS AGAINST TAGS) ====================
  // Same dyn-list shape as the move-level Tag Rules above, but simpler: just a tag to match and a damage
  // multiplier to apply. Lives directly on the entry (see normalizeTagMatchup/normalizeTagMatchups), so the
  // simulator core's tagMatchupMultiplier() reads it unconditionally — no Ability gate involved.
  function addTagMatchupRow(data){
    data = normalizeTagMatchup(data || {});
    const row = document.createElement("div"); row.className = "dyn-row tagmatchup-row";
    row.innerHTML = `
      <div class="dyn-row-top">
        <input type="text" class="tm-tag" placeholder="Tag to match, e.g. sound, punch, bite" value="${esc(data.tag)}">
        <button type="button" class="dyn-row-remove" title="Remove tag matchup">×</button>
      </div>
      <div class="rule-row">
        <label class="rule-inline-label">Damage Multiplier <input type="number" class="tm-multiplier" min="0" step="0.1" value="${data.multiplier}"> (0.5 = resists this tag, 2 = weak to it, 0 = fully immune)</label>
      </div>`;
    row.querySelector(".dyn-row-remove").addEventListener("click", ()=>row.remove());
    tagMatchupFieldsEl.appendChild(row);
  }
  document.getElementById("addTagMatchupBtn").addEventListener("click", ()=>addTagMatchupRow());
  function collectTagMatchups(){
    return [...tagMatchupFieldsEl.querySelectorAll(":scope > .tagmatchup-row")].map(row=>({
      tag: row.querySelector(".tm-tag").value,
      multiplier: Number(row.querySelector(".tm-multiplier").value)
    })).map(normalizeTagMatchup);
  }

  // ==================== STATUS-BYPASS & FORCED ACTION MECHANICS ====================
  function statusBypassBlockHtml(sb){
    sb = sb || {};
    return `
      <div class="field statusbypass-block">
        <label class="rule-label">Status-Bypass / Forced Action (executes despite the listed status)</label>
        <label class="dyn-hidden-check"><input type="checkbox" class="mv-bypass-sleep" ${sb.sleep?"checked":""}> Usable While Asleep (Sleep Talk / Snore-style)</label>
        <label class="dyn-hidden-check"><input type="checkbox" class="mv-bypass-freeze" ${sb.freeze?"checked":""}> Auto-Thaws User and Executes Despite Freeze</label>
        <label class="dyn-hidden-check"><input type="checkbox" class="mv-bypass-confusion" ${sb.confusion?"checked":""}> Forced Action: Bypasses the Confusion Self-Hit Roll</label>
      </div>`;
  }

  // ---- Collapsible Builder Blocks: shared minimize/expand wiring for both Ability and Move rows. Toggles
  // the `.dyn-row-collapsed` class on the row (CSS hides `.dyn-row-body`), flips the ▲/▼ glyph, and fills
  // a small preview label next to the name field so a minimized row still identifies itself. `getPreviewText`
  // is a callback (re-run on every toggle) so the preview always reflects the row's current name field. ----
  function wireRowCollapse(row, getPreviewText){
    const btn = row.querySelector(".dyn-row-collapse");
    const preview = row.querySelector(".dyn-row-collapsed-preview");
    function sync(){
      const collapsed = row.classList.contains("dyn-row-collapsed");
      btn.textContent = collapsed ? "▼" : "▲";
      btn.title = collapsed ? "Expand" : "Minimize";
      preview.textContent = collapsed ? (getPreviewText ? getPreviewText() : "") : "";
    }
    btn.addEventListener("click", ()=>{
      row.classList.toggle("dyn-row-collapsed");
      sync();
    });
    sync();
  }

  // ---- Targeted Type Filters: reusable multi-select checkbox block shared by Abilities + Moves ----
  function affectedTypesBlockHtml(selected, cls, labelText){
    selected = Array.isArray(selected) ? selected : [];
    return `
      <div class="field affected-types-block">
        <label class="rule-label">${labelText || "Affected Types (leave empty = affects all types)"}</label>
        <div class="type-checks ${cls}">
          ${TYPES.map(t=>`<label class="type-check"><input type="checkbox" class="fx-affected-type" value="${t}" ${selected.includes(t)?"checked":""}> ${cap(t)}</label>`).join("")}
        </div>
      </div>`;
  }
  function collectAffectedTypes(scopeEl){
    return [...scopeEl.querySelectorAll(".fx-affected-type:checked")].map(el=>el.value);
  }

  // ==================== UNIFIED RULE BUILDER (shared by Abilities AND Moves) ====================
  // One generator + one wiring function + one collector, parameterized by a CSS-class `prefix` (e.g.
  // "ab" for Abilities, "mvr" for Moves). Both entity types get the exact same Passive Rule / Active
  // Trigger (Boolean Gate) UI, the exact same vocab (PASSIVE_TRIGGERS / PASSIVE_ACTIONS /
  // ACTIVE_CONDITIONS / ACTIVE_ACTIONS), and the exact same "IF weather is active, THEN do X" gate.
  function ruleBuilderBlockHtml(prefix, data){
    const p = data.passive, ac = data.active;
    return `
      <div class="rule-builder">
        <div class="rule-row">
          <label class="rule-label">Type</label>
          <select class="${prefix}-type">${ABILITY_TYPES.map(([v,l])=>`<option value="${v}" ${v===(data.abilityType||data.ruleType)?"selected":""}>${l}</option>`).join("")}</select>
        </div>

        <div class="rule-sub ${prefix}-passive-panel">
          <p class="rule-sub-title">Passive Rule</p>
          <div class="rule-row">
            <label class="rule-label">Trigger (When)</label>
            <select class="${prefix}-p-trigger">${PASSIVE_TRIGGERS.map(([v,l])=>`<option value="${v}" ${v===p.trigger?"selected":""}>${l}</option>`).join("")}</select>
          </div>
          <div class="rule-row ${prefix}-p-weathercond-row">
            <label class="rule-label">Weather Must Be</label>
            <select class="${prefix}-p-weathercond">${WEATHER_STATES.filter(w=>w[0]!=="clear").map(([v,l])=>`<option value="${v}" ${v===p.weatherCondition?"selected":""}>${l}</option>`).join("")}</select>
          </div>
          <div class="rule-row ${prefix}-p-statloweredsource-row">
            <label class="rule-label">Caused By</label>
            <select class="${prefix}-p-statloweredsource">${STAT_LOWERED_SOURCES.map(([v,l])=>`<option value="${v}" ${v===p.statLoweredSource?"selected":""}>${l}</option>`).join("")}</select>
          </div>
          <div class="rule-row">
            <label class="rule-label">Filter (Move Type)</label>
            <select class="${prefix}-p-filter">
              <option value="any" ${p.filterType==="any"?"selected":""}>Any</option>
              ${TYPES.map(t=>`<option value="${t}" ${t===p.filterType?"selected":""}>${cap(t)}</option>`).join("")}
            </select>
          </div>
          <div class="rule-row">
            <label class="rule-label">Action (What)</label>
            <select class="${prefix}-p-action">${PASSIVE_ACTIONS.map(([v,l])=>`<option value="${v}" ${v===p.action?"selected":""}>${l}</option>`).join("")}</select>
          </div>
          <div class="rule-row ${prefix}-p-mult-row">
            <label class="rule-label">Multiplier</label>
            <input type="number" class="${prefix}-p-mult" step="0.1" min="0" value="${p.multiplier}">
          </div>
          <div class="rule-row ${prefix}-p-secchancemult-row">
            <label class="rule-label">Secondary Effect Chance Multiplier</label>
            <input type="number" class="${prefix}-p-secchancemult" step="0.1" min="0" value="${p.secondaryChanceMultiplier}" title="Multiplies the base Effect Chance % of any move's secondary effect (e.g. 2.0x turns a 30% flinch into a 60% flinch)">
          </div>
          <div class="rule-row ${prefix}-p-secchancescope-row">
            <label class="rule-label">Filter Scope (blank / "any" = global)</label>
            <input type="text" class="${prefix}-p-secchancescope" placeholder="e.g. Punching, Elemental, Status-Inflicting" value="${esc(p.secondaryChanceScope)}" title="Case-insensitive match against the triggering move's tags">
          </div>
          <div class="rule-row ${prefix}-p-stat-row">
            <label class="rule-label">Stat / Stage</label>
            <select class="${prefix}-p-statkey">${STAT_STAGE_KEYS.map(([v,l])=>`<option value="${v}" ${v===p.statKey?"selected":""}>${l}</option>`).join("")}</select>
            <select class="${prefix}-p-statstage">${STAT_STAGE_VALUES.map(v=>`<option value="${v}" ${v===p.statStage?"selected":""}>${v>0?"+"+v:v}</option>`).join("")}</select>
          </div>
          <div class="rule-row ${prefix}-p-heal-row">
            <label class="rule-label">Heal Amount</label>
            <div class="heal-toggle ${prefix}-p-healtype">
              <button type="button" data-v="percent" class="${p.healType==="percent"?"picked":""}">[% Base]</button>
              <button type="button" data-v="flat" class="${p.healType==="flat"?"picked":""}">[Flat #]</button>
            </div>
            <input type="number" class="${prefix}-p-healvalue" min="0" step="1" value="${p.healValue}">
            <select class="${prefix}-p-healtarget">${HEAL_TARGETS.map(([v,l])=>`<option value="${v}" ${v===p.healTarget?"selected":""}>${l}</option>`).join("")}</select>
          </div>
          <div class="rule-row ${prefix}-p-protect-row">
            <label class="rule-label">Shield vs Type</label>
            <select class="${prefix}-p-protecttype">${TYPES.map(t=>`<option value="${t}" ${t===p.protectType?"selected":""}>${cap(t)}</option>`).join("")}</select>
            <input type="number" class="${prefix}-p-protectpct" min="0" max="100" step="5" value="${p.protectPercent}" title="% damage reduction">
          </div>
          <div class="rule-row ${prefix}-p-resist-row">
            <label class="rule-label">Resistance Ratio (0 = full immunity, 1 = no reduction)</label>
            <input type="number" class="${prefix}-p-resistratio" min="0" max="1" step="0.05" value="${p.resistRatio}">
          </div>
          <div class="rule-row ${prefix}-p-tag-row">
            <label class="rule-label">Tag Filter / Multiplier</label>
            <input type="text" class="${prefix}-p-tagfilter" placeholder="e.g. Punch" value="${esc(p.tagFilter)}">
            <input type="number" class="${prefix}-p-tagmult" min="0" step="0.1" value="${p.tagMultiplier}" title="Damage multiplier vs tagged moves">
          </div>
          <div class="rule-row ${prefix}-p-boosttag-row">
            <label class="rule-label">Tags/Types to Boost (comma-separated) / Multiplier</label>
            <input type="text" class="${prefix}-p-boosttagfilter" placeholder="e.g. punch, fire" value="${esc(p.boostTagFilter)}" title="A move's own Type also counts as an implicit tag here">
            <input type="number" class="${prefix}-p-boosttagmult" min="0" step="0.1" value="${p.boostTagMultiplier}" title="Damage multiplier for your own moves matching any listed tag/type">
          </div>
          <div class="rule-row ${prefix}-p-loafaround-row">
            <label class="rule-label">Loaf Cycle: Acts Once Every / Starts</label>
            <input type="number" class="${prefix}-p-loafinterval" min="2" step="1" value="${p.loafInterval}" title="2 = Truant-style (acts, loafs, acts, loafs...). Higher = acts once every N turns.">
            <div class="heal-toggle ${prefix}-p-loafstarts">
              <button type="button" data-v="active" class="${p.loafStartsActive?"picked":""}">[ Active on Turn 1 ]</button>
              <button type="button" data-v="loaf" class="${!p.loafStartsActive?"picked":""}">[ Loafing on Turn 1 ]</button>
            </div>
          </div>
          <div class="rule-row ${prefix}-p-allyhit-row">
            <label class="rule-label">Huge Hit = at least (% of the teammate's max HP)</label>
            <input type="number" class="${prefix}-p-allyhitpct" min="1" max="100" step="5" value="${p.allyHitPct}" title="Works from the bench. A hit that would KO the active teammate (it is left at 1 HP) or takes at least this % of its max HP fires this ability's Action and Additional Effects. Once per battle. Add the Switch In effect to enter the field.">
          </div>
          <div class="rule-row ${prefix}-p-ohkoguard-row">
            <label class="rule-label">Resist OHKO: Immune While HP Is At/Above (%)</label>
            <input type="number" class="${prefix}-p-ohkoguardpct" min="1" max="100" step="5" value="${p.ohkoGuardHpPct}" title="One-hit-KO moves have no effect while this Fakemon's HP is at or above this %. 100 = only at full HP (Sturdy-style).">
          </div>
          <div class="rule-row ${prefix}-p-block-row">
            <label class="rule-label">Auto-Fail: Move Type</label>
            <select class="${prefix}-p-blocktype">${typeOptionsHtml(p.blockType)}</select>
          </div>
          <div class="rule-row ${prefix}-p-blockscope-row">
            <label class="rule-label">Auto-Fail: Whose Moves</label>
            <select class="${prefix}-p-blockscope"><option value="all" ${p.blockScope==="all"?"selected":""}>Everyone's moves (Desolate Land / Primordial Sea)</option><option value="opponent" ${p.blockScope==="opponent"?"selected":""}>Only the opponent's moves</option></select>
          </div>
          <div class="rule-row ${prefix}-p-blockweather-row">
            <label class="rule-label">Auto-Fail: Also Set Weather on Entry</label>
            <select class="${prefix}-p-blockweather"><option value="none" ${p.blockWeather==="none"?"selected":""}>None</option>${WEATHER_STATES.filter(w=>w[0]!=="clear").map(([k,l])=>`<option value="${k}" ${p.blockWeather===k?"selected":""}>${l} (cannot be replaced)</option>`).join("")}</select>
          </div>
          <div class="rule-row ${prefix}-p-trap-row">
            <label class="rule-label">Trap Opponent: Who Is Trapped</label>
            <select class="${prefix}-p-trapscope" title="Trapped opponents can't switch out (bot switching and their own U-turn-style moves are blocked). Forced drag-outs and fainting still work.">${TRAP_SCOPES.map(([v,l])=>`<option value="${v}" ${v===p.trapScope?"selected":""}>${l}</option>`).join("")}</select>
          </div>
          <div class="rule-row ${prefix}-p-traptypes-row">
            <label class="rule-label">Trap Filter: Types</label>
            <div class="type-checks ${prefix}-p-traptypes">
              ${TYPES.map(t=>`<label class="type-check"><input type="checkbox" class="${prefix}-p-traptype" value="${t}" ${(p.trapTypes||[]).includes(t)?"checked":""}> ${cap(t)}</label>`).join("")}
            </div>
          </div>
          <div class="rule-row ${prefix}-p-traptags-row">
            <label class="rule-label">Trap Filter: Tags (comma-separated)</label>
            <input type="text" data-tagkind="creature" class="${prefix}-p-traptags" placeholder="e.g. flying, floating, levitating" value="${esc(p.trapTags)}" title="Matches Fakemon Tags (and types). 'flying', 'floating', 'levitating' and 'airborne' all match anything airborne: Flying-types and levitating-tagged Fakemon.">
          </div>
          <div class="rule-row ${prefix}-p-slowstart-row">
            <label class="rule-label">Slow Start: First N Turns / Multiplier</label>
            <input type="number" class="${prefix}-p-slowstartturns" min="1" step="1" value="${p.slowStartTurns}" title="How many turns from battle start the penalty lasts">
            <input type="number" class="${prefix}-p-slowstartmult" min="0" step="0.1" value="${p.slowStartMultiplier}" title="0.5 = halved, like the real Slow Start">
          </div>
          <div class="rule-row ${prefix}-p-slowstartkeys-row">
            <label class="rule-label">Slow Start: Affected Stats</label>
            <div class="type-checks ${prefix}-p-slowstartkeys">
              ${STAT_STAGE_KEYS.map(([v,l])=>`<label class="type-check"><input type="checkbox" class="${prefix}-p-slowstartkey" value="${v}" ${(p.slowStartKeys||[]).includes(v)?"checked":""}> ${l}</label>`).join("")}
            </div>
          </div>
          <div class="rule-row ${prefix}-p-movetypeoverride-row">
            <label class="rule-label">Convert Move Type — From / To / Power ×</label>
            <select class="${prefix}-p-movetypefrom" title="Any = converts every move regardless of its current type (Normalize-style). A specific type = only converts moves that are currently that type (Galvanize/Pixilate/Refrigerate-style)">
              <option value="any" ${p.moveTypeFrom==="any"?"selected":""}>Any Type (Normalize-style)</option>
              ${TYPES.map(t=>`<option value="${t}" ${t===p.moveTypeFrom?"selected":""}>${cap(t)}</option>`).join("")}
            </select>
            <select class="${prefix}-p-movetypeto">${TYPES.map(t=>`<option value="${t}" ${t===p.moveTypeTo?"selected":""}>${cap(t)}</option>`).join("")}</select>
            <input type="number" class="${prefix}-p-movetypeboost" min="0" step="0.1" value="${p.moveTypeBoost}" title="Power multiplier applied on conversion. 1 = no boost (Normalize-style). 1.2 = Galvanize/Pixilate/Refrigerate/Aerilate-style">
          </div>
          <div class="rule-row ${prefix}-p-hittag-row">
            <label class="rule-label">Move Tag</label>
            <input type="text" class="${prefix}-p-hittagfilter" placeholder="e.g. Sound, Punching" value="${esc(p.hitTagFilter)}" title="Case-insensitive match against the relevant move's tags for whichever tag-trigger is selected above (When Hit By / When Hitting With / When Opponent Uses / When You Use a Move Tag)">
          </div>
          <div class="rule-row ${prefix}-p-reflect-row">
            <label class="rule-label">Reflect Damage</label>
            <div class="heal-toggle ${prefix}-p-reflecttype">
              <button type="button" data-v="percent" class="${p.reflectType==="percent"?"picked":""}">[% Attacker Max HP]</button>
              <button type="button" data-v="flat" class="${p.reflectType==="flat"?"picked":""}">[Flat #]</button>
            </div>
            <input type="number" class="${prefix}-p-reflectvalue" min="0" step="1" value="${p.reflectValue}">
          </div>
          <div class="${prefix}-p-affectedtypes-row">${affectedTypesBlockHtml(p.affectedTypes, prefix+"-p-affectedtypes")}</div>
          <div class="rule-row ${prefix}-p-aura-row">
            <label class="rule-label">Aura Field (Type / % Dmg per Turn / Target)</label>
            <select class="${prefix}-p-aurafieldtype">${TYPES.map(t=>`<option value="${t}" ${t===p.auraFieldType?"selected":""}>${cap(t)}</option>`).join("")}</select>
            <input type="number" class="${prefix}-p-aurafieldpercent" min="0" max="100" step="1" value="${p.auraFieldPercent}">
            <select class="${prefix}-p-aurafieldtarget">${HEAL_TARGETS.map(([v,l])=>`<option value="${v}" ${v===p.auraFieldTarget?"selected":""}>${l}</option>`).join("")}</select>
          </div>
          <div class="rule-row ${prefix}-p-chip-row">
            <label class="rule-label">Chip Damage</label>
            <div class="heal-toggle ${prefix}-p-chiptype">
              <button type="button" data-v="percent" class="${p.chipDamageType==="percent"?"picked":""}">[% of Dmg]</button>
              <button type="button" data-v="flat" class="${p.chipDamageType==="flat"?"picked":""}">[Flat #]</button>
            </div>
            <input type="number" class="${prefix}-p-chipvalue" min="0" step="1" value="${p.chipDamageValue}">
            <select class="${prefix}-p-chiptrigger">
              <option value="onDealHit" ${p.chipDamageTrigger==="onDealHit"?"selected":""}>When Landing a Hit</option>
              <option value="onGetHit" ${p.chipDamageTrigger==="onGetHit"?"selected":""}>When Hit (Recoil-style)</option>
            </select>
          </div>
          <div class="rule-row ${prefix}-p-weather-row">
            <label class="rule-label">Set Weather</label>
            <select class="${prefix}-p-weatherset">${WEATHER_STATES.map(([v,l])=>`<option value="${v}" ${v===p.weatherSet?"selected":""}>${l}</option>`).join("")}</select>
            <input type="number" class="${prefix}-p-weatherduration" min="1" step="1" value="${p.weatherSetDuration}" title="Turns">
            <label class="dyn-hidden-check"><input type="checkbox" class="${prefix}-p-weatheroverridable" ${p.weatherOverridable?"checked":""}> Can Be Overridden By a Move</label>
          </div>
          <div class="rule-row ${prefix}-p-field-row">
            <label class="rule-label">Set Field Effect</label>
            <select class="${prefix}-p-fieldset">${FIELD_STATES.filter(f=>f[0]!=="none").map(([v,l])=>`<option value="${v}" ${v===p.fieldSet?"selected":""}>${l}</option>`).join("")}</select>
            <input type="number" class="${prefix}-p-fieldduration" min="1" step="1" value="${p.fieldSetDuration}" title="Turns">
            <label class="dyn-hidden-check"><input type="checkbox" class="${prefix}-p-fieldoverridable" ${p.fieldOverridable?"checked":""}> Can Be Overridden By a Move</label>
          </div>
          <div class="rule-row ${prefix}-p-pollutedchance-row">
            <label class="rule-label">Polluted: Turn-End Poison Chance %</label>
            <input type="number" class="${prefix}-p-pollutedchance" min="0" max="100" step="5" value="${p.pollutedPoisonChance}">
          </div>
          <div class="rule-row ${prefix}-p-ppcost-row">
            <label class="rule-label">Dynamic PP Cost: Target Move</label>
            <select class="${prefix}-p-ppcosttarget">${PP_COST_TARGETS.map(([v,l])=>`<option value="${v}" ${v===p.ppCostTarget?"selected":""}>${l}</option>`).join("")}</select>
            <div class="heal-toggle ${prefix}-p-ppcostdir">
              <button type="button" data-v="increase" class="${p.ppCostDirection==="increase"?"picked":""}">[ Increase ]</button>
              <button type="button" data-v="decrease" class="${p.ppCostDirection==="decrease"?"picked":""}">[ Decrease ]</button>
            </div>
            <input type="number" class="${prefix}-p-ppcostamount" min="0" step="1" value="${p.ppCostAmount}" title="PP delta applied per use">
          </div>
          <div class="rule-row rule-chance-row">
            <label class="rule-label">Effect Chance %</label>
            <input type="number" class="${prefix}-p-chance" min="0" max="100" step="5" value="${p.chance}">
          </div>
        </div>

        <div class="rule-sub ${prefix}-active-panel">
          <p class="rule-sub-title">Active Trigger (Boolean Gate)</p>
          <div class="rule-row">
            <label class="rule-label">Condition</label>
            <select class="${prefix}-a-condition">${ACTIVE_CONDITIONS.map(([v,l])=>`<option value="${v}" ${v===ac.condition?"selected":""}>${l}</option>`).join("")}</select>
          </div>
          <div class="rule-row ${prefix}-a-weathercond-row">
            <label class="rule-label">Weather Must Be</label>
            <select class="${prefix}-a-weathercond">${WEATHER_STATES.filter(w=>w[0]!=="clear").map(([v,l])=>`<option value="${v}" ${v===ac.weatherCondition?"selected":""}>${l}</option>`).join("")}</select>
          </div>
          <div class="rule-row ${prefix}-a-hittype-row">
            <label class="rule-label">Element Type Hit</label>
            <select class="${prefix}-a-hittype">${TYPES.map(t=>`<option value="${t}" ${t===ac.hitType?"selected":""}>${cap(t)}</option>`).join("")}</select>
          </div>
          <div class="rule-row ${prefix}-a-overridetype-row">
            <label class="rule-label">Move Type to Override</label>
            <select class="${prefix}-a-overridetype">${TYPES.map(t=>`<option value="${t}" ${t===ac.overrideType?"selected":""}>${cap(t)}</option>`).join("")}</select>
          </div>
          <div class="rule-row ${prefix}-a-hiteffect-row">
            <label class="rule-label">Effectiveness When Hitting</label>
            <select class="${prefix}-a-hiteffect">${HIT_EFFECTIVENESS_OPTIONS.map(([v,l])=>`<option value="${v}" ${v===ac.hitEffectiveness?"selected":""}>${l}</option>`).join("")}</select>
          </div>
          <div class="rule-row">
            <label class="rule-label">Action</label>
            <select class="${prefix}-a-action">${ACTIVE_ACTIONS.map(([v,l])=>`<option value="${v}" ${v===ac.action?"selected":""}>${l}</option>`).join("")}</select>
          </div>
          <div class="rule-row ${prefix}-a-once-row">
            <label class="dyn-hidden-check"><input type="checkbox" class="${prefix}-a-once" ${ac.oncePerBattle?"checked":""}> Activates Once Per Battle (Disguise-style)</label>
          </div>
          <div class="rule-row ${prefix}-a-heal-row">
            <label class="rule-label">Heal Amount</label>
            <div class="heal-toggle ${prefix}-a-healtype">
              <button type="button" data-v="percent" class="${ac.healType==="percent"?"picked":""}">[% Base]</button>
              <button type="button" data-v="flat" class="${ac.healType==="flat"?"picked":""}">[Flat #]</button>
            </div>
            <input type="number" class="${prefix}-a-healvalue" min="0" step="1" value="${ac.healValue}">
            <select class="${prefix}-a-healtarget">${HEAL_TARGETS.map(([v,l])=>`<option value="${v}" ${v===ac.healTarget?"selected":""}>${l}</option>`).join("")}</select>
          </div>
          <div class="rule-row ${prefix}-a-protect-row">
            <label class="rule-label">Shield vs Type</label>
            <select class="${prefix}-a-protecttype">${TYPES.map(t=>`<option value="${t}" ${t===ac.protectType?"selected":""}>${cap(t)}</option>`).join("")}</select>
            <input type="number" class="${prefix}-a-protectpct" min="0" max="100" step="5" value="${ac.protectPercent}" title="% damage reduction">
          </div>
          <div class="rule-row ${prefix}-a-weather-row">
            <label class="rule-label">Set Weather</label>
            <select class="${prefix}-a-weatherset">${WEATHER_STATES.map(([v,l])=>`<option value="${v}" ${v===ac.weatherSet?"selected":""}>${l}</option>`).join("")}</select>
            <input type="number" class="${prefix}-a-weatherduration" min="1" step="1" value="${ac.weatherSetDuration}" title="Turns">
            <label class="dyn-hidden-check"><input type="checkbox" class="${prefix}-a-weatheroverridable" ${ac.weatherOverridable?"checked":""}> Can Be Overridden By a Move</label>
          </div>
          <div class="rule-row ${prefix}-a-field-row">
            <label class="rule-label">Set Field Effect</label>
            <select class="${prefix}-a-fieldset">${FIELD_STATES.filter(f=>f[0]!=="none").map(([v,l])=>`<option value="${v}" ${v===ac.fieldSet?"selected":""}>${l}</option>`).join("")}</select>
            <input type="number" class="${prefix}-a-fieldduration" min="1" step="1" value="${ac.fieldSetDuration}" title="Turns">
            <label class="dyn-hidden-check"><input type="checkbox" class="${prefix}-a-fieldoverridable" ${ac.fieldOverridable?"checked":""}> Can Be Overridden By a Move</label>
          </div>
          <div class="rule-row ${prefix}-a-pollutedchance-row">
            <label class="rule-label">Polluted: Turn-End Poison Chance %</label>
            <input type="number" class="${prefix}-a-pollutedchance" min="0" max="100" step="5" value="${ac.pollutedPoisonChance}">
          </div>
          <div class="rule-row ${prefix}-a-mult-row">
            <label class="rule-label">Damage Multiplier</label>
            <input type="number" class="${prefix}-a-mult" step="0.1" min="0" value="${ac.multiplier}">
          </div>
          <div class="${prefix}-a-boosttypes-row">${affectedTypesBlockHtml(ac.boostTypeTargets, prefix+"-a-boosttypes", "Types to Boost (select one or more — none selected = never triggers)")}</div>
          <div class="rule-row ${prefix}-a-boosttagfilter-row">
            <label class="rule-label">Tags/Types to Boost (comma-separated)</label>
            <input type="text" class="${prefix}-a-boosttagfilter" placeholder="e.g. punch, fire" value="${esc(ac.boostTagFilter)}" title="A move's own Type also counts as an implicit tag here">
          </div>
          <div class="rule-row ${prefix}-a-ppcost-row">
            <label class="rule-label">Dynamic PP Cost: Target Move</label>
            <select class="${prefix}-a-ppcosttarget">${PP_COST_TARGETS.map(([v,l])=>`<option value="${v}" ${v===ac.ppCostTarget?"selected":""}>${l}</option>`).join("")}</select>
            <div class="heal-toggle ${prefix}-a-ppcostdir">
              <button type="button" data-v="increase" class="${ac.ppCostDirection==="increase"?"picked":""}">[ Increase ]</button>
              <button type="button" data-v="decrease" class="${ac.ppCostDirection==="decrease"?"picked":""}">[ Decrease ]</button>
            </div>
            <input type="number" class="${prefix}-a-ppcostamount" min="0" step="1" value="${ac.ppCostAmount}" title="PP delta applied per use">
          </div>
          <div class="rule-row rule-chance-row">
            <label class="rule-label">Effect Chance %</label>
            <input type="number" class="${prefix}-a-chance" min="0" max="100" step="5" value="${ac.chance}">
          </div>
        </div>
      </div>`;
  }

  // ---- Wires visibility + toggle-button behavior for a rule-builder block rendered with the given prefix.
  // This is the single "clean boolean if/else" switchboard both Abilities and Moves run through: each
  // field's visibility is a plain if/else on the currently selected Type / Trigger / Condition / Action. ----
  function wireRuleBuilder(row, prefix){
    function syncVisibility(){
      const t = row.querySelector(`.${prefix}-type`).value;
      row.querySelector(`.${prefix}-passive-panel`).style.display = t==="passive" ? "flex" : "none";
      row.querySelector(`.${prefix}-active-panel`).style.display = t==="active" ? "flex" : "none";

      const pTrigger = row.querySelector(`.${prefix}-p-trigger`).value;
      const pAction = row.querySelector(`.${prefix}-p-action`).value;
      // IF the passive trigger is "While Weather Is Active" THEN reveal the Weather Must Be selector — ELSE hide it.
      row.querySelector(`.${prefix}-p-weathercond-row`).style.display = pTrigger==="weatherActive" ? "flex" : "none";
      row.querySelector(`.${prefix}-p-statloweredsource-row`).style.display = pTrigger==="statLowered" ? "flex" : "none";
      // IF the passive trigger is "When Receiving a Move With Tag" THEN reveal the tag-to-match field.
      row.querySelector(`.${prefix}-p-hittag-row`).style.display =
        ["hitByTag","onHitTag","opponentUsesTag","selfUsesTag"].includes(pTrigger) ? "flex" : "none";
      row.querySelector(`.${prefix}-p-mult-row`).style.display = pAction==="multiplyDamage" ? "flex" : "none";
      row.querySelector(`.${prefix}-p-secchancemult-row`).style.display = pAction==="secondaryChanceMult" ? "flex" : "none";
      row.querySelector(`.${prefix}-p-secchancescope-row`).style.display = pAction==="secondaryChanceMult" ? "flex" : "none";
      // Stat / Stage fields are shared by both the plain "Modify Stat Stage" action and the tag-triggered
      // "Apply Stat Modification" action.
      row.querySelector(`.${prefix}-p-stat-row`).style.display = (pAction==="modifyStat" || pAction==="tagStatMod") ? "flex" : "none";
      row.querySelector(`.${prefix}-p-reflect-row`).style.display = pAction==="reflectDamage" ? "flex" : "none";
      row.querySelector(`.${prefix}-p-heal-row`).style.display = pAction==="heal" ? "flex" : "none";
      row.querySelector(`.${prefix}-p-protect-row`).style.display = (pAction==="protect" || pAction==="reduceSuperEffective") ? "flex" : "none";
      row.querySelector(`.${prefix}-p-resist-row`).style.display = pAction==="resistanceMult" ? "flex" : "none";
      row.querySelector(`.${prefix}-p-tag-row`).style.display = pAction==="tagDamageMult" ? "flex" : "none";
      row.querySelector(`.${prefix}-p-boosttag-row`).style.display = pAction==="boostTagMove" ? "flex" : "none";
      row.querySelector(`.${prefix}-p-movetypeoverride-row`).style.display = pAction==="moveTypeOverride" ? "flex" : "none";
      row.querySelector(`.${prefix}-p-loafaround-row`).style.display = pAction==="loafAround" ? "flex" : "none";
      row.querySelector(`.${prefix}-p-allyhit-row`).style.display = pTrigger==="allyHugeHit" ? "flex" : "none";
      row.querySelector(`.${prefix}-p-ohkoguard-row`).style.display = pAction==="ohkoGuard" ? "flex" : "none";
      ["block","blockscope","blockweather"].forEach(k=>{ row.querySelector(`.${prefix}-p-${k}-row`).style.display = pAction==="blockMoveType" ? "flex" : "none"; });
      // IF the passive action is "Trap Opponent" THEN reveal the scope picker — and the type/tag filters only when the scope isn't "Every opponent".
      const trapOn = pAction==="trapSwitch";
      const trapFiltered = trapOn && row.querySelector(`.${prefix}-p-trapscope`).value !== "all";
      row.querySelector(`.${prefix}-p-trap-row`).style.display = trapOn ? "flex" : "none";
      row.querySelector(`.${prefix}-p-traptypes-row`).style.display = trapFiltered ? "flex" : "none";
      row.querySelector(`.${prefix}-p-traptags-row`).style.display = trapFiltered ? "flex" : "none";
      row.querySelector(`.${prefix}-p-slowstart-row`).style.display = pAction==="slowStart" ? "flex" : "none";
      row.querySelector(`.${prefix}-p-slowstartkeys-row`).style.display = pAction==="slowStart" ? "flex" : "none";
      row.querySelector(`.${prefix}-p-aura-row`).style.display = pAction==="auraField" ? "flex" : "none";
      row.querySelector(`.${prefix}-p-chip-row`).style.display = pAction==="chipOnHit" ? "flex" : "none";
      row.querySelector(`.${prefix}-p-weather-row`).style.display = pAction==="setWeather" ? "flex" : "none";
      row.querySelector(`.${prefix}-p-field-row`).style.display = pAction==="setField" ? "flex" : "none";
      // IF the passive action is "Modify PP Cost" THEN reveal the Target/Direction/Amount fields — ELSE hide them.
      row.querySelector(`.${prefix}-p-ppcost-row`).style.display = pAction==="modifyPPCost" ? "flex" : "none";
      // IF the passive action sets weather AND the chosen weather is Polluted THEN reveal the Poison Chance field.
      const pWeatherSet = row.querySelector(`.${prefix}-p-weatherset`).value;
      row.querySelector(`.${prefix}-p-pollutedchance-row`).style.display = (pAction==="setWeather" && pWeatherSet==="polluted") ? "flex" : "none";

      const aAction = row.querySelector(`.${prefix}-a-action`).value;
      row.querySelector(`.${prefix}-a-heal-row`).style.display = aAction==="heal" ? "flex" : "none";
      row.querySelector(`.${prefix}-a-protect-row`).style.display = aAction==="protect" ? "flex" : "none";
      row.querySelector(`.${prefix}-a-weather-row`).style.display = aAction==="setWeather" ? "flex" : "none";
      row.querySelector(`.${prefix}-a-field-row`).style.display = aAction==="setField" ? "flex" : "none";
      // IF the active action is "Modify PP Cost" THEN reveal the Target/Direction/Amount fields — ELSE hide them.
      row.querySelector(`.${prefix}-a-ppcost-row`).style.display = aAction==="modifyPPCost" ? "flex" : "none";
      // IF the active action sets weather AND the chosen weather is Polluted THEN reveal the Poison Chance field.
      const aWeatherSet = row.querySelector(`.${prefix}-a-weatherset`).value;
      row.querySelector(`.${prefix}-a-pollutedchance-row`).style.display = (aAction==="setWeather" && aWeatherSet==="polluted") ? "flex" : "none";
      // IF the active action is "Boost Damage by Custom Multiplier" / "Boost Type Moves" / "Boost Tag Moves" THEN reveal the Multiplier field.
      row.querySelector(`.${prefix}-a-mult-row`).style.display = ["boostDamageCustom","boostType","boostTagMove"].includes(aAction) ? "flex" : "none";
      row.querySelector(`.${prefix}-a-boosttypes-row`).style.display = aAction==="boostType" ? "flex" : "none";
      row.querySelector(`.${prefix}-a-boosttagfilter-row`).style.display = aAction==="boostTagMove" ? "flex" : "none";

      const aCondition = row.querySelector(`.${prefix}-a-condition`).value;
      // IF the active condition is "IF Weather Is Active" THEN reveal the Weather Must Be selector — ELSE hide it.
      row.querySelector(`.${prefix}-a-weathercond-row`).style.display = aCondition==="weatherIs" ? "flex" : "none";
      row.querySelector(`.${prefix}-a-hittype-row`).style.display = aCondition==="hitByType" ? "flex" : "none";
      row.querySelector(`.${prefix}-a-overridetype-row`).style.display = (aCondition==="typeMatchOverride" && aAction==="typeOverrideCrit") ? "flex" : "none";
      row.querySelector(`.${prefix}-a-hiteffect-row`).style.display = aCondition==="onHitting" ? "flex" : "none";
    }
    row.querySelector(`.${prefix}-type`).addEventListener("change", syncVisibility);
    row.querySelector(`.${prefix}-p-trigger`).addEventListener("change", syncVisibility);
    row.querySelector(`.${prefix}-p-action`).addEventListener("change", syncVisibility);
    row.querySelector(`.${prefix}-a-action`).addEventListener("change", syncVisibility);
    row.querySelector(`.${prefix}-a-condition`).addEventListener("change", syncVisibility);
    row.querySelector(`.${prefix}-p-weatherset`).addEventListener("change", syncVisibility);
    row.querySelector(`.${prefix}-p-trapscope`).addEventListener("change", syncVisibility);
    row.querySelector(`.${prefix}-a-weatherset`).addEventListener("change", syncVisibility);
    row.querySelectorAll(`.rule-builder .heal-toggle`).forEach(tg=>{
      tg.querySelectorAll("button").forEach(btn=>{
        btn.addEventListener("click", ()=>{
          tg.querySelectorAll("button").forEach(b=>b.classList.toggle("picked", b===btn));
        });
      });
    });
    syncVisibility();
  }

  // ---- Reads a rendered rule-builder block back into the unified {ruleType, passive, active} shape ----
  function collectRuleFromRow(row, prefix){
    return {
      ruleType: row.querySelector(`.${prefix}-type`).value,
      passive: {
        trigger: row.querySelector(`.${prefix}-p-trigger`).value,
        weatherCondition: row.querySelector(`.${prefix}-p-weathercond`).value,
        statLoweredSource: row.querySelector(`.${prefix}-p-statloweredsource`).value,
        filterType: row.querySelector(`.${prefix}-p-filter`).value,
        action: row.querySelector(`.${prefix}-p-action`).value,
        multiplier: Number(row.querySelector(`.${prefix}-p-mult`).value) || 1.5,
        statKey: row.querySelector(`.${prefix}-p-statkey`).value,
        statStage: Number(row.querySelector(`.${prefix}-p-statstage`).value) || 1,
        chance: Number(row.querySelector(`.${prefix}-p-chance`).value),
        healType: row.querySelector(`.${prefix}-p-healtype .picked`)?.dataset.v || "percent",
        healValue: Number(row.querySelector(`.${prefix}-p-healvalue`).value),
        healTarget: row.querySelector(`.${prefix}-p-healtarget`).value,
        protectType: row.querySelector(`.${prefix}-p-protecttype`).value,
        protectPercent: Number(row.querySelector(`.${prefix}-p-protectpct`).value),
        resistRatio: Number(row.querySelector(`.${prefix}-p-resistratio`).value),
        tagFilter: row.querySelector(`.${prefix}-p-tagfilter`).value,
        tagMultiplier: Number(row.querySelector(`.${prefix}-p-tagmult`).value),
        boostTagFilter: row.querySelector(`.${prefix}-p-boosttagfilter`).value,
        boostTagMultiplier: Number(row.querySelector(`.${prefix}-p-boosttagmult`).value),
        moveTypeFrom: row.querySelector(`.${prefix}-p-movetypefrom`).value,
        moveTypeTo: row.querySelector(`.${prefix}-p-movetypeto`).value,
        moveTypeBoost: Number(row.querySelector(`.${prefix}-p-movetypeboost`).value) || 1,
        loafInterval: Number(row.querySelector(`.${prefix}-p-loafinterval`).value) || 2,
        allyHitPct: Number(row.querySelector(`.${prefix}-p-allyhitpct`).value) || 50,
        blockType: row.querySelector(`.${prefix}-p-blocktype`).value,
        blockScope: row.querySelector(`.${prefix}-p-blockscope`).value,
        blockWeather: row.querySelector(`.${prefix}-p-blockweather`).value,
        ohkoGuardHpPct: Number(row.querySelector(`.${prefix}-p-ohkoguardpct`).value) || 100,
        loafStartsActive: (row.querySelector(`.${prefix}-p-loafstarts .picked`)?.dataset.v || "active") === "active",
        slowStartTurns: Number(row.querySelector(`.${prefix}-p-slowstartturns`).value) || 5,
        slowStartKeys: [...row.querySelectorAll(`.${prefix}-p-slowstartkey:checked`)].map(el=>el.value),
        trapScope: row.querySelector(`.${prefix}-p-trapscope`).value,
        trapTypes: [...row.querySelectorAll(`.${prefix}-p-traptype:checked`)].map(el=>el.value),
        trapTags: row.querySelector(`.${prefix}-p-traptags`).value,
        slowStartMultiplier: Number(row.querySelector(`.${prefix}-p-slowstartmult`).value),
        hitTagFilter: row.querySelector(`.${prefix}-p-hittagfilter`).value,
        secondaryChanceMultiplier: Number(row.querySelector(`.${prefix}-p-secchancemult`).value) || 2.0,
        secondaryChanceScope: row.querySelector(`.${prefix}-p-secchancescope`).value,
        reflectType: row.querySelector(`.${prefix}-p-reflecttype .picked`)?.dataset.v || "percent",
        reflectValue: Number(row.querySelector(`.${prefix}-p-reflectvalue`).value),
        affectedTypes: collectAffectedTypes(row.querySelector(`.${prefix}-p-affectedtypes-row`)),
        auraFieldType: row.querySelector(`.${prefix}-p-aurafieldtype`).value,
        auraFieldPercent: Number(row.querySelector(`.${prefix}-p-aurafieldpercent`).value),
        auraFieldTarget: row.querySelector(`.${prefix}-p-aurafieldtarget`).value,
        chipDamageType: row.querySelector(`.${prefix}-p-chiptype .picked`)?.dataset.v || "percent",
        chipDamageValue: Number(row.querySelector(`.${prefix}-p-chipvalue`).value),
        chipDamageTrigger: row.querySelector(`.${prefix}-p-chiptrigger`).value,
        weatherSet: row.querySelector(`.${prefix}-p-weatherset`).value,
        weatherSetDuration: Number(row.querySelector(`.${prefix}-p-weatherduration`).value),
        weatherOverridable: row.querySelector(`.${prefix}-p-weatheroverridable`).checked,
        fieldSet: row.querySelector(`.${prefix}-p-fieldset`).value,
        fieldSetDuration: Number(row.querySelector(`.${prefix}-p-fieldduration`).value),
        fieldOverridable: row.querySelector(`.${prefix}-p-fieldoverridable`).checked,
        pollutedPoisonChance: Number(row.querySelector(`.${prefix}-p-pollutedchance`).value),
        ppCostTarget: row.querySelector(`.${prefix}-p-ppcosttarget`).value,
        ppCostDirection: row.querySelector(`.${prefix}-p-ppcostdir .picked`)?.dataset.v || "increase",
        ppCostAmount: Number(row.querySelector(`.${prefix}-p-ppcostamount`).value)
      },
      active: {
        condition: row.querySelector(`.${prefix}-a-condition`).value,
        weatherCondition: row.querySelector(`.${prefix}-a-weathercond`).value,
        action: row.querySelector(`.${prefix}-a-action`).value,
        chance: Number(row.querySelector(`.${prefix}-a-chance`).value),
        healType: row.querySelector(`.${prefix}-a-healtype .picked`)?.dataset.v || "percent",
        healValue: Number(row.querySelector(`.${prefix}-a-healvalue`).value),
        healTarget: row.querySelector(`.${prefix}-a-healtarget`).value,
        protectType: row.querySelector(`.${prefix}-a-protecttype`).value,
        protectPercent: Number(row.querySelector(`.${prefix}-a-protectpct`).value),
        hitType: row.querySelector(`.${prefix}-a-hittype`).value,
        overrideType: row.querySelector(`.${prefix}-a-overridetype`).value,
        hitEffectiveness: row.querySelector(`.${prefix}-a-hiteffect`).value,
        oncePerBattle: row.querySelector(`.${prefix}-a-once`).checked,
        weatherSet: row.querySelector(`.${prefix}-a-weatherset`).value,
        weatherSetDuration: Number(row.querySelector(`.${prefix}-a-weatherduration`).value),
        weatherOverridable: row.querySelector(`.${prefix}-a-weatheroverridable`).checked,
        fieldSet: row.querySelector(`.${prefix}-a-fieldset`).value,
        fieldSetDuration: Number(row.querySelector(`.${prefix}-a-fieldduration`).value),
        fieldOverridable: row.querySelector(`.${prefix}-a-fieldoverridable`).checked,
        pollutedPoisonChance: Number(row.querySelector(`.${prefix}-a-pollutedchance`).value),
        multiplier: Number(row.querySelector(`.${prefix}-a-mult`).value) || 2,
        boostTypeTargets: collectAffectedTypes(row.querySelector(`.${prefix}-a-boosttypes-row`)),
        boostTagFilter: row.querySelector(`.${prefix}-a-boosttagfilter`).value,
        ppCostTarget: row.querySelector(`.${prefix}-a-ppcosttarget`).value,
        ppCostDirection: row.querySelector(`.${prefix}-a-ppcostdir .picked`)?.dataset.v || "increase",
        ppCostAmount: Number(row.querySelector(`.${prefix}-a-ppcostamount`).value)
      }
    };
  }

  function addAbilityRow(data, targetEl){
    targetEl = targetEl || abilityFieldsEl;
    const isExisting = !!data; // fresh "＋ Add Ability" clicks pass null — those start expanded, not collapsed
    data = normalizeAbility(data || {});
    const row = document.createElement("div"); row.className = "dyn-row";
    row.innerHTML = `
      <div class="dyn-row-top">
        <input type="text" class="ab-name" placeholder="Ability name, e.g. Blaze Core" value="${esc(data.name)}">
        <span class="dyn-row-collapsed-preview"></span>
        <button type="button" class="dyn-row-collapse" title="Minimize/Expand">▲</button>
        <button type="button" class="dyn-row-remove" title="Remove ability">×</button>
      </div>
      <div class="dyn-row-body">
      <div class="dyn-row-meta">
        <label class="dyn-hidden-check"><input type="checkbox" class="ab-hidden" ${data.hidden?"checked":""}> Hidden Ability</label>
      </div>
      <textarea class="ab-desc" placeholder="What does it do?">${esc(data.desc)}</textarea>

      <div class="rule-row ab-lockability-row">
        <label class="dyn-hidden-check"><input type="checkbox" class="ab-lockability" ${data.lockAbility?"checked":""}> Cannot Be Copied / Swapped / Overwritten (Wonder Guard / Multitype-style Lock — blocks Role Play, Trace, Skill Swap, Entrainment, and Ditto-style Transform against this ability, both as source and target)</label>
      </div>

      <div class="rule-row ab-negatestatmod-row">
        <label class="rule-label">Negate Stat Changes (blocks incoming stat-stage mods against this ability's owner)</label>
        <select class="ab-negatestatmod">${NEGATE_STATMOD_MODES.map(([v,l])=>`<option value="${v}" ${v===data.negateStatMod?"selected":""}>${l}</option>`).join("")}</select>
      </div>
      <div class="rule-row ab-recoil-row">
        <label class="dyn-hidden-check"><input type="checkbox" class="ab-boostsrecoil" ${data.boostsRecoilMoves?"checked":""}> Boosts Moves With Recoil (Reckless-style, 1.2x power)</label>
        <label class="dyn-hidden-check"><input type="checkbox" class="ab-ignoresrecoil" ${data.ignoresRecoil?"checked":""}> Immune to Own Recoil Damage (Rock Head-style)</label>
      </div>
      <div class="rule-row ab-immunetype-row">
        <label class="rule-label">Immune to Type (any damage of this type is reduced to 0)</label>
        <select class="ab-immunetype">
          <option value="none" ${data.immuneToType==="none"?"selected":""}>— None —</option>
          ${TYPES.map(t=>`<option value="${t}" ${t===data.immuneToType?"selected":""}>${cap(t)}</option>`).join("")}
        </select>
      </div>
      <div class="rule-row ab-shieldbreaker-row">
        <label class="rule-inline-label">Damage Multiplier against Shields <input type="number" class="ab-shieldbreaker" min="0" step="0.1" value="${data.shieldBreakerMultiplier}"> (multiplies Hit-Count Capacity removed per landed hit against a Breakable Attack Shield; 1 = normal)</label>
      </div>
      <div class="rule-row ab-mirrorpercent-row">
        <label class="rule-inline-label">Mirror Damage Reflection % <input type="number" class="ab-mirrorpercent" min="0" max="100" step="5" value="${data.mirrorReflectPercent}"> of any damage taken is reflected straight back at the attacker (0 = disabled)</label>
      </div>
      <div class="rule-row ab-ignoresweather-row">
        <label class="dyn-hidden-check"><input type="checkbox" class="ab-ignoresweather" ${data.ignoresWeatherEffects?"checked":""}> Ignores Weather Effects (Night Blooming-style)</label>
        <select class="ab-ignoredweather">
          <option value="any" ${data.ignoredWeather==="any"?"selected":""}>Any Weather</option>
          ${WEATHER_STATES.filter(w=>w[0]!=="clear").map(([v,l])=>`<option value="${v}" ${v===data.ignoredWeather?"selected":""}>${l}</option>`).join("")}
        </select>
      </div>

      ${ruleBuilderBlockHtml("ab", data)}
      ${effectsBlockHtml()}
      </div>`;
    row.querySelector(".dyn-row-remove").addEventListener("click", ()=>row.remove());

    // ---- Collapsible Builder Block: toggles the .dyn-row-collapsed class, which hides .dyn-row-body via
    // CSS — keeps the name input + a live preview snippet visible so a minimized ability is still identifiable.
    // Starts collapsed by default whenever an existing Ability is being loaded in (editing an entry, or
    // populating a Mega profile), to avoid long scroll fatigue; a freshly-added blank row stays expanded. ----
    if(isExisting) row.classList.add("dyn-row-collapsed");
    wireRowCollapse(row, ()=> row.querySelector(".ab-name").value.trim() || "Untitled Ability");

    wireRuleBuilder(row, "ab");
    wireEffectsBlock(row, data);

    targetEl.appendChild(row);
  }
  document.getElementById("addAbilityBtn").addEventListener("click", ()=>addAbilityRow());
  function collectAbilities(containerEl){
    containerEl = containerEl || abilityFieldsEl;
    return [...containerEl.querySelectorAll(":scope > .dyn-row")].map(row=>{
      const r = collectRuleFromRow(row, "ab");
      return {
        name: row.querySelector(".ab-name").value.trim(),
        desc: row.querySelector(".ab-desc").value.trim(),
        hidden: row.querySelector(".ab-hidden").checked,
        abilityType: r.ruleType,
        passive: r.passive,
        active: r.active,
        effects: collectEffects(row.querySelector(".effects-list")),
        negateStatMod: row.querySelector(".ab-negatestatmod").value,
        boostsRecoilMoves: row.querySelector(".ab-boostsrecoil").checked,
        ignoresRecoil: row.querySelector(".ab-ignoresrecoil").checked,
        immuneToType: row.querySelector(".ab-immunetype").value,
        ignoresWeatherEffects: row.querySelector(".ab-ignoresweather").checked,
        ignoredWeather: row.querySelector(".ab-ignoredweather").value,
        shieldBreakerMultiplier: Number(row.querySelector(".ab-shieldbreaker").value),
        mirrorReflectPercent: Number(row.querySelector(".ab-mirrorpercent").value),
        lockAbility: row.querySelector(".ab-lockability").checked
      };
    }).filter(a=>a.name).map(normalizeAbility);
  }

  function addMoveRow(data, targetEl){
    targetEl = targetEl || moveFieldsEl;
    const isExisting = !!data; // fresh "＋ Add Move" clicks pass null — those start expanded, not collapsed
    data = normalizeMove(data || {});
    const row = document.createElement("div"); row.className = "dyn-row";
    row.innerHTML = `
      <div class="dyn-row-top">
        <input type="text" class="mv-name" placeholder="Move name, e.g. Ember Slash" value="${esc(data.name)}">
        <span class="dyn-row-collapsed-preview"></span>
        <button type="button" class="dyn-row-collapse" title="Minimize/Expand">▲</button>
        <button type="button" class="dyn-row-remove" title="Remove move">×</button>
      </div>
      <div class="dyn-row-body">
      <div class="dyn-row-meta">
        <select class="mv-type">${typeOptionsHtml(data.type)}</select>
        <select class="mv-cat">${MOVE_CATEGORIES.map(c=>`<option value="${c}" ${c===data.category?"selected":""}>${c}</option>`).join("")}</select>
        <select class="mv-priority" title="Move Priority">${MOVE_PRIORITIES.map(p=>`<option value="${p}" ${p===data.priority?"selected":""}>${p>0?"+"+p:p} Priority</option>`).join("")}</select>
      </div>
      <div class="rule-row mv-megausable-row">
        <label class="dyn-hidden-check"><input type="checkbox" class="mv-megausable" ${data.megaUsable?"checked":""}> Can Be Used In Mega Evolution</label>
        <div class="field-hint">Unchecked (default): a base-movepool move is dropped from the usable move list once the creature is Mega Evolved. Checked: it stays selectable in both forms. A move placed only in the Mega's own Special Mega Move Slots is always Mega-only regardless of this checkbox — it simply isn't in the base movepool to begin with. This restriction only applies to profiles whose Transformation Type is "Mega Evolution" (or "Other") — a profile set to "Dynamax" ignores it entirely and keeps every base move, matching normal Dynamax behavior.</div>
      </div>
      <details class="mv-weatheracc-box" style="margin:6px 0;">
        <summary>Weather Accuracy Rules (Thunder / Hurricane / Blizzard-style)</summary>
        <div class="field-hint">For each weather, give this move a different Accuracy % while that weather is active, and/or tick "Never misses". Leave blank for no change. Example: Thunder = Rainy "Never misses", Sunny 50%.</div>
        ${WEATHER_STATES.filter(w=>w[0]!=="clear").map(([k,l])=>{ const r=(data.weatherAccuracy||[]).find(x=>x.weather===k)||{}; return `<div class="rule-row"><label class="rule-label">${l}</label><input type="number" class="mv-wacc" data-weather="${k}" min="1" max="100" placeholder="—" value="${r.accuracy!=null?Math.round(r.accuracy*100):""}"> % <label class="rule-inline-label"><input type="checkbox" class="mv-wacc-never" data-weather="${k}" ${r.neverMiss?"checked":""}> Never misses</label></div>`; }).join("")}
      </details>
      <div class="dyn-row-meta mv-numeric-row">
        <label class="rule-inline-label mv-basepower-row">Base Power <input type="number" class="mv-basepower" min="0" max="250" step="5" value="${data.basePower}"></label>
        <label class="rule-inline-label">Accuracy <input type="number" class="mv-acc" min="0" max="1" step="0.05" value="${data.accuracy}"></label>
        <label class="rule-inline-label">Max PP <input type="number" class="mv-pp" min="1" step="1" value="${data.maxPP}"></label>
        <label class="rule-inline-label" title="Raises the USER's own chance to dodge an incoming attack this turn, on top of the usual Speed-based dodge. 0 = no bonus. Quick Attack-style evasive strikes.">Dodge Chance % <input type="number" class="mv-dodgechance" min="0" max="100" step="5" value="${data.dodgeChance}"></label>
        <label class="rule-inline-label" title="Which level THIS creature learns the move at. Purely informational for this species — it never affects the move's own identity, so the same move taught at different levels across different creatures still counts as one shared entry in the Move Dex.">Learn Level <input type="number" class="mv-level" min="1" step="1" value="${data.level!=null?data.level:1}"></label>
      </div>
      <div class="rule-row mv-tags-row">
        <label class="rule-label">Tags (comma-separated; Slash/Punch/Kick/Bite/Draining/Defending auto-detected from name+desc)</label>
        <input type="text" class="mv-tags" data-tagkind="move" placeholder="e.g. Punch, Priority" value="${esc((data.tags||[]).join(", "))}">
      </div>
      <div class="rule-row mv-targetscope-row">
        <label class="rule-label" title="Who this move hits. Only used in 2v2 battles (1v1 and 6v6 always hit the single opponent). A move that hits several Fakemon deals 0.75x damage to each.">Target (2v2 battles)</label>
        <select class="mv-targetscope">${DOUBLES_TARGET_SCOPES.map(([v,l])=>`<option value="${v}" ${v===(data.targetScope||"enemy")?"selected":""}>${l}</option>`).join("")}</select>
      </div>
      <div class="rule-row mv-special-row">
        <label class="rule-label" title="A connecting hit deals the target's whole remaining HP. Set Accuracy low (e.g. 30%) like Fissure. Type immunities still apply; abilities with 'Resist OHKO Moves' block it.">OHKO Move (one-hit KO, like Fissure)</label>
        <input type="checkbox" class="mv-ohko" ${data.ohko?"checked":""}>
        <label class="rule-label" title="The user faints right after using this move, even if it misses (Explosion / Self-Destruct). It does not faint if the move fails its Fail Condition.">User faints after use (Explosion-style)</label>
        <input type="checkbox" class="mv-selffaint" ${data.selfFaint?"checked":""}>
      </div>
      <div class="rule-row mv-failstags-row">
        <label class="rule-label" title="The move FAILS against a target carrying any of these Fakemon tags. 'grounded' (also buried, burrowed, underground, subterranean) = buried in the ground, e.g. Whirlwind / Telekinesis / Sky Drop vs Diglett.">Fails Against Fakemon Tags (comma-separated)</label>
        <input type="text" class="mv-failstags" data-tagkind="creature" placeholder="e.g. grounded" value="${esc((data.failsAgainstTags||[]).join(", "))}">
        <select class="mv-failstags-on"><option value="opponent" ${data.failsAgainstTagsOn!=="self"?"selected":""}>Check the opponent's tags (Telekinesis, Whirlwind, Sky Drop)</option><option value="self" ${data.failsAgainstTagsOn==="self"?"selected":""}>Check the user's tags (Magnetic Lift on itself)</option></select>
      </div>
      <details class="mv-advanced-details">
      <summary class="mv-advanced-summary">⚙ Advanced move mechanics <span class="mv-advanced-summary-sub">(optional — most moves never need these. Open this only for special stuff like multi-hit, charge-up moves, Counter, or self-sacrifice effects.)</span></summary>
      ${tagRulesBlockHtml()}
      ${moveVsTagsBlockHtml()}
      ${statusBypassBlockHtml(data.statusBypass)}
      <div class="rule-row mv-weightscaling-row">
        <label class="rule-label">Weight Interaction</label>
        <select class="mv-weightscaling">${WEIGHT_SCALING_MODES.map(([v,l])=>`<option value="${v}" ${v===data.weightScaling?"selected":""}>${l}</option>`).join("")}</select>
      </div>
      <div class="rule-row mv-dynamicpower-row">
        <label class="rule-label">Dynamic Base Power (Speed/Weight Formula) — replaces Base Power above with a computed value instead of a fixed number</label>
        <select class="mv-dynamicpower">${DYNAMIC_POWER_MODES.map(([v,l])=>`<option value="${v}" ${v===data.dynamicPower?"selected":""}>${l}</option>`).join("")}</select>
      </div>
      <div class="rule-row mv-historyscaling-row">
        <label class="rule-label">Battle History Scaling</label>
        <select class="mv-historyscaling">${HISTORY_SCALING_MODES.map(([v,l])=>`<option value="${v}" ${v===data.historyScaling?"selected":""}>${l}</option>`).join("")}</select>
      </div>
      <div class="rule-row mv-historystep-row">
        <label class="rule-inline-label">Damage Bonus per Stack/Count % <input type="number" class="mv-historystep" min="0" step="5" value="${data.historyScalingStepPct}"></label>
      </div>
      <div class="rule-row mv-damagebasis-row">
        <label class="rule-label">Damage Basis</label>
        <select class="mv-damagebasis">${DAMAGE_BASIS_OPTIONS.map(([v,l])=>`<option value="${v}" ${v===data.damageBasis?"selected":""}>${l}</option>`).join("")}</select>
      </div>
      <div class="rule-row mv-statbasis-row">
        <label class="rule-label">Custom Damage Scaling (e.g. Psyshock: SpAtk vs Def)</label>
        <select class="mv-atkstatbasis">
          <option value="auto" ${data.atkStatBasis==="auto"?"selected":""}>Offensive Stat: Auto (by Category)</option>
          <option value="atk" ${data.atkStatBasis==="atk"?"selected":""}>Offensive Stat: Attack</option>
          <option value="spa" ${data.atkStatBasis==="spa"?"selected":""}>Offensive Stat: Sp. Attack</option>
        </select>
        <select class="mv-defstatbasis">
          <option value="auto" ${data.defStatBasis==="auto"?"selected":""}>Defensive Stat: Auto (by Category)</option>
          <option value="def" ${data.defStatBasis==="def"?"selected":""}>Defensive Stat: Defense</option>
          <option value="spd" ${data.defStatBasis==="spd"?"selected":""}>Defensive Stat: Sp. Defense</option>
        </select>
      </div>
      <div class="rule-row mv-hits-row">
        <label class="rule-label">Hits Count</label>
        <select class="mv-hits">${HITS_OPTIONS.map(n=>`<option value="${n}" ${n===data.hits?"selected":""}>${n===1?"1 (single hit)":n+"x hits"}</option>`).join("")}</select>
      </div>
      <div class="rule-row mv-multihitscaling-row">
        <label class="rule-label">Multi-Hit Scaling <span style="color:var(--slate);text-transform:none;font-weight:400;">(only matters when Hits Count &gt; 1)</span></label>
        <select class="mv-multihitscaling">${MULTI_HIT_SCALING_MODES.map(t=>`<option value="${t[0]}" ${t[0]===data.multiHitScaling?"selected":""}>${t[1]}</option>`).join("")}</select>
        <input type="number" class="mv-multihitscalingpct" min="0" max="90" step="1" value="${data.multiHitScalingPct!=null?data.multiHitScalingPct:20}" placeholder="% per hit">
      </div>
      <div class="rule-row mv-triggers-row">
        <label class="dyn-hidden-check"><input type="checkbox" class="mv-ignoredef" ${data.ignoreDefense?"checked":""}> Ignore Defense (bypasses target's Def/SpD stat stage changes)</label>
        <label class="dyn-hidden-check"><input type="checkbox" class="mv-ignoreshield" ${data.ignoreShields?"checked":""}> Ignore Defenses/Shields (Bypass Protection Override — breaks through active shields, unless a shield is flagged Unignorable)</label>
      </div>
      <div class="rule-sub mv-delayed-row">
        <p class="rule-sub-title">Delayed Action Event (Future Sight / Doom Desire Mechanic)</p>
        <div class="rule-row">
          <label class="dyn-hidden-check"><input type="checkbox" class="mv-delayed-enabled" ${data.delayedAttack.enabled?"checked":""}> Enable Delayed Attack (damage lands on a future turn instead of immediately)</label>
        </div>
        <div class="rule-row mv-delayed-fields-row">
          <label class="rule-inline-label">Delay Duration <input type="number" class="mv-delayed-duration" min="1" step="1" value="${data.delayedAttack.delayTurns}"> Turns before landing</label>
        </div>
        <div class="rule-row mv-delayed-fields-row">
          <label class="rule-label">Stat Calculation Snap</label>
          <div class="heal-toggle mv-delayed-snapmode">
            <button type="button" data-v="launch" class="${data.delayedAttack.statSnapMode==="launch"?"picked":""}">[Snap Stats at Launch Time]</button>
            <button type="button" data-v="landing" class="${data.delayedAttack.statSnapMode==="landing"?"picked":""}">[Calculate Stats at Landing Time]</button>
          </div>
        </div>
        <div class="rule-row mv-delayed-fields-row">
          <label class="dyn-hidden-check"><input type="checkbox" class="mv-delayed-ignoretypeimmunity" ${data.delayedAttack.ignoreTypeImmunity?"checked":""}> Ignore Type Immunities When Landing</label>
        </div>
        <div class="rule-row mv-delayed-fields-row">
          <label class="rule-label">Secondary Effect Timing (this move's own Additional Effects list)</label>
          <div class="heal-toggle mv-delayed-efftiming">
            <button type="button" data-v="cast" class="${data.delayedAttack.effectTiming==="cast"?"picked":""}">[With Cast]</button>
            <button type="button" data-v="resolve" class="${data.delayedAttack.effectTiming==="resolve"?"picked":""}">[With Resolve]</button>
          </div>
        </div>
      </div>
      <div class="rule-sub mv-stateimm-row">
        <p class="rule-sub-title">State Immunity/Vulnerability Key (Fly / Dig / Bury Mechanics)</p>
        <div class="rule-row">
          <label class="dyn-hidden-check"><input type="checkbox" class="mv-stateimm-enabled" ${data.stateImmunity.enabled?"checked":""}> Enable — using this move puts the user into a named stance for the rest of the round, immune to (almost) everything</label>
        </div>
        <div class="rule-row mv-stateimm-fields-row">
          <label class="rule-inline-label">State Name <input type="text" class="mv-stateimm-key" placeholder="e.g. buried, airborne" value="${esc(data.stateImmunity.key)}"></label>
        </div>
        <div class="rule-row mv-stateimm-fields-row">
          <label class="rule-label">Moves/Tags that CAN still damage the user while in this state (comma-separated; matches move name OR any move tag, case-insensitive)</label>
          <input type="text" class="mv-stateimm-exceptions" placeholder="e.g. Earthquake, Ground" value="${esc((data.stateImmunity.exceptions||[]).join(", "))}">
        </div>
        <div class="rule-row mv-stateimm-fields-row">
          <label class="rule-label">Invulnerability Expiration Event</label>
          <select class="mv-stateimm-expireevent">
            <option value="onAttack" ${data.stateImmunity.expireEvent==="onAttack"?"selected":""}>On Attack Resolution (standard Fly/Dig)</option>
            <option value="fixedDuration" ${data.stateImmunity.expireEvent==="fixedDuration"?"selected":""}>Fixed Turn Duration</option>
          </select>
        </div>
        <div class="rule-row mv-stateimm-fields-row mv-stateimm-expiredur-row">
          <label class="rule-inline-label">Lasts for <input type="number" class="mv-stateimm-expiredur" min="1" step="1" value="${data.stateImmunity.expireDurationTurns}"> Turns (counter runs regardless of when/whether the attack lands)</label>
        </div>
      </div>
      <div class="rule-sub mv-charge-row">
        <p class="rule-sub-title">Multi-Turn Charge Execution (Solar Beam / Skull Bash Mechanics)</p>
        <div class="rule-row">
          <label class="dyn-hidden-check"><input type="checkbox" class="mv-charge-enabled" ${data.chargeUp.enabled?"checked":""}> Enable — the user locks into this move for a number of turns before it fires for real</label>
        </div>
        <div class="rule-row mv-charge-fields-row">
          <label class="rule-inline-label">Charge Duration <input type="number" class="mv-charge-duration" min="1" step="1" value="${data.chargeUp.duration}"> Turns spent preparing before the move fires</label>
        </div>
        <div class="rule-row mv-charge-fields-row">
          <label class="rule-label">User Condition While Charging</label>
          <select class="mv-charge-condition">${CHARGE_CONDITIONS.map(([v,l])=>`<option value="${v}" ${v===data.chargeUp.condition?"selected":""}>${l}</option>`).join("")}</select>
        </div>
        <div class="rule-row mv-charge-shield-row">
          <label class="rule-inline-label">Damage Reduction while Shielded <input type="number" class="mv-charge-shieldpct" min="0" max="100" step="5" value="${data.chargeUp.shieldPercent}"> %</label>
        </div>
        <div class="rule-row mv-charge-heal-row">
          <label class="rule-inline-label">Heal per Charging Turn <input type="number" class="mv-charge-healpct" min="0" max="100" step="5" value="${data.chargeUp.healPercent}"> % Max HP</label>
        </div>
      </div>
      <div class="rule-sub mv-counter-row">
        <p class="rule-sub-title">Counter Mechanics (Counter / Mirror Coat / Metal Burst)</p>
        <div class="rule-row">
          <label class="dyn-hidden-check"><input type="checkbox" class="mv-counter-enabled" ${data.counterMove.enabled?"checked":""}> Enable — this move ignores its own Base Power and instead reflects a multiple of the damage the user took THIS turn, bypassing the target's Def/SpD stat entirely. Fails if the user wasn't hit this turn (or was hit by a non-matching damage type).</label>
        </div>
        <div class="rule-row mv-counter-fields-row">
          <label class="rule-label">Reflects Damage Taken From</label>
          <select class="mv-counter-damagetype">${COUNTER_DAMAGE_TYPES.map(([v,l])=>`<option value="${v}" ${v===data.counterMove.damageType?"selected":""}>${l}</option>`).join("")}</select>
        </div>
        <div class="rule-row mv-counter-fields-row">
          <label class="rule-inline-label">Reflect Multiplier <input type="number" class="mv-counter-multiplier" min="0.1" step="0.1" value="${data.counterMove.multiplier}">x the damage taken</label>
        </div>
      </div>
      <div class="rule-row mv-failcond-row">
        <label class="rule-label">Move Fails If (Sucker Punch-style)</label>
        <select class="mv-failcond">${MOVE_FAIL_CONDITIONS.map(([v,l])=>`<option value="${v}" ${v===data.failCondition?"selected":""}>${l}</option>`).join("")}</select>
      </div>
      <div class="rule-row mv-failstatus-row">
        <label class="rule-label">Status Condition for this Fail Condition</label>
        <select class="mv-failstatus">${STATUS_DMG_FILTERS.map(([v,l])=>`<option value="${v}" ${v===(data.failStatus||"any")?"selected":""}>${l}</option>`).join("")}</select>
      </div>
      <div class="rule-row mv-failweather-row">
        <label class="rule-label">Required Weather</label>
        <select class="mv-failweather">${WEATHER_STATES.filter(w=>w[0]!=="clear").map(([v,l])=>`<option value="${v}" ${v===data.failWeather?"selected":""}>${l}</option>`).join("")}</select>
      </div>
      <div class="rule-row mv-failfield-row">
        <label class="rule-label">Required Field Effect</label>
        <select class="mv-failfield">${FIELD_STATES.map(([v,l])=>`<option value="${v}" ${v===data.failField?"selected":""}>${l}</option>`).join("")}</select>
      </div>
      <div class="rule-row mv-critrate-row">
        <label class="rule-label">Critical Hit Rate</label>
        <select class="mv-critrate">${CRIT_RATE_MODES.map(([v,l])=>`<option value="${v}" ${v===data.critRateMode?"selected":""}>${l}</option>`).join("")}</select>
      </div>
      <div class="rule-row mv-cooldown-row">
        <label class="rule-inline-label">Cooldown Turns <input type="number" class="mv-cooldown" min="0" step="1" value="${data.cooldownTurns}"></label>
      </div>
      <div class="rule-row mv-recoil-row">
        <label class="rule-inline-label">Recoil Damage (% of damage dealt) <input type="number" class="mv-recoil" min="0" max="100" step="5" value="${data.recoilPercent}"></label>
      </div>
      <div class="rule-row mv-statusdmgmult-row">
        <label class="rule-label">Damage Multiplier if the chosen side has the Status Condition</label>
        <input type="number" class="mv-statusdmgmult" min="0" step="0.1" value="${data.statusDamageMultiplier}">
        <select class="mv-statusdmgmult-filter">${STATUS_DMG_FILTERS.map(([v,l])=>`<option value="${v}" ${v===data.statusDamageMultFilter?"selected":""}>${l}</option>`).join("")}</select>
        <select class="mv-statusdmgmult-on"><option value="target" ${data.statusDamageMultOn!=="user"?"selected":""}>Target has it (Hex)</option><option value="user" ${data.statusDamageMultOn==="user"?"selected":""}>User has it (Facade)</option></select>
      </div>
      <div class="rule-row mv-dyntype-row">
        <label class="dyn-hidden-check"><input type="checkbox" class="mv-dyntype-enabled" ${data.dynamicTypeEnabled?"checked":""}> Dynamic Type Matching (Freedom Selection)</label>
        <select class="mv-dyntype-target">${TYPES.map(t=>`<option value="${t}" ${t===data.dynamicTypeTarget?"selected":""}>${cap(t)}</option>`).join("")}</select>
        <select class="mv-dyntype-mode">${DYNAMIC_TYPE_MODES.map(([v,l])=>`<option value="${v}" ${v===data.dynamicTypeMode?"selected":""}>${l}</option>`).join("")}</select>
      </div>

      <div class="rule-row mv-tradeoff-toggle-row">
        <label class="dyn-hidden-check"><input type="checkbox" class="mv-tradeoff-enabled" ${data.tradeoff.enabled?"checked":""}> Enable Tradeoff Action (Curse-style: self-cost forces a consequence onto the target)</label>
        <div class="field-hint">Charges the user a Cost, then forces a Target Consequence tracked over a Duration — optionally gated so it only triggers for a specific user Type.</div>
      </div>
      <div class="mv-tradeoff-wrap" style="display:${data.tradeoff.enabled?"block":"none"};">
        <div class="rule-row">
          <label class="rule-label">Conditional Type Override</label>
          <select class="mv-tradeoff-reqtype">
            <option value="any" ${data.tradeoff.requireUserType==="any"?"selected":""}>Any Type (always apply)</option>
            ${TYPES.map(t=>`<option value="${t}" ${t===data.tradeoff.requireUserType?"selected":""}>Apply ONLY if user is ${cap(t)}-type</option>`).join("")}
          </select>
          <div class="field-hint">If the user is NOT this type, the tradeoff is skipped entirely and the move just falls back to its normal damage/stat-boosting calculation.</div>
        </div>
        <div class="rule-row">
          <label class="rule-label">Cost (paid by the user)</label>
          <div class="heal-toggle mv-tradeoff-costtype">
            <button type="button" data-v="hpPercent" class="${data.tradeoff.costType==="hpPercent"?"picked":""}">[Sacrifice % Max HP]</button>
            <button type="button" data-v="statStage" class="${data.tradeoff.costType==="statStage"?"picked":""}">[Lower Own Stat Stage]</button>
          </div>
        </div>
        <div class="rule-row mv-tradeoff-costhp-row">
          <label class="rule-inline-label">Sacrifice <input type="number" class="mv-tradeoff-costhp" min="0" max="100" step="5" value="${data.tradeoff.costHpPercent}"> % Max HP</label>
        </div>
        <div class="rule-row mv-tradeoff-coststat-row">
          <label class="rule-label">Lower (User)</label>
          <select class="mv-tradeoff-coststatkey">${STAT_STAGE_KEYS.map(([v,l])=>`<option value="${v}" ${v===data.tradeoff.costStatKey?"selected":""}>${l}</option>`).join("")}</select>
          <label class="rule-inline-label">by <input type="number" class="mv-tradeoff-coststatstage" min="1" max="6" step="1" value="${data.tradeoff.costStatStage}"> stage(s)</label>
        </div>
        <div class="rule-row">
          <label class="rule-label">Target Consequence</label>
          <div class="heal-toggle mv-tradeoff-conseqtype">
            <button type="button" data-v="status" class="${data.tradeoff.consequenceType==="status"?"picked":""}">[Inflict Status]</button>
            <button type="button" data-v="drain" class="${data.tradeoff.consequenceType==="drain"?"picked":""}">[Drain % HP]</button>
            <button type="button" data-v="statStage" class="${data.tradeoff.consequenceType==="statStage"?"picked":""}">[Lower Stat Stage]</button>
          </div>
        </div>
        <div class="rule-row mv-tradeoff-conseqstatus-row">
          <label class="rule-label">Status Effect</label>
          <select class="mv-tradeoff-conseqstatus">${STATUS_EFFECTS.filter(s=>s[0]!=="none").map(([v,l])=>`<option value="${v}" ${v===data.tradeoff.consequenceStatus?"selected":""}>${l}</option>`).join("")}</select>
        </div>
        <div class="rule-row mv-tradeoff-conseqdrain-row">
          <label class="rule-inline-label">Drain <input type="number" class="mv-tradeoff-conseqdrain" min="0" max="100" step="5" value="${data.tradeoff.consequenceDrainPercent}"> % Target's Max HP per turn (returned to the user as HP)</label>
        </div>
        <div class="rule-row mv-tradeoff-conseqstat-row">
          <label class="rule-label">Lower (Target)</label>
          <select class="mv-tradeoff-conseqstatkey">${STAT_STAGE_KEYS.map(([v,l])=>`<option value="${v}" ${v===data.tradeoff.consequenceStatKey?"selected":""}>${l}</option>`).join("")}</select>
          <label class="rule-inline-label">by <input type="number" class="mv-tradeoff-conseqstatstage" min="1" max="6" step="1" value="${data.tradeoff.consequenceStatStage}"> stage(s)</label>
        </div>
        <div class="rule-row mv-tradeoff-duration-row">
          <label class="rule-inline-label">Duration <input type="number" class="mv-tradeoff-duration" min="1" step="1" value="${data.tradeoff.durationTurns}"> Turns (Status / Drain tracked this long)</label>
        </div>
      </div>
      </details>

      <div class="rule-row mv-action-row">
        <label class="rule-label">Secondary Effect <span style="color:var(--slate);text-transform:none;font-weight:400;">(what this move does in addition to damage — only matters for Status-category moves, or damaging moves that also inflict something)</span></label>
        <select class="mv-action">${MOVE_ACTIONS.map(([v,l])=>`<option value="${v}" ${v===data.action?"selected":""}>${l}</option>`).join("")}</select>
      </div>
      <div class="rule-row mv-exchangetarget-row">
        <label class="rule-label">Target Move Selection</label>
        <select class="mv-exchangetarget">${MOVE_EXCHANGE_TARGETS.map(([v,l])=>`<option value="${v}" ${v===data.moveExchangeTarget?"selected":""}>${l}</option>`).join("")}</select>
      </div>
      <div class="rule-row mv-exchangeslot-row">
        <label class="rule-inline-label">Slot # <input type="number" class="mv-exchangeslot" min="1" max="4" step="1" value="${data.moveExchangeSlot}"></label>
      </div>
      <div class="rule-row mv-transformrevert-row">
        <label class="rule-label">Transform Wears Off</label>
        <select class="mv-transformrevert">${TRANSFORM_REVERT_MODES.map(([v,l])=>`<option value="${v}" ${v===data.transformRevertMode?"selected":""}>${l}</option>`).join("")}</select>
      </div>
      <div class="rule-row mv-transformrevertturns-row">
        <label class="rule-inline-label">Reverts After <input type="number" class="mv-transformrevertturns" min="1" step="1" value="${data.transformRevertTurns}"> Turns</label>
      </div>
      <div class="rule-row mv-status-row">
        <label class="rule-label">Status Effect</label>
        <select class="mv-status">${STATUS_EFFECTS.map(([v,l])=>`<option value="${v}" ${v===data.statusEffect?"selected":""}>${l}</option>`).join("")}</select>
      </div>
      <div class="rule-row mv-statusdur-row">
        <label class="rule-label">Status Duration</label>
        <div class="heal-toggle mv-statusdurmode">
          <button type="button" data-v="random" class="${data.statusDurationMode==="random"?"picked":""}">[ Random Range ]</button>
          <button type="button" data-v="fixed" class="${data.statusDurationMode==="fixed"?"picked":""}">[ Fixed Turns ]</button>
        </div>
      </div>
      <div class="rule-row mv-statusdur-random-row">
        <label class="rule-inline-label">Min Turns <input type="number" class="mv-statusdur-min" min="1" step="1" value="${data.statusDurationMin}"></label>
        <label class="rule-inline-label">Max Turns <input type="number" class="mv-statusdur-max" min="1" step="1" value="${data.statusDurationMax}"></label>
      </div>
      <div class="rule-row mv-statusdur-fixed-row">
        <label class="rule-inline-label">Exactly <input type="number" class="mv-statusdur-fixed" min="1" step="1" value="${data.statusDurationFixed}"> Turns</label>
      </div>
      <div class="rule-row mv-heal-row">
        <label class="rule-label">Heal Amount</label>
        <div class="heal-toggle mv-healtype">
          <button type="button" data-v="percent" class="${data.healType==="percent"?"picked":""}">[% Base]</button>
          <button type="button" data-v="flat" class="${data.healType==="flat"?"picked":""}">[Flat #]</button>
        </div>
        <input type="number" class="mv-healvalue" min="0" step="1" value="${data.healValue}">
      </div>
      <div class="rule-row mv-healtarget-row">
        <label class="rule-label">Healing Target</label>
        <select class="mv-healtarget">${HEAL_TARGETS.map(([v,l])=>`<option value="${v}" ${v===data.healTarget?"selected":""}>${l}</option>`).join("")}</select>
      </div>
      <div class="rule-row mv-setsweather-row">
        <label class="dyn-hidden-check"><input type="checkbox" class="mv-setsweather" ${data.setsWeather?"checked":""}> Also Sets Weather When It Hits (works alongside damage)</label>
      </div>
      <div class="rule-row mv-weather-row">
        <label class="rule-label">Weather</label>
        <select class="mv-weather">${WEATHER_STATES.map(([v,l])=>`<option value="${v}" ${v===data.weather?"selected":""}>${l}</option>`).join("")}</select>
      </div>
      <div class="rule-row mv-weatherdur-row">
        <label class="rule-inline-label">Weather Lasts <input type="number" class="mv-weatherdur" min="1" step="1" value="${data.weatherDuration}"> Turns</label>
      </div>
      <div class="rule-row mv-pollutedchance-row">
        <label class="rule-inline-label">Polluted: Turn-End Poison Chance % <input type="number" class="mv-pollutedchance" min="0" max="100" step="5" value="${data.pollutedPoisonChance}"></label>
      </div>
      <div class="rule-row mv-setsfield-row">
        <label class="dyn-hidden-check"><input type="checkbox" class="mv-setsfield" ${data.setsField?"checked":""}> Also Sets Field Effect When It Hits (works alongside damage; independent of Weather)</label>
      </div>
      <div class="rule-row mv-field-row">
        <label class="rule-label">Field Effect</label>
        <select class="mv-field">${FIELD_STATES.filter(f=>f[0]!=="none").map(([v,l])=>`<option value="${v}" ${v===data.field?"selected":""}>${l}</option>`).join("")}</select>
      </div>
      <div class="rule-row mv-fielddur-row">
        <label class="rule-inline-label">Field Effect Lasts <input type="number" class="mv-fielddur" min="1" step="1" value="${data.fieldDuration}"> Turns</label>
      </div>
      <div class="rule-row mv-hazard-row">
        <label class="rule-label">Hazard Type</label>
        <select class="mv-hazardtype">${HAZARD_TYPES.map(([v,l])=>`<option value="${v}" ${v===data.hazardType?"selected":""}>${l}</option>`).join("")}</select>
      </div>
      <div class="rule-row rule-chance-row mv-chance-row">
        <label class="rule-label">Effect Chance %</label>
        <input type="number" class="mv-chance" min="0" max="100" step="5" value="${data.effectChance}">
      </div>
      <textarea class="mv-desc" placeholder="What does this move do?">${esc(data.desc)}</textarea>

      <div class="rule-row">
        <label class="dyn-hidden-check"><input type="checkbox" class="mvr-enabled" ${data.rule.enabled?"checked":""}> Enable Conditional Rule (unified Ability/Move rule builder)</label>
      </div>
      <div class="mvr-rule-wrap">${ruleBuilderBlockHtml("mvr", data.rule)}</div>
      ${effectsBlockHtml()}
      </div>`;
    row.querySelector(".dyn-row-remove").addEventListener("click", ()=>row.remove());

    // ---- Collapsible Builder Block: same minimize/expand behavior as Ability rows — collapsed by default
    // when loading in an existing Move, expanded for a freshly-added blank one ----
    if(isExisting) row.classList.add("dyn-row-collapsed");
    wireRowCollapse(row, ()=>{
      const n = row.querySelector(".mv-name").value.trim() || "Untitled Move";
      const lvl = row.querySelector(".mv-level").value;
      return lvl ? `${n} (Lv. ${lvl})` : n;
    });

    // ---- Base Power Conditional Visibility: ONLY shown/enabled for damaging categories (Physical/Special).
    // Status moves deal no damage, so Base Power is hidden, disabled, and reset to 0 — the classic
    // "IF category is Physical/Special THEN show Base Power ELSE hide + zero it out" gate. ----
    const bpInput = row.querySelector(".mv-basepower");
    let lastBasePower = data.basePower > 0 ? data.basePower : 60;
    function syncBasePowerVisibility(){
      const category = row.querySelector(".mv-cat").value;
      const dealsDamage = category==="Physical" || category==="Special";
      row.querySelector(".mv-basepower-row").style.display = dealsDamage ? "flex" : "none";
      bpInput.disabled = !dealsDamage;
      if(dealsDamage){
        if(Number(bpInput.value)<=0) bpInput.value = lastBasePower;
      } else {
        if(Number(bpInput.value)>0) lastBasePower = Number(bpInput.value);
        bpInput.value = 0;
      }
    }

    function syncStatusVisibility(){
      const isStatus = row.querySelector(".mv-cat").value==="Status";
      row.querySelector(".mv-action-row").style.display = isStatus ? "flex" : "none";
      const action = row.querySelector(".mv-action").value;
      const isStatusEffect = isStatus && action==="status";
      row.querySelector(".mv-status-row").style.display = isStatusEffect ? "flex" : "none";
      const durMode = row.querySelector(".mv-statusdurmode .picked")?.dataset.v || "random";
      row.querySelector(".mv-statusdur-row").style.display = isStatusEffect ? "flex" : "none";
      row.querySelector(".mv-statusdur-random-row").style.display = isStatusEffect && durMode==="random" ? "flex" : "none";
      row.querySelector(".mv-statusdur-fixed-row").style.display = isStatusEffect && durMode==="fixed" ? "flex" : "none";
      row.querySelector(".mv-heal-row").style.display = isStatus && action==="heal" ? "flex" : "none";
      row.querySelector(".mv-healtarget-row").style.display = isStatus && action==="heal" ? "flex" : "none";
      // ---- Move Exchange Targeting sub-setting: only relevant for the 4 Copy/Steal/Swap/Force actions.
      // The Slot # input additionally only shows up when "Specific Slot #" mode is picked. ----
      const isExchangeAction = isStatus && ["copyMove","stealMove","swapMove","forceMove"].includes(action);
      row.querySelector(".mv-exchangetarget-row").style.display = isExchangeAction ? "flex" : "none";
      const exchangeMode = row.querySelector(".mv-exchangetarget").value;
      row.querySelector(".mv-exchangeslot-row").style.display = isExchangeAction && exchangeMode==="specificSlot" ? "flex" : "none";
      // ---- Full Transform (Ditto-style) Revert Timing: only relevant to the "transform" action; the
      // Fixed-Turns input additionally only shows up when that specific revert mode is picked. ----
      const isTransformAction = isStatus && action==="transform";
      row.querySelector(".mv-transformrevert-row").style.display = isTransformAction ? "flex" : "none";
      const transformRevertMode = row.querySelector(".mv-transformrevert").value;
      row.querySelector(".mv-transformrevertturns-row").style.display = isTransformAction && transformRevertMode==="turns" ? "flex" : "none";
      // ---- Weather picker: available for Status moves via the "Set Weather" Effect, AND for damaging
      // (Physical/Special) moves via the independent "Also Sets Weather When It Hits" checkbox below ----
      const dealsDamage = !isStatus;
      row.querySelector(".mv-setsweather-row").style.display = dealsDamage ? "flex" : "none";
      const setsWeatherOnHit = dealsDamage && row.querySelector(".mv-setsweather").checked;
      const weatherActive = (isStatus && action==="weather") || setsWeatherOnHit;
      row.querySelector(".mv-weather-row").style.display = weatherActive ? "flex" : "none";
      row.querySelector(".mv-weatherdur-row").style.display = weatherActive ? "flex" : "none";
      const weatherChoice = row.querySelector(".mv-weather").value;
      row.querySelector(".mv-pollutedchance-row").style.display = (weatherActive && weatherChoice==="polluted") ? "flex" : "none";
      // ---- Field Effect picker: same dual-path pattern as Weather above — a Status move's own "Set
      // Field Effect" Effect action, OR any move's independent "Also Sets Field Effect When It Hits"
      // checkbox. Field Effect is independent of Weather (both can be active at once). ----
      row.querySelector(".mv-setsfield-row").style.display = dealsDamage ? "flex" : "none";
      const setsFieldOnHit = dealsDamage && row.querySelector(".mv-setsfield").checked;
      const fieldActive = (isStatus && action==="field") || setsFieldOnHit;
      row.querySelector(".mv-field-row").style.display = fieldActive ? "flex" : "none";
      row.querySelector(".mv-fielddur-row").style.display = fieldActive ? "flex" : "none";
      row.querySelector(".mv-hazard-row").style.display = isStatus && action==="hazard" ? "flex" : "none";
      row.querySelector(".mv-chance-row").style.display = isStatus && action!=="none" ? "flex" : "none";
      // IF this move's Fail Condition is "Weather Doesn't Match Required State" THEN reveal the weather picker.
      row.querySelector(".mv-failweather-row").style.display = row.querySelector(".mv-failcond").value==="weatherIsNot" ? "flex" : "none";
      // IF this move's Fail Condition is "Field Effect Doesn't Match Required State" THEN reveal the field picker.
      row.querySelector(".mv-failfield-row").style.display = row.querySelector(".mv-failcond").value==="fieldIsNot" ? "flex" : "none";
      row.querySelector(".mv-failstatus-row").style.display = ["userHasStatus","targetHasStatus","userNoStatus","targetNoStatus"].includes(row.querySelector(".mv-failcond").value) ? "flex" : "none";
      syncBasePowerVisibility();
    }
    row.querySelector(".mv-cat").addEventListener("change", syncStatusVisibility);
    row.querySelector(".mv-action").addEventListener("change", syncStatusVisibility);
    row.querySelector(".mv-exchangetarget").addEventListener("change", syncStatusVisibility);
    row.querySelector(".mv-transformrevert").addEventListener("change", syncStatusVisibility);
    row.querySelector(".mv-weather").addEventListener("change", syncStatusVisibility);
    row.querySelector(".mv-setsweather").addEventListener("change", syncStatusVisibility);
    row.querySelector(".mv-field").addEventListener("change", syncStatusVisibility);
    row.querySelector(".mv-setsfield").addEventListener("change", syncStatusVisibility);
    row.querySelector(".mv-failcond").addEventListener("change", syncStatusVisibility);
    // ---- Battle History Scaling: only show the per-stack bonus % input when a scaling mode is chosen ----
    function syncHistoryScalingVisibility(){
      row.querySelector(".mv-historystep-row").style.display = row.querySelector(".mv-historyscaling").value==="none" ? "none" : "flex";
    }
    row.querySelector(".mv-historyscaling").addEventListener("change", syncHistoryScalingVisibility);
    syncHistoryScalingVisibility();
    row.querySelector(".mv-statusdurmode").querySelectorAll("button").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        row.querySelector(".mv-statusdurmode").querySelectorAll("button").forEach(b=>b.classList.toggle("picked", b===btn));
        syncStatusVisibility();
      });
    });
    row.querySelectorAll(".heal-toggle").forEach(tg=>{
      tg.querySelectorAll("button").forEach(btn=>{
        btn.addEventListener("click", ()=>{
          tg.querySelectorAll("button").forEach(b=>b.classList.toggle("picked", b===btn));
        });
      });
    });
    syncStatusVisibility();
    wireEffectsBlock(row, data);
    wireTagRulesBlock(row, data);
    wireVsTagsBlock(row, data);

    // ---- "TRADEOFF" Move Matrix: master toggle shows/hides the whole block; within it, the Cost and
    // Target Consequence heal-toggle pairs each reveal their own matching sub-fields. ----
    function syncTradeoffVisibility(){
      const enabled = row.querySelector(".mv-tradeoff-enabled").checked;
      row.querySelector(".mv-tradeoff-wrap").style.display = enabled ? "block" : "none";
      const costType = row.querySelector(".mv-tradeoff-costtype .picked")?.dataset.v || "hpPercent";
      row.querySelector(".mv-tradeoff-costhp-row").style.display = costType==="hpPercent" ? "flex" : "none";
      row.querySelector(".mv-tradeoff-coststat-row").style.display = costType==="statStage" ? "flex" : "none";
      const conseqType = row.querySelector(".mv-tradeoff-conseqtype .picked")?.dataset.v || "status";
      row.querySelector(".mv-tradeoff-conseqstatus-row").style.display = conseqType==="status" ? "flex" : "none";
      row.querySelector(".mv-tradeoff-conseqdrain-row").style.display = conseqType==="drain" ? "flex" : "none";
      row.querySelector(".mv-tradeoff-conseqstat-row").style.display = conseqType==="statStage" ? "flex" : "none";
      // ---- Duration only matters for a tracked-over-time consequence (Status/Drain); an instant stat
      // stage drop on the target has nothing to "expire", so hide it for that mode ----
      row.querySelector(".mv-tradeoff-duration-row").style.display = conseqType==="statStage" ? "none" : "flex";
    }
    row.querySelector(".mv-tradeoff-enabled").addEventListener("change", syncTradeoffVisibility);
    row.querySelectorAll(".mv-tradeoff-costtype button, .mv-tradeoff-conseqtype button").forEach(btn=>{
      btn.addEventListener("click", syncTradeoffVisibility);
    });
    syncTradeoffVisibility();

    // ---- Delayed Attack Events (Future Sight / Doom Desire Mechanic): master toggle shows/hides the
    // Delay Duration / Stat Snap / Type Immunity Bypass sub-fields ----
    function syncDelayedVisibility(){
      const enabled = row.querySelector(".mv-delayed-enabled").checked;
      row.querySelectorAll(".mv-delayed-fields-row").forEach(el=>{ el.style.display = enabled ? "flex" : "none"; });
    }
    row.querySelector(".mv-delayed-enabled").addEventListener("change", syncDelayedVisibility);
    syncDelayedVisibility();

    // ---- Dynamic State-Binding Partial Immunity: master toggle shows/hides the State Name / Exceptions
    // sub-fields; the Fixed Duration turns input further only shows when that expiration mode is picked ----
    function syncStateImmVisibility(){
      const enabled = row.querySelector(".mv-stateimm-enabled").checked;
      row.querySelectorAll(".mv-stateimm-fields-row").forEach(el=>{ el.style.display = enabled ? "flex" : "none"; });
      if(enabled){
        const fixedDuration = row.querySelector(".mv-stateimm-expireevent").value === "fixedDuration";
        row.querySelector(".mv-stateimm-expiredur-row").style.display = fixedDuration ? "flex" : "none";
      }
    }
    row.querySelector(".mv-stateimm-enabled").addEventListener("change", syncStateImmVisibility);
    row.querySelector(".mv-stateimm-expireevent").addEventListener("change", syncStateImmVisibility);
    syncStateImmVisibility();

    // ---- Multi-Turn Charge Execution: master toggle shows/hides the Duration/Condition sub-fields, and
    // the Condition dropdown further shows only the Shielded % or Healing % field that's actually relevant ----
    function syncChargeVisibility(){
      const enabled = row.querySelector(".mv-charge-enabled").checked;
      const condition = row.querySelector(".mv-charge-condition").value;
      row.querySelectorAll(".mv-charge-fields-row").forEach(el=>{ el.style.display = enabled ? "flex" : "none"; });
      row.querySelector(".mv-charge-shield-row").style.display = (enabled && condition==="shielded") ? "flex" : "none";
      row.querySelector(".mv-charge-heal-row").style.display = (enabled && condition==="healing") ? "flex" : "none";
    }
    row.querySelector(".mv-charge-enabled").addEventListener("change", syncChargeVisibility);
    row.querySelector(".mv-charge-condition").addEventListener("change", syncChargeVisibility);
    syncChargeVisibility();

    // ---- Unified Rule Builder for Moves: same vocab/markup/wiring as Abilities. Wrapped behind an
    // "Enable Conditional Rule" checkbox so simple moves aren't cluttered with the full builder. ----
    wireRuleBuilder(row, "mvr");
    function syncRuleEnabled(){
      row.querySelector(".mvr-rule-wrap").style.display = row.querySelector(".mvr-enabled").checked ? "block" : "none";
    }
    row.querySelector(".mvr-enabled").addEventListener("change", syncRuleEnabled);
    syncRuleEnabled();

    targetEl.appendChild(row);
    return row;
  }
  document.getElementById("addMoveBtn").addEventListener("click", ()=>addMoveRow());
 function collectMoves(containerEl){
  containerEl = containerEl || moveFieldsEl;
  return [...containerEl.querySelectorAll(":scope > .dyn-row")].map(row=>{
    const category = row.querySelector(".mv-cat").value;
    
    // Extract level learned (default to 1 if missing/invalid)
    const levelRaw = Number(row.querySelector(".mv-level")?.value);
    const levelLearned = !isNaN(levelRaw) && levelRaw > 0 ? Math.round(levelRaw) : 1;

    const accRaw = Number(row.querySelector(".mv-acc").value);
    const dodgeChanceRaw = Number(row.querySelector(".mv-dodgechance").value);
    const ppRaw = Number(row.querySelector(".mv-pp").value);
    const bpRaw = Number(row.querySelector(".mv-basepower").value);
    const dealsDamage = category==="Physical" || category==="Special";
    const action = category==="Status" ? row.querySelector(".mv-action").value : "none";
    const r = collectRuleFromRow(row, "mvr");

    return {
      name: row.querySelector(".mv-name").value.trim(),
      level: levelLearned, // learn level — independent of the move's own identity, see getMoveGroups()
      type: row.querySelector(".mv-type").value,
      category,
        desc: row.querySelector(".mv-desc").value.trim(),
        accuracy: !isNaN(accRaw) ? Math.max(0, Math.min(1, accRaw)) : 1,
        weatherAccuracy: [...row.querySelectorAll(".mv-wacc")].map(inp=>{
          const k = inp.dataset.weather, v = inp.value.trim();
          const never = row.querySelector(`.mv-wacc-never[data-weather="${k}"]`).checked;
          return (v!=="" || never) ? { weather:k, accuracy: v!=="" ? Math.max(0, Math.min(100, Number(v)))/100 : null, neverMiss: never } : null;
        }).filter(Boolean),
        dodgeChance: !isNaN(dodgeChanceRaw) ? Math.max(0, Math.min(100, dodgeChanceRaw)) : 0,
        maxPP: !isNaN(ppRaw) && ppRaw>0 ? Math.round(ppRaw) : 15,
        // Base Power is only ever collected for damaging categories — a Status move is force-zeroed
        // here too, so a stray non-zero value left in a disabled input can never leak into saved data.
        basePower: dealsDamage && !isNaN(bpRaw) ? bpRaw : 0,
        hits: Number(row.querySelector(".mv-hits").value) || 1,
        multiHitScaling: MULTI_HIT_SCALING_MODES.some(t=>t[0]===row.querySelector(".mv-multihitscaling").value) ? row.querySelector(".mv-multihitscaling").value : "none",
        multiHitScalingPct: Math.max(0, Math.min(90, Number(row.querySelector(".mv-multihitscalingpct").value) || 0)),
        action,
        moveExchangeTarget: row.querySelector(".mv-exchangetarget").value,
        moveExchangeSlot: Number(row.querySelector(".mv-exchangeslot").value) || 1,
        transformRevertMode: row.querySelector(".mv-transformrevert").value,
        transformRevertTurns: Number(row.querySelector(".mv-transformrevertturns").value) || 3,
        statusEffect: action==="status" ? row.querySelector(".mv-status").value : "none",
        statusDurationMode: row.querySelector(".mv-statusdurmode .picked")?.dataset.v || "random",
        statusDurationMin: Number(row.querySelector(".mv-statusdur-min").value) || 1,
        statusDurationMax: Number(row.querySelector(".mv-statusdur-max").value) || 3,
        statusDurationFixed: Number(row.querySelector(".mv-statusdur-fixed").value) || 5,
        effectChance: Number(row.querySelector(".mv-chance").value),
        healType: row.querySelector(".mv-healtype .picked")?.dataset.v || "percent",
        healValue: Number(row.querySelector(".mv-healvalue").value),
        healTarget: row.querySelector(".mv-healtarget").value,
        weather: row.querySelector(".mv-weather").value,
        weatherDuration: Number(row.querySelector(".mv-weatherdur").value) || 5,
        setsWeather: dealsDamage && row.querySelector(".mv-setsweather").checked,
        field: row.querySelector(".mv-field").value,
        fieldDuration: Number(row.querySelector(".mv-fielddur").value) || 5,
        setsField: dealsDamage && row.querySelector(".mv-setsfield").checked,
        pollutedPoisonChance: Number(row.querySelector(".mv-pollutedchance").value),
        hazardType: row.querySelector(".mv-hazardtype").value,
        effects: collectEffects(row.querySelector(".effects-list")),
        tags: row.querySelector(".mv-tags").value,
        failsAgainstTags: row.querySelector(".mv-failstags").value,
        failsAgainstTagsOn: row.querySelector(".mv-failstags-on").value,
        targetScope: row.querySelector(".mv-targetscope").value,
        tagRules: collectTagRules(row.querySelector(".tagrules-list")),
        vsTags: collectVsTags(row.querySelector(".vstags-list")),
        statusBypass: {
          sleep: row.querySelector(".mv-bypass-sleep").checked,
          freeze: row.querySelector(".mv-bypass-freeze").checked,
          confusion: row.querySelector(".mv-bypass-confusion").checked
        },
        weightScaling: row.querySelector(".mv-weightscaling").value,
        dynamicPower: row.querySelector(".mv-dynamicpower").value,
        damageBasis: row.querySelector(".mv-damagebasis").value,
        historyScaling: row.querySelector(".mv-historyscaling").value,
        historyScalingStepPct: Number(row.querySelector(".mv-historystep").value),
        atkStatBasis: row.querySelector(".mv-atkstatbasis").value,
        defStatBasis: row.querySelector(".mv-defstatbasis").value,
        ignoreDefense: row.querySelector(".mv-ignoredef").checked,
        ignoreShields: row.querySelector(".mv-ignoreshield").checked,
        stateImmunity: {
          enabled: row.querySelector(".mv-stateimm-enabled").checked,
          key: row.querySelector(".mv-stateimm-key").value,
          exceptions: row.querySelector(".mv-stateimm-exceptions").value,
          expireEvent: row.querySelector(".mv-stateimm-expireevent").value,
          expireDurationTurns: Number(row.querySelector(".mv-stateimm-expiredur").value) || 2
        },
        chargeUp: {
          enabled: row.querySelector(".mv-charge-enabled").checked,
          duration: row.querySelector(".mv-charge-duration").value,
          condition: row.querySelector(".mv-charge-condition").value,
          shieldPercent: row.querySelector(".mv-charge-shieldpct").value,
          healPercent: row.querySelector(".mv-charge-healpct").value
        },
        delayedAttack: {
          enabled: row.querySelector(".mv-delayed-enabled").checked,
          delayTurns: Number(row.querySelector(".mv-delayed-duration").value) || 2,
          statSnapMode: row.querySelector(".mv-delayed-snapmode .picked")?.dataset.v || "launch",
          ignoreTypeImmunity: row.querySelector(".mv-delayed-ignoretypeimmunity").checked,
          effectTiming: row.querySelector(".mv-delayed-efftiming .picked")?.dataset.v || "cast"
        },
        critRateMode: row.querySelector(".mv-critrate").value,
        cooldownTurns: Number(row.querySelector(".mv-cooldown").value) || 0,
        priority: Number(row.querySelector(".mv-priority").value) || 0,
        counterMove: {
          enabled: row.querySelector(".mv-counter-enabled").checked,
          damageType: row.querySelector(".mv-counter-damagetype").value,
          multiplier: Number(row.querySelector(".mv-counter-multiplier").value) || 2
        },
        dynamicTypeEnabled: row.querySelector(".mv-dyntype-enabled").checked,
        dynamicTypeTarget: row.querySelector(".mv-dyntype-target").value,
        dynamicTypeMode: row.querySelector(".mv-dyntype-mode").value,
        recoilPercent: Number(row.querySelector(".mv-recoil").value) || 0,
        statusDamageMultiplier: Number(row.querySelector(".mv-statusdmgmult").value),
        statusDamageMultFilter: row.querySelector(".mv-statusdmgmult-filter").value,
        failCondition: row.querySelector(".mv-failcond").value,
        failWeather: row.querySelector(".mv-failweather").value,
        failStatus: row.querySelector(".mv-failstatus").value,
        statusDamageMultOn: row.querySelector(".mv-statusdmgmult-on").value,
        ohko: row.querySelector(".mv-ohko").checked,
        selfFaint: row.querySelector(".mv-selffaint").checked,
        failField: row.querySelector(".mv-failfield").value,
        // ---- Unified Rule Builder (same shape as Abilities) — only meaningful when the "Enable
        // Conditional Rule" checkbox is on; normalizeMove still normalizes it either way ----
        rule: {
          enabled: row.querySelector(".mvr-enabled").checked,
          ruleType: r.ruleType,
          passive: r.passive,
          active: r.active
        },
        // ---- "TRADEOFF" Move Matrix: Cost / Target Consequence / Duration / Conditional Type Override ----
        tradeoff: {
          enabled: row.querySelector(".mv-tradeoff-enabled").checked,
          requireUserType: row.querySelector(".mv-tradeoff-reqtype").value,
          costType: row.querySelector(".mv-tradeoff-costtype .picked")?.dataset.v || "hpPercent",
          costHpPercent: Number(row.querySelector(".mv-tradeoff-costhp").value),
          costStatKey: row.querySelector(".mv-tradeoff-coststatkey").value,
          costStatStage: Number(row.querySelector(".mv-tradeoff-coststatstage").value),
          consequenceType: row.querySelector(".mv-tradeoff-conseqtype .picked")?.dataset.v || "status",
          consequenceStatus: row.querySelector(".mv-tradeoff-conseqstatus").value,
          consequenceDrainPercent: Number(row.querySelector(".mv-tradeoff-conseqdrain").value),
          consequenceStatKey: row.querySelector(".mv-tradeoff-conseqstatkey").value,
          consequenceStatStage: Number(row.querySelector(".mv-tradeoff-conseqstatstage").value),
          durationTurns: Number(row.querySelector(".mv-tradeoff-duration").value)
        },
        // ---- Mega Evolution Move Restrictions ----
        megaUsable: row.querySelector(".mv-megausable").checked
      };
    }).filter(m=>m.name).map(normalizeMove);
  }

  // ================= FORM: EVOLUTION / VARIANT LINK SELECTS =================
  const preEvoSelect = document.getElementById("f-preevo");
  const variantOfSelect = document.getElementById("f-variantof");
  const preEvoMethodField = document.getElementById("preEvoMethodField");
  function refreshLinkSelects(excludeId){
    if (!preEvoSelect || !variantOfSelect) {
      console.warn("refreshLinkSelects: missing #f-preevo or #f-variantof in the DOM", { preEvoSelect, variantOfSelect });
      return;
    }
    const options = entries.filter(e=>e.id!==excludeId).map(e=>{
      const r = regionById(e.regionId);
      return `<option value="${e.id}">${esc(e.name)}${r?" — "+esc(r.name):""}</option>`;
    }).join("");
    preEvoSelect.innerHTML = `<option value="">— None (base form) —</option>` + options;
    variantOfSelect.innerHTML = `<option value="">— Not a variant —</option>` + options;
  }
  preEvoSelect.addEventListener("change", ()=>{
    preEvoMethodField.style.display = preEvoSelect.value ? "block" : "none";
  });

  const statFieldsEl = document.getElementById("statFields");
  let statValues = {};
  STAT_KEYS.forEach(([key,label])=>{
    statValues[key] = 50;
    const row = document.createElement("div"); row.className = "stat-field";
    row.innerHTML = `<label>${label}</label><input type="range" min="1" max="150" value="50" data-key="${key}"><div class="val">50</div>`;
    const range = row.querySelector("input"); const val = row.querySelector(".val");
    range.addEventListener("input", ()=>{ statValues[key] = Number(range.value); val.textContent = range.value; });
    statFieldsEl.appendChild(row);
  });

  function refreshRegionSelect(){
    const formSel = document.getElementById("f-region");
    const prev = formSel.value;
    formSel.innerHTML = regions.map(r=>`<option value="${r.id}">${esc(r.name)}</option>`).join("");
    if(regions.some(r=>String(r.id)===prev)) formSel.value = prev;
  }

  // ================= FILTER CHIPS =================
  function closeAllPanels(){ document.querySelectorAll(".chip-panel").forEach(p=>p.classList.remove("open")); }
  document.addEventListener("click", closeAllPanels);
  function stopAnd(fn){ return (ev)=>{ ev.stopPropagation(); fn(ev); }; }
  function togglePanel(panel){ const wasOpen = panel.classList.contains("open"); closeAllPanels(); if(!wasOpen) panel.classList.add("open"); }

  const regionChipBtn = document.getElementById("regionChipBtn");
  const regionChipPanel = document.getElementById("regionChipPanel");
  regionChipBtn.addEventListener("click", stopAnd(()=>{ renderRegionPanel(); togglePanel(regionChipPanel); }));
  function renderRegionPanel(){
    let html = `<div class="chip-option ${filters.region===""?"selected":""}" data-value="">All Regions</div>`;
    html += regions.map(r=>`<div class="chip-option ${filters.region===r.id?"selected":""}" data-value="${r.id}"><span class="dot" style="background:${r.color.base}"></span>${esc(r.name)}</div>`).join("");
    regionChipPanel.innerHTML = html;
    regionChipPanel.querySelectorAll("[data-value]").forEach(el=>{
      el.addEventListener("click", ()=>{ filters.region = el.dataset.value ? Number(el.dataset.value) : ""; closeAllPanels(); updateChipLabels(); renderGrid(); });
    });
  }

  const typeChipBtn = document.getElementById("typeChipBtn");
  const typeChipPanel = document.getElementById("typeChipPanel");
  typeChipBtn.addEventListener("click", stopAnd(()=>{ renderTypePanel(); togglePanel(typeChipPanel); }));
  function renderTypePanel(){
    let html = `<div class="chip-option ${filters.type===""?"selected":""}" data-value="" style="margin-bottom:6px;">All Types</div><div class="type-chip-grid">`;
    html += TYPES.map(t=>(t===FANMADE_TYPE_LIST[0]?fanmadeTypesHeaderHtml():"")+`<div class="chip-option ${filters.type===t?"selected":""}" data-value="${t}" title="${typeCreditTitle(t)}" style="background:var(--t-${t})">${t}</div>`).join("");
    html += `</div>`;
    typeChipPanel.innerHTML = html;
    typeChipPanel.querySelectorAll("[data-value]").forEach(el=>{
      el.addEventListener("click", ()=>{ filters.type = el.dataset.value; closeAllPanels(); updateChipLabels(); renderGrid(); });
    });
  }

  const rarityChipBtn = document.getElementById("rarityChipBtn");
  const rarityChipPanel = document.getElementById("rarityChipPanel");
  const RARITIES = ["common","uncommon","rare","legendary"];
  rarityChipBtn.addEventListener("click", stopAnd(()=>{ renderRarityPanel(); togglePanel(rarityChipPanel); }));
  function renderRarityPanel(){
    let html = `<div class="chip-option ${filters.rarity===""?"selected":""}" data-value="">All Rarities</div>`;
    html += RARITIES.map(r=>`<div class="chip-option ${filters.rarity===r?"selected":""}" data-value="${r}">${cap(r)}</div>`).join("");
    rarityChipPanel.innerHTML = html;
    rarityChipPanel.querySelectorAll("[data-value]").forEach(el=>{
      el.addEventListener("click", ()=>{ filters.rarity = el.dataset.value; closeAllPanels(); updateChipLabels(); renderGrid(); });
    });
  }

  const sortChipBtn = document.getElementById("sortChipBtn");
  const sortChipPanel = document.getElementById("sortChipPanel");
  const SORTS = [["id","No."],["name","A–Z"],["power","Power"]];
  sortChipBtn.addEventListener("click", stopAnd(()=>{ renderSortPanel(); togglePanel(sortChipPanel); }));
  function renderSortPanel(){
    sortChipPanel.innerHTML = SORTS.map(([k,l])=>`<div class="chip-option ${filters.sort===k?"selected":""}" data-value="${k}">${l}</div>`).join("");
    sortChipPanel.querySelectorAll("[data-value]").forEach(el=>{
      el.addEventListener("click", ()=>{ filters.sort = el.dataset.value; closeAllPanels(); updateChipLabels(); renderGrid(); });
    });
  }

  function updateChipLabels(){
    const r = filters.region ? regionById(filters.region) : null;
    regionChipBtn.innerHTML = (r ? esc(r.name) : "All Regions") + ` <span class="caret">▾</span>`;
    regionChipBtn.classList.toggle("active-filter", !!filters.region);
    typeChipBtn.innerHTML = (filters.type ? cap(filters.type) : "All Types") + ` <span class="caret">▾</span>`;
    typeChipBtn.classList.toggle("active-filter", !!filters.type);
    rarityChipBtn.innerHTML = (filters.rarity ? cap(filters.rarity) : "All Rarities") + ` <span class="caret">▾</span>`;
    rarityChipBtn.classList.toggle("active-filter", !!filters.rarity);
    const sortLabel = SORTS.find(([k])=>k===filters.sort)[1];
    sortChipBtn.innerHTML = `Sort: ${sortLabel} <span class="caret">▾</span>`;
  }

  // ================= ADD/EDIT POKEMON FORM =================
  const formOverlay = document.getElementById("formOverlay");
  const pokeForm = document.getElementById("pokeForm");
  const formTitle = document.getElementById("formTitle");
  const submitFormBtn = document.getElementById("submitFormBtn");

  // ---------------------------------------------------------------------
  // MULTI-IMAGE ICON RESOLUTION
  // An entry can now carry up to 4 images (entry.images = { pixel,
  // pixelShiny, artwork, artworkShiny }), any/all optional. This is the
  // single source of truth for "what should this creature's icon actually
  // show" — call it from ui-dex-renderer.js / roster.js / battle UI instead
  // of reading entry.icon or entry.customIconEmoji directly, so the
  // "photo beats emoji placeholder" rule stays consistent everywhere.
  //
  // Returns either { type:"image", value:<url> } or { type:"emoji", value:<glyph> }.
  // Usage example in a renderer file:
  //   const ic = resolveCreatureIcon(entry);
  //   el.innerHTML = ic.type === "image"
  //     ? `<img src="${esc(ic.value)}" class="mon-icon-img" onerror="this.style.display='none'">`
  //     : `<span class="mon-icon-emoji">${ic.value}</span>`;
  function resolveCreatureIcon(entry, opts){
    opts = opts || {};
    const shiny = !!opts.shiny;
    const images = (entry && entry.images) || {};
    // Backward compatible with entries saved before this feature existed,
    // which only ever had a flat entry.imageUrl (treated as "artwork").
    const artwork = images.artwork || entry.imageUrl || "";
    const pixel = images.pixel || "";
    const artworkShiny = images.artworkShiny || "";
    const pixelShiny = images.pixelShiny || "";
    const focusMap = images.focus || {};

    // Track WHICH slot actually won, so we can look up its matching
    // crop/focus point (a focus point picked for the shiny artwork
    // shouldn't apply if the icon is actually falling back to the
    // non-shiny pixel sprite instead).
    let slot = null, photo = "";
    if(shiny){
      if(pixelShiny){ slot="pixelShiny"; photo=pixelShiny; }
      else if(artworkShiny){ slot="artworkShiny"; photo=artworkShiny; }
      else if(pixel){ slot="pixel"; photo=pixel; }
      else if(artwork){ slot="artwork"; photo=artwork; }
    } else {
      if(pixel){ slot="pixel"; photo=pixel; }
      else if(artwork){ slot="artwork"; photo=artwork; }
    }

    if(photo) return { type: "image", value: photo, focus: focusMap[slot] || null };
    return { type: "emoji", value: (entry.customIconEmoji || entry.icon || "❓") };
  }
  window.resolveCreatureIcon = resolveCreatureIcon;

  // Live preview in the form itself: as soon as any of the 4 image fields
  // has a URL in it, show a small thumbnail + note confirming that image
  // (not the emoji picker below it) is what will be used as the icon.
  const iconPreviewRow = document.getElementById("iconPreviewRow");
  const iconPreviewImg = document.getElementById("iconPreviewImg");
  const IMAGE_FIELD_IDS = ["f-image-pixel", "f-image-pixel-shiny", "f-image", "f-image-artwork-shiny"];
  function refreshIconPreview(){
    const pixel = document.getElementById("f-image-pixel").value.trim();
    const artwork = document.getElementById("f-image").value.trim();
    const photo = pixel || artwork; // same non-shiny priority as resolveCreatureIcon()
    if(photo){
      iconPreviewImg.src = photo;
      iconPreviewRow.style.display = "flex";
    } else {
      iconPreviewRow.style.display = "none";
    }
  }
  IMAGE_FIELD_IDS.forEach(id=>{
    document.getElementById(id).addEventListener("input", refreshIconPreview);
  });
  iconPreviewImg.addEventListener("error", ()=>{ iconPreviewRow.style.display = "none"; });

  // ================= CROP / FOCUS PICKER =================
  // Lets a creator paste ONE shared "group art" URL (a Pinterest-style
  // collage with several creatures in it) into multiple different entries,
  // and for each entry click the spot that's actually theirs + zoom in.
  // Stored per-slot as { x, y, zoom } (x/y are percentages) on
  // entry.images.focus.<slot>. See resolveCreatureIcon()/miniArtHtml() in
  // ui-dex-renderer.js for how this gets turned into object-position +
  // transform: scale() on the rendered <img>.
  const CROP_SLOT_FIELD_IDS = {
    pixel: "f-image-pixel",
    pixelShiny: "f-image-pixel-shiny",
    artwork: "f-image",
    artworkShiny: "f-image-artwork-shiny"
  };
  let imageFocusState = {}; // { [slot]: {x,y,zoom} } — only slots the creator actually clicked

  const cropPickerEls = {}; // { [slot]: { root, preview, marker, zoomInput, resetBtn } }
  Object.keys(CROP_SLOT_FIELD_IDS).forEach(slot=>{
    const root = document.querySelector(`.crop-picker[data-slot="${slot}"]`);
    if(!root) return;
    root.innerHTML = `
      <div class="crop-preview"><div class="crop-marker"></div></div>
      <div class="crop-controls">
        <span class="field-hint" style="margin:0;">Zoom</span>
        <input type="range" min="1" max="3" step="0.05" value="1">
        <button type="button" class="crop-reset-btn">Reset</button>
      </div>
      <div class="field-hint" style="margin-top:4px;">Click the spot on this image that's actually this creature — handy when one picture has several creatures in it.</div>
    `;
    const preview = root.querySelector(".crop-preview");
    const marker = root.querySelector(".crop-marker");
    const zoomInput = root.querySelector('input[type="range"]');
    const resetBtn = root.querySelector(".crop-reset-btn");
    cropPickerEls[slot] = { root, preview, marker, zoomInput, resetBtn };

    function placeMarker(x, y){
      marker.style.left = x + "%";
      marker.style.top = y + "%";
      marker.style.display = "block";
    }

    preview.addEventListener("click", (ev)=>{
      const rect = preview.getBoundingClientRect();
      const x = Math.max(0, Math.min(100, ((ev.clientX - rect.left) / rect.width) * 100));
      const y = Math.max(0, Math.min(100, ((ev.clientY - rect.top) / rect.height) * 100));
      const zoom = parseFloat(zoomInput.value) || 1;
      imageFocusState[slot] = { x: Math.round(x), y: Math.round(y), zoom };
      placeMarker(x, y);
    });

    zoomInput.addEventListener("input", ()=>{
      const zoom = parseFloat(zoomInput.value) || 1;
      const existing = imageFocusState[slot];
      // No point picked yet? A drag on the zoom slider alone defaults to a
      // centered focus so it still does something visible.
      imageFocusState[slot] = { x: existing?.x ?? 50, y: existing?.y ?? 50, zoom };
      placeMarker(imageFocusState[slot].x, imageFocusState[slot].y);
    });

    resetBtn.addEventListener("click", ()=>{
      delete imageFocusState[slot];
      marker.style.display = "none";
      zoomInput.value = 1;
    });
  });

  function refreshCropPicker(slot){
    const fieldId = CROP_SLOT_FIELD_IDS[slot];
    const url = document.getElementById(fieldId).value.trim();
    const els = cropPickerEls[slot];
    if(!els) return;
    if(url){
      els.root.style.display = "block";
      els.preview.style.backgroundImage = `url("${url}")`;
    } else {
      els.root.style.display = "none";
      delete imageFocusState[slot];
      els.marker.style.display = "none";
      els.zoomInput.value = 1;
    }
  }
  Object.keys(CROP_SLOT_FIELD_IDS).forEach(slot=>{
    document.getElementById(CROP_SLOT_FIELD_IDS[slot]).addEventListener("input", ()=>refreshCropPicker(slot));
  });

  function resetCropPickers(){
    imageFocusState = {};
    Object.keys(CROP_SLOT_FIELD_IDS).forEach(slot=>{
      const els = cropPickerEls[slot];
      if(!els) return;
      els.root.style.display = "none";
      els.marker.style.display = "none";
      els.zoomInput.value = 1;
    });
  }

  function loadCropPickersFromEntry(entry){
    const focusMap = (entry.images && entry.images.focus) || {};
    Object.keys(CROP_SLOT_FIELD_IDS).forEach(slot=>{
      refreshCropPicker(slot); // shows/hides based on whether that slot has a URL
      const saved = focusMap[slot];
      const els = cropPickerEls[slot];
      if(saved && els && els.root.style.display !== "none"){
        imageFocusState[slot] = { ...saved };
        els.marker.style.left = saved.x + "%";
        els.marker.style.top = saved.y + "%";
        els.marker.style.display = "block";
        els.zoomInput.value = saved.zoom || 1;
      }
    });
  }
  // ============================================================

  // resetForm() clears the modal back to blank defaults (new entry) — it
  // doesn't touch which sections are collapsed/expanded, that's just normal
  // <details open> HTML/CSS. If you add a brand-new optional field, add its
  // reset-to-default line here too, next to the similar existing ones below.
  function resetForm(){
    editingId = null; pokeForm.reset(); selectedTypes = []; selectedEmoji = EMOJIS[0];
    renderTypeGrid(); renderEmojiRow();
    iconPreviewRow.style.display = "none"; // pokeForm.reset() already clears the 4 image inputs themselves
    resetCropPickers();
    STAT_KEYS.forEach(([key])=>{ statValues[key] = 50; });
    [...statFieldsEl.children].forEach(row=>{ row.querySelector("input").value = 50; row.querySelector(".val").textContent = 50; });
    abilityFieldsEl.innerHTML = ""; moveFieldsEl.innerHTML = "";
    addAbilityRow(); addMoveRow();
    tagMatchupFieldsEl.innerHTML = "";
    resetMegaProfiles();
    refreshLinkSelects(null);
    preEvoSelect.value = ""; variantOfSelect.value = ""; preEvoMethodField.style.display = "none";
    formTitle.textContent = "Log New Creature"; submitFormBtn.textContent = "Save Entry";
  }
  function openAdd(presetRegionId){
    if(regions.length===0){
      alert("Create a region first — every creature needs a dex to belong to.");
      activeTabName = "regions"; location.hash=""; updateViewVisibility();
      return;
    }
    resetForm(); refreshRegionSelect();
    document.getElementById("f-region").value = presetRegionId || filters.region || regions[0].id;
    formOverlay.classList.add("open");
    document.getElementById("f-name").focus();
  }
  function openEdit(entry){
    resetForm(); 
    refreshRegionSelect();
    editingId = entry.id;
    formTitle.textContent = "Edit Entry"; 
    submitFormBtn.textContent = "Update Entry";
    document.getElementById("f-region").value = entry.regionId;
    document.getElementById("f-name").value = entry.name;
    document.getElementById("f-category").value = entry.category || "";
    document.getElementById("f-creator").value = entry.creator || "";
    document.getElementById("f-image").value = (entry.images && entry.images.artwork) || entry.imageUrl || "";
    document.getElementById("f-image-pixel").value = (entry.images && entry.images.pixel) || "";
    document.getElementById("f-image-pixel-shiny").value = (entry.images && entry.images.pixelShiny) || "";
    document.getElementById("f-image-artwork-shiny").value = (entry.images && entry.images.artworkShiny) || "";
    refreshIconPreview();
    loadCropPickersFromEntry(entry);
    document.getElementById("f-height").value = entry.height ?? "";
    document.getElementById("f-weight").value = entry.weight ?? "";
    document.getElementById("f-rarity").value = entry.rarity || "common";
    document.getElementById("f-desc").value = entry.desc || "";
    selectedTypes = [...(entry.types||[])];
    selectedEmoji = entry.icon || EMOJIS[0];
    document.getElementById("f-custom-icon").value = entry.customIconEmoji || "";
    renderTypeGrid(); 
    renderEmojiRow();
    
    STAT_KEYS.forEach(([key])=>{ statValues[key] = (entry.stats && entry.stats[key]) || 50; });
    [...statFieldsEl.children].forEach((row,i)=>{ 
        const key = STAT_KEYS[i][0]; 
        row.querySelector("input").value = statValues[key]; 
        row.querySelector(".val").textContent = statValues[key]; 
    });

    // ================= SAFE LINK / PRE-EVO SETTINGS =================
    refreshLinkSelects(entry.id);

    // Safely assign Pre-Evo dropdown
    if (preEvoSelect) {
        preEvoSelect.value = entry.preEvo || "";
    }

    // Safely assign method fields (works with both legacy text and new structured fields)
    const legacyMethod = document.getElementById("f-preevo-method");
    const evoType = document.getElementById("f-preevo-type");
    const evoValue = document.getElementById("f-preevo-value");

    if (evoType && evoValue) {
        if (entry.evolvesAt) {
            evoType.value = entry.evolvesAt.type || "level";
            evoValue.value = entry.evolvesAt.value || "";
        } else {
            evoType.value = "level";
            evoValue.value = entry.preEvoMethod || "";
        }
    } else if (legacyMethod) {
        legacyMethod.value = entry.preEvoMethod || "";
    }

    if (preEvoMethodField) {
        preEvoMethodField.style.display = entry.preEvo ? "block" : "none";
    }

    if (variantOfSelect) {
        variantOfSelect.value = entry.variantOf || "";
    }

    // Populate Abilities / Moves / Tag Matchups / Megas
    abilityFieldsEl.innerHTML = "";
    (entry.abilities && entry.abilities.length ? entry.abilities : [null]).forEach(a=>addAbilityRow(a, abilityFieldsEl));
    moveFieldsEl.innerHTML = "";
    (entry.moves && entry.moves.length ? entry.moves : [null]).forEach(m=>addMoveRow(m, moveFieldsEl));
    tagMatchupFieldsEl.innerHTML = "";
    (entry.tagMatchups || []).forEach(tm=>addTagMatchupRow(tm));
    document.getElementById("f-tags").value = (entry.tags || []).join(", ");
    document.getElementById("f-gender-pool").value = normalizeGenderPool(entry.genderPool);
    const editTastes = normalizeTastes(entry.tastes);
    FLAVORS.forEach(f=>{ document.getElementById(`f-taste-${f.toLowerCase()}`).value = editTastes[f] || "neutral"; });
    populateMegaProfiles(entry.megas);

    formOverlay.classList.add("open");
}

  function closeForm(){ formOverlay.classList.remove("open"); }

  document.getElementById("openAdd").addEventListener("click", ()=>openAdd());
  document.getElementById("closeForm").addEventListener("click", closeForm);
  document.getElementById("cancelForm").addEventListener("click", closeForm);
  formOverlay.addEventListener("click", (e)=>{ if(e.target===formOverlay) closeForm(); });

pokeForm.addEventListener("submit", (e)=>{
  e.preventDefault();

  // ================= LOGIN + OWNERSHIP CHECK =================
  // Saving now actually reaches Firestore (see cloud-sync.js), so this
  // needs to be gated the same way: must be logged in to save at all, and
  // editing an existing entry someone else created is blocked outright.
  if(!window.currentUser){ alert("Log in to save a creature to the Dex."); return; }
  if(editingId){
    const existing = entries.find(e=>e.id===editingId);
    if(existing && window.CloudSync && !window.CloudSync.canManageRecord(existing)){
      alert("You can only edit creatures you created.");
      return;
    }
  }
  // ============================================================

  // ================= REQUIRED FIELD CHECKS =================
  // This is the ONLY place a field is actually forced. Everything else in
  // the form (stats, abilities, moves, region, image, evolution, Mega/Other
  // Forms, etc.) is optional and just gets saved with its default/blank
  // value if the creator skips it.
  //
  // To make another field required: copy one of the "if(!x){ alert(...);
  // return; }" lines below, point it at your field's id, and give it a
  // friendly alert message. To make Type optional too, delete/comment out
  // the selectedTypes check. To relax Name/Description back to optional,
  // delete their checks (and drop the `required` attribute + the little
  // red "*" next to that label in index.html so the UI matches).
  const name = document.getElementById("f-name").value.trim();
  if(!name){ alert("This creature needs a Name before it can be saved."); document.getElementById("f-name").focus(); return; }
  if(selectedTypes.length===0){ alert("Pick at least one type for this creature."); return; }
  const descVal = document.getElementById("f-desc").value.trim();
  if(!descVal){ alert("Give this creature a quick Description before saving — even a sentence is fine."); document.getElementById("f-desc").focus(); return; }
  // ============================================================
  
  const preEvoVal = preEvoSelect.value ? Number(preEvoSelect.value) : null;
  const variantOfVal = variantOfSelect.value ? Number(variantOfSelect.value) : null;
  if(editingId && preEvoVal===editingId){ alert("A creature can't be its own pre-evolution."); return; }
  if(editingId && variantOfVal===editingId){ alert("A creature can't be a variant of itself."); return; }

  // ================= EVOLUTION LINK DATA =================
  // The form only ever captures ONE direction of the relationship: "Evolves
  // From" on THIS entry (evolves from [preEvo], via [f-preevo-type] at
  // [f-preevo-value]). evolution.js/leveling.js need the OPPOSITE direction
  // to actually fire a level-up evolution: the PARENT entry needs
  // evolvesInto (this entry's id) + evolvesAt ({type,value}). That forward
  // link is auto-derived onto the parent right after this entry is saved —
  // see "DERIVE FORWARD EVOLUTION LINK" below — so the creator only fills
  // this in once, from the child's side.
  const previousPreEvoVal = editingId ? (entries.find(e=>e.id===editingId)?.preEvo ?? null) : null;
  const preEvoType = document.getElementById("f-preevo-type").value || "level";
  const preEvoRawValue = document.getElementById("f-preevo-value").value.trim();
  const preEvoEvolvesAt = (preEvoVal && preEvoRawValue)
    ? { type: preEvoType, value: preEvoType === "level" ? Number(preEvoRawValue) : preEvoRawValue }
    : null;
  // ============================================================

  const customIconVal = document.getElementById("f-custom-icon").value.trim();

  // The 4 optional image slots. "artwork" doubles as the legacy imageUrl
  // value so anything still reading entry.imageUrl directly keeps working.
  const imgArtwork = document.getElementById("f-image").value.trim();
  const imgPixel = document.getElementById("f-image-pixel").value.trim();
  const imgPixelShiny = document.getElementById("f-image-pixel-shiny").value.trim();
  const imgArtworkShiny = document.getElementById("f-image-artwork-shiny").value.trim();

  const payload = {
    name, 
    regionId: Number(document.getElementById("f-region").value),
    category: document.getElementById("f-category").value.trim(),
    creator: document.getElementById("f-creator").value.trim() || "Anonymous",
    types: [...selectedTypes], 
    icon: customIconVal || selectedEmoji,
    customIconEmoji: customIconVal,
    // images: the new multi-image set. imageUrl is kept in sync with
    // images.artwork purely for backward compatibility with any older code
    // path that still reads entry.imageUrl directly — see
    // resolveCreatureIcon() above for the function that should be used by
    // any NEW rendering code instead.
    images: {
      pixel: imgPixel,
      pixelShiny: imgPixelShiny,
      artwork: imgArtwork,
      artworkShiny: imgArtworkShiny,
      // Per-slot crop/focus point ({x,y,zoom} as percentages), only for
      // slots that actually have a URL — set via the click-to-pick preview
      // under each image field, so a shared "group art" URL can be reused
      // across entries while each crops to just their own creature.
      focus: Object.fromEntries(
        Object.entries(imageFocusState).filter(([slot]) => {
          if(slot==="pixel") return !!imgPixel;
          if(slot==="pixelShiny") return !!imgPixelShiny;
          if(slot==="artwork") return !!imgArtwork;
          if(slot==="artworkShiny") return !!imgArtworkShiny;
          return false;
        })
      )
    },
    imageUrl: imgArtwork,
    height: Number(document.getElementById("f-height").value) || 0,
    weight: Number(document.getElementById("f-weight").value) || 0,
    rarity: document.getElementById("f-rarity").value,
    abilities: collectAbilities(), 
    moves: collectMoves(), // Make sure collectMoves captures move learn level!
    tagMatchups: collectTagMatchups(),
    genderPool: normalizeGenderPool(document.getElementById("f-gender-pool").value),
    tastes: normalizeTastes(Object.fromEntries(FLAVORS.map(f=>[f, document.getElementById(`f-taste-${f.toLowerCase()}`).value]))),
    tags: (()=>{
      const manual = normalizeCreatureTags(document.getElementById("f-tags").value);
      const taste = normalizeTastes(Object.fromEntries(FLAVORS.map(f=>[f, document.getElementById(`f-taste-${f.toLowerCase()}`).value])));
      return [...new Set([...manual, ...deriveTasteTags(taste)])];
    })(),
    desc: document.getElementById("f-desc").value.trim(),
    stats: {...statValues},
    
    // Backward link only — "this entry evolves from [preEvo]", the one
    // direction the form actually collects. This entry's OWN evolvesInto/
    // evolvesAt is intentionally left out of this payload: it's not this
    // entry's to set, only its children can set it (see "DERIVE FORWARD
    // EVOLUTION LINK" below) — so editing this entry never wipes out an
    // evolution link one of its children already stamped onto it.
    preEvo: preEvoVal,
    preEvoMethod: preEvoEvolvesAt ? String(preEvoEvolvesAt.value) : "",

    variantOf: variantOfVal,
    megas: collectMegas()
  };

  let savedId;
  if(editingId){
    const idx = entries.findIndex(e=>e.id===editingId);
    if(idx>-1) entries[idx] = {...entries[idx], ...payload};
    savedId = editingId;
  } else {
    payload.id = nextEntryId();
    entries.push(payload);
    savedId = payload.id;
  }

  // ================= DERIVE FORWARD EVOLUTION LINK =================
  // Stamp the pre-evo parent (if any) with the evolvesInto/evolvesAt link
  // that evolution.js actually reads at level-up time. If this entry used
  // to point at a DIFFERENT parent (changed via editing), clear that old
  // parent's link first so it doesn't keep pointing at a child it's no
  // longer connected to.
  // NOTE: this assumes one child per parent (a straight line, not a
  // branching evolution) — if two entries both set the same preEvo, the
  // second one saved wins and overwrites the first's forward link.
  if(editingId && previousPreEvoVal!=null && previousPreEvoVal!==preEvoVal){
    const oldParent = entries.find(e=>e.id===previousPreEvoVal);
    if(oldParent && oldParent.evolvesInto===savedId){
      oldParent.evolvesInto = null;
      oldParent.evolvesAt = null;
    }
  }
  if(preEvoVal!=null){
    const parent = entries.find(e=>e.id===preEvoVal);
    if(parent){
      parent.evolvesInto = savedId;
      parent.evolvesAt = preEvoEvolvesAt;
    }
  }
  // ============================================================

  saveEntries(entries);
  closeForm();
  renderAll();
  updateViewVisibility();

  // ================= CLOUD SYNC =================
  // Push this entry to Firestore too (with creatorUid stamped) so it's
  // visible to everyone, not just saved in this browser's localStorage.
  if(window.CloudSync){
    const savedEntry = entries.find(e=>e.id===savedId);
    window.CloudSync.saveEntryToCloud(savedEntry)
      .then(firestoreId=>{
        if(firestoreId && savedEntry.firestoreId !== firestoreId){
          savedEntry.firestoreId = firestoreId;
          savedEntry.creatorUid = savedEntry.creatorUid || window.currentUser.uid;
          saveEntries(entries);
        }
      })
      .catch(err=>{
        console.error("❌ Cloud save failed:", err);
        alert(err.message || "Couldn't save this entry to the cloud — it was only saved on this device.");
      });
  }
  // ============================================================
});

  // ================= MOVE IMPORTER & ABILITY IMPORTER =================
  // Lets a creator search the global Move/Ability Dex from inside a creature's own editor, pull an
  // existing move/ability straight into their custom setup as a new (fully editable) row, and tweak
  // its attributes — name, stats, effects, everything — from there without retyping it from scratch.
  const importPickerOverlay = document.getElementById("importPickerOverlay");
  const importPickerTitle = document.getElementById("importPickerTitle");
  const importPickerSearch = document.getElementById("importPickerSearch");
  const importPickerList = document.getElementById("importPickerList");
  const importPickerEmpty = document.getElementById("importPickerEmpty");
  let importPickerMode = "move"; // "move" | "ability"
  let importPickerTarget = null; // the .dyn-list container the imported row gets appended to
  let importPickerClearFirst = false; // true for single-slot containers (Mega Ability, item Tera Move)
  function renderImportPickerList(){
    const text = importPickerSearch.value.trim().toLowerCase();
    const groups = importPickerMode === "move" ? getMoveGroups() : getAbilityGroups();
    const filtered = groups.filter(g=>{
      const name = importPickerMode==="move" ? g.move.name : g.ability.name;
      return !text || name.toLowerCase().includes(text);
    });
    importPickerEmpty.style.display = filtered.length ? "none" : "block";
    importPickerList.innerHTML = filtered.map((g,i)=>{
      const item = importPickerMode==="move" ? g.move : g.ability;
      const sub = importPickerMode==="move"
        ? `${cap(item.type)} · ${item.category}${(item.category==="Physical"||item.category==="Special") ? " · Power "+item.basePower : ""}`
        : describeAbility(item);
      // g.learners is an array of {entry, level} wrapper objects (see
      // getMoveGroups()/getAbilityGroups()) — reading .name straight off
      // one of those wrappers is always undefined, which is why "Learned
      // by:" showed up blank. Need .entry.name. Filtering out any bad/
      // missing entries here too, so one odd record can't blank the whole line.
      const validLearners = g.learners.filter(l=>l && l.entry && l.entry.name);
      const learnerNames = validLearners.length
        ? validLearners.slice(0,3).map(l=>l.entry.name).join(", ") + (validLearners.length>3 ? ` +${validLearners.length-3} more` : "")
        : "Nobody yet";
      return `
        <div class="item-card" style="cursor:pointer;padding:12px 14px;" data-idx="${i}">
          <div class="item-name">${esc(item.name)}</div>
          <div class="item-meta"><span>${esc(sub)}</span></div>
          <div class="field-hint">Learned by: ${esc(learnerNames)}</div>
        </div>`;
    }).join("");
    importPickerList.querySelectorAll("[data-idx]").forEach(el=>{
      el.addEventListener("click", ()=>{
        const g = filtered[Number(el.dataset.idx)];
        const item = importPickerMode==="move" ? g.move : g.ability;
        if(importPickerClearFirst) importPickerTarget.innerHTML = "";
        if(importPickerMode==="move") addMoveRow(item, importPickerTarget);
        else addAbilityRow(item, importPickerTarget);
        importPickerOverlay.classList.remove("open");
      });
    });
  }
  function openImportPicker(mode, targetEl, clearFirst){
    importPickerMode = mode;
    importPickerTarget = targetEl;
    importPickerClearFirst = !!clearFirst;
    importPickerTitle.textContent = mode==="move" ? "Import Move" : "Import Ability";
    importPickerSearch.value = "";
    renderImportPickerList();
    importPickerOverlay.classList.add("open");
    importPickerSearch.focus();
  }
  importPickerSearch.addEventListener("input", renderImportPickerList);
  document.getElementById("closeImportPicker").addEventListener("click", ()=>importPickerOverlay.classList.remove("open"));
  importPickerOverlay.addEventListener("click", (e)=>{ if(e.target===importPickerOverlay) importPickerOverlay.classList.remove("open"); });
  document.getElementById("importMoveBtn").addEventListener("click", ()=> openImportPicker("move", moveFieldsEl));
  document.getElementById("importAbilityBtn").addEventListener("click", ()=> openImportPicker("ability", abilityFieldsEl));

  // ---- Item Dex CRUD: add/edit form (mirrors the existing Region form modal pattern) ----
  function slugify(name){
    const base = String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g,"") || "item";
    let slug = base, n = 1;
    while(items.some(i=>i.id===slug && i.id!==editingItemId)){ slug = base + (++n); }
    return slug;
  }
  let editingItemId = null;
  const itemOverlay = document.getElementById("itemOverlay");
  const itemForm = document.getElementById("itemForm");
  const itEffectsListEl = document.getElementById("it-effects-list");
  const ITEM_TRIGGERS = [["battleStart","battleStart (held item, already active)"],["onUse","onUse (eaten/activated the instant it fires — supports Heal, Stat Boost, Cure Status, Type Boost)"],["onTakeDamage","onTakeDamage (receiving a move)"],["onDealDamage","onDealDamage (holder using a move)"],["onHpThreshold","onHpThreshold"],["turnEnd","turnEnd"],["onMoveMiss","onMoveMiss (holder's move missed)"],["onSwitchIn","onSwitchIn (battle start, on entry)"],["onUserIntent","onUserIntent (manual activation — Terastallize, popped during turn selection)"]];
  const ITEM_ACTIONS = [["none","No Effect (Key Item / Trash — e.g. a Mega Evolution key item, or inert fodder for item-swap moves)"],["heal","heal"],["boostStat","boostStat (Speed)"],["preventFaint","preventFaint"],["recoil","recoil"],["cureStatus","cureStatus"],["boostDamage","boostDamage"],
    ["terastallize","Terastallize (change Type + inject Dynamic Move — requires Tera Type set above, trigger: onUserIntent)"],
    ["failSafeRandomMove","Fail-Safe — random move on miss (trigger: onMoveMiss)"],
    ["copyStatStages","Stat Copy — match enemy stat stages (trigger: onSwitchIn)"],
    ["statModifierTimed","Stat Modifier — timed self-buff + while-active effect"],
    ["convertIncoming","Status Change — Incoming (rewrite a status about to hit the holder)"],
    ["convertOutgoing","Status Change — Outgoing (rewrite a status the holder is about to inflict)"],
    ["contactCounterStatus","Contact Counter — % chance to inflict status on contact (trigger: onTakeDamage)"],
    ["suppressAbility","Ability Nullifier — suppress opponent's Ability for N turns"],
    ["firstTurnPriority","First-Turn Priority — +N priority on first move after entry"],
    ["percentStatShift","Stat Shift — %-based stat boost/penalty (trigger: battleStart)"],
    ["boostTypePower","Multi-Hit Break — +% power for a type/tag, item breaks after N uses"],
    ["neverMissFilter","Never-Miss — moves of a chosen type/tag never miss"],
    ["weaknessSurge","Weakness — take +% damage from a chosen type/tag"],
    ["mitigation","Mitigation — take -% damage from super-effective or a chosen type/tag"],
    ["echoRepeat","Move Repeat (Echo) — % chance to re-execute the move at reduced power"]];
  const ITEM_STAT_KEYS = [["atk","Attack"],["def","Defense"],["spa","Sp. Atk"],["spd","Sp. Def"],["spe","Speed"]];
  const ITEM_WHILE_ACTIVE_OPTIONS = [["none","Nothing extra"],["heal","Heal a % of Max HP each turn"],["cureStatus","Cure the holder's status each turn"],["boostDamage","Boost the holder's outgoing damage"]];
  const ITEM_STATUS_OPTIONS = STATUS_EFFECTS.filter(([v])=>v!=="none");
  // Which actions need which extra parameter groups, keyed by the group's data-group name below.
  const ITEM_ACTION_EXTRA_FIELDS = {
    statModifierTimed: ["statkey","duration","whileactive"],
    convertIncoming: ["fromstatus","tostatus"],
    convertOutgoing: ["fromstatus","tostatus"],
    contactCounterStatus: ["chance","statuskind"],
    suppressAbility: ["duration"],
    percentStatShift: ["statkey"],
    mitigation: ["filtermode"],
    echoRepeat: ["chance","powerpct"],
    boostDamage: ["boostduration"]
  };
  // ---- Multi-Effect Builder: one item can now stack any number of these rows (Heal + Stat Boost + Cure
  // Status + Type Boost, etc.), the same "+ Add Effect" repeater pattern the Move/Ability builder uses. ----
  function createItemEffectRow(data){
    data = data || { trigger:"turnEnd", action:"heal", value:0, filterKind:"none", filterValue:"" };
    const row = document.createElement("div"); row.className = "dyn-row effect-row";
    row.innerHTML = `
      <div class="dyn-row-top">
        <select class="ie-trigger">${ITEM_TRIGGERS.map(([v,l])=>`<option value="${v}">${l}</option>`).join("")}</select>
        <select class="ie-action">${ITEM_ACTIONS.map(([v,l])=>`<option value="${v}">${l}</option>`).join("")}</select>
        <button type="button" class="dyn-row-remove" title="Remove effect">×</button>
      </div>
      <div class="rule-row">
        <label class="rule-label">Priority <span style="color:var(--slate);text-transform:none;font-weight:400;">(lower fires first when more than one effect is eligible at once — 0 = default, so set the 2nd effect to 1, 2, etc. to make it follow the 1st)</span></label>
        <input type="number" class="ie-priority" step="1" placeholder="0">
      </div>
      <div class="rule-row">
        <label class="rule-label">Value</label>
        <input type="number" class="ie-value" step="0.01" placeholder="e.g. 0.0625 for 1/16, 2 for +2 stages, 0.2 for +20%">
      </div>
      <div class="rule-row">
        <label class="rule-label">Move Filter <span style="color:var(--slate);text-transform:none;font-weight:400;">(onTakeDamage / onDealDamage / Never-Miss / Weakness / Multi-Hit Break / Mitigation)</span></label>
        <select class="ie-filterkind">
          <option value="none">None — always triggers</option>
          <option value="type">Move Type</option>
          <option value="tag">Move Tag</option>
        </select>
      </div>
      <div class="rule-row ie-filtertype-row" style="display:none;">
        <label class="rule-label">Type</label>
        <select class="ie-filtertype">${TYPES.map(t=>`<option value="${t}">${cap(t)}</option>`).join("")}</select>
      </div>
      <div class="rule-row ie-filtertag-row" style="display:none;">
        <label class="rule-label">Tag</label>
        <input type="text" class="ie-filtertag" placeholder="e.g. contact, projectile, blade">
      </div>
      <div class="rule-row">
        <label class="rule-label">Holder Filter <span style="color:var(--slate);text-transform:none;font-weight:400;">(only fires if the HOLDER itself is this Type/Tag — independent of the Move Filter above)</span></label>
        <select class="ie-holderfilterkind">
          <option value="none">None — always triggers</option>
          <option value="type">Holder Type</option>
          <option value="tag">Holder Creature Tag</option>
        </select>
      </div>
      <div class="rule-row ie-holderfiltertype-row" style="display:none;">
        <label class="rule-label">Type</label>
        <select class="ie-holderfiltertype">${TYPES.map(t=>`<option value="${t}">${cap(t)}</option>`).join("")}</select>
      </div>
      <div class="rule-row ie-holderfiltertag-row" style="display:none;">
        <label class="rule-label">Tag</label>
        <input type="text" class="ie-holderfiltertag" placeholder="e.g. levitating, boss, heavyweight">
      </div>
      <!-- ---- Extended Item Effect Hooks: extra per-action parameter groups (hidden unless the chosen
           action needs them — see ITEM_ACTION_EXTRA_FIELDS / syncFieldVisibility). ---- -->
      <div class="rule-row ie-extra-row" data-group="statkey" style="display:none;">
        <label class="rule-label">Stat</label>
        <select class="ie-statkey">${ITEM_STAT_KEYS.map(([v,l])=>`<option value="${v}">${l}</option>`).join("")}</select>
      </div>
      <div class="rule-row ie-extra-row" data-group="duration" style="display:none;">
        <label class="rule-label">Duration (turns)</label>
        <input type="number" class="ie-duration" min="1" step="1" placeholder="e.g. 3">
      </div>
      <div class="rule-row ie-extra-row" data-group="whileactive" style="display:none;">
        <label class="rule-label">While Active</label>
        <select class="ie-whileactive">${ITEM_WHILE_ACTIVE_OPTIONS.map(([v,l])=>`<option value="${v}">${l}</option>`).join("")}</select>
        <input type="number" class="ie-whileactivevalue" step="0.01" placeholder="value, e.g. 0.1 = 10%">
      </div>
      <div class="rule-row ie-extra-row" data-group="fromstatus" style="display:none;">
        <label class="rule-label">From Status</label>
        <select class="ie-fromstatus">${ITEM_STATUS_OPTIONS.map(([v,l])=>`<option value="${v}">${l}</option>`).join("")}</select>
      </div>
      <div class="rule-row ie-extra-row" data-group="tostatus" style="display:none;">
        <label class="rule-label">To Status</label>
        <select class="ie-tostatus">${ITEM_STATUS_OPTIONS.map(([v,l])=>`<option value="${v}">${l}</option>`).join("")}</select>
      </div>
      <div class="rule-row ie-extra-row" data-group="chance" style="display:none;">
        <label class="rule-label">Chance (%)</label>
        <input type="number" class="ie-chance" min="0" max="100" step="1" placeholder="e.g. 30">
      </div>
      <div class="rule-row ie-extra-row" data-group="statuskind" style="display:none;">
        <label class="rule-label">Status To Inflict</label>
        <select class="ie-statuskind">${ITEM_STATUS_OPTIONS.map(([v,l])=>`<option value="${v}">${l}</option>`).join("")}</select>
      </div>
      <div class="rule-row ie-extra-row" data-group="filtermode" style="display:none;">
        <label class="rule-label">Mitigate Against</label>
        <select class="ie-filtermode">
          <option value="superEffective">Any Super-Effective Hit</option>
          <option value="typeFilter">Only the Move Filter Type/Tag Above</option>
        </select>
      </div>
      <div class="rule-row ie-extra-row" data-group="powerpct" style="display:none;">
        <label class="rule-label">Echo Power (%)</label>
        <input type="number" class="ie-powerpct" min="1" max="100" step="1" placeholder="e.g. 50">
      </div>
      <div class="rule-row ie-extra-row" data-group="boostduration" style="display:none;">
        <label class="rule-label">Boost Duration (turns) <span style="color:var(--slate);text-transform:none;font-weight:400;">— 0 = infinite (lasts the rest of the battle). Only used when Trigger is battleStart or onUse; ignored for onDealDamage's one-shot bonus.</span></label>
        <input type="number" class="ie-boostduration" min="0" step="1" placeholder="0">
      </div>`;
    row.querySelector(".ie-trigger").value = data.trigger || "turnEnd";
    row.querySelector(".ie-action").value = data.action || "heal";
    row.querySelector(".ie-priority").value = data.priority!=null ? data.priority : "";
    row.querySelector(".ie-value").value = data.value!=null ? data.value : "";
    const filterKind = data.filterKind || "none";
    row.querySelector(".ie-filterkind").value = filterKind;
    if(filterKind==="type") row.querySelector(".ie-filtertype").value = data.filterValue || TYPES[0];
    if(filterKind==="tag") row.querySelector(".ie-filtertag").value = data.filterValue || "";
    const holderFilterKind = data.holderFilterKind || "none";
    row.querySelector(".ie-holderfilterkind").value = holderFilterKind;
    if(holderFilterKind==="type") row.querySelector(".ie-holderfiltertype").value = data.holderFilterValue || TYPES[0];
    if(holderFilterKind==="tag") row.querySelector(".ie-holderfiltertag").value = data.holderFilterValue || "";
    row.querySelector(".ie-statkey").value = data.statKey || "atk";
    row.querySelector(".ie-duration").value = data.durationTurns!=null ? data.durationTurns : "";
    row.querySelector(".ie-whileactive").value = data.whileActiveAction || "none";
    row.querySelector(".ie-whileactivevalue").value = data.whileActiveValue!=null ? data.whileActiveValue : "";
    row.querySelector(".ie-fromstatus").value = data.fromStatus || ITEM_STATUS_OPTIONS[0][0];
    row.querySelector(".ie-tostatus").value = data.toStatus || ITEM_STATUS_OPTIONS[0][0];
    row.querySelector(".ie-chance").value = data.chance!=null ? data.chance : "";
    row.querySelector(".ie-statuskind").value = data.statusKind || ITEM_STATUS_OPTIONS[0][0];
    row.querySelector(".ie-filtermode").value = data.filterMode || "superEffective";
    row.querySelector(".ie-powerpct").value = data.powerPct!=null ? data.powerPct : "";
    row.querySelector(".ie-boostduration").value = data.boostDurationTurns!=null ? data.boostDurationTurns : "";
    function syncFieldVisibility(){
      const kind = row.querySelector(".ie-filterkind").value;
      row.querySelector(".ie-filtertype-row").style.display = kind==="type" ? "flex" : "none";
      row.querySelector(".ie-filtertag-row").style.display = kind==="tag" ? "flex" : "none";
      const holderKind = row.querySelector(".ie-holderfilterkind").value;
      row.querySelector(".ie-holderfiltertype-row").style.display = holderKind==="type" ? "flex" : "none";
      row.querySelector(".ie-holderfiltertag-row").style.display = holderKind==="tag" ? "flex" : "none";
      const action = row.querySelector(".ie-action").value;
      const wanted = new Set(ITEM_ACTION_EXTRA_FIELDS[action] || []);
      row.querySelectorAll(".ie-extra-row").forEach(g=>{ g.style.display = wanted.has(g.dataset.group) ? "flex" : "none"; });
    }
    syncFieldVisibility();
    row.querySelector(".ie-filterkind").addEventListener("change", syncFieldVisibility);
    row.querySelector(".ie-holderfilterkind").addEventListener("change", syncFieldVisibility);
    row.querySelector(".ie-action").addEventListener("change", syncFieldVisibility);
    row.querySelector(".dyn-row-remove").addEventListener("click", ()=>row.remove());
    itEffectsListEl.appendChild(row);
  }
  function collectItemEffects(){
    return [...itEffectsListEl.querySelectorAll(".effect-row")].map(row=>{
      const filterKind = row.querySelector(".ie-filterkind").value;
      const filterValue = filterKind==="type" ? row.querySelector(".ie-filtertype").value
        : (filterKind==="tag" ? row.querySelector(".ie-filtertag").value.trim() : "");
      const holderFilterKind = row.querySelector(".ie-holderfilterkind").value;
      const holderFilterValue = holderFilterKind==="type" ? row.querySelector(".ie-holderfiltertype").value
        : (holderFilterKind==="tag" ? row.querySelector(".ie-holderfiltertag").value.trim() : "");
      return {
        trigger: row.querySelector(".ie-trigger").value,
        action: row.querySelector(".ie-action").value,
        priority: Math.round(Number(row.querySelector(".ie-priority").value)) || 0,
        value: parseFloat(row.querySelector(".ie-value").value) || 0,
        filterKind, filterValue,
        holderFilterKind, holderFilterValue,
        // Extended Item Effect Hooks: extra per-action parameters (harmless/unused on rows whose
        // action doesn't read them — the handler functions only ever look at the fields their own
        // action cares about).
        statKey: row.querySelector(".ie-statkey").value,
        durationTurns: row.querySelector(".ie-duration").value!=="" ? Math.max(1, Math.round(Number(row.querySelector(".ie-duration").value)||1)) : undefined,
        whileActiveAction: row.querySelector(".ie-whileactive").value,
        whileActiveValue: parseFloat(row.querySelector(".ie-whileactivevalue").value) || 0,
        fromStatus: row.querySelector(".ie-fromstatus").value,
        toStatus: row.querySelector(".ie-tostatus").value,
        chance: row.querySelector(".ie-chance").value!=="" ? Math.max(0, Math.min(100, Number(row.querySelector(".ie-chance").value)||0)) : undefined,
        statusKind: row.querySelector(".ie-statuskind").value,
        filterMode: row.querySelector(".ie-filtermode").value,
        powerPct: row.querySelector(".ie-powerpct").value!=="" ? Math.max(1, Math.min(100, Number(row.querySelector(".ie-powerpct").value)||50)) : undefined,
        // boostDamage's timed-boost duration: 0 explicitly means infinite (unlike the older `duration`
        // field elsewhere, which treats 0 as falsy and falls back to a default) — so an empty box and a
        // typed "0" both come through as 0 here, both meaning "lasts the rest of the battle".
        boostDurationTurns: row.querySelector(".ie-boostduration").value!=="" ? Math.max(0, Math.round(Number(row.querySelector(".ie-boostduration").value)||0)) : 0
      };
    });
  }
  document.getElementById("it-add-effect-btn").addEventListener("click", ()=>createItemEffectRow());
  const IMMUNITY_KEYS = ["freeze","poison","burn","paralysis","sleep","hazard"];
  const itStatusEffectSelect = document.getElementById("it-status-effect");
  itStatusEffectSelect.innerHTML = STATUS_EFFECTS.map(([v,l])=>`<option value="${v}">${l}</option>`).join("");
  // ---- Flavor dropdown: "None" (default — most items aren't food) plus every entry in FLAVORS, the
  // same vocabulary a Pokémon's own Taste Preferences (entry.tastes) are authored in, so the two line up
  // one-to-one for getTastePreference()/useItem() at battle time. ----
  const itFlavorSelect = document.getElementById("it-flavor");
  itFlavorSelect.innerHTML = `<option value="none">None (not food)</option>` + FLAVORS.map(f=>`<option value="${f}">${f}</option>`).join("");
  // ---- Terastallization Engine: Tera Type dropdown — "none" (default, no Tera behavior) plus every
  // battle Type, plus "stellar" (the one Tera Type that keeps the holder's own types — see
  // activateTeraState() in the sim core). ----
  const itTeraTypeSelect = document.getElementById("it-teratype");
  itTeraTypeSelect.innerHTML = `<option value="none">None (no Tera behavior)</option>`
    + TYPES.map(t=>`<option value="${t}">${cap(t)}</option>`).join("")
    + `<option value="stellar">Stellar (keeps the holder's own types)</option>`;
  // ---- Dynamic Move Injector: reuses the exact same full Move builder (addMoveRow/collectMoves) the
  // main Moves panel and Mega Move Slots already use, pointed at its own single-row container. Always
  // holds exactly one row (its remove button is hidden via CSS — see #it-teramove-list .dyn-row-remove
  // above) since an item's teraMove is one move, not a list. ----
  const itTeraMoveListEl = document.getElementById("it-teramove-list");
  document.getElementById("itImportMoveBtn").addEventListener("click", ()=>openImportPicker("move", itTeraMoveListEl, true));
  function openItemForm(existing){
    itemForm.reset();
    editingItemId = existing ? existing.id : null;
    document.getElementById("itemFormTitle").textContent = existing ? "Edit Item" : "New Item";
    document.getElementById("it-name").value = existing ? existing.name : "";
    document.getElementById("it-type").value = existing ? existing.type : "held";
    document.getElementById("it-maxuses").value = existing ? (Number(existing.maxUses)||0) : 1;
    itFlavorSelect.value = (existing && FLAVORS.includes(existing.flavor)) ? existing.flavor : "none";
    // ---- Terastallization Engine: teraType + the Dynamic Move Injector (teraMove) fields, mirroring
    // the same defaults applied by migrateItem()/loadItems() at data-load time. ----
    const teraType = (existing && existing.teraType) || "none";
    itTeraTypeSelect.value = itTeraTypeSelect.querySelector(`option[value="${teraType}"]`) ? teraType : "none";
    document.getElementById("it-notera").checked = !!(existing && existing.noTeraRequired);
    itTeraMoveListEl.innerHTML = "";
    addMoveRow(Object.assign({ name:"Tera Blast", basePower:80, accuracy:1, maxPP:10, tags:["tera"] }, (existing && existing.teraMove) || {}), itTeraMoveListEl);
    document.getElementById("it-desc").value = existing ? (existing.desc||"") : "";
    itEffectsListEl.innerHTML = "";
    const effects = (existing && existing.effects && existing.effects.length) ? existing.effects : [{ trigger:"turnEnd", action:"none", value:0, filterKind:"none", filterValue:"" }];
    effects.forEach(fx=>createItemEffectRow(fx));
    const immunities = (existing && existing.immunities) || {};
    IMMUNITY_KEYS.forEach(k=>{ document.getElementById(`it-immune-${k}`).checked = !!immunities[k]; });
    const statusOnUse = Object.assign({ effect:"none", chance:100, target:"opponent" }, (existing && existing.statusEffectOnUse) || {});
    itStatusEffectSelect.value = statusOnUse.effect;
    document.getElementById("it-status-chance").value = statusOnUse.chance;
    document.getElementById("it-status-target").value = statusOnUse.target;
    itemOverlay.classList.add("open");
    document.getElementById("it-name").focus();
  }
  document.getElementById("closeItemForm").addEventListener("click", ()=>itemOverlay.classList.remove("open"));
  document.getElementById("cancelItemForm").addEventListener("click", ()=>itemOverlay.classList.remove("open"));
  itemOverlay.addEventListener("click", (e)=>{ if(e.target===itemOverlay) itemOverlay.classList.remove("open"); });
  itemForm.addEventListener("submit", (e)=>{
    e.preventDefault();

    // ================= LOGIN + OWNERSHIP CHECK =================
    if(!window.currentUser){ alert("Log in to save an item to the Item Dex."); return; }
    if(editingItemId){
      const existingItem = items.find(i=>i.id===editingItemId);
      if(existingItem && window.CloudSync && !window.CloudSync.canManageRecord(existingItem)){
        alert("You can only edit items you created.");
        return;
      }
    }
    // ============================================================

    const name = document.getElementById("it-name").value.trim();
    if(!name){ alert("This item needs a Name before it can be saved."); document.getElementById("it-name").focus(); return; }
    const immunities = {};
    IMMUNITY_KEYS.forEach(k=>{ immunities[k] = document.getElementById(`it-immune-${k}`).checked; });
    const data = {
      id: editingItemId || slugify(name),
      name,
      type: document.getElementById("it-type").value,
      flavor: FLAVORS.includes(itFlavorSelect.value) ? itFlavorSelect.value : "none",
      maxUses: Math.max(0, Math.round(Number(document.getElementById("it-maxuses").value)||0)),
      effects: collectItemEffects(),
      // ---- Terastallization Engine: teraType "none" disables Tera behavior entirely (skipped by
      // activateTeraState()/tryTerastallize() in the sim core). teraMove is collected through the same
      // collectMoves() the main Moves panel uses, so it carries Base Power/Accuracy/PP/Tags/Effects/
      // secondary Status/Stat/Heal/Hazard actions and everything else the full move builder supports.
      // Type/Category are deliberately stripped afterward — buildTeraBlastMove() always recomputes both
      // live (Type = holder's current Tera Type, Category = whichever of Atk/SpAtk is higher), so
      // whatever the Type/Category dropdowns on the row show is never actually used. ----
      teraType: itTeraTypeSelect.value,
      teraMove: (()=>{ const m = collectMoves(itTeraMoveListEl)[0] || {}; if(!m.name) m.name = "Tera Blast"; delete m.type; delete m.category; return m; })(),
      noTeraRequired: document.getElementById("it-notera").checked,
      immunities,
      statusEffectOnUse: {
        effect: itStatusEffectSelect.value,
        chance: Math.max(0, Math.min(100, Number(document.getElementById("it-status-chance").value)||0)),
        target: document.getElementById("it-status-target").value==="self" ? "self" : "opponent"
      },
      desc: document.getElementById("it-desc").value.trim()
    };
    if(editingItemId){
      const prior = items.find(i=>i.id===editingItemId);
      if(prior){ data.creatorUid = prior.creatorUid; data.firestoreId = prior.firestoreId; }
      items = items.map(i=> i.id===editingItemId ? data : i);
    } else {
      items.push(data);
    }
    saveItems(items);
    itemOverlay.classList.remove("open");
    renderItemGrid();
    populateItemSelects();

    // ================= CLOUD SYNC =================
    if(window.CloudSync){
      window.CloudSync.saveItemToCloud(data)
        .then(firestoreId=>{
          if(firestoreId && data.firestoreId !== firestoreId){
            data.firestoreId = firestoreId;
            data.creatorUid = data.creatorUid || window.currentUser.uid;
            saveItems(items);
          }
        })
        .catch(err=>{
          console.error("❌ Cloud save failed:", err);
          alert(err.message || "Couldn't save this item to the cloud — it was only saved on this device.");
        });
    }
    // ============================================================
  });



  // ================= NEW REGION FORM =================
  const regionOverlay = document.getElementById("regionOverlay");
  const regionForm = document.getElementById("regionForm");
  const swatchRow = document.getElementById("swatchRow");
  REGION_COLORS.forEach(c=>{
    const sw = document.createElement("div"); sw.className = "swatch"; sw.style.background = c.base; sw.dataset.name = c.name;
    sw.addEventListener("click", ()=>{ pickedRegionColor = c; renderSwatches(); });
    swatchRow.appendChild(sw);
  });
  function renderSwatches(){ [...swatchRow.children].forEach(sw=>{ sw.classList.toggle("picked", sw.dataset.name === pickedRegionColor.name); }); }
  function openRegionForm(){
    regionForm.reset();
    pickedRegionColor = REGION_COLORS[Math.floor(Math.random()*REGION_COLORS.length)];
    renderSwatches();
    document.getElementById("regionFormTitle").textContent = "New Region";
    regionOverlay.classList.add("open");
    document.getElementById("r-name").focus();
  }
  document.getElementById("closeRegionForm").addEventListener("click", ()=>regionOverlay.classList.remove("open"));
  document.getElementById("cancelRegionForm").addEventListener("click", ()=>regionOverlay.classList.remove("open"));
  regionOverlay.addEventListener("click", (e)=>{ if(e.target===regionOverlay) regionOverlay.classList.remove("open"); });
  regionForm.addEventListener("submit", (e)=>{
    e.preventDefault();
    const name = document.getElementById("r-name").value.trim();
    if(!name){ alert("This region needs a Name before it can be saved."); document.getElementById("r-name").focus(); return; }
    const subtitle = document.getElementById("r-subtitle").value.trim();
    regions.push({ id: nextRegionId(), name, subtitle, color: pickedRegionColor, createdAt: Date.now() });
    saveRegions(regions);
    regionOverlay.classList.remove("open");
    refreshRegionSelect(); renderAll(); renderCartridges();
  });

  // ================= SETTINGS: EXPORT / IMPORT =================
  document.getElementById("exportBtn").addEventListener("click", ()=>{
    const payload = { fielddex_export: true, version: 1, exportedAt: new Date().toISOString(), regions, entries };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `fielddex-export-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  const importFileInput = document.getElementById("importFile");
  document.getElementById("importBtn").addEventListener("click", ()=> importFileInput.click());
  importFileInput.addEventListener("change", (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = ()=>{
      let data;
      try{ data = JSON.parse(reader.result); }
      catch(err){ alert("That file isn't valid JSON."); importFileInput.value=""; return; }

      if(data.fielddex_entry && data.entry){
        let targetRegion = regions.find(r=>r.name===data.region) || regions[0];
        if(!targetRegion){ alert("Create a region first — every creature needs a dex to belong to."); importFileInput.value=""; return; }
        const newEntry = migrateEntry({ ...data.entry, id: nextEntryId(), regionId: targetRegion.id, preEvo:null, variantOf:null });
        entries.push(newEntry);
        saveEntries(entries);
        refreshRegionSelect(); updateChipLabels();
        location.hash = ""; renderAll(); renderCartridges();
        importFileInput.value = "";
        alert(`Imported "${newEntry.name}" into ${targetRegion.name}.`);
        return;
      }

      if(!Array.isArray(data.entries) || !Array.isArray(data.regions)){
        alert("That file doesn't look like a FIELDDEX export (missing regions/entries)."); importFileInput.value=""; return;
      }
      const replace = confirm(
        `Import ${data.entries.length} entries and ${data.regions.length} regions?\n\n` +
        `OK = Replace everything currently saved.\nCancel = Merge into your current data (keeping both, may create duplicate IDs).`
      );
      if(replace){
        regions = data.regions;
        entries = data.entries.map(migrateEntry);
      } else {
        const regionIdOffset = regions.reduce((m,r)=>Math.max(m,r.id),0);
        const entryIdOffset = entries.reduce((m,e)=>Math.max(m,e.id),0);
        const regionIdMap = {};
        data.regions.forEach(r=>{ regionIdMap[r.id] = r.id + regionIdOffset; });
        const importedRegions = data.regions.map(r=>({ ...r, id: regionIdMap[r.id] }));
        const entryIdMap = {};
        data.entries.forEach(en=>{ entryIdMap[en.id] = en.id + entryIdOffset; });
        const importedEntries = data.entries.map(en=>migrateEntry({
          ...en,
          id: entryIdMap[en.id],
          regionId: regionIdMap[en.regionId] ?? en.regionId,
          preEvo: en.preEvo!=null ? entryIdMap[en.preEvo] : null,
          variantOf: en.variantOf!=null ? entryIdMap[en.variantOf] : null
        }));
        regions = [...regions, ...importedRegions];
        entries = [...entries, ...importedEntries];
      }
      saveRegions(regions); saveEntries(entries);
      refreshRegionSelect(); updateChipLabels();
      location.hash = ""; renderAll(); renderCartridges();
      importFileInput.value = "";
      alert("Import complete.");
    };
    reader.readAsText(file);
  });

  // ================= GLOBAL STATS + RENDER ALL =================

  // Expose openEdit to the global window scope for ui-dex-renderer.js
window.openEdit = openEdit;