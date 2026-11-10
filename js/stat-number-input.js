"use strict";

// ================= TAP-TO-TYPE STATS (works on every .stat-field slider) =================
// The stat sliders are hard to use on a phone and stop at 150. This lets you TAP THE NUMBER next to a slider and type
// the exact value instead (numeric keypad on phones). Enter / tapping elsewhere confirms, Esc cancels.
//  · Typed values can go up to MAX_STAT; the slider's own maximum grows to match (never below 150), so the slider
//    still lines up with the number. Reset / load code that sets a value above 150 also raises the max automatically.
//  · It goes through the slider's normal "input" event, so statValues / statVals in ui-form-handler.js update exactly
//    as if you had dragged the slider — no other file needs to change. Covers the main form, Mega profiles and
//    Change Form effects, including rows that are created later.
(function () {
  if (window.__statNumberInputInstalled) return;
  window.__statNumberInputInstalled = true;

  const MIN_STAT = 1, MAX_STAT = 999, BASE_MAX = 150;
  const VAL_SEL = ".stat-field .val";
  const rangeOf = val => { const f = val.closest(".stat-field"); return f && f.querySelector('input[type="range"]'); };

  // Keep the slider's scale in step with the number shown (raises past 150, drops back to 150 on reset).
  function syncMax(val) {
    if (val.querySelector("input")) return;                 // mid-edit
    const r = rangeOf(val); if (!r) return;
    const n = Number(String(val.textContent).trim());
    if (isNaN(n) || val.textContent.trim() === "") return;
    const want = Math.max(BASE_MAX, Math.round(n));
    if (Number(r.max) !== want) { r.max = want; r.value = n; }
  }
  function upgrade(val) {
    if (val.dataset.statTap === "1") return;
    val.dataset.statTap = "1";
    val.tabIndex = 0;
    val.setAttribute("role", "button");
    val.title = "Tap to type a value";
    syncMax(val);
  }
  function upgradeAll(root) {
    if (!root || !root.querySelectorAll) return;
    if (root.matches && root.matches(VAL_SEL)) upgrade(root);
    root.querySelectorAll(VAL_SEL).forEach(upgrade);
  }

  function startEdit(val) {
    if (val.querySelector("input")) return;
    const r = rangeOf(val); if (!r) return;
    const cur = val.textContent.trim();
    const inp = document.createElement("input");
    inp.type = "text"; inp.inputMode = "numeric"; inp.pattern = "[0-9]*"; inp.maxLength = 3;
    inp.className = "val-edit"; inp.value = cur; inp.setAttribute("aria-label", "Stat value");
    inp.autocomplete = "off";
    val.textContent = ""; val.appendChild(inp); val.classList.add("editing");
    inp.focus(); try { inp.select(); } catch (e) { }

    let done = false;
    function finish(commit) {
      if (done) return; done = true;
      const raw = inp.value.replace(/\D/g, "");
      inp.remove(); val.classList.remove("editing"); val.textContent = cur;
      if (commit && raw !== "") {
        const n = Math.max(MIN_STAT, Math.min(MAX_STAT, parseInt(raw, 10)));
        r.max = Math.max(BASE_MAX, n); r.value = n;
        r.dispatchEvent(new Event("input", { bubbles: true }));   // the existing listener updates statValues + the label
        r.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    inp.addEventListener("input", () => { const c = inp.value.replace(/\D/g, ""); if (c !== inp.value) inp.value = c; });
    inp.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
      else if (e.key === "Tab") finish(true);
    });
    inp.addEventListener("blur", () => finish(true));
  }

  document.addEventListener("click", e => {
    const val = e.target && e.target.closest && e.target.closest(VAL_SEL);
    if (val) { e.preventDefault(); startEdit(val); }
  });
  document.addEventListener("keydown", e => {
    if ((e.key === "Enter" || e.key === " ") && e.target && e.target.matches && e.target.matches(VAL_SEL)) { e.preventDefault(); startEdit(e.target); }
  });

  new MutationObserver(muts => {
    muts.forEach(m => {
      if (m.type === "characterData") { const p = m.target.parentElement; if (p && p.matches(VAL_SEL)) syncMax(p); return; }
      if (m.target.matches && m.target.matches(VAL_SEL)) syncMax(m.target);
      m.addedNodes.forEach(n => { if (n.nodeType === 1) upgradeAll(n); });
    });
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  upgradeAll(document.body);
})();
