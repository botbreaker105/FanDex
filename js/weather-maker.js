"use strict";

// ================= CUSTOM WEATHER MAKER (Settings tab) =================
// Builds a "Custom Weather Maker" block at the bottom of the Settings tab. Weathers made here are registered by
// engine.js (registerCustomWeather) so they appear in every weather dropdown: weather-setting abilities, moves
// that set weather, weather accuracy rules, Auto-Fail abilities... Open an ability/move editor AFTER saving so its
// dropdown includes the new weather. Weathers are saved in this browser; use Export / Import to move them.
(function installWeatherMaker() {
  const host = document.getElementById("view-settings");
  if (!host || typeof registerCustomWeather !== "function" || document.getElementById("customWeatherMaker")) return;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const cap = t => t[0].toUpperCase() + t.slice(1);

  const block = document.createElement("div");
  block.className = "settings-block";
  block.id = "customWeatherMaker";
  block.innerHTML = `
    <h3>Custom Weather Maker</h3>
    <p>Create your own weather: it can boost or weaken moves of chosen types, hurt or heal Fakemon every round, and change accuracy.
       After saving, it appears in every weather dropdown (open the ability / move editor again to see it).</p>
    <div id="cwList" style="margin:8px 0 12px;"></div>
    <div class="rule-row"><label class="rule-label">Name</label><input type="text" id="cwName" maxlength="30" placeholder="e.g. Acid Rain"></div>
    <div class="rule-row"><label class="rule-label">Emoji</label><input type="text" id="cwEmoji" maxlength="4" placeholder="🌧️" style="width:70px;"></div>
    <div class="rule-row"><label class="rule-label">Type Boosts / Nerfs (multiplier on that type's moves)</label>
      <div id="cwMods" style="width:100%;"></div>
      <button type="button" class="btn-secondary" id="cwAddMod">+ Add Type Modifier</button></div>
    <div class="rule-row"><label class="rule-label">Damages Every Round (% of max HP)</label><input type="number" id="cwChip" min="0" max="25" step="1" value="0" style="width:90px;"></div>
    <div class="rule-row"><label class="rule-label">...except these types (comma-separated)</label><input type="text" id="cwChipImmune" placeholder="e.g. poison, steel"></div>
    <div class="rule-row"><label class="rule-label">Heals Every Round (% of max HP)</label><input type="number" id="cwHeal" min="0" max="25" step="1" value="0" style="width:90px;"></div>
    <div class="rule-row"><label class="rule-label">...only these types (comma-separated)</label><input type="text" id="cwHealTypes" placeholder="e.g. grass, water"></div>
    <div class="rule-row"><label class="rule-label">Accuracy Multiplier (all moves)</label><input type="number" id="cwAcc" min="0.5" max="1.5" step="0.05" value="1" style="width:90px;"></div>
    <div class="field-hint">Types: ${TYPES.map(cap).join(", ")}. Multipliers: 0.5 = half damage, 1.5 = +50%. Duration is chosen by whatever sets the weather.</div>
    <div style="margin:10px 0;">
      <button type="button" class="btn-primary" id="cwSave">💾 Save Weather</button>
      <button type="button" class="btn-secondary" id="cwNew">New / Clear</button>
      <span id="cwMsg" style="margin-left:10px;"></span>
    </div>
    <details style="margin-top:8px;"><summary>Export / Import (move weathers between browsers)</summary>
      <textarea id="cwJson" rows="5" style="width:100%;margin-top:6px;" placeholder="Export fills this box. To import, paste exported JSON here and click Import."></textarea>
      <div><button type="button" class="btn-secondary" id="cwExport">Export</button> <button type="button" class="btn-secondary" id="cwImport">Import</button></div>
    </details>`;
  host.appendChild(block);

  const $ = id => document.getElementById(id);
  let editingKey = null;
  const myUid = () => (window.currentUser && window.currentUser.uid) || null;
  const isAdminUser = () => !!(window.userProfile && window.userProfile.isAdmin);
  // Local-only weathers (no creator yet) can be managed by anyone on this device; shared ones only by their creator / an admin.
  const canManage = w => !w.creatorUid || (!!myUid() && (w.creatorUid === myUid() || isAdminUser()));
  const say = (t, ok) => { const m = $("cwMsg"); m.textContent = t; m.style.color = ok === false ? "#ff6b6b" : "#5fd68c"; };

  function addModRow(type, mult) {
    const row = document.createElement("div");
    row.className = "cw-mod-row";
    row.style.cssText = "display:flex;gap:6px;align-items:center;margin:4px 0;";
    row.innerHTML = `<select class="cw-mod-type">${TYPES.map(t => `<option value="${t}" ${t === type ? "selected" : ""}>${cap(t)}</option>`).join("")}</select>
      × <input type="number" class="cw-mod-mult" min="0.1" max="3" step="0.1" value="${mult || 1.5}" style="width:80px;">
      <button type="button" class="btn-secondary cw-mod-del">✕</button>`;
    row.querySelector(".cw-mod-del").addEventListener("click", () => row.remove());
    $("cwMods").appendChild(row);
  }
  function clearForm() {
    editingKey = null;
    ["cwName", "cwEmoji", "cwChipImmune", "cwHealTypes"].forEach(id => { $(id).value = ""; });
    $("cwChip").value = 0; $("cwHeal").value = 0; $("cwAcc").value = 1;
    $("cwMods").innerHTML = "";
    $("cwSave").textContent = "💾 Save Weather";
  }
  function summary(w) {
    const parts = [];
    if (w.typeMods.length) parts.push(w.typeMods.map(m => `${cap(m.type)} ×${m.mult}`).join(", "));
    if (w.chipPct) parts.push(`hurts ${w.chipPct}%/round${w.chipImmune.length ? ` (not ${w.chipImmune.map(cap).join("/")})` : ""}`);
    if (w.healPct) parts.push(`heals ${w.healPct}%/round for ${w.healTypes.map(cap).join("/") || "no types yet"}`);
    if (w.accMult !== 1) parts.push(`accuracy ×${w.accMult}`);
    return parts.join(" · ") || "no effects";
  }
  function renderList() {
    const list = Object.values(CUSTOM_WEATHERS);
    $("cwList").innerHTML = list.length
      ? list.map(w => `<div class="rule-row" style="align-items:center;gap:8px;">
          <b>${esc(w.emoji)} ${esc(w.name)}</b> <span class="field-hint" style="flex:1;">${esc(summary(w))} · ${w.firestoreId ? `☁ shared${w.creatorName ? " by " + esc(w.creatorName) : ""}` : "💾 this device only"}</span>
          ${canManage(w) ? `<button type="button" class="btn-secondary" data-edit="${esc(w.key)}">Edit</button>
          <button type="button" class="btn-secondary" data-del="${esc(w.key)}">Delete</button>` : `<span class="field-hint">view only</span>`}</div>`).join("")
      : `<div class="field-hint">No custom weathers yet.</div>`;
  }
  $("cwList").addEventListener("click", async ev => {
    const ed = ev.target.closest && ev.target.closest("[data-edit]"), del = ev.target.closest && ev.target.closest("[data-del]");
    if (ed) {
      const w = CUSTOM_WEATHERS[ed.dataset.edit]; if (!w || !canManage(w)) return;
      clearForm(); editingKey = w.key;
      $("cwName").value = w.name; $("cwEmoji").value = w.emoji; $("cwChip").value = w.chipPct; $("cwHeal").value = w.healPct; $("cwAcc").value = w.accMult;
      $("cwChipImmune").value = w.chipImmune.join(", "); $("cwHealTypes").value = w.healTypes.join(", ");
      w.typeMods.forEach(m => addModRow(m.type, m.mult));
      $("cwSave").textContent = "💾 Update Weather"; say(`Editing ${w.name}`);
    } else if (del) {
      const w = CUSTOM_WEATHERS[del.dataset.del];
      if (w && canManage(w) && confirm(`Delete the weather "${w.name}"${w.firestoreId ? " for EVERYONE" : ""}? Abilities and moves that use it will have no weather effect.`)) {
        if (w.firestoreId && window.CloudSync) {
          try { await window.CloudSync.deleteWeatherFromCloud(w); }
          catch (err) { say("Could not delete it from the cloud: " + err.message, false); return; }
        }
        deleteCustomWeather(w.key); renderList(); say("Deleted");
      }
    }
  });
  $("cwAddMod").addEventListener("click", () => addModRow("fire", 1.5));
  $("cwNew").addEventListener("click", () => { clearForm(); say(""); });
  $("cwSave").addEventListener("click", async () => {
    const draft = {
      key: editingKey || undefined,
      name: $("cwName").value, emoji: $("cwEmoji").value,
      typeMods: [...document.querySelectorAll("#cwMods .cw-mod-row")].map(r => ({ type: r.querySelector(".cw-mod-type").value, mult: Number(r.querySelector(".cw-mod-mult").value) })),
      chipPct: $("cwChip").value, chipImmune: $("cwChipImmune").value, healPct: $("cwHeal").value, healTypes: $("cwHealTypes").value, accMult: $("cwAcc").value
    };
    const preview = normalizeCustomWeather(draft);
    if (!preview) { say("Give the weather a name first.", false); return; }
    const existing = CUSTOM_WEATHERS[preview.key];
    if (existing && !canManage(existing)) {
      say(`A weather named "${existing.name}" already exists (made by ${existing.creatorName || "another trainer"}). Pick a different name.`, false); return;
    }
    if (existing && !editingKey && existing.creatorUid) { say(`You already have a weather with that name — use Edit on it, or pick another name.`, false); return; }
    const base = existing || {};
    const def = registerCustomWeather({ ...draft, key: preview.key, firestoreId: base.firestoreId, creatorUid: base.creatorUid, creatorName: base.creatorName });
    saveCustomWeathers();
    let msg = `Saved "${def.name}" on this device — it is now in the weather dropdowns. Log in to share it with everyone.`, ok = true;
    if (myUid() && window.CloudSync && window.CloudSync.saveWeatherToCloud) {
      try {
        const rec = { ...def, creatorUid: def.creatorUid || myUid(), creatorName: def.creatorName || (window.userProfile && window.userProfile.displayName) || "Anonymous Trainer" };
        const id = await window.CloudSync.saveWeatherToCloud(rec);
        CUSTOM_WEATHERS[def.key] = { ...CUSTOM_WEATHERS[def.key], firestoreId: id, creatorUid: rec.creatorUid, creatorName: rec.creatorName };
        saveCustomWeathers();
        msg = `Saved "${def.name}" and shared it with everyone.`;
      } catch (err) { msg = `Saved on this device, but sharing failed: ${err.message}`; ok = false; }
    }
    renderList(); clearForm(); say(msg, ok);
  });
  $("cwExport").addEventListener("click", () => { $("cwJson").value = JSON.stringify(Object.values(CUSTOM_WEATHERS), null, 2); say("Exported below."); });
  $("cwImport").addEventListener("click", () => {
    try {
      const arr = JSON.parse($("cwJson").value);
      const n = (Array.isArray(arr) ? arr : [arr]).map(registerCustomWeather).filter(Boolean).length;
      saveCustomWeathers(); renderList(); say(`Imported ${n} weather${n === 1 ? "" : "s"}.`, n > 0);
    } catch (e) { say("That is not valid weather JSON.", false); }
  });
  renderList();
  window.addEventListener("customweathers:loaded", renderList);
  window.addEventListener("fandex:authchanged", renderList);
})();
