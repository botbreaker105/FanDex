"use strict";

// ================= 2v2 RANDOM BATTLES (separate simulator, v1) =================
// Each side (Blue 🔵 = team "a", Red 🔴 = team "b") rolls 4 random Fakemon: 2 start on the field, 2 wait on the
// bench and are sent out (in order) whenever an active Fakemon faints.
//
// Moves use their "Target" setting (move field `targetScope`, set in the move editor):
//   enemy        — one random enemy on the field         you          — the user itself
//   bothEnemies  — both enemies                          bothAllies   — the user AND its partner
//   all          — everyone on the field                 allButYou    — everyone on the field except the user (Earthquake)
// A move that hits more than one Fakemon deals 0.75x damage to each (spread), allies included.
//
// v2 simulates: speed (with stat stages / paralysis) + priority order, accuracy, type effectiveness, STAB, crits
// (incl. crit-rate modes), spread damage, OHKO, multi-hit (+ ramp scaling), drain / recoil, self-faint, replacements,
// stat stages, status conditions (sleep, paralysis, burn, poison, bad poison, frostbite), a move's Additional Effects
// (stat modifier / heal / status), Status-move actions (status, heal, weather), weather (sun, rain, sand, snow, polluted)
// and a core set of abilities (type immunity, Wonder Guard, damage multipliers, resistances, stat-drop blockers,
// battle-start weather / stat changes). Held items, hazards, delayed effects and other exotic effect kinds are not yet simulated.
// Uses engine.js globals: migrateEntry, typeMultiplier, buildRandomTeam, entries.

const DOUBLES_TARGET_SCOPES = [
  ["enemy", "One enemy (default)"],
  ["you", "You (the user)"],
  ["bothEnemies", "Both enemies"],
  ["bothAllies", "Both allies (you + your partner)"],
  ["all", "Everyone on the field"],
  ["allButYou", "Everyone except you (Earthquake)"]
];
const DOUBLES_TEAMS = { a: { name: "Blue", emoji: "🔵", color: "#5aa9ff" }, b: { name: "Red", emoji: "🔴", color: "#ff6b6b" } };

