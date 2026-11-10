"use strict";

  // ================= OWNERSHIP HELPER =================
  // Shared by ui-form-handler.js / ui-dex-renderer.js (classic scripts, no
  // import) to check if the logged-in user may edit/delete a given entry
  // or item. Delegates to cloud-sync.js's real check; defaults to false
  // if that module hasn't loaded yet for any reason.
  function canManageRecord(record){
    return !!(window.CloudSync && window.CloudSync.canManageRecord(record));
  }
  function isAdmin(){
    return !!(window.userProfile && window.userProfile.isAdmin);
  }

  // ================= THEME =================
  const themeCards = document.querySelectorAll(".theme-card");
  function applyTheme(theme){
    document.documentElement.setAttribute("data-theme", theme);
    themeCards.forEach(card=> card.classList.toggle("active", card.dataset.theme===theme));
    try{ localStorage.setItem(THEME_KEY, theme); }catch(e){}
  }
  themeCards.forEach(card=> card.addEventListener("click", ()=>applyTheme(card.dataset.theme)));
  (function initTheme(){ let saved="dark"; try{ saved = localStorage.getItem(THEME_KEY) || "dark"; }catch(e){} applyTheme(saved); })();

  // ================= TABS + ROUTER =================
  const tabButtons = document.querySelectorAll(".tabs button");
  tabButtons.forEach(btn=>{
    btn.addEventListener("click", ()=>{
      activeTabName = btn.dataset.tab;
      if(location.hash) location.hash = ""; else updateViewVisibility();
    });
  });
  document.getElementById("detailBackBtn").addEventListener("click", ()=>{ location.hash = ""; });

  function updateViewVisibility(){
    document.querySelectorAll(".view").forEach(v=>v.classList.remove("active"));
    const m = location.hash.match(/^#\/dex\/(\d+)$/);
    if(m){
      const entry = entries.find(e=>e.id===Number(m[1]));
      if(entry){
        document.getElementById("view-detail").classList.add("active");
        populateDetailPage(entry);
        window.scrollTo(0,0);
        return;
      }
    }
    // Virtual Mega/Form entries: rebuilt fresh from the live base entry + profile on every visit, so the
    // page can never go stale relative to edits made in the base entry's editor.
    const vm = location.hash.match(/^#\/dex\/mega-(\d+)-(.+)$/);
    if(vm){
      const baseEntry = entries.find(e=>e.id===Number(vm[1]));
      const mg = baseEntry && (baseEntry.megas||[]).find(x=>x.id===vm[2] && x.enabled);
      if(baseEntry && mg){
        document.getElementById("view-detail").classList.add("active");
        populateDetailPage(buildVirtualMegaEntry(baseEntry, mg));
        window.scrollTo(0,0);
        return;
      }
    }
    tabButtons.forEach(b=>b.classList.toggle("active", b.dataset.tab===activeTabName));
    document.getElementById("view-"+activeTabName).classList.add("active");
    if(activeTabName==="regions") renderCartridges();
    if(activeTabName==="battle"){ populateFighterSelects(); populateItemSelects(); }
    if(activeTabName==="items") renderItemGrid();
    if(activeTabName==="movedex") renderMoveDex();
    if(activeTabName==="abilitydex") renderAbilityDex();
  }
  window.addEventListener("hashchange", updateViewVisibility);

  // ================= FORM: TYPE GRID / EMOJI / STATS =================
  const typeGrid = document.getElementById("typeGrid");
  let selectedTypes = [];
  TYPES.forEach(t=>{
    if(t===FANMADE_TYPE_LIST[0]) typeGrid.appendChild(fanmadeTypesHeaderEl());
    const label = document.createElement("label");
    label.className = "type-check";
    label.dataset.type = t;
    if(FANMADE_TYPES[t]) label.title = typeCreditTitle(t);
    label.innerHTML = `<input type="checkbox" value="${t}"> ${t}`;
    label.addEventListener("click", (ev)=>{
      ev.preventDefault();
      const idx = selectedTypes.indexOf(t);
      if(idx>-1){ selectedTypes.splice(idx,1); } else { if(selectedTypes.length>=2) return; selectedTypes.push(t); }
      renderTypeGrid();
    });
    typeGrid.appendChild(label);
  });
  function renderTypeGrid(){
    [...typeGrid.children].forEach(el=>{
      const t = el.dataset.type; const on = selectedTypes.includes(t);
      el.classList.toggle("picked", on);
      el.style.background = on ? `var(--t-${t})` : "";
      el.style.borderColor = on ? `var(--t-${t})` : "";
    });
  }

  const emojiRow = document.getElementById("emojiRow");
  let selectedEmoji = EMOJIS[0];
  EMOJIS.forEach(em=>{
    const d = document.createElement("div"); d.className = "emoji-choice"; d.textContent = em;
    d.addEventListener("click", ()=>{ selectedEmoji = em; renderEmojiRow(); });
    emojiRow.appendChild(d);
  });
  function renderEmojiRow(){ [...emojiRow.children].forEach(el=>{ el.classList.toggle("picked", el.textContent === selectedEmoji); }); }

  // ================= MULTI-MEGA EVOLUTION REPEATER (types / emoji / stats mirror the base pickers) =================
  // One entry can now carry several independent Mega profiles (Mega X, Mega Y, Regional Mega, etc.), each
  // rendered as its own collapsible .dyn-row — the exact same repeater pattern as the Ability/Move panels.
  const megaProfilesEl = document.getElementById("megaProfiles");