"use strict";

  // ================= PER-FAKEMON DETAIL PAGE =================

  // miniArtHtml() is the ONE place a creature's icon gets turned into HTML —
  // detail pages, evolution tree nodes, scan cards, the dex grid, and the
  // battle fighter preview all call this instead of reading entry.imageUrl
  // or entry.icon directly. The actual "which image wins, or fall back to
  // the emoji" decision lives in resolveCreatureIcon() (js/ui-form-handler.js) —
  // change the priority order there, not here.
  function miniArtHtml(entry, cls){
    const ic = resolveCreatureIcon(entry);
    if(ic.type === "image"){
      const fallbackEmoji = esc(entry.customIconEmoji || entry.icon || "❓");
      // A picked crop/focus point overrides the default "centered, contain"
      // look with "cover, pan to that spot, zoom in" — this is what lets a
      // shared group-art URL be reused across entries while each one crops
      // to just their own creature. No focus picked → untouched default
      // (inline style stays empty, stylesheet's normal rule applies).
      const focus = ic.focus;
      const styleAttr = focus
        ? ` style="object-fit:cover;object-position:${focus.x}% ${focus.y}%;transform:scale(${focus.zoom||1});transform-origin:${focus.x}% ${focus.y}%;"`
        : "";
      return `<img src="${esc(ic.value)}" alt="${esc(entry.name)}" loading="lazy" decoding="async"${styleAttr} onerror="const p=this.parentElement; this.remove(); if(p){ const f=p.querySelector('.${cls}'); if(f) f.style.display='flex'; }"><span class="${cls}" style="display:none;">${fallbackEmoji}</span>`;
    }
    return `<span class="${cls}">${esc(ic.value)}</span>`;
  }

  function evoNodeHtml(entry, currentId){
    const isCurrent = entry.id === currentId;
    const typesDots = entry.types.map(t=>`<span style="background:var(--t-${t})"></span>`).join("");
    return `
      <div class="evo-node ${isCurrent?"is-current":""}" ${isCurrent?"":`data-nav-id="${entry.id}"`}>
        <div class="evo-node-art" style="background:${rowBg(entry)}">${miniArtHtml(entry,"art-emoji")}</div>
        <div class="evo-node-name">${esc(entry.name)}</div>
        <div class="evo-node-types">${typesDots}</div>
      </div>`;
  }

  function evoTreeHtml(node, currentId){
    const kids = childrenOf(node.id);
    let html = `<div class="evo-node-wrap">${evoNodeHtml(node, currentId)}`;
    if(kids.length){
      html += `<div class="evo-children">`;
      html += kids.map(k=>`
        <div class="evo-branch">
          <div class="evo-branch-arrow">↓ ${esc(k.preEvoMethod || "Evolves")}</div>
          ${evoTreeHtml(k, currentId)}
        </div>`).join("");
      html += `</div>`;
    }
    html += `</div>`;
    return html;
  }

  function describeAbility(a){
    a = normalizeAbility(a); // guarantees .passive/.active/.effects always exist, regardless of source/age of the data
    const lockTag = a.lockAbility ? " 🔒 Locked (uncopyable/unswappable)" : "";
    const transformTag = (a.abilityType==="passive" && a.passive.action==="transformOnEntry") ? " ✨ Transform on Entry (Imposter-style)" : "";
    if(a.abilityType === "active"){
      const cond = ACTIVE_CONDITIONS.find(c=>c[0]===a.active.condition);
      const act = ACTIVE_ACTIONS.find(c=>c[0]===a.active.action);
      // The static ACTIVE_ACTIONS label is just the category ("Boost Tag
      // Moves (Iron Fist-style...)") — it never says WHICH tag/type was
      // actually picked. Swap in the real configured value here so two
      // abilities that both use "Boost Tag Moves" but target different
      // tags (or two "Blaze"-style ones targeting different Types) read
      // as the distinct things they are, instead of identical boilerplate.
      let actLabel = act ? act[1] : "";
      if(a.active.action === "boostTagMove" && a.active.boostTagFilter){
        actLabel = `Boost Tag Moves — ${a.active.boostTagFilter}`;
      } else if(a.active.action === "boostType" && a.active.boostTypeTargets.length){
        actLabel = `Boost Type Moves — ${a.active.boostTypeTargets.map(cap).join(", ")}`;
      }
      return `Active · ${cond?cond[1]:""} → ${actLabel}${lockTag}${transformTag}`;
    }
    const trig = PASSIVE_TRIGGERS.find(t=>t[0]===a.passive.trigger);
    const filt = a.passive.filterType==="any" ? "any move" : `${cap(a.passive.filterType)}-type moves only`;
    let actLabel;
    if(a.passive.action==="multiplyDamage") actLabel = `Multiply Damage ×${a.passive.multiplier}`;
    else if(a.passive.action==="modifyStat") actLabel = `${cap(a.passive.statKey)} ${a.passive.statStage>0?"+":""}${a.passive.statStage}`;
    else { const act = PASSIVE_ACTIONS.find(c=>c[0]===a.passive.action); actLabel = act?act[1].split(" (")[0]:""; }
    return `Passive · ${trig?trig[1]:""} · ${filt} · ${actLabel}${lockTag}${transformTag}`;
  }

  // ---- Summarizes the Advanced Battle Systems mechanics (Shield reactions, Unavoidable, Speed-Scaling) a
  // move carries, for display on its card — mirrors describeAbility() above but reads a move's own fields
  // (tags / speedScaling / an effects-array "shield" node) instead of an ability's passive/active rule. ----
  function describeMove(m){
    const parts = [];
    const tagsLower = (m.tags||[]).map(t=>String(t).toLowerCase());
    if(tagsLower.includes("unavoidable") || tagsLower.includes("undodgeable")){
      parts.push("Unavoidable — bypasses the Accuracy/Dodge check entirely");
    }
    if(m.dodgeChance){
      parts.push(`Dodge Chance +${Math.round(m.dodgeChance)}% — using this move raises the user's own chance to dodge the incoming attack this round`);
    }
    if(m.speedScaling && m.speedScaling !== "none"){
      const label = m.speedScaling==="relativeFaster" ? "bonus damage the faster the user is vs. the target"
        : m.speedScaling==="relativeSlower" ? "bonus damage the slower the user is vs. the target"
        : "power scales directly with the user's own raw Speed";
      parts.push(`Speed-Scaling (${m.speedScaling}) — ${label}, factor ${m.speedScalingFactor}`);
    }
    if(m.dynamicPower && m.dynamicPower !== "none"){
      const dpLabel = m.dynamicPower==="speedFaster" ? "Base Power set by a fixed tier off the Speed ratio — faster user hits harder (Electro Ball-style)"
        : m.dynamicPower==="speedSlower" ? "Base Power computed from the Speed ratio — slower user hits harder (Gyro Ball-style)"
        : m.dynamicPower==="weightAbsolute" ? "Base Power multiplied by the user's own raw Weight (Heavy Hitter-style)"
        : "Base Power set by a fixed tier off the user/target Weight ratio (Heavy Slam-style)";
      parts.push(`Dynamic Base Power (${m.dynamicPower}) — ${dpLabel}`);
    }
    const shieldFx = (m.effects||[]).find(fx=>fx.type==="shield");
    if(shieldFx){
      const reactLabel = shieldFx.shieldReaction==="damage" ? `reflects ${shieldFx.shieldReactionValue}% of max HP onto the attacker`
        : shieldFx.shieldReaction==="status" ? `${shieldFx.shieldReactionChance}% chance to inflict ${cap(shieldFx.shieldReactionStatus)} on the attacker`
        : "no reactive trigger";
      const scope = shieldFx.shieldReactionContactOnly ? "contact hits only" : "any hit, contact or not";
      const capacity = shieldFx.shieldDuration>0 ? `${shieldFx.shieldDuration} turns` : `${shieldFx.shieldHitCapacity} hits`;
      parts.push(`Shield (${capacity}) — ${reactLabel} (${scope})`);
    }
    if((m.vsTags||[]).length){
      const vsSummary = m.vsTags.filter(vt=>vt.tag).map(vt=>`${vt.tag} ×${vt.multiplier}`).join(", ");
      if(vsSummary) parts.push(`vs Pokémon Tags — ${vsSummary}`);
    }
    return parts.join(" · ");
  }

  // "Suggest Something" only makes sense for someone ELSE's entry — suggesting a Mega/Evolution/Art to
  // yourself is a no-op, since you can just add it directly (Edit Entry / Add a Form already cover that).
  // Deliberately checked against real ownership (creatorUid), not canManageRecord()/isAdmin() — an admin
  // suggesting on someone ELSE's entry still makes sense, so only true self-suggestion is blocked here.
  function isOwnEntry(entry){
    return !!(window.currentUser && entry && entry.creatorUid === window.currentUser.uid);
  }

  // ================= SUGGESTIONS REVIEW PANEL (entry owner only) =================
  // Shows on a base entry's own detail page, visible only to that entry's creator (or an admin) —
  // lists every suggestion made on it (js/suggestions-sync.js) with Accept/Reject for pending ones.
  function suggestSummary(s){
    if(s.type === "mega") return `${esc((s.megaData&&s.megaData.name)||"Untitled form")} <span style="color:var(--slate);font-size:12px;">— Mega/Form</span>`;
    if(s.type === "evolution") return `${esc((s.evolutionDraft&&s.evolutionDraft.name)||"Untitled evolution")} <span style="color:var(--slate);font-size:12px;">— Evolution</span>`;
    if(s.type === "art") return `Art suggestion <span style="color:var(--slate);font-size:12px;">— Pixel/Artwork links</span>`;
    return "Suggestion";
  }
  function suggestionsPanelHtml(entry){
    if(!canManageRecord(entry)) return "";
    const list = (window.suggestionsByEntry && window.suggestionsByEntry[entry.id]) || [];
    if(!list.length) return "";
    const pending = list.filter(s=>s.status==="pending");
    const decided = list.filter(s=>s.status!=="pending");
    const row = (s)=>`
      <div class="ability-row" style="padding:10px 12px;" data-suggestion-id="${esc(s.id)}">
        <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap;">
          <div>
            <b>${suggestSummary(s)}</b>
            <div style="color:var(--slate);font-size:12px;">by ${esc(s.authorName||"a trainer")}${s.note ? ` — "${esc(s.note)}"` : ""}</div>
          </div>
          ${s.status==="pending" ? `
            <div style="display:flex;gap:6px;">
              <button type="button" class="btn-secondary suggestion-accept-btn" data-id="${esc(s.id)}">Accept</button>
              <button type="button" class="btn-danger suggestion-reject-btn" data-id="${esc(s.id)}">Reject</button>
            </div>` : `<span class="move-status-pill" style="text-transform:capitalize;">${esc(s.status)}</span>`
          }
        </div>
      </div>`;
    return `
      <div class="d-section">
        <div class="d-section-head"><h4>Suggestions${pending.length ? ` (${pending.length} pending)` : ""}</h4></div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${pending.map(row).join("")}
          ${decided.map(row).join("")}
        </div>
      </div>`;
  }
  function wireSuggestionsPanel(entry){
    document.querySelectorAll(".suggestion-accept-btn").forEach(btn=>{
      btn.addEventListener("click", async ()=>{
        const s = ((window.suggestionsByEntry && window.suggestionsByEntry[entry.id]) || []).find(x=>x.id===btn.dataset.id);
        if(!s) return;
        btn.disabled = true;
        try{
          await window.SuggestionsSync.acceptSuggestion(s);
        }catch(err){
          console.error("❌ Error accepting suggestion:", err);
          alert(err.message || "Couldn't accept this suggestion.");
          btn.disabled = false;
        }
      });
    });
    document.querySelectorAll(".suggestion-reject-btn").forEach(btn=>{
      btn.addEventListener("click", async ()=>{
        const s = ((window.suggestionsByEntry && window.suggestionsByEntry[entry.id]) || []).find(x=>x.id===btn.dataset.id);
        if(!s) return;
        btn.disabled = true;
        try{
          await window.SuggestionsSync.rejectSuggestion(s);
        }catch(err){
          console.error("❌ Error rejecting suggestion:", err);
          alert(err.message || "Couldn't reject this suggestion.");
          btn.disabled = false;
        }
      });
    });
  }
  // ============================================================

  function populateDetailPage(entry){
    const region = regionById(entry.regionId);
    // For a Mega/Form's virtual entry, ownership is decided by the REAL base
    // entry, not the virtual one — buildVirtualMegaEntry() merges a bunch of
    // computed fields together and there's no guarantee creatorUid survives
    // that merge intact. Looking the base entry up directly here means the
    // edit button's permission check can never be fooled by that, even if
    // the merge logic changes later.
    const megaBaseEntry = entry.isVirtualMega ? entries.find(e=>e.id===entry.baseEntryId) : null;
    const typesHtml = entry.types.map(t=>`<span class="type-pill" style="background:var(--t-${t})">${cap(t)}</span>`).join("");
    const statTotal = STAT_KEYS.reduce((s,[k])=>s+((entry.stats&&entry.stats[k])||0),0);
    // Bars are scaled to 150 like before, but if any stat of THIS entry is higher (stats can now be typed in above 150),
    // the scale grows to that stat so a 200 and a 150 no longer both fill the bar completely.
    const statBarMax = Math.max(150, ...STAT_KEYS.map(([k])=>(entry.stats&&entry.stats[k])||0));
    const statsHtml = STAT_KEYS.map(([key,label])=>{
      const v = (entry.stats && entry.stats[key]) || 0;
      const pct = Math.min(100, (v/statBarMax)*100);
      return `<div class="stat-bar-row"><label>${label}</label><div class="stat-bar-track"><div class="stat-bar-fill" data-w="${pct}"></div></div><div class="stat-bar-num">${v}</div></div>`;
    }).join("");

    const abilities = (entry.abilities||[]).map(normalizeAbility);
    const abilitiesHtml = abilities.length
      ? abilities.map(a=>`
          <details class="ability-row">
            <summary>${esc(a.name)} ${a.hidden?`<span class="ability-hidden-tag">Hidden</span>`:""}</summary>
            <p class="ability-desc ${a.desc?"":"empty"}">${a.desc?esc(a.desc):"No description logged yet."}</p>
            <p class="ability-rule-tag">⚙ ${esc(describeAbility(a))}</p>
          </details>`).join("")
      : `<p class="detail-desc" style="margin:0;">No abilities logged yet.</p>`;

    const moves = entry.moves||[];
    const movesHtml = moves.length
      ? `<div class="move-list">${moves.map(m=>{
          const mechTags = (m.tags||[]).filter(t=>["unavoidable","undodgeable","shield","barrier"].includes(String(t).toLowerCase()));
          const mechSummary = describeMove(m);
          return `
          <details class="move-row">
            <summary>
              <span class="move-name">${esc(m.name)}</span>
              <span class="move-type-pill" style="background:var(--t-${m.type})">${cap(m.type)}</span>
              <span class="move-cat">${esc(m.category)}</span>
              <span class="move-badge-row">
                ${m.level ? `<span class="move-status-pill">Lv. ${m.level}</span>` : ""}
                <span class="move-acc-pill">ACC ${Math.round((m.accuracy??1)*100)}%</span>
                <span class="move-pp-pill">PP ${m.pp??15}</span>
                ${m.dodgeChance ? `<span class="move-status-pill">DODGE +${Math.round(m.dodgeChance)}%</span>` : ""}
                ${m.statusEffect && m.statusEffect!=="none" ? `<span class="move-status-pill">${cap(m.statusEffect)}</span>` : ""}
                ${mechTags.map(t=>`<span class="move-status-pill">${esc(cap(t))}</span>`).join("")}
                ${m.speedScaling && m.speedScaling!=="none" ? `<span class="move-status-pill">Speed-Scaling</span>` : ""}
                ${m.dynamicPower && m.dynamicPower!=="none" ? `<span class="move-status-pill">Dynamic BP</span>` : ""}
              </span>
            </summary>
            <p class="move-desc">${m.desc?esc(m.desc):"No description logged yet."}</p>
            ${mechSummary ? `<p class="ability-rule-tag" style="padding:0 13px 12px;margin-top:-6px;">⚙ ${esc(mechSummary)}</p>` : ""}
          </details>`;}).join("")}</div>`
      : `<p class="detail-desc" style="margin:0;">No moves logged yet.</p>`;

    // ---- Virtual Mega/Form entries get their own simplified, read-only page: no Edit/Delete/Export/
    // Favorite (those belong to the base entry, which owns the underlying data), no evolution chain or
    // alt-forms section (those are base-entry concepts), just its own stats/types/ability/moves plus a
    // link back to the base entry it transforms from and a plain-language note on how it's triggered. ----
    if(entry.isVirtualMega){
      const baseEntry = entryById(entry.baseEntryId);
      const shareUrl = location.origin + location.pathname + "#/dex/" + entry.id;
      const cardEl = document.getElementById("detailCardContent");
      cardEl.style.setProperty("--tint", `var(--t-${entry.types[0]})`);
      cardEl.innerHTML = `
        <div class="scan-top">
          <div class="scan-id">${esc((entry.megaKind||"mega").toUpperCase())} FORM${baseEntry?" · "+esc(baseEntry.name):""}</div>
          <div class="scan-icon-wrap">${miniArtHtml(entry,"scan-emoji")}</div>
          <h3 class="scan-name">${esc(entry.name)}</h3>
          <div class="scan-cat">${esc(entry.category || "Fan Creature")}</div>
          <div class="scan-types">${typesHtml}</div>
          ${baseEntry ? `<div class="scan-variant-tag" data-nav-id="${baseEntry.id}">⬅ Base form: ${esc(baseEntry.name)}</div>` : ""}
          ${entry.isCommunityForm ? `<div class="scan-variant-tag" style="opacity:.8;">🌐 Community-submitted form by ${esc(entry.formCreatorName || "a trainer")} — not authored by ${esc(baseEntry?baseEntry.name:"the original creature")}'s creator.</div>` : ``}
          <div class="scan-variant-tag" style="opacity:.8;">Not selectable directly in Battle Setup — triggers mid-battle (${esc(entry.megaActivationLabel)}).</div>
        </div>
        <div class="detail-body">
          <div class="d-section">
            <div class="d-section-head"><h4>Species</h4></div>
            <p class="detail-desc">${entry.desc ? esc(entry.desc) : "No field notes recorded for this form yet."}</p>
          </div>
          <div class="d-section">
            <div class="d-section-head"><h4>Ability</h4><span class="d-sub">tap to expand</span></div>
            <div class="abilities">${abilitiesHtml}</div>
          </div>
          <div class="d-section">
            <div class="d-section-head"><h4>Base Stats</h4></div>
            ${statsHtml}
            <div class="stat-total-row"><span>Total</span><b>${statTotal}</b></div>
          </div>
          <div class="d-section">
            <div class="d-section-head"><h4>Moves</h4><span class="d-sub">tap to expand</span></div>
            ${movesHtml}
          </div>
          <p class="credit">Discovered &amp; logged by ${esc(entry.creator || "Anonymous")}</p>
          <div class="share-hint">This form has its own page — copy the link to share it: ${esc(shareUrl)}</div>
        </div>
        <div class="detail-footer">
          ${entry.isCommunityForm
            ? `${canManageRecord(entry) ? `<button class="btn-secondary" style="flex:1" id="editCommunityFormBtn">Edit This Form</button>
               <button class="btn-danger" id="deleteCommunityFormBtn">Delete</button>` : ``}`
            : (baseEntry && canManageRecord(baseEntry) ? `<button class="btn-secondary" style="flex:1" id="editBaseFromMegaBtn">Edit on Base Entry</button>` : ``)
          }
          ${baseEntry ? `<button class="btn-secondary" id="backToBaseBtn">⬅ Back to ${esc(baseEntry.name)}</button>` : ""}
        </div>
      `;
      requestAnimationFrame(()=>{
        document.querySelectorAll("#detailCardContent .stat-bar-fill").forEach(el=>{ el.style.width = el.dataset.w + "%"; });
      });
      cardEl.querySelectorAll("[data-nav-id]").forEach(el=>{
        el.addEventListener("click", ()=>{ location.hash = "#/dex/" + el.dataset.navId; });
      });
      if(baseEntry){
        document.getElementById("editBaseFromMegaBtn")?.addEventListener("click", ()=>{
          // Defense in depth: re-check here too, not just at render time —
          // this is the check that actually stops the "edit the base entry
          // from the mega page" bypass, the button not existing is just the
          // visible symptom of it.
          if(!canManageRecord(baseEntry)){ alert("You can only edit creatures you created."); return; }
          openEdit(baseEntry);
        });
        document.getElementById("backToBaseBtn").addEventListener("click", ()=>{ location.hash = "#/dex/" + baseEntry.id; });
      }
      document.getElementById("editCommunityFormBtn")?.addEventListener("click", ()=>{
        if(!canManageRecord(entry)){ alert("You can only edit forms you created."); return; }
        // Pull the RAW saved form doc, not this merged/computed virtual entry — the virtual entry has
        // already flattened away fields the editor needs back (raw activation object, duration/cooldown,
        // transformVerb, etc.) to build a battle-ready creature, not to repopulate a form for editing.
        const raw = ((window.communityForms && window.communityForms[entry.baseEntryId]) || []).find(f=>f.id===entry.megaId);
        openFormEditor(entry.baseEntryId, raw);
      });
      document.getElementById("deleteCommunityFormBtn")?.addEventListener("click", async ()=>{
        if(!canManageRecord(entry)){ alert("You can only delete forms you created."); return; }
        if(!confirm(`Delete this form ("${entry.name}")? This can't be undone.`)) return;
        try{
          await window.FormsSync.deleteForm(entry.baseEntryId, entry.megaId, entry.creatorUid);
          await window.FormsSync.loadAllForms();
          location.hash = "#/dex/" + entry.baseEntryId;
        }catch(err){
          console.error("❌ Error deleting form:", err);
          alert(err.message || "Couldn't delete this form.");
        }
      });
      return;
    }

    // evolution family: walk up to the root ancestor, then build the tree back down
    let root = entry;
    while(root.preEvo!=null && entryById(root.preEvo)) root = entryById(root.preEvo);
    const hasFamily = root.id !== entry.id || childrenOf(entry.id).length > 0;
    const evoHtml = hasFamily
      ? `<div class="evo-tree">${evoTreeHtml(root, entry.id)}</div>`
      : `<div class="evo-empty-note">This creature has no logged pre-evolutions or evolutions yet.</div>`;

    // alternate / regional forms
    const altForms = variantSiblingsOf(entry);
    const altFormsHtml = altForms.length
      ? `<div class="alt-forms-grid">${altForms.map(f=>{
          const r = regionById(f.regionId);
          return `
            <div class="evo-node" data-nav-id="${f.id}" style="width:auto;">
              <div class="evo-node-art" style="background:${rowBg(f)}">${miniArtHtml(f,"art-emoji")}</div>
              <div class="evo-node-name">${esc(f.name)}</div>
              <div class="evo-node-types">${f.types.map(t=>`<span style="background:var(--t-${t})"></span>`).join("")}</div>
              ${r?`<div style="font-size:9.5px;color:var(--slate);font-family:'IBM Plex Mono',monospace;">${esc(r.name)}</div>`:""}
            </div>`;
        }).join("")}</div>`
      : `<div class="evo-empty-note">No alternate or regional forms logged yet.</div>`;

    const tagMatchups = entry.tagMatchups || [];
    const tagMatchupsHtml = tagMatchups.length
      ? `<div class="move-badge-row" style="flex-wrap:wrap;gap:6px;">${tagMatchups.map(tm=>{
          const label = tm.multiplier===0 ? "Immune" : tm.multiplier>1 ? `Weak ×${tm.multiplier}` : tm.multiplier<1 ? `Resists ×${tm.multiplier}` : `×${tm.multiplier}`;
          return `<span class="move-status-pill">[${esc(tm.tag)}] ${label}</span>`;
        }).join("")}</div>`
      : `<p class="detail-desc" style="margin:0;">No tag matchups logged yet.</p>`;

    const shareUrl = location.origin + location.pathname + "#/dex/" + entry.id;
    const cardEl = document.getElementById("detailCardContent");
    cardEl.style.setProperty("--tint", `var(--t-${entry.types[0]})`);
    const baseEntry = entry.variantOf!=null ? entryById(entry.variantOf) : null;

    cardEl.innerHTML = `
      <div class="scan-top">
        <button class="scan-fav-btn ${isFavorite(entry.id)?"is-fav":""}" id="detailFavBtn" title="${isFavorite(entry.id)?"Remove from My Dex":"Add to My Dex"}">${isFavorite(entry.id)?"★":"☆"}</button>
        <div class="scan-id">NO. ${pad(entry.id)} · ${region ? esc(region.name) : "Unfiled"}</div>
        <div class="scan-icon-wrap">${miniArtHtml(entry,"scan-emoji")}</div>
        <h3 class="scan-name">${esc(entry.name)}</h3>
        <div class="scan-cat">${esc(entry.category || "Fan Creature")}</div>
        <div class="scan-types">${typesHtml}</div>
        ${baseEntry ? `<div class="scan-variant-tag" data-nav-id="${baseEntry.id}">Variant of ${esc(baseEntry.name)}</div>` : ""}
      </div>
      <div class="detail-body">
        <div class="d-section">
          <div class="d-section-head"><h4>Species</h4></div>
          <p class="detail-desc">${entry.desc ? esc(entry.desc) : "No field notes recorded for this entry yet."}</p>
          <div class="meta-row">
            <div class="meta-item"><span>Height</span><b>${entry.height || 0} m</b></div>
            <div class="meta-item"><span>Weight</span><b>${entry.weight || 0} kg</b></div>
            <div class="meta-item"><span>Rarity</span><b style="text-transform:capitalize">${entry.rarity}</b></div>
          </div>
        </div>

        <div class="d-section">
          <div class="d-section-head"><h4>Abilities</h4><span class="d-sub">tap to expand</span></div>
          <div class="abilities">${abilitiesHtml}</div>
        </div>

        <div class="d-section">
          <div class="d-section-head"><h4>Base Stats</h4></div>
          ${statsHtml}
          <div class="stat-total-row"><span>Total</span><b>${statTotal}</b></div>
        </div>

        <div class="d-section">
          <div class="d-section-head"><h4>Moves</h4><span class="d-sub">tap to expand</span></div>
          ${movesHtml}
        </div>

        <div class="d-section">
          <div class="d-section-head"><h4>Tag Matchups</h4><span class="d-sub">always active, no Ability needed</span></div>
          ${tagMatchupsHtml}
        </div>

        <div class="d-section">
          <div class="d-section-head"><h4>Evolution Chain</h4></div>
          ${evoHtml}
        </div>

        <div class="d-section">
          <div class="d-section-head"><h4>Alternative Forms</h4></div>
          ${altFormsHtml}
        </div>

        ${(entry.artCredits && entry.artCredits.length) ? `<p class="credit" style="margin-top:-8px;">Art by ${entry.artCredits.map(c=>esc(c.name)).join(", ")}</p>` : ``}
        <p class="credit">Discovered &amp; logged by ${esc(entry.creator || "Anonymous")}</p>
        <div class="share-hint">This entry has its own page — copy the link to share it: ${esc(shareUrl)}</div>

        ${!entry.isVirtualMega ? suggestionsPanelHtml(entry) : ``}
      </div>
      <div class="detail-footer">
        ${entry.isVirtualMega
          ? (canManageRecord(megaBaseEntry) ? `<button class="btn-secondary" style="flex:1" id="editBaseEntryBtn">Edit Base Entry's Mega Profiles</button>` : ``)
          : (canManageRecord(entry) ? `<button class="btn-secondary" style="flex:1" id="editEntryBtn">Edit Entry</button>` : ``)
        }
        ${!entry.isVirtualMega && window.currentUser ? `<button class="btn-secondary" id="addFormBtn">＋ Add a Form</button>` : ``}
        ${(!entry.isVirtualMega && window.currentUser && !isOwnEntry(entry)) ? `<button class="btn-secondary" id="suggestBtn">💡 Suggest Something</button>` : ``}
        <button class="btn-secondary" id="exportEntryBtn">⬇ Export</button>
        ${(!entry.isVirtualMega && canManageRecord(entry)) ? `<button class="btn-danger" id="deleteEntryBtn">Delete</button>` : ``}
      </div>
    `;
    requestAnimationFrame(()=>{
      document.querySelectorAll("#detailCardContent .stat-bar-fill").forEach(el=>{ el.style.width = el.dataset.w + "%"; });
    });
    cardEl.querySelectorAll("[data-nav-id]").forEach(el=>{
      el.addEventListener("click", ()=>{ location.hash = "#/dex/" + el.dataset.navId; });
    });
    document.getElementById("suggestBtn")?.addEventListener("click", ()=>{
      // Re-check here too, not just at render time — the button not existing for your own entry is just
      // the visible symptom of this, not the actual guard.
      if(isOwnEntry(entry)){ alert("This is your own entry — you can add this directly instead of suggesting it."); return; }
      window.openSuggestModal(entry.id);
    });
    wireSuggestionsPanel(entry);
    document.getElementById("editEntryBtn")?.addEventListener("click", ()=>{ openEdit(entry); });
    document.getElementById("addFormBtn")?.addEventListener("click", ()=>{ openFormEditor(entry.id); });
    document.getElementById("editBaseEntryBtn")?.addEventListener("click", ()=>{
      // A Mega/Form view is a virtual, computed-on-the-fly entry (see
      // buildVirtualMegaEntry) — it has no row of its own to edit. Its
      // stats/moves/etc. only exist as an override profile living on the
      // REAL base entry. So this intentionally opens the base entry's own
      // edit form (never the virtual one) and jumps to its Mega Profiles
      // section, instead of silently editing the base entry while looking
      // like it's just editing "the mega."
      const baseEntry = entries.find(e=>e.id===entry.baseEntryId);
      if(!baseEntry){ alert("Couldn't find this form's base entry."); return; }
      // Re-check ownership here too, not just when the button was drawn —
      // this is what actually stops the "edit the base entry from the mega
      // page" bypass, rather than relying on the button simply not existing.
      if(!canManageRecord(baseEntry)){ alert("You can only edit creatures you created."); return; }
      openEdit(baseEntry);
      requestAnimationFrame(()=>{
        const megaSection = document.getElementById("megaProfiles")?.closest("details");
        if(megaSection){ megaSection.open = true; megaSection.scrollIntoView({ behavior:"smooth", block:"start" }); }
      });
    });
    document.getElementById("detailFavBtn").addEventListener("click", (ev)=>{
      toggleFavorite(entry.id);
      const nowFav = isFavorite(entry.id);
      ev.currentTarget.classList.toggle("is-fav", nowFav);
      ev.currentTarget.textContent = nowFav ? "★" : "☆";
      ev.currentTarget.title = nowFav ? "Remove from My Dex" : "Add to My Dex";
    });
    document.getElementById("exportEntryBtn").addEventListener("click", ()=>{
      const payload = { fielddex_entry: true, version: 1, exportedAt: new Date().toISOString(), region: region ? region.name : null, entry };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${entry.name.toLowerCase().replace(/[^a-z0-9]+/g,"-")}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
    document.getElementById("deleteEntryBtn")?.addEventListener("click", async ()=>{
      if(!canManageRecord(entry)){ alert("You can only delete entries you created."); return; }
      if(confirm(`Remove ${entry.name} from the registry? This can't be undone.`)){
        try {
          if (window.CloudSync) {
            await window.CloudSync.deleteEntryFromCloud(entry);
            console.log(`✅ Deleted entry ${entry.name} from Firestore`);
          }
        } catch (err) {
          console.error("❌ Error deleting from Firestore:", err);
        }

        // Remove locally and refresh UI
        entries = entries.filter(e=>e.id!==entry.id);
        // unlink anything that referenced this entry so the app never points at a ghost id
        entries = entries.map(e=>({
          ...e,
          preEvo: e.preEvo===entry.id ? null : e.preEvo,
          preEvoMethod: e.preEvo===entry.id ? "" : e.preEvoMethod,
          variantOf: e.variantOf===entry.id ? null : e.variantOf
        }));
        if (typeof saveEntries === "function") saveEntries(entries);
        if (typeof favorites !== "undefined" && favorites.delete) {
          favorites.delete(entry.id); saveFavorites();
        }
        location.hash = "";
        renderAll();
      }
    });
  }

  // ================= COMPLETE DEX: FILTER / SEARCH / SORT / RENDER =================
  const searchInput = document.getElementById("searchInput");
  searchInput.addEventListener("input", renderGrid);

  function getFiltered(){
    const q = searchInput.value.trim().toLowerCase();
    let list = entries.filter(e=>{
      const matchesQ = !q || e.name.toLowerCase().includes(q) || (e.creator||"").toLowerCase().includes(q);
      const matchesType = !filters.type || e.types.includes(filters.type);
      const matchesRarity = !filters.rarity || e.rarity === filters.rarity;
      const matchesRegion = !filters.region || e.regionId === filters.region;
      return matchesQ && matchesType && matchesRarity && matchesRegion;
    });
    if(filters.sort==="name") list.sort((a,b)=>a.name.localeCompare(b.name));
    else if(filters.sort==="power") list.sort((a,b)=>powerOf(b)-powerOf(a));
    else list.sort((a,b)=>a.id-b.id);
    return list;
  }

  const gridEl = document.getElementById("grid");
  const gridFavEl = document.getElementById("gridFav");

  function rowCardHtml(e){
    const region = regionById(e.regionId);
    const typesHtml = e.types.map(t=>`<span class="row-type-pill">${t}</span>`).join("");
    // Single source of truth for icon rendering — see miniArtHtml() up top.
    const artHtml = miniArtHtml(e, "art-emoji");
    // Virtual Mega/Form rows: same card shell, but no favorite star (favoriting belongs to the base
    // entry) and a badge in place of the region/rarity line making clear it's an alternate form, not a
    // separately battle-selectable creature.
    if(e.isVirtualMega){
      return `
        <div class="dex-row" data-id="${esc(e.id)}" style="background:${rowBg(e)};color:${rowTextColor(e)}">
          <div class="row-id">${esc((e.megaKind||"mega").toUpperCase())} FORM</div>
          <div class="row-name">${esc(e.name)}</div>
          <div class="row-types">${typesHtml}</div>
          <div class="row-meta"><span class="row-rarity-badge">alt form</span><span>not battle-selectable</span></div>
          <div class="row-art">${artHtml}</div>
        </div>`;
    }
    const fav = isFavorite(e.id);
    return `
      <div class="dex-row" data-id="${e.id}" style="background:${rowBg(e)};color:${rowTextColor(e)}">
        <button class="fav-btn ${fav?"is-fav":""}" data-fav-id="${e.id}" title="${fav?"Remove from My Dex":"Add to My Dex"}">${fav?"★":"☆"}</button>
        <div class="row-id">No. ${pad(e.id)}${region ? " · "+esc(region.name) : ""}</div>
        <div class="row-name">${esc(e.name)}</div>
        <div class="row-types">${typesHtml}</div>
        <div class="row-meta"><span class="row-rarity-badge">${e.rarity}</span><span>by ${esc(e.creator || "Anonymous")}</span></div>
        <div class="row-art">${artHtml}</div>
      </div>`;
  }
  function wireRowCards(container){
    container.querySelectorAll(".dex-row").forEach(row=>{
      row.addEventListener("click", ()=>{ location.hash = "#/dex/" + row.dataset.id; });
    });
    container.querySelectorAll(".fav-btn").forEach(btn=>{
      btn.addEventListener("click", (ev)=>{
        ev.stopPropagation();
        toggleFavorite(btn.dataset.favId);
        renderGrid();
      });
    });
  }

  function renderGrid(){
    const list = getFiltered();
    if(list.length===0){
      gridEl.innerHTML = `<div class="empty"><h3>No creatures match this scan</h3><p>Try clearing filters, or log the first entry yourself.</p><button class="btn-new" id="emptyAddBtn">＋ Log New Creature</button></div>`;
      document.getElementById("emptyAddBtn").addEventListener("click", ()=>openAdd());
      return;
    }
    // Each base entry's enabled Mega/Form profiles ride along right after it as their own inspectable
    // (but non-battle-selectable) cards — see buildVirtualMegaEntry.
    const expanded = [];
    list.forEach(e=>{
      expanded.push(e);
      enabledMegasOf(e).forEach(mg=> expanded.push(buildVirtualMegaEntry(e, mg)));
    });
    gridEl.innerHTML = expanded.map(rowCardHtml).join("");
    wireRowCards(gridEl);
  }

  function renderFavGrid(){
    // The old My Dex favorites grid (#gridFav) was replaced by the Inventory & Box
    // view (js/inventory-box.js). Nothing wires a #gridFav element into the page
    // anymore, so just no-op instead of throwing on a null container.
    if(!gridFavEl) return;
    const list = entries.filter(e=>isFavorite(e.id));
    if(list.length===0){
      gridFavEl.innerHTML = `<div class="empty"><h3>No favorites yet</h3><p>Tap the ☆ on any creature to add it to My Dex.</p></div>`;
      return;
    }
    gridFavEl.innerHTML = list.map(rowCardHtml).join("");
    wireRowCards(gridFavEl);
  }

  // ================= HEADER STAT COUNTERS =================
  // Called by renderAll() below — keeps the "Entries / Regions / Legendary" readout in the header
  // in sync with the live entries/regions arrays. Was previously never wired up anywhere: nothing
  // in the app ever touched #statTotal/#statRegions/#statLegendary, so the header sat stuck at 0
  // no matter how much data actually loaded.
  function updateHeaderStats(){
    const statTotalEl = document.getElementById("statTotal");
    const statRegionsEl = document.getElementById("statRegions");
    const statLegendaryEl = document.getElementById("statLegendary");
    if(statTotalEl) statTotalEl.textContent = entries.length;
    if(statRegionsEl) statRegionsEl.textContent = regions.length;
    if(statLegendaryEl) statLegendaryEl.textContent = entries.filter(e=>e.rarity==="legendary").length;
  }

  // ================= renderAll =================
  // Every save/delete flow across the app (creature form, item form, region form, delete handlers)
  // already calls renderAll() expecting a full refresh — but no such function was ever actually
  // defined anywhere in the codebase, so every one of those calls was throwing a silent
  // "renderAll is not defined" and quietly skipping whatever it was supposed to do. This restores it.
  function renderAll(){
    renderGrid();
    if(typeof renderFavGrid==="function") renderFavGrid();
    updateHeaderStats();
  }

  // ================= BATTLE MODE =================
  const TYPE_CHART = {
    normal:{rock:.5,ghost:0,steel:.5},
    fire:{fire:.5,water:.5,grass:2,ice:2,bug:2,rock:.5,dragon:.5,steel:2},
    water:{fire:2,water:.5,grass:.5,ground:2,rock:2,dragon:.5},
    electric:{water:2,electric:.5,grass:.5,ground:0,flying:2,dragon:.5},
    grass:{fire:.5,water:2,grass:.5,poison:.5,ground:2,flying:.5,bug:.5,rock:2,dragon:.5,steel:.5},
    ice:{fire:.5,water:.5,grass:2,ice:.5,ground:2,flying:2,dragon:2,steel:.5},
    fighting:{normal:2,ice:2,poison:.5,flying:.5,psychic:.5,bug:.5,rock:2,ghost:0,dark:2,steel:2,fairy:.5},
    poison:{grass:2,poison:.5,ground:.5,rock:.5,ghost:.5,steel:0,fairy:2},
    ground:{fire:2,electric:2,grass:.5,poison:2,flying:0,bug:.5,rock:2,steel:2},
    flying:{electric:.5,grass:2,fighting:2,bug:2,rock:.5,steel:.5},
    psychic:{fighting:2,poison:2,psychic:.5,dark:0,steel:.5},
    bug:{fire:.5,grass:2,fighting:.5,poison:.5,flying:.5,psychic:2,ghost:.5,dark:2,steel:.5,fairy:.5},
    rock:{fire:2,ice:2,fighting:.5,ground:.5,flying:2,bug:2,steel:.5},
    ghost:{normal:0,psychic:2,ghost:2,dark:.5},
    dragon:{dragon:2,steel:.5,fairy:0},
    dark:{fighting:.5,psychic:2,ghost:2,dark:.5,fairy:.5},
    steel:{fire:.5,water:.5,electric:.5,ice:2,rock:2,steel:.5,fairy:2},
    fairy:{fire:.5,fighting:2,poison:.5,dragon:2,dark:2,steel:.5}
  };
  // ================= FANMADE TYPES (Cosmic / Light / Rubber) — see FANMADE_TYPES in common.js for credits =================
  // Step 1: each fanmade type's OWN attacking row (super effective / not very effective / no effect against).
  TYPE_CHART.cosmic = { fire:2, flying:2, steel:2, fairy:2,  electric:.5, bug:.5, cosmic:.5,  ice:0 };
  TYPE_CHART.light  = { fighting:2, ghost:2, cosmic:2, dark:2,  fire:.5, water:.5, grass:.5, ice:.5 };
  TYPE_CHART.rubber = { electric:2, fighting:2, fairy:2, water:2 };
  // Step 2: how every other type hits each fanmade type (their weaknesses / resistances / immunities),
  // written defender-first so it reads like the type's info card: FANMADE_DEFENSE[defender][attacker] = multiplier.
  const FANMADE_DEFENSE = {
    cosmic: { bug:2, ghost:2, psychic:2, normal:2, light:2,  steel:.5, cosmic:.5, ground:.5, rock:.5,  fire:0 },
    light:  { water:2, grass:2, ice:2, dark:2 },
    rubber: { fire:2, ice:2, steel:2, bug:2,  fighting:.5, normal:.5, grass:.5, ground:.5, rock:.5, poison:.5, fairy:.5,  electric:0 }
  };
  Object.entries(FANMADE_DEFENSE).forEach(([def,row])=> Object.entries(row).forEach(([atk,m])=>{
    (TYPE_CHART[atk] = TYPE_CHART[atk] || {})[def] = m;
  }));
  function renderItemGrid(){
    const cards = items.map(it=>{
      const effSummary = (it.effects||[]).map(e=> e.action==="none" ? "No Effect" : `${esc(e.trigger)}→${esc(e.action)}`).join(", ");
      const immuneOn = Object.entries(it.immunities||{}).filter(([k,v])=>v).map(([k])=>k);
      const mu = Number(it.maxUses)||0;
      const hasFlavor = it.flavor && it.flavor!=="none";
      return `
      <div class="item-card" data-id="${esc(it.id)}">
        <div class="item-name">${esc(it.name)}</div>
        <div class="item-meta">
          <span>${esc(it.type)}</span>
          <span>${mu>0 ? `${mu} use${mu===1?"":"s"}/battle` : "unlimited uses"}</span>
          ${hasFlavor ? `<span>flavor: ${esc(it.flavor)}</span>` : ""}
          ${effSummary ? `<span>${effSummary}</span>` : ""}
          ${immuneOn.length ? `<span>immune: ${immuneOn.map(esc).join("/")}</span>` : ""}
        </div>
        <div class="item-desc">${esc(it.desc || "")}</div>
        ${canManageRecord(it) ? `
        <div class="item-card-actions">
          <button type="button" class="item-edit-btn" data-id="${esc(it.id)}">Edit</button>
          <button type="button" class="item-del-btn" data-id="${esc(it.id)}">Delete</button>
        </div>` : ``}
      </div>
    `;}).join("");
    itemGrid.innerHTML = cards + `<div class="item-card new-item-card" id="newItemBtn"><div class="new-cart-plus">＋</div><div>New Item</div></div>`;

    itemGrid.querySelectorAll(".item-edit-btn").forEach(btn=>{
      btn.addEventListener("click", ()=> openItemForm(itemById(btn.dataset.id)));
    });
    itemGrid.querySelectorAll(".item-del-btn").forEach(btn=>{
      btn.addEventListener("click", async ()=>{
        const it = itemById(btn.dataset.id);
        if(!it) return;
        if(!canManageRecord(it)){ alert("You can only delete items you created."); return; }
        if(confirm(`Delete "${it.name}" from the Item Dex? Any battle setup currently using it will fall back to None.`)){
          try{
            if(window.CloudSync) await window.CloudSync.deleteItemFromCloud(it);
          }catch(err){
            console.error("❌ Error deleting item from Firestore:", err);
          }
          items = items.filter(i=>i.id!==it.id);
          saveItems(items);
          renderItemGrid();
          populateItemSelects();
        }
      });
    });
    document.getElementById("newItemBtn").addEventListener("click", ()=> openItemForm(null));
  }
  function getMoveGroups(){
    const groups = new Map();
    // Same lesson as the Ability Dex fix: hashing the FULL move object was
    // too strict. Moves carry dozens of advanced-mechanics fields (accuracy,
    // PP, dodge chance, tags, delayed-attack config, etc.), and two "Bite"
    // rows created independently for different creatures can end up with
    // tiny differences buried in those — even though every field a player
    // actually sees (name/type/category/power) is identical. That was
    // fragmenting one move into a separate duplicate card per creature that
    // knows it, instead of one card listing every learner. Grouping by just
    // the visible identity — name + type + category + base power — is what
    // "the same move" actually means for Move Dex/importer purposes.
    function moveSig(m){
      return JSON.stringify({
        name: (m.name||"").trim().toLowerCase(),
        type: m.type,
        category: m.category,
        basePower: m.basePower || 0
      });
    }
    entries.forEach(e=>{
      (e.moves||[]).forEach(m=>{
        if(!m.name) return;
        const sig = moveSig(m);
        if(!groups.has(sig)) groups.set(sig, { move:m, learners:[] });
        groups.get(sig).learners.push({ entry:e, level:m.level });
      });
      // Mega/Form Dex Integration: each profile's own Special Mega Move Slots (its unique moves, not the
      // base moves it merely carries over — those are already covered by the base entry's own moves loop
      // above) are folded into the same global grouping, attributed to that profile's virtual Dex entry
      // so the "Mons that learn this move" pill links straight to the form's own page.
      enabledMegasOf(e).forEach(mg=>{
        if(!(mg.moves||[]).length) return;
        const virtual = buildVirtualMegaEntry(e, mg);
        mg.moves.forEach(m=>{
          if(!m.name) return;
          const sig = moveSig(m);
          if(!groups.has(sig)) groups.set(sig, { move:m, learners:[] });
          groups.get(sig).learners.push({ entry:virtual, level:m.level });
        });
      });
    });
    return [...groups.values()].sort((a,b)=>a.move.name.localeCompare(b.move.name));
  }
  function getAbilityGroups(){
    const groups = new Map();
    // Two ability rows built independently (e.g. the same "Blaze" imported
    // onto several different creatures) can end up with tiny differences
    // buried in their rule-builder config even when they look completely
    // identical on screen — that was fragmenting one ability into several
    // duplicate-looking cards in the Ability Dex/importer, each showing up
    // with only itself as a "learner". Grouping by name+description instead
    // of the raw full object treats those as the same ability, which is
    // what "unique abilities" actually means to someone browsing the Dex.
    function abilitySig(a){
      return JSON.stringify({ name: (a.name||"").trim().toLowerCase(), desc: (a.desc||"").trim() });
    }
    entries.forEach(e=>{
      (e.abilities||[]).forEach(a=>{
        if(!a.name) return;
        const sig = abilitySig(a);
        if(!groups.has(sig)) groups.set(sig, { ability:a, learners:[] });
        groups.get(sig).learners.push({ entry:e, level:null });
      });
      // Mega/Form Dex Integration: a profile's dedicated Mega Ability (when it defines one) also joins
      // the global Ability Dex grouping, attributed to that profile's virtual Dex entry.
      enabledMegasOf(e).forEach(mg=>{
        if(!mg.ability || !mg.ability.name) return;
        const virtual = buildVirtualMegaEntry(e, mg);
        const sig = abilitySig(mg.ability);
        if(!groups.has(sig)) groups.set(sig, { ability:mg.ability, learners:[] });
        groups.get(sig).learners.push({ entry:virtual, level:null });
      });
    });
    return [...groups.values()].sort((a,b)=>a.ability.name.localeCompare(b.ability.name));
  }
  function monLearnPillsHtml(learners){
    const seen = new Set();
    const uniq = learners.filter(l=>{ if(seen.has(l.entry.id)) return false; seen.add(l.entry.id); return true; });
    if(!uniq.length) return `<span class="field-hint">No creatures currently carry this.</span>`;
    return uniq.map(l=>{
      const e = l.entry;
      const lvlTag = l.level ? `<span style="opacity:.7;"> · Lv.${l.level}</span>` : "";
      return `<span class="type-pill mon-learn-pill" data-goto="${e.id}" style="background:var(--t-${e.types[0]});cursor:pointer;">${esc(e.name)}${lvlTag}</span>`;
    }).join("");
  }
  function wireMonLearnPills(container){
    container.querySelectorAll(".mon-learn-pill").forEach(el=>{
      el.addEventListener("click", ()=>{ location.hash = `#/dex/${el.dataset.goto}`; });
    });
  }

  // ---- Move Dex UI ----
  let moveDexFilters = { text:"", type:"", cat:"" };
  const moveDexSearchInput = document.getElementById("moveDexSearchInput");
  const moveDexGrid = document.getElementById("moveDexGrid");
  const moveDexSummary = document.getElementById("moveDexSummary");
  const moveDexTypeChipBtn = document.getElementById("moveDexTypeChipBtn");
  const moveDexTypeChipPanel = document.getElementById("moveDexTypeChipPanel");
  const moveDexCatChipBtn = document.getElementById("moveDexCatChipBtn");
  const moveDexCatChipPanel = document.getElementById("moveDexCatChipPanel");
  function renderMoveDexTypeChipPanel(){
    let html = `<div class="chip-option ${moveDexFilters.type===""?"selected":""}" data-value="" style="margin-bottom:6px;">All Types</div><div class="type-chip-grid">`;
    html += TYPES.map(t=>`<div class="chip-option ${moveDexFilters.type===t?"selected":""}" data-value="${t}" style="background:var(--t-${t})">${t}</div>`).join("");
    html += `</div>`;
    moveDexTypeChipPanel.innerHTML = html;
    moveDexTypeChipPanel.querySelectorAll(".chip-option").forEach(el=>{
      el.addEventListener("click", ()=>{ moveDexFilters.type = el.dataset.value; closeAllPanels(); renderMoveDex(); });
    });
  }
  moveDexTypeChipBtn.addEventListener("click", stopAnd(()=>{ renderMoveDexTypeChipPanel(); togglePanel(moveDexTypeChipPanel); }));
  function renderMoveDexCatChipPanel(){
    let html = `<div class="chip-option ${moveDexFilters.cat===""?"selected":""}" data-value="">All Categories</div>`;
    html += MOVE_CATEGORIES.map(c=>`<div class="chip-option ${moveDexFilters.cat===c?"selected":""}" data-value="${c}">${c}</div>`).join("");
    moveDexCatChipPanel.innerHTML = html;
    moveDexCatChipPanel.querySelectorAll(".chip-option").forEach(el=>{
      el.addEventListener("click", ()=>{ moveDexFilters.cat = el.dataset.value; closeAllPanels(); renderMoveDex(); });
    });
  }
  moveDexCatChipBtn.addEventListener("click", stopAnd(()=>{ renderMoveDexCatChipPanel(); togglePanel(moveDexCatChipPanel); }));
  moveDexSearchInput.addEventListener("input", ()=>{ moveDexFilters.text = moveDexSearchInput.value.trim().toLowerCase(); renderMoveDex(); });
  function renderMoveDex(){
    moveDexTypeChipBtn.innerHTML = (moveDexFilters.type ? cap(moveDexFilters.type) : "All Types") + ` <span class="caret">▾</span>`;
    moveDexTypeChipBtn.classList.toggle("active-filter", !!moveDexFilters.type);
    moveDexCatChipBtn.innerHTML = (moveDexFilters.cat || "All Categories") + ` <span class="caret">▾</span>`;
    moveDexCatChipBtn.classList.toggle("active-filter", !!moveDexFilters.cat);
    let groups = getMoveGroups().filter(g=>{
      if(moveDexFilters.type && g.move.type!==moveDexFilters.type) return false;
      if(moveDexFilters.cat && g.move.category!==moveDexFilters.cat) return false;
      if(moveDexFilters.text && !g.move.name.toLowerCase().includes(moveDexFilters.text)) return false;
      return true;
    });
    moveDexSummary.textContent = `${groups.length} unique move${groups.length===1?"":"s"} across ${entries.length} creature${entries.length===1?"":"s"}.`;
    if(!groups.length){
      moveDexGrid.innerHTML = `<div class="field-hint">No moves match yet — create some from a creature's Moves list, or clear your filters.</div>`;
      return;
    }
    moveDexGrid.innerHTML = groups.map(g=>{
      const m = g.move;
      const dealsDamage = m.category==="Physical" || m.category==="Special";
      const mech = describeMove(m);
      return `
      <div class="item-card">
        <div class="item-name">${esc(m.name)} <span class="type-pill" style="background:var(--t-${m.type});font-size:11px;">${cap(m.type)}</span></div>
        <div class="item-meta">
          <span>${m.category}</span>
          ${dealsDamage ? `<span>Power ${m.basePower}</span>` : ""}
          <span>Acc ${Math.round(m.accuracy*100)}%</span>
          <span>${m.maxPP} PP</span>
          ${m.priority ? `<span>${m.priority>0?"+":""}${m.priority} Priority</span>` : ""}
        </div>
        ${m.desc ? `<div class="item-desc">${esc(m.desc)}</div>` : ""}
        ${mech ? `<div class="item-desc" style="color:var(--accent);">⚙ ${esc(mech)}</div>` : ""}
        <div class="item-meta" style="margin-top:2px;"><b style="width:100%;color:var(--slate);font-size:11px;text-transform:uppercase;letter-spacing:.04em;">Mons that learn this move</b></div>
        <div class="dyn-row-meta" style="flex-wrap:wrap;gap:6px;">${monLearnPillsHtml(g.learners)}</div>
      </div>`;
    }).join("");
    wireMonLearnPills(moveDexGrid);
  }

  // ---- Ability Dex UI ----
  let abilityDexFilters = { text:"", kind:"" };
  const abilityDexSearchInput = document.getElementById("abilityDexSearchInput");
  const abilityDexGrid = document.getElementById("abilityDexGrid");
  const abilityDexSummary = document.getElementById("abilityDexSummary");
  const abilityDexTypeChipBtn = document.getElementById("abilityDexTypeChipBtn");
  const abilityDexTypeChipPanel = document.getElementById("abilityDexTypeChipPanel");
  function renderAbilityDexKindChipPanel(){
    const kinds = [["","All Kinds"],["passive","Passive"],["active","Active"]];
    abilityDexTypeChipPanel.innerHTML = kinds.map(([v,l])=>`<div class="chip-option ${abilityDexFilters.kind===v?"selected":""}" data-value="${v}">${l}</div>`).join("");
    abilityDexTypeChipPanel.querySelectorAll(".chip-option").forEach(el=>{
      el.addEventListener("click", ()=>{ abilityDexFilters.kind = el.dataset.value; closeAllPanels(); renderAbilityDex(); });
    });
  }
  abilityDexTypeChipBtn.addEventListener("click", stopAnd(()=>{ renderAbilityDexKindChipPanel(); togglePanel(abilityDexTypeChipPanel); }));
  abilityDexSearchInput.addEventListener("input", ()=>{ abilityDexFilters.text = abilityDexSearchInput.value.trim().toLowerCase(); renderAbilityDex(); });
  function renderAbilityDex(){
    abilityDexTypeChipBtn.innerHTML = (abilityDexFilters.kind ? cap(abilityDexFilters.kind) : "All Kinds") + ` <span class="caret">▾</span>`;
    abilityDexTypeChipBtn.classList.toggle("active-filter", !!abilityDexFilters.kind);
    let groups = getAbilityGroups().filter(g=>{
      if(abilityDexFilters.kind && g.ability.abilityType!==abilityDexFilters.kind) return false;
      if(abilityDexFilters.text && !g.ability.name.toLowerCase().includes(abilityDexFilters.text)) return false;
      return true;
    });
    abilityDexSummary.textContent = `${groups.length} unique abilit${groups.length===1?"y":"ies"} across ${entries.length} creature${entries.length===1?"":"s"}.`;
    if(!groups.length){
      abilityDexGrid.innerHTML = `<div class="field-hint">No abilities match yet — create some from a creature's Abilities list, or clear your filters.</div>`;
      return;
    }
    abilityDexGrid.innerHTML = groups.map(g=>{
      const a = g.ability;
      return `
      <div class="item-card">
        <div class="item-name">${esc(a.name)} ${a.hidden?`<span class="type-pill" style="background:var(--slate-dim);font-size:11px;">Hidden</span>`:""}</div>
        <div class="item-meta"><span>${esc(describeAbility(a))}</span></div>
        ${a.desc ? `<div class="item-desc">${esc(a.desc)}</div>` : ""}
        <div class="item-meta" style="margin-top:2px;"><b style="width:100%;color:var(--slate);font-size:11px;text-transform:uppercase;letter-spacing:.04em;">Mons that learn this ability</b></div>
        <div class="dyn-row-meta" style="flex-wrap:wrap;gap:6px;">${monLearnPillsHtml(g.learners)}</div>
      </div>`;
    }).join("");
    wireMonLearnPills(abilityDexGrid);
  }
  function renderCartridges(){
    const cards = regions.map(r=>{
      const count = entries.filter(e=>e.regionId===r.id).length;
      return `
        <div class="cartridge" data-id="${r.id}" style="--c-base:${r.color.base};--c-dark:${r.color.dark};">
          ${isAdmin() ? `<button class="cart-del" data-id="${r.id}" title="Delete region">×</button>` : ``}
          <div class="cart-grip"></div>
          <div class="cart-label">
            <div class="cart-label-name">${esc(r.name)}</div>
            <div class="cart-label-sub">${esc(r.subtitle || "Untitled region")}</div>
            <div class="cart-count"><span>${count} ${count===1?"entry":"entries"}</span><span class="cart-teeth"><span></span><span></span><span></span></span></div>
          </div>
        </div>`;
    }).join("");
    cartGrid.innerHTML = cards + `<div class="cartridge new-cart" id="newCartBtn"><div class="new-cart-plus">＋</div><div class="new-cart-label">New Region</div></div>`;

    cartGrid.querySelectorAll(".cartridge[data-id]").forEach(el=>{
      el.addEventListener("click", (ev)=>{
        if(ev.target.closest(".cart-del")) return;
        const id = Number(el.dataset.id);
        filters.region = id; updateChipLabels();
        activeTabName = "complete"; location.hash = ""; updateViewVisibility();
        renderGrid();
      });
    });
    cartGrid.querySelectorAll(".cart-del").forEach(btn=>{
      btn.addEventListener("click", (ev)=>{
        ev.stopPropagation();
        // Defense in depth: re-check here too, not just at render time — the
        // button not existing for non-admins is just the visible symptom.
        if(!isAdmin()){ alert("Only an admin can delete a region."); return; }
        const id = Number(btn.dataset.id);
        const region = regionById(id);
        const count = entries.filter(e=>e.regionId===id).length;
        // A region can NEVER take its entries down with it — no confirm dialog
        // is worth the risk of one click wiping out other people's work. Move
        // or delete the entries individually first (each already has its own
        // owner-gated delete), then the now-empty region can go.
        if(count>0){
          alert(`"${region.name}" still has ${count} ${count===1?"entry":"entries"} in it. Move or delete ${count===1?"it":"them"} individually first — deleting a region can never take its entries down with it.`);
          return;
        }
        if(confirm(`Delete empty region "${region.name}"? This can't be undone.`)){
          regions = regions.filter(r=>r.id!==id);
          saveRegions(regions);
          if(filters.region===id){ filters.region=""; updateChipLabels(); }
          renderAll(); renderCartridges();
        }
      });
    });
    document.getElementById("newCartBtn").addEventListener("click", openRegionForm);
  }