function simulateDoubles(rawTeamA, rawTeamB, opts) {
  opts = { megaEnabled: true, megaChance: 50, itemsA: [], itemsB: [], ...(opts || {}) };
  const log = [];
  const lc = v => String(v == null ? "" : v).toLowerCase();
  const num = (v, d) => (v != null && v !== "" && !isNaN(Number(v)) ? Number(v) : d);
  const chanceOk = pct => Math.random() * 100 < num(pct, 100);
  const STAGE_KEYS = ["atk", "def", "spa", "spd", "spe"];
  const stageMult = n => (n >= 0 ? (2 + n) / 2 : 2 / (2 - n));
  const immunities = (typeof STATUS_IMMUNITIES !== "undefined" && STATUS_IMMUNITIES) || {};
  const STATUS_LABEL = { sleep: "fell asleep", paralysis: "was paralyzed", burn: "was burned", poison: "was poisoned", badlypoisoned: "was badly poisoned", frostbite: "got frostbite", freeze: "was frozen" };

  const mkSlot = (raw, team, itemId) => {
    const f = raw.__migrated ? raw : migrateEntry(raw);
    const maxHp = ((f.stats && f.stats.hp) || 50) * 3;
    const abs = (f.abilities || []).filter(a => a && a.name);
    return {
      f, team, hp: maxHp, maxHp, fainted: false,
      stages: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
      status: null,                  // { kind, turns, counter }
      ability: abs.length ? abs[Math.floor(Math.random() * abs.length)] : null,
      announced: false, usedActive: false, onFieldTurns: 0,
      heldItemId: itemId || null, item: (itemId && typeof itemById === "function") ? itemById(itemId) : null,
      transformed: false, preForm: null, turnsRemaining: null, baseMaxHp: null
    };
  };
  const teams = {
    a: rawTeamA.map((r, i) => mkSlot(r, "a", opts.itemsA && opts.itemsA[i])),
    b: rawTeamB.map((r, i) => mkSlot(r, "b", opts.itemsB && opts.itemsB[i]))
  };
  const active = { a: [0, 1], b: [0, 1] };           // indices into teams[x]; null = empty position
  const other = t => (t === "a" ? "b" : "a");
  const label = s => `${DOUBLES_TEAMS[s.team].emoji} ${DOUBLES_TEAMS[s.team].name} ${s.f.name}`;
  const onField = t => active[t].map(i => (i == null ? null : teams[t][i])).filter(s => s && !s.fainted);
  const allOnField = () => [...onField("a"), ...onField("b")];
  const alive = t => teams[t].some(s => !s.fainted);
  const baseStat = (s, k) => ((s.f.stats && s.f.stats[k]) || 50);
  const rnd = arr => arr[Math.floor(Math.random() * arr.length)];
  const typesOf = s => s.f.types || ["normal"];

  // ---------- weather (sun / rain / sand / snow / polluted are simulated; other custom weathers are only announced) ----------
  let weather = { kind: "clear", turns: 0, pollutedChance: 15 };
  function setWeather(kind, turns, source, pollutedChance) {
    if (!kind || kind === "clear") return;
    if (weather.kind === kind) { log.push(`  …but the weather is already ${kind}.`); return; }
    weather = { kind, turns: turns > 0 ? turns : 5, pollutedChance: num(pollutedChance, 15) };
    log.push(`  🌦 ${source ? source + " changed the weather to " : "The weather became "}${kind}! (${weather.turns} turns)`);
  }

  // ---------- stats with stages / status ----------
  function effStat(s, k) {
    let v = baseStat(s, k) * stageMult(s.stages[k] || 0);
    if (k === "spe" && s.status && s.status.kind === "paralysis") v *= 0.5;
    return v;
  }
  // ---------- ability helpers ----------
  const passiveOf = s => (s.ability && s.ability.abilityType === "passive" && s.ability.passive) || null;
  const activeOf = s => (s.ability && s.ability.abilityType === "active" && s.ability.active) || null;
  const trig = (p, ev) => p && (p.trigger === ev || p.trigger === "always");
  function passiveCovers(s, moveType) {
    const p = passiveOf(s); if (!p) return false;
    if (Array.isArray(p.affectedTypes) && p.affectedTypes.length) return p.affectedTypes.includes(moveType);
    return !p.filterType || p.filterType === "any" || p.filterType === moveType;
  }
  const blocksDebuffs = s => !!(s.ability && (s.ability.negateStatMod === "blockDebuffs" || s.ability.negateStatMod === "blockAll"));
  const blocksAllStatMods = s => !!(s.ability && s.ability.negateStatMod === "blockAll");

  // ---------- stat stage changes ----------
  function changeStage(target, key, delta, source) {
    if (!STAGE_KEYS.includes(key) || !delta) return false;
    if (source && source !== target && delta < 0 && blocksDebuffs(target)) { log.push(`  ${label(target)}'s ${target.ability.name} prevents its stats from being lowered!`); return false; }
    if (source && source !== target && blocksAllStatMods(target)) return false;
    const before = target.stages[key];
    const after = Math.max(-6, Math.min(6, before + delta));
    if (after === before) { log.push(`  ${label(target)}'s ${key.toUpperCase()} won't go ${delta > 0 ? "higher" : "lower"}!`); return false; }
    target.stages[key] = after;
    const mag = Math.abs(after - before);
    log.push(`  ${label(target)}'s ${key.toUpperCase()} ${delta > 0 ? (mag > 1 ? "rose sharply" : "rose") : (mag > 1 ? "fell harshly" : "fell")}!`);
    return true;
  }

  // ---------- status conditions ----------
  function statusImmune(target, kind) {
    const k = lc(kind);
    if (target.ability && target.ability.abilityType === "passive" && target.ability.passive && target.ability.passive.action === "negateStatus"
      && trig(target.ability.passive, "defending") && (target.ability.passive.filterType === "any" || !target.ability.passive.filterType)
      && num(target.ability.passive.chance, 100) >= 100) return true;
    return typesOf(target).some(t => {
      const set = immunities[t];
      return set && [...set].some(x => lc(x) === k);
    });
  }
  function inflictStatus(target, kind, source, fx) {
    if (!kind || kind === "none" || target.fainted) return false;
    const k = lc(kind);
    if (target.status) { log.push(`  …${label(target)} already has a status condition.`); return false; }
    if (statusImmune(target, kind)) { log.push(`  It doesn't affect ${label(target)}...`); return false; }
    let turns = 0;
    if (k === "sleep") {
      const mode = fx && fx.statusDurationMode;
      const mn = num(fx && fx.statusDurationMin, 1), mx = Math.max(mn, num(fx && fx.statusDurationMax, 3));
      turns = mode === "fixed" ? num(fx && fx.statusDurationFixed, 3) : mn + Math.floor(Math.random() * (mx - mn + 1));
    }
    target.status = { kind: k, turns, counter: 0 };
    log.push(`  ${label(target)} ${STATUS_LABEL[k] || ("is now " + k)}!`);
    return true;
  }
  function heal(target, amount, why) {
    if (target.fainted || amount <= 0) return;
    const before = target.hp;
    target.hp = Math.min(target.maxHp, target.hp + Math.round(amount));
    if (target.hp > before) log.push(`  ${label(target)} ${why || "recovered"} ${target.hp - before} HP. (${target.hp}/${target.maxHp})`);
  }
  function hurt(target, amount, why) {
    if (target.fainted || amount <= 0) return;
    target.hp = Math.max(0, target.hp - Math.max(1, Math.round(amount)));
    log.push(`  ${label(target)} ${why} (${target.hp}/${target.maxHp})`);
    if (target.hp <= 0) faint(target);
  }

  // ---------- held items + item-gated transformations (Mega / Alternate Forms) ----------
  const announceItem = s => { if (s.item) log.push(`  🎒 ${label(s)} is holding ${s.item.name}.`); };
  // Mirrors checkMegaEvolution(): the first enabled profile whose Required Held Item (if any) matches what this
  // Fakemon holds AND whose Activation Requirement is met right now.
  function tryTransform(s, justUsedMoveName, turn) {
    if (!opts.megaEnabled || s.fainted || s.transformed || !(s.f.megas || []).length || typeof applyMegaEvolution !== "function") return;
    for (const mg of s.f.megas) {
      if (!mg || !mg.enabled) continue;
      const act = mg.activation || {};
      if (act.requiredItem && act.requiredItem !== s.heldItemId) continue;
      const ready =
        (act.requirement === "heldStone" && chanceOk(opts.megaChance)) ||
        (act.requirement === "triggerMove" && justUsedMoveName && act.triggerMoveName && justUsedMoveName === act.triggerMoveName) ||
        (act.requirement === "turnThreshold" && turn >= num(act.turnThreshold, 3));
      if (!ready) continue;
      s.preForm = s.f;
      s.f = applyMegaEvolution(s.f, mg, log);
      s.transformed = true;
      if (num(mg.hpMultiplier, 1) > 1 && s.maxHp > 0) {
        const ratio = s.hp / s.maxHp; s.baseMaxHp = s.maxHp;
        s.maxHp = Math.round(s.maxHp * mg.hpMultiplier); s.hp = Math.max(1, Math.round(ratio * s.maxHp));
        log.push(`  ${label(s)}'s HP surges to ${s.hp}/${s.maxHp}!`);
      }
      s.turnsRemaining = num(mg.durationLimit, 0) > 0 ? mg.durationLimit : null;
      const abs = (s.f.abilities || []).filter(a => a && a.name);
      s.ability = abs.length ? rnd(abs) : null;
      log.push(`  ${label(s)}'s Ability is now ${s.ability ? s.ability.name : "None"}!`);
      enterField(s);
      return;
    }
  }
  function revertTransform(s) {
    if (!s.preForm) return;
    log.push(`  ${label(s)} reverted to ${s.preForm.name}.`);
    if (s.baseMaxHp) { const ratio = s.hp / s.maxHp; s.maxHp = s.baseMaxHp; s.hp = Math.max(1, Math.round(ratio * s.maxHp)); s.baseMaxHp = null; }
    s.f = s.preForm; s.preForm = null; s.turnsRemaining = null;
    const abs = (s.f.abilities || []).filter(a => a && a.name);
    s.ability = abs.length ? rnd(abs) : null;
  }

  // ---------- field handling ----------
  function enterField(s) {
    s.onFieldTurns = 0;
    const p = passiveOf(s);
    if (p && trig(p, "battleStart")) {
      if (p.action === "setWeather" && p.weatherSet) { log.push(`  ✨ ${label(s)}'s ${s.ability.name} activates!`); setWeather(p.weatherSet, 5, s.ability.name); }
      else if (p.action === "modifyStat" && p.statKey && num(p.statStage, 0)) {
        log.push(`  ✨ ${label(s)}'s ${s.ability.name} activates!`);
        const foes = p.statTarget === "opponent" || p.target === "opponent";
        (foes ? onField(other(s.team)) : [s]).forEach(t => changeStage(t, p.statKey, num(p.statStage, 0), s));
      }
    }
  }
  function sendOut(team, pos) {
    const bench = teams[team].map((s, i) => i).filter(i => !active[team].includes(i) && !teams[team][i].fainted);
    if (!bench.length) { active[team][pos] = null; return; }
    active[team][pos] = bench[0];
    const s = teams[team][bench[0]];
    log.push(`${DOUBLES_TEAMS[team].emoji} ${DOUBLES_TEAMS[team].name} sends out ${s.f.name}! (${bench.length - 1} left in reserve)`);
    announceItem(s);
    enterField(s);
  }
  function faint(s) {
    if (s.fainted) return;
    s.fainted = true; s.hp = 0;
    log.push(`${label(s)} fainted!`);
    const pos = active[s.team].findIndex(i => i != null && teams[s.team][i] === s);
    if (pos >= 0 && alive(s.team)) sendOut(s.team, pos);
    else if (pos >= 0) active[s.team][pos] = null;
  }

  function pickMove(s) {
    const ms = (s.f.moves || []).filter(m => m && m.name);
    if (!ms.length) return { name: "Struggle", type: "normal", category: "Physical", basePower: 50, accuracy: 1, targetScope: "enemy", priority: 0, hits: 1, effects: [], recoilPercent: 25 };
    const dmg = ms.filter(m => m.category !== "Status" || m.ohko);
    return rnd(dmg.length && Math.random() < 0.8 ? dmg : ms);
  }
  function targetsFor(user, move) {
    const foes = onField(other(user.team)), mates = onField(user.team);
    switch (move.targetScope) {
      case "you": return [user];
      case "bothEnemies": return foes;
      case "bothAllies": return mates;
      case "all": return [...mates, ...foes];
      case "allButYou": return [...mates.filter(s => s !== user), ...foes];
      default:
        // Moves that only help the user / allies (heal, self stat boost) default to the user.
        if (move.category === "Status" && (move.action === "heal" && (move.healTarget || "self") === "self")) return [user];
        if (move.category === "Status" && move.action === "weather") return [user];
        return foes.length ? [rnd(foes)] : [];
    }
  }

  // ---------- Additional Effects (move.effects[]): statmod / heal / status ----------
  function applyEffectList(effects, user, target, moveName, dealt) {
    (effects || []).forEach(fx => {
      if (!fx || !chanceOk(fx.chance)) return;
      const who = fx.target === "self" ? [user] : fx.target === "both" ? [user, target] : [target];
      if (fx.type === "statmod") {
        who.forEach(t => {
          if (t.fainted) return;
          const keys = Array.isArray(fx.statKeys) && fx.statKeys.length && fx.statKeys.length > 1 && fx.statKey == null ? fx.statKeys : [fx.statKey || "atk"];
          keys.forEach(k => changeStage(t, k, num(fx.statStage, 1), user));
        });
      } else if (fx.type === "heal") {
        who.forEach(t => {
          const amt = fx.healType === "flat" ? num(fx.healValue, 25) : t.maxHp * num(fx.healValue, 25) / 100;
          heal(t, amt, "recovered");
        });
      } else if (fx.type === "status") {
        who.forEach(t => inflictStatus(t, fx.statusEffect, user, fx));
      }
      // other effect kinds (hazards, delayed queue, weight, copy stats…) are not simulated in 2v2 yet
    });
  }

  // ---------- damage ----------
  function weatherMult(moveType) {
    if (weather.kind === "sun") return moveType === "fire" ? 1.5 : moveType === "water" ? 0.5 : 1;
    if (weather.kind === "rain") return moveType === "water" ? 1.5 : moveType === "fire" ? 0.5 : 1;
    return 1;
  }
  function abilityAttackMult(user, move, tmult) {
    let m = 1;
    const p = passiveOf(user);
    if (p) {
      if (p.action === "multiplyDamage" && trig(p, "attacking") && passiveCovers(user, move.type) && chanceOk(p.chance)) m *= num(p.multiplier, 1);
      else if (p.action === "boostTagMove" && String(p.boostTagFilter || "").split(",").map(x => lc(x).trim()).filter(Boolean).some(t => (move.tags || []).map(lc).includes(t) || t === lc(move.type))) m *= num(p.boostTagMultiplier, 1);
      else if (p.action === "slowStart" && user.onFieldTurns < num(p.slowStartTurns, 5)) m *= Math.max(0.1, Math.min(1, num(p.slowStartMultiplier, 0.5)));
    }
    const ac = activeOf(user);
    if (ac && (ac.action === "boostDamage150" || ac.action === "boostDamageCustom")) {
      const cond = ac.condition === "hpBelow33" ? user.hp / user.maxHp < 0.34 : ac.condition === "stabMatch" ? typesOf(user).includes(move.type) : ac.condition === "weatherIs" ? weather.kind === ac.weatherCondition : false;
      if (cond && chanceOk(ac.chance)) m *= ac.action === "boostDamage150" ? 1.5 : num(ac.multiplier, 1);
    }
    return m;
  }
  function abilityDefendMult(target, move, tmult) {
    const p = passiveOf(target);
    let m = 1;
    if (p) {
      if (p.action === "wonderGuard") { if (tmult <= 1) return 0; }
      else if (trig(p, "defending") && passiveCovers(target, move.type)) {
        if (p.action === "negateDamage" && chanceOk(p.chance)) return 0;
        if (p.action === "resistanceMult" && chanceOk(p.chance)) m *= num(p.resistRatio, 0.5);
        if (p.action === "multiplyDamage" && chanceOk(p.chance)) m *= num(p.multiplier, 1);
        if (p.action === "reduceSuperEffective" && tmult > 1 && chanceOk(p.chance)) m *= 1 - num(p.protectPercent, 50) / 100;
      }
    }
    if (num(target.ability && target.ability.mirrorReflectPercent, 0) > 0) m *= 1; // reflect is applied after the hit
    return m;
  }
  function critRoll(move) {
    const mode = move.critRateMode;
    if (mode === "always") return true;
    return Math.random() < (mode === "high" ? 1 / 4 : 1 / 16);
  }
  function computeDamage(user, t, move, mult, spread, hitIdx) {
    const spec = move.category === "Special";
    const atkKey = move.atkStatBasis && move.atkStatBasis !== "auto" ? move.atkStatBasis : (spec ? "spa" : "atk");
    const defKey = move.defStatBasis && move.defStatBasis !== "auto" ? move.defStatBasis : (spec ? "spd" : "def");
    const crit = critRoll(move);
    // crits ignore the attacker's negative offense stages and the defender's positive defense stages
    const atkStage = crit ? Math.max(0, user.stages[atkKey]) : user.stages[atkKey];
    const defStage = (crit || move.ignoreDefense) ? Math.min(0, t.stages[defKey]) : t.stages[defKey];
    let atk = baseStat(user, atkKey) * stageMult(atkStage);
    const def = baseStat(t, defKey) * stageMult(defStage);
    if (user.status && user.status.kind === "burn" && atkKey === "atk") atk *= 0.5;
    if (user.status && (user.status.kind === "frostbite" || user.status.kind === "freeze") && atkKey === "spa") atk *= 0.5;
    const stab = typesOf(user).includes(move.type) ? 1.5 : 1;
    const variance = 0.85 + Math.random() * 0.15;
    const bpScale = Math.max(0.2, (move.basePower || 60) / 60);
    // multi-hit scaling (rampUp / rampDown)
    let hitScale = 1;
    const pct = num(move.multiHitScalingPct, 20) / 100;
    if (move.multiHitScaling === "rampUp") hitScale = 1 + pct * hitIdx;
    else if (move.multiHitScaling === "rampDown") hitScale = Math.max(0.1, 1 - pct * hitIdx);
    let d = (atk / Math.max(20, def)) * 26 * mult * stab * (crit ? 1.5 : 1) * variance * spread * bpScale * weatherMult(move.type) * hitScale;
    d *= abilityAttackMult(user, move, mult) * abilityDefendMult(t, move, mult);
    return { dmg: d <= 0 ? 0 : Math.max(1, Math.round(d)), crit };
  }

  // ---------- one move against one target ----------
  function hitTarget(user, t, move, spread) {
    if (t.fainted) return 0;
    const unavoidable = (move.tags || []).map(lc).includes("unavoidable");
    const acc = move.accuracy ?? 1;
    if (!unavoidable && t !== user && Math.random() > acc) { log.push(`  ${label(user)}'s ${move.name} missed ${label(t)}!`); return 0; }
    const isDamaging = move.category !== "Status" || move.ohko;
    if (!isDamaging) {
      // Status-category move: run its action, then its Additional Effects
      const chanceHit = chanceOk(move.effectChance);
      if (move.action === "status" && move.statusEffect && move.statusEffect !== "none" && chanceHit && t !== user) inflictStatus(t, move.statusEffect, user, move);
      else if (move.action === "status" && move.statusEffect && move.statusEffect !== "none" && chanceHit && t === user) inflictStatus(t, move.statusEffect, user, move);
      if (move.action === "heal") {
        const tgt = move.healTarget || "self";
        const recipients = tgt === "opponent" ? [t] : tgt === "both" ? [user, t] : [user];
        recipients.forEach(r => heal(r, move.healType === "flat" ? num(move.healValue, 25) : r.maxHp * num(move.healValue, 25) / 100, "recovered"));
      }
      applyEffectList(move.effects, user, t, move.name, 0);
      return 0;
    }
    const mult = move.ohko && t === user ? 1 : typeMultiplier(move.type, typesOf(t));
    if (t.ability && t.ability.immuneToType && t.ability.immuneToType !== "none" && t.ability.immuneToType === move.type) {
      log.push(`  It doesn't affect ${label(t)}... (${t.ability.name})`); return 0;
    }
    if (mult <= 0) { log.push(`  It doesn't affect ${label(t)}...`); return 0; }
    const hits = Math.max(1, num(move.hits, 1));
    let total = 0, landed = 0, anyCrit = false;
    for (let h = 0; h < hits && !t.fainted; h++) {
      let dmg, crit = false;
      if (move.ohko) dmg = t.hp;
      else {
        const r = computeDamage(user, t, move, mult, spread, h);
        dmg = r.dmg; crit = r.crit;
        if (dmg <= 0) { log.push(`  ${label(t)}'s ${t.ability ? t.ability.name : "defenses"} blocked the damage!`); break; }
      }
      t.hp = Math.max(0, t.hp - dmg); total += dmg; landed++; anyCrit = anyCrit || crit;
      if (hits > 1) log.push(`  Hit ${h + 1}: ${label(t)} took ${dmg} damage!${crit ? " A critical hit!" : ""}`);
      else log.push(`  ${label(t)} took ${dmg} damage! (${t.hp}/${t.maxHp})` + (crit ? " A critical hit!" : "")
        + (move.ohko ? " It's a one-hit KO!" : mult > 1 ? " It's super effective!" : mult < 1 ? " It's not very effective..." : ""));
    }
    if (hits > 1 && landed) log.push(`  ${label(t)} was hit ${landed} time(s) for ${total} total. (${t.hp}/${t.maxHp})${!move.ohko && mult > 1 ? " It's super effective!" : mult < 1 ? " It's not very effective..." : ""}`);
    if (!landed) return 0;
    // drain / recoil
    if (num(move.drainPercent, 0) > 0 && !user.fainted) heal(user, total * move.drainPercent / 100, "drained");
    // mirror-style reflected damage
    const refl = num(t.ability && t.ability.mirrorReflectPercent, 0);
    if (refl > 0 && t !== user) hurt(user, total * refl / 100, `was hurt by ${t.ability.name}!`);
    // Additional Effects only trigger while the target is still standing (self effects always apply)
    if (!t.fainted) applyEffectList(move.effects, user, t, move.name, total);
    else applyEffectList((move.effects || []).filter(fx => fx.target === "self"), user, t, move.name, total);
    if (t.hp <= 0) faint(t);
    return total;
  }

  // ---------- end-of-turn: status damage, weather, countdowns ----------
  function endOfTurn() {
    allOnField().forEach(s => {
      if (s.fainted || !s.status) return;
      const k = s.status.kind;
      if (k === "burn") hurt(s, s.maxHp / 16, "is hurt by its burn!");
      else if (k === "frostbite" || k === "freeze") hurt(s, s.maxHp / 16, "is hurt by frostbite!");
      else if (k === "poison") hurt(s, s.maxHp / 8, "is hurt by poison!");
      else if (k === "badlypoisoned") { s.status.counter++; hurt(s, s.maxHp * Math.min(15, s.status.counter) / 16, "is badly hurt by poison!"); }
    });
    if (weather.kind !== "clear") {
      allOnField().forEach(s => {
        if (s.fainted) return;
        const ts = typesOf(s);
        if (weather.kind === "sand" && !ts.some(t => ["rock", "ground", "steel"].includes(t))) hurt(s, s.maxHp / 16, "is buffeted by the sandstorm!");
        else if (weather.kind === "snow" && !ts.includes("ice")) hurt(s, s.maxHp / 16, "is chilled by the snow!");
        else if (weather.kind === "polluted" && chanceOk(weather.pollutedChance)) inflictStatus(s, "poison", null, null);
      });
      if (--weather.turns <= 0) { log.push(`🌦 The ${weather.kind} weather faded.`); weather = { kind: "clear", turns: 0, pollutedChance: 15 }; }
    }
    allOnField().forEach(s => {
      if (s.fainted) return;
      // Leftovers-style held items (heal at turn end) — the only item effect simulated in 2v2 so far
      if (s.item && Array.isArray(s.item.effects)) s.item.effects.forEach(fx => {
        if (fx && fx.action === "heal" && fx.trigger === "turnEnd" && (typeof matchesHolderFilter !== "function" || matchesHolderFilter(fx, s.f))) heal(s, s.maxHp * num(fx.value, 0), `recovered a little with ${s.item.name}:`);
      });
      if (s.turnsRemaining != null && --s.turnsRemaining <= 0) revertTransform(s);
      s.onFieldTurns++;
    });
  }

  log.push(`⚔ 2v2 Random Battle — ${DOUBLES_TEAMS.a.emoji} Blue vs ${DOUBLES_TEAMS.b.emoji} Red`);
  log.push(`${DOUBLES_TEAMS.a.emoji} Blue opens with ${onField("a").map(s => s.f.name).join(" & ")}`);
  log.push(`${DOUBLES_TEAMS.b.emoji} Red opens with ${onField("b").map(s => s.f.name).join(" & ")}`);
  allOnField().forEach(s => { announceItem(s); enterField(s); });

  let turns = 0;
  while (alive("a") && alive("b") && turns < 100) {
    turns++;
    log.push(`— Turn ${turns} —`);
    allOnField().forEach(s => tryTransform(s, null, turns));
    const actions = allOnField().map(s => ({ s, move: pickMove(s) }));
    actions.sort((x, y) => ((y.move.priority || 0) - (x.move.priority || 0)) || (effStat(y.s, "spe") - effStat(x.s, "spe")) || (Math.random() - 0.5));
    for (const { s: user, move } of actions) {
      if (user.fainted || !alive("a") || !alive("b")) continue;
      // status gates: sleep / paralysis / freeze
      if (user.status) {
        const k = user.status.kind;
        if (k === "sleep") {
          if (user.status.turns > 0) { user.status.turns--; log.push(`${label(user)} is fast asleep.`); continue; }
          user.status = null; log.push(`${label(user)} woke up!`);
        } else if (k === "freeze" && Math.random() < 0.8) { log.push(`${label(user)} is frozen solid!`); continue; }
        else if (k === "freeze") { user.status = null; log.push(`${label(user)} thawed out!`); }
        else if (k === "paralysis" && Math.random() < 0.25) { log.push(`${label(user)} is paralyzed! It can't move!`); continue; }
      }
      const targets = targetsFor(user, move);
      if (!targets.length) { log.push(`${label(user)} used ${move.name}! But there was no target!`); continue; }
      log.push(`${label(user)} used ${move.name}!${targets.length > 1 ? ` (hits ${targets.length} Fakemon)` : ""}`);
      const spread = targets.length > 1 && (move.category !== "Status" || move.ohko) ? 0.75 : 1;
      let dealtAny = 0;
      for (const t of targets) dealtAny += hitTarget(user, t, move, spread);
      // weather-setting moves (damaging or status)
      if ((move.setsWeather || (move.category === "Status" && move.action === "weather")) && move.weather) setWeather(move.weather, num(move.weatherDuration, 5), `${user.f.name}'s ${move.name}`, move.pollutedPoisonChance);
      // recoil (after the move lands; Rock Head-style abilities ignore it)
      if (dealtAny > 0 && num(move.recoilPercent, 0) > 0 && !user.fainted && !(user.ability && user.ability.ignoresRecoil)) {
        hurt(user, dealtAny * move.recoilPercent / 100 * ((user.ability && user.ability.boostsRecoilMoves) ? 1 : 1), "is hit by recoil!");
      }
      if (move.selfFaint && !user.fainted) { log.push(`  ${label(user)} fainted from the blast!`); faint(user); }
      else if (!user.fainted) tryTransform(user, move.name, turns);
    }
    if (alive("a") && alive("b")) endOfTurn();
  }
  const winner = alive("a") && !alive("b") ? "a" : alive("b") && !alive("a") ? "b" : (teams.a.filter(s => !s.fainted).length >= teams.b.filter(s => !s.fainted).length ? "a" : "b");
  const remaining = { a: teams.a.filter(s => !s.fainted).length, b: teams.b.filter(s => !s.fainted).length };
  log.push(`🏆 ${DOUBLES_TEAMS[winner].emoji} ${DOUBLES_TEAMS[winner].name} team wins! (${remaining[winner]} Fakemon left standing, ${turns} turns)`);
  return { log, winner, turns, remaining, teamA: teams.a.map(s => s.f), teamB: teams.b.map(s => s.f) };
}

