"use strict";

// ================= SEARCHABLE SELECT (styled dropdown for EVERY <select>) =================
// How it works: the native <select> stays in the page, keeps its own layout / theme classes and keeps working for
// all existing code (.value, .selectedIndex, .options, "change" listeners, innerHTML re-population, cloning…).
// We only intercept the click / keyboard open of the native list and show our own panel instead:
//   · a search box (shown when the list has SEARCH_MIN_OPTIONS or more options)
//   · highlighted matches, optgroup headings, disabled options, a ✓ on the current value
//   · keyboard: ↑ ↓ Home End PageUp PageDown, Enter to pick, Esc to close, Tab to close
//   · phones: opens as a bottom sheet so the keyboard / thumbs have room
// Event delegation means selects created later (modals, repeaters, cloud-synced pickers) are picked up for free.
//
// Options:  <select data-native>              → keep the browser's own dropdown for this one
//           <select data-ss-search="never">   → styled panel but no search box
//           <select data-ss-search="always">  → search box even for short lists
(function () {
  if (window.__searchableSelectInstalled) return;
  window.__searchableSelectInstalled = true;

  const SEARCH_MIN_OPTIONS = 8;   // lists shorter than this get the styled panel without a search box
  const MAX_RENDERED = 400;       // very long lists render the first N matches (the search narrows the rest)

  const isEnhanceable = el =>
    el && el.tagName === "SELECT" && !el.multiple && !(el.size > 1) && !el.hasAttribute("data-native") && !el.disabled;

  let ui = null; // the one open panel: { select, panel, input, list, backdrop, items, active, sheet }

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = s => String(s == null ? "" : s).toLowerCase();
  const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // ---------- read the select's options (fresh every time it opens, so dynamic lists are always current) ----------
  function readOptions(select) {
    const out = [];
    Array.from(select.children).forEach(node => {
      if (node.tagName === "OPTGROUP") {
        const group = node.label || "";
        Array.from(node.children).forEach(o => { if (o.tagName === "OPTION") out.push(toItem(o, group)); });
      } else if (node.tagName === "OPTION") out.push(toItem(node, ""));
    });
    return out;
  }
  function toItem(o, group) {
    return {
      index: o.index, label: (o.textContent || "").trim() || o.value || "—", value: o.value,
      disabled: o.disabled || (o.parentElement && o.parentElement.disabled), hidden: o.hidden, group,
      placeholder: o.value === "", selected: o.selected
    };
  }

  // ---------- filtering + ranking ----------
  function filterItems(all, query) {
    const tokens = norm(query).split(/\s+/).filter(Boolean);
    const visible = all.filter(i => !i.hidden);
    if (!tokens.length) return { items: visible, tokens };
    const scored = [];
    visible.forEach((it, pos) => {
      const hay = norm(it.label), hayV = norm(it.value);
      if (!tokens.every(t => hay.includes(t) || hayV.includes(t))) return;
      let score = 3;                                              // plain substring
      if (tokens.every(t => hay.startsWith(t))) score = 0;       // label starts with the query
      else if (tokens.every(t => new RegExp("(^|[\\s\\-_/(])" + escRe(t)).test(hay))) score = 1; // word start
      else if (tokens.every(t => hay.includes(t))) score = 2;
      scored.push({ it, score, pos });
    });
    scored.sort((a, b) => (a.score - b.score) || (a.pos - b.pos));
    return { items: scored.map(s => s.it), tokens };
  }
  function highlight(text, tokens) {
    if (!tokens.length) return esc(text);
    const re = new RegExp("(" + tokens.map(escRe).join("|") + ")", "ig");
    return text.split(re).map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part))).join("");
  }

  // ---------- open / close ----------
  function open(select) {
    if (ui && ui.select === select) return;
    close(false);
    const all = readOptions(select);
    if (!all.length) return;
    const mode = select.getAttribute("data-ss-search");
    const hasSearch = mode === "always" || (mode !== "never" && all.filter(i => !i.hidden).length >= SEARCH_MIN_OPTIONS);
    const sheet = window.matchMedia("(max-width: 600px)").matches;

    const backdrop = document.createElement("div");
    backdrop.className = "ss-backdrop" + (sheet ? " ss-backdrop-dim" : "");
    const panel = document.createElement("div");
    panel.className = "ss-panel" + (sheet ? " ss-sheet" : "");
    panel.setAttribute("role", "listbox");
    panel.innerHTML =
      (hasSearch ? `<div class="ss-search"><span class="ss-search-ico" aria-hidden="true">🔎</span><input type="text" class="ss-input" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Search ${all.filter(i => !i.hidden).length} options…" aria-label="Search options"><button type="button" class="ss-clear" aria-label="Clear search" hidden>✕</button></div>` : "")
      + `<div class="ss-list"></div><div class="ss-foot" hidden></div>`;
    document.body.appendChild(backdrop);
    document.body.appendChild(panel);

    ui = {
      select, all, panel, backdrop, sheet, hasSearch, items: [], active: -1, tokens: [],
      input: panel.querySelector(".ss-input"), clearBtn: panel.querySelector(".ss-clear"),
      list: panel.querySelector(".ss-list"), foot: panel.querySelector(".ss-foot")
    };
    select.classList.add("ss-open");
    render("");
    position();

    // events
    backdrop.addEventListener("mousedown", e => { e.preventDefault(); close(true); });
    backdrop.addEventListener("touchstart", e => { e.preventDefault(); close(true); }, { passive: false });
    panel.addEventListener("mousedown", e => { if (!e.target.closest(".ss-input")) e.preventDefault(); }); // keep focus in the search box
    ui.list.addEventListener("click", e => {
      const row = e.target.closest(".ss-opt"); if (!row || row.classList.contains("ss-disabled")) return;
      choose(Number(row.dataset.pos));
    });
    ui.list.addEventListener("mousemove", e => {
      const row = e.target.closest(".ss-opt"); if (!row || row.classList.contains("ss-disabled")) return;
      setActive(Number(row.dataset.pos), false);
    });
    if (ui.input) {
      ui.input.addEventListener("input", () => { render(ui.input.value); if (ui.clearBtn) ui.clearBtn.hidden = !ui.input.value; });
      ui.clearBtn.addEventListener("click", () => { ui.input.value = ""; ui.clearBtn.hidden = true; render(""); ui.input.focus(); });
      // On touch devices focusing the box pops the keyboard, which is exactly what you want for a long list.
      setTimeout(() => { if (ui && ui.input) ui.input.focus({ preventScroll: true }); }, 0);
    }
    window.addEventListener("resize", position);
    window.addEventListener("scroll", onScroll, true);
    if (window.visualViewport) { window.visualViewport.addEventListener("resize", position); window.visualViewport.addEventListener("scroll", position); }
  }

  function close(refocus) {
    if (!ui) return;
    const { select, panel, backdrop } = ui;
    window.removeEventListener("resize", position);
    window.removeEventListener("scroll", onScroll, true);
    if (window.visualViewport) { window.visualViewport.removeEventListener("resize", position); window.visualViewport.removeEventListener("scroll", position); }
    panel.remove(); backdrop.remove();
    select.classList.remove("ss-open");
    ui = null;
    if (refocus) { try { select.focus({ preventScroll: true }); } catch (e) { } }
  }

  function choose(pos) {
    if (!ui) return;
    const it = ui.items[pos]; if (!it || it.disabled) return;
    const select = ui.select;
    const changed = select.selectedIndex !== it.index;
    select.selectedIndex = it.index;
    close(true);
    if (changed) {
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  // ---------- rendering ----------
  function render(query) {
    const { items, tokens } = filterItems(ui.all, query);
    ui.items = items; ui.tokens = tokens;
    const shown = items.slice(0, MAX_RENDERED);
    const grouped = !tokens.length && shown.some(i => i.group);
    let html = "", lastGroup = null;
    shown.forEach((it, pos) => {
      if (grouped && it.group !== lastGroup) { lastGroup = it.group; if (it.group) html += `<div class="ss-group">${esc(it.group)}</div>`; }
      const cls = ["ss-opt"];
      if (it.selected) cls.push("ss-selected");
      if (it.disabled) cls.push("ss-disabled");
      if (it.placeholder) cls.push("ss-placeholder");
      html += `<div class="${cls.join(" ")}" role="option" data-pos="${pos}" aria-selected="${it.selected}">`
        + `<span class="ss-opt-label">${highlight(it.label, tokens)}</span>`
        + (!grouped && it.group && tokens.length ? `<span class="ss-opt-group">${esc(it.group)}</span>` : "")
        + (it.selected ? `<span class="ss-check" aria-hidden="true">✓</span>` : "") + `</div>`;
    });
    if (!shown.length) html = `<div class="ss-empty">No matches${tokens.length ? ` for “${esc(query.trim())}”` : ""}</div>`;
    ui.list.innerHTML = html;

    if (items.length > MAX_RENDERED) { ui.foot.hidden = false; ui.foot.textContent = `Showing ${MAX_RENDERED} of ${items.length} — type to narrow down`; }
    else if (tokens.length && items.length) { ui.foot.hidden = false; ui.foot.textContent = `${items.length} match${items.length === 1 ? "" : "es"}`; }
    else ui.foot.hidden = true;

    // active row: the first match while searching, otherwise the current value
    let start = tokens.length ? items.findIndex(i => !i.disabled) : items.findIndex(i => i.selected);
    if (start < 0) start = items.findIndex(i => !i.disabled);
    ui.active = -1;
    setActive(start, true);
    position();
  }
  function setActive(pos, scroll) {
    if (!ui) return;
    const rows = ui.list.querySelectorAll(".ss-opt");
    rows.forEach(r => r.classList.remove("ss-active"));
    ui.active = pos;
    const row = pos >= 0 ? ui.list.querySelector(`.ss-opt[data-pos="${pos}"]`) : null;
    if (row) { row.classList.add("ss-active"); if (scroll) row.scrollIntoView({ block: "nearest" }); }
  }
  function move(delta) {
    if (!ui || !ui.items.length) return;
    const n = Math.min(ui.items.length, MAX_RENDERED);
    let pos = ui.active;
    for (let step = 0; step < n; step++) {
      pos = (pos + delta + n) % n;
      if (!ui.items[pos].disabled) break;
    }
    setActive(pos, true);
  }

  // ---------- positioning ----------
  function position() {
    if (!ui) return;
    const { select, panel, sheet } = ui;
    if (sheet) {
      const vv = window.visualViewport;
      const bottomGap = vv ? Math.max(0, window.innerHeight - (vv.height + vv.offsetTop)) : 0; // lifts the sheet above the on-screen keyboard
      panel.style.bottom = bottomGap + "px";
      panel.style.maxHeight = Math.min(window.innerHeight * 0.75, (vv ? vv.height : window.innerHeight) - 16) + "px";
      return;
    }
    const r = select.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight, pad = 8;
    const width = Math.min(Math.max(r.width, 260), vw - pad * 2);
    let left = Math.min(Math.max(pad, r.left), vw - width - pad);
    panel.style.width = width + "px";
    panel.style.left = left + "px";
    const spaceBelow = vh - r.bottom - pad, spaceAbove = r.top - pad;
    const want = Math.min(panel.scrollHeight || 320, 380);
    const below = spaceBelow >= Math.min(want, 220) || spaceBelow >= spaceAbove;
    const maxH = Math.max(140, Math.min(380, below ? spaceBelow - 4 : spaceAbove - 4));
    panel.style.maxHeight = maxH + "px";
    if (below) { panel.style.top = (r.bottom + 4) + "px"; panel.style.bottom = "auto"; panel.classList.remove("ss-up"); }
    else { panel.style.bottom = (vh - r.top + 4) + "px"; panel.style.top = "auto"; panel.classList.add("ss-up"); }
  }
  let rafScroll = 0;
  function onScroll(e) {
    if (!ui || (e.target && ui.panel.contains(e.target))) return;
    if (ui.sheet) return;
    cancelAnimationFrame(rafScroll);
    rafScroll = requestAnimationFrame(position);
  }

  let suppressClick = false;
  // ---------- opening the dropdown (delegated, so dynamic selects need no wiring) ----------
  document.addEventListener("mousedown", e => {
    const sel = e.target && e.target.closest && e.target.closest("select");
    if (!isEnhanceable(sel) || e.button !== 0) return;
    e.preventDefault();           // stops the browser's native list
    sel.focus({ preventScroll: true });
    if (ui && ui.select === sel) { close(false); suppressClick = true; } else open(sel);
  }, true);
  document.addEventListener("click", e => {
    const sel = e.target && e.target.closest && e.target.closest("select");
    if (!isEnhanceable(sel)) return;
    e.preventDefault();           // touch devices open the native picker on click
    if (suppressClick) { suppressClick = false; return; }
    if (!ui) open(sel);
  }, true);
  document.addEventListener("keydown", e => {
    if (ui) {
      const k = e.key;
      if (k === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); return; }
      if (k === "ArrowDown") { e.preventDefault(); move(1); return; }
      if (k === "ArrowUp") { e.preventDefault(); move(-1); return; }
      if (k === "PageDown") { e.preventDefault(); for (let i = 0; i < 8; i++) move(1); return; }
      if (k === "PageUp") { e.preventDefault(); for (let i = 0; i < 8; i++) move(-1); return; }
      if (k === "Home" && !(ui.input && ui.input.value)) { e.preventDefault(); ui.active = -1; move(1); return; }
      if (k === "End" && !(ui.input && ui.input.value)) { e.preventDefault(); ui.active = 0; move(-1); return; }
      if (k === "Enter") { e.preventDefault(); e.stopPropagation(); choose(ui.active); return; }
      if (k === "Tab") { close(false); return; }
      // closed-list style typing without a search box: jump to the option starting with that letter
      if (!ui.hasSearch && k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const from = ui.active + 1, n = ui.items.length;
        for (let s = 0; s < n; s++) { const p = (from + s) % n; if (!ui.items[p].disabled && norm(ui.items[p].label).startsWith(norm(k))) { setActive(p, true); break; } }
      }
      return;
    }
    const sel = e.target;
    if (!isEnhanceable(sel)) return;
    if (e.key === "Enter" || e.key === " " || ((e.key === "ArrowDown" || e.key === "ArrowUp") && e.altKey)) {
      e.preventDefault(); open(sel);
    }
  }, true);
  // Close if the page navigates / the select disappears while open (e.g. a modal closes or a list re-renders).
  new MutationObserver(() => { if (ui && !document.body.contains(ui.select)) close(false); })
    .observe(document.body, { childList: true, subtree: true });
})();
