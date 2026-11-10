"use strict";
  function renderBattleTypeChipPanel(){
    let html = `<div class="chip-option ${battleFilters.type===""?"selected":""}" data-value="" style="margin-bottom:6px;">All Types</div><div class="type-chip-grid">`;
    html += TYPES.map(t=>`<div class="chip-option ${battleFilters.type===t?"selected":""}" data-value="${t}" style="background:var(--t-${t})">${t}</div>`).join("");
    html += `</div>`;
    battleTypeChipPanel.innerHTML = html;
    battleTypeChipPanel.querySelectorAll(".chip-option").forEach(el=>{
      el.addEventListener("click", ()=>{ battleFilters.type = el.dataset.value; closeAllPanels(); updateBattleSearchUi(); runBattleSearchReset(); });
    });
  }
  battleTypeChipBtn.addEventListener("click", stopAnd(()=>{ renderBattleTypeChipPanel(); togglePanel(battleTypeChipPanel); }));
  function updateBattleSearchUi(){
    battleTypeChipBtn.innerHTML = (battleFilters.type ? cap(battleFilters.type) : "All Types") + ` <span class="caret">▾</span>`;
    battleTypeChipBtn.classList.toggle("active-filter", !!battleFilters.type);
    const activeBits = [];
    if(battleFilters.text) activeBits.push(`name/move/item matches "${battleFilters.text}"`);
    if(battleFilters.type) activeBits.push(`type: ${cap(battleFilters.type)}`);
    battleSearchSummary.textContent = activeBits.length ? `Filtering pickers by ${activeBits.join(" · ")}.` : "";
  }
  // ---- Battle Search reset rule ----
  // Every keystroke/type-filter change re-filters all four pickers (Fighter A, Fighter B, Held Item A,
  // Held Item B) against the fresh query. Any already-placed selection that no longer matches the new
  // query is cleared back to its placeholder ("— Choose a creature —" / "None") rather than being left
  // selected-but-invisible inside its own now-filtered dropdown. A selection that still matches the new,
  // narrower query is left untouched — so refining a search (e.g. "fire" -> "fire ember") never discards
  // a pick that's still valid. Any cleared pick also wipes the stale battle-odds result below it, and
  // surfaces a one-line notice so the reset is visible instead of silent.
  function runBattleSearchReset(){
    const before = { a:fighterASelect.value, b:fighterBSelect.value, ia:fighterAItemSelect.value, ib:fighterBItemSelect.value };
    populateFighterSelects();
    populateItemSelects();
    const clearedSomething =
      (before.a && before.a!==fighterASelect.value) ||
      (before.b && before.b!==fighterBSelect.value) ||
      (before.ia && before.ia!==fighterAItemSelect.value) ||
      (before.ib && before.ib!==fighterBItemSelect.value);
    if(clearedSomething){
      battleSearchSummary.textContent += (battleSearchSummary.textContent ? "  " : "") + "⚠ Cleared a previous pick that no longer matches this search.";
      battleResultsEl.innerHTML = "";
    }
  }
  battleSearchInput.addEventListener("input", ()=>{
    battleFilters.text = battleSearchInput.value.trim().toLowerCase();
    updateBattleSearchUi();
    runBattleSearchReset();
  });
  battleSearchClearBtn.addEventListener("click", ()=>{
    battleFilters = { text:"", type:"" };
    battleSearchInput.value = "";
    updateBattleSearchUi();
    runBattleSearchReset();
  });
  // A battler matches the current search text if its own name matches, OR any move in its kit does —
  // so typing a move name (e.g. "Ember Slash") surfaces every creature that actually learns it.
  function battlerMatchesSearch(e){
    if(battleFilters.type && !e.types.includes(battleFilters.type)) return false;
    if(!battleFilters.text) return true;
    if(e.name.toLowerCase().includes(battleFilters.text)) return true;
    return (e.moves||[]).some(m=>(m.name||"").toLowerCase().includes(battleFilters.text));
  }
  function itemMatchesSearch(it){
    if(!battleFilters.text) return true;
    return (it.name||"").toLowerCase().includes(battleFilters.text);
  }

  // ================= ITEM DEX UI =================

  // Populates the Fighter A / Fighter B "Held Item" dropdowns from the Item Dex registry.
  // Called whenever the Battle tab opens, and re-populated if the Item Dex changes.
  function populateItemSelects(){
    const prevA = fighterAItemSelect.value, prevB = fighterBItemSelect.value;
    const pool = items.filter(itemMatchesSearch);
    const optionsHtml = `<option value="">None</option>` + pool.map(it=>`<option value="${it.id}">${esc(it.name)}</option>`).join("");
    fighterAItemSelect.innerHTML = optionsHtml;
    fighterBItemSelect.innerHTML = optionsHtml;
    if(pool.some(i=>i.id===prevA)) fighterAItemSelect.value = prevA;
    if(pool.some(i=>i.id===prevB)) fighterBItemSelect.value = prevB;
  }

  // ================= GLOBAL MOVE DEX + ABILITY DEX =================
  // Scans every creature across every region and groups moves/abilities that share an identical
  // name, stats, and effects into a single encyclopedia entry — each entry lists every creature
  // ("Mon") that learns it. Signature = the full normalized object, so two moves only merge when
  // truly everything about them matches; anything edited even slightly gets its own entry.
  function populateFighterSelects(){
    const prevA = fighterASelect.value, prevB = fighterBSelect.value;
    let pool = battleFavOnly.checked ? entries.filter(e=>isFavorite(e.id)) : entries;
    pool = pool.filter(battlerMatchesSearch);
    const optionsHtml = `<option value="">— Choose a creature —</option>` + pool.map(e=>{
      const r = regionById(e.regionId);
      return `<option value="${e.id}">${esc(e.name)}${r?" — "+esc(r.name):""}</option>`;
    }).join("");
    fighterASelect.innerHTML = optionsHtml;
    fighterBSelect.innerHTML = optionsHtml;
    if(pool.some(e=>String(e.id)===prevA)) fighterASelect.value = prevA;
    if(pool.some(e=>String(e.id)===prevB)) fighterBSelect.value = prevB;
    renderFighterPreview(fighterAPreview, entryById(fighterASelect.value));
    renderFighterPreview(fighterBPreview, entryById(fighterBSelect.value));
    updateSimulateBtnState();
  }

  function renderFighterPreview(el, entry){
    if(!entry){
      el.className = "fighter-preview";
      el.innerHTML = `Pick a creature to preview it here.`;
      return;
    }
    el.className = "fighter-preview filled";
    el.style.borderColor = `var(--t-${entry.types[0]})`;
    el.innerHTML = `
      <div class="fp-art" style="background:${rowBg(entry)}">${miniArtHtml(entry,"art-emoji")}</div>
      <div class="fp-name">${esc(entry.name)}</div>
      <div class="fp-types">${entry.types.map(t=>`<span class="type-pill" style="background:var(--t-${t})">${cap(t)}</span>`).join("")}</div>
      <div class="fp-stat-total">Power ${battlePower(entry)}</div>
    `;
  }

  function updateSimulateBtnState(){
    const a = fighterASelect.value, b = fighterBSelect.value;
    simulateBattleBtn.disabled = !a || !b || a===b;
  }

  fighterASelect.addEventListener("change", ()=>{ renderFighterPreview(fighterAPreview, entryById(fighterASelect.value)); updateSimulateBtnState(); battleResultsEl.innerHTML=""; });
  fighterBSelect.addEventListener("change", ()=>{ renderFighterPreview(fighterBPreview, entryById(fighterBSelect.value)); updateSimulateBtnState(); battleResultsEl.innerHTML=""; });
  fighterAItemSelect.addEventListener("change", ()=>{ battleResultsEl.innerHTML=""; });
  fighterBItemSelect.addEventListener("change", ()=>{ battleResultsEl.innerHTML=""; });
  battleFavOnly.addEventListener("change", populateFighterSelects);
  allowMegaToggle.addEventListener("change", ()=>{ battleResultsEl.innerHTML=""; });
  megaChancePct.addEventListener("change", ()=>{ battleResultsEl.innerHTML=""; });
  fieldEffectSelect.addEventListener("change", ()=>{ battleResultsEl.innerHTML=""; });

  function runAndRenderBattle(){
    const a = entryById(fighterASelect.value), b = entryById(fighterBSelect.value);
    if(!a || !b || a.id===b.id) return;
    const megaConfig = { enabled: allowMegaToggle.checked, chance: clampPct(megaChancePct.value, 50) };
    const fieldConfig = { field: fieldEffectSelect.value };
    // Fighter A / Fighter B Held Item selections, read fresh for every simulated battle.
    const itemConfig = { a: fighterAItemSelect.value || null, b: fighterBItemSelect.value || null };
    const { pctA, pctB, narratedLog } = runBattleOdds(a, b, 300, megaConfig, fieldConfig, itemConfig);
    const verdict = pctA===pctB ? `It's a dead heat!` : (pctA>pctB ? `${a.name} is favored to win!` : `${b.name} is favored to win!`);
    battleResultsEl.innerHTML = `
      <div class="battle-results">
        <div class="odds-verdict">${esc(verdict)}</div>
        <div class="odds-names"><span>${esc(a.name)} · ${pctA}%</span><span>${pctB}% · ${esc(b.name)}</span></div>
        <div class="odds-bar">
          <div class="odds-seg" style="width:${pctA}%;background:var(--t-${a.types[0]});">${pctA>=12?pctA+"%":""}</div>
          <div class="odds-seg" style="width:${pctB}%;background:var(--t-${b.types[0]});">${pctB>=12?pctB+"%":""}</div>
        </div>
        <div class="battle-log-title">Sample matchup replay</div>
        <div class="battle-log">${narratedLog.map(line=>`<div class="${line.includes('🏆')?'winner-line':(line.includes('🪄')?'move-learn-line':(line.includes('🎒')?'item-line':((line.includes('🎯')||line.includes('🔄')||line.includes('🔮')||line.includes('🧬')||line.includes('🧪')||line.includes('🔁'))?'move-swap-line':'')))}">${esc(line)}</div>`).join("")}</div>
        <button class="btn-secondary replay-btn" id="rerunBattleBtn">🎲 Run It Back</button>
      </div>
    `;
    document.getElementById("rerunBattleBtn").addEventListener("click", runAndRenderBattle);
  }
  simulateBattleBtn.addEventListener("click", runAndRenderBattle);

  // ================= REGIONS TAB (CARTRIDGES) =================
  const cartGrid = document.getElementById("cartGrid");