// Rolls two random 4-Fakemon teams from the roster and runs one 2v2 battle.
function runDoublesBattle(size, opts) {
  const teamA = buildRandomTeam(entries, size || 4), teamB = buildRandomTeam(entries, size || 4);
  if (!teamA.length || !teamB.length) return null;
  // Item Randomizer (see engine.js): item-gated transformations get their item most of the time
  const itemsA = typeof rollTeamItems === "function" ? rollTeamItems(teamA) : [], itemsB = typeof rollTeamItems === "function" ? rollTeamItems(teamB) : [];
  const res = simulateDoubles(teamA, teamB, { ...(opts || {}), itemsA, itemsB });
  res.itemsA = itemsA; res.itemsB = itemsB;
  return res;
}

// Draws the result into the Battle tab's results box (blue / red coloured log lines).
function renderDoublesResult(res, onAgain) {
  const box = (typeof battleResultsEl !== "undefined" && battleResultsEl) || document.getElementById("battleResults");
  if (!box) return;
  const esc2 = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const itemTag = id => { const it = id && typeof itemById === "function" ? itemById(id) : null; return it ? ` 🎒${it.name}` : ""; };
  const chip = (ids) => (en, i) => `<span class="type-pill" style="background:var(--t-${(en.types && en.types[0]) || "normal"});margin:2px 4px 2px 0;">${esc2(en.name)}${esc2(itemTag(ids && ids[i]))}</span>`;
  const colour = line => line.includes("🔵") && !line.includes("🔴") ? DOUBLES_TEAMS.a.color : line.includes("🔴") && !line.includes("🔵") ? DOUBLES_TEAMS.b.color
    : line.startsWith("  ") ? "" : "";
  const W = DOUBLES_TEAMS[res.winner];
  box.innerHTML = `
    <div class="battle-results">
      <div class="odds-verdict" style="color:${W.color};">${W.emoji} ${W.name} team wins — ${res.remaining[res.winner]} Fakemon left standing (${res.turns} turns)</div>
      <div style="margin:8px 0 4px;"><b style="color:${DOUBLES_TEAMS.a.color};">🔵 Blue</b> ${res.teamA.map(chip(res.itemsA)).join("")}</div>
      <div style="margin:4px 0 12px;"><b style="color:${DOUBLES_TEAMS.b.color};">🔴 Red</b> ${res.teamB.map(chip(res.itemsB)).join("")}</div>
      <div class="battle-log-title">Battle replay</div>
      <div class="battle-log">${res.log.map(line => { const c = colour(line); return `<div${c ? ` style="color:${c};"` : ""}>${esc2(line)}</div>`; }).join("")}</div>
      <button class="btn-secondary replay-btn" id="rerunDoublesBattleBtn">🎲 Roll Again</button>
    </div>`;
  const again = document.getElementById("rerunDoublesBattleBtn");
  if (again && onAgain) again.addEventListener("click", onAgain);
}