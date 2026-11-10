"use strict";

  const OFFICIAL_TYPES = ["normal","fire","water","electric","grass","ice","fighting","poison","ground","flying","psychic","bug","rock","ghost","dragon","dark","steel","fairy"];
  // ---- FANMADE TYPES (not part of the official games). Add a new one here + give it a TYPE_CHART row/column
  // (ui-dex-renderer.js) and a --t-<name> color (index.html <style>) and it shows up everywhere automatically. ----
  const FANMADE_TYPES = {
    cosmic: { credit: "Pokémon Void / Pokédex Fillers" },
    light:  { credit: "Pokémon Void" },
    rubber: { credit: "AdeptCharon-style fan version" }
  };
  const FANMADE_TYPE_LIST = Object.keys(FANMADE_TYPES);
  const TYPES = [...OFFICIAL_TYPES, ...FANMADE_TYPE_LIST];
  const DARK_TEXT_TYPES = new Set(["normal","electric","ice","ground","bug","rock","steel","fairy","light"]);

  // "— Fanmade Types —" divider + credit lines, shown inside every type picker grid.
  function fanmadeTypesHeaderHtml(){
    const cap1 = t => t[0].toUpperCase()+t.slice(1);
    return `<div class="fanmade-divider" style="grid-column:1/-1;flex-basis:100%;width:100%;margin:8px 0 4px;text-align:left;">`
      + `<div style="font-weight:700;font-size:11px;letter-spacing:.06em;text-transform:uppercase;">— Fanmade Types —</div>`
      + FANMADE_TYPE_LIST.map(t=>`<div style="font-size:11px;font-weight:400;text-transform:none;letter-spacing:0;opacity:.7;">${cap1(t)} — ${FANMADE_TYPES[t].credit}</div>`).join("")
      + `</div>`;
  }
  function fanmadeTypesHeaderEl(){
    const d = document.createElement("div"); d.innerHTML = fanmadeTypesHeaderHtml(); return d.firstElementChild;
  }
  function typeCreditTitle(t){ return FANMADE_TYPES[t] ? `Fanmade type — ${FANMADE_TYPES[t].credit}` : ""; }
  // <option> list for plain <select>s: official types, then a "— Fanmade Types —" optgroup (credit in each tooltip).
  function typeOptionsHtml(selected){
    const label = t => t[0].toUpperCase()+t.slice(1);
    const opt = t => `<option value="${t}" ${t===selected?"selected":""} title="${typeCreditTitle(t)}">${label(t)}</option>`;
    return OFFICIAL_TYPES.map(opt).join("") + `<optgroup label="— Fanmade Types —">${FANMADE_TYPE_LIST.map(opt).join("")}</optgroup>`;
  }
  const EMOJIS = ["🐉","🔥","🌊","🍃","⚡","❄️","🪨","👻","🦋","🐺","🦊","🦎","🐍","🦂","🐦","🐢","🦑","🐲","🌟","🕷️","🐌","🦖","🐡","🍄"];
  const STAT_KEYS = [["hp","HP"],["atk","Attack"],["def","Defense"],["spa","Sp.Atk"],["spd","Sp.Def"],["spe","Speed"]];
  const ENTRIES_KEY = "fielddex_entries_v4";
  const REGIONS_KEY = "fielddex_regions_v4";
  const FAVORITES_KEY = "fielddex_favorites_v1";
  const ITEMS_KEY = "fielddex_items_v1";