"use strict";

// ============================================================
// OFFICIAL MOVE + CREATURE-TAG MAPPING — PokéAPI data  ->  your modular move system.
//
// PokéAPI says nothing about contact/punch/bite/sound flags, self-destruct, counters, semi-invulnerable turns,
// weight/HP-scaled power etc., so on top of PokéAPI's own fields (power, ailments, stat changes, drain, recoil,
// multi-hit...) this file carries CURATED tables (by move slug) that switch on the matching engine feature:
//   selfFaint, recoilPercent, drainPercent, counterMove, delayedAttack, dynamicPower, weightScaling, damageBasis,
//   defStatBasis, statusDamageMultiplier, historyScaling, failCondition, stateImmunity (Fly/Dig/Dive/Protect...),
//   critRateMode, cooldownTurns (recharge), tags (+ tagRules for Powder), hazards, weather, terrain, utility effects.
// Every mapped move is stamped autoRule:true so the admin "Rebuild moves & tags" button can regenerate it later
// without touching a move someone edited by hand (the move editor doesn't carry that flag).
// ============================================================

const L = s => new Set(String(s).split(/\s+/).filter(Boolean));
const KNOWN_TYPES = () => (typeof TYPES !== "undefined" ? TYPES : []);
const en = list => (list || []).find(x => x.language && x.language.name === "en");
const clean = s => String(s || "").replace(/[\n\f\r\u00ad]+/g, " ").replace(/\s+/g, " ").trim();
const titleCase = s => String(s || "").split("-").map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(" ");
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Tag names exactly as they appear in your engine (Slash/Punch/Kick/Bite/Draining/Defending are the built-in ones).
// Rename here if you prefer different spellings for the extra ones.
export const TAG = { contact: "Contact", punch: "Punch", bite: "Bite", slash: "Slash", kick: "Kick", sound: "Sound", pulse: "Pulse",
  bullet: "Bullet", powder: "Powder", wind: "Wind", dance: "Dance", draining: "Draining", defending: "Defending" };

const TAG_SETS = {
  punch: L("bullet-punch comet-punch dizzy-punch drain-punch dynamic-punch fire-punch focus-punch hammer-arm ice-hammer ice-punch mach-punch mega-punch meteor-mash plasma-fists power-up-punch rage-fist shadow-punch sky-uppercut thunder-punch double-iron-bash jet-punch surging-strikes"),
  bite: L("bite crunch fire-fang fishious-rend hyper-fang ice-fang jaw-lock poison-fang psychic-fangs thunder-fang"),
  slash: L("aerial-ace air-cutter air-slash aqua-cutter behemoth-blade bitter-blade ceaseless-edge cross-poison cut fury-cutter leaf-blade mighty-cleave night-slash psyblade psycho-cut razor-leaf razor-shell sacred-sword secret-sword slash solar-blade stone-axe tachyon-cutter x-scissor kowtow-cleave"),
  kick: L("double-kick high-jump-kick jump-kick rolling-kick low-kick blaze-kick mega-kick triple-kick trop-kick axe-kick thunderous-kick stomp"),
  sound: L("boomburst bug-buzz chatter clanging-scales clangorous-soul confide disarming-voice echoed-voice eerie-spell grass-whistle growl heal-bell hyper-voice metal-sound noble-roar overdrive parting-shot perish-song relic-song roar round screech sing snarl snore supersonic uproar torch-song alluring-voice psychic-noise sparkling-aria howl"),
  pulse: L("aura-sphere dark-pulse dragon-pulse heal-pulse origin-pulse terrain-pulse water-pulse"),
  bullet: L("acid-spray aura-sphere barrage beak-blast bullet-seed egg-bomb electro-ball energy-ball focus-blast gyro-ball ice-ball magnet-bomb mist-ball mud-bomb octazooka pollen-puff pyro-ball rock-blast rock-wrecker searing-shot seed-bomb shadow-ball sludge-bomb weather-ball zap-cannon syrup-bomb"),
  powder: L("cotton-spore poison-powder powder rage-powder sleep-powder spore stun-spore magic-powder"),
  wind: L("air-cutter bleakwind-storm blizzard fairy-wind gust heat-wave hurricane icy-wind petal-blizzard sandsear-storm springtide-storm tailwind twister whirlwind wildbolt-storm"),
  dance: L("dragon-dance feather-dance fiery-dance lunar-dance petal-dance quiver-dance revelation-dance swords-dance teeter-dance victory-dance aqua-step")
};
// Physical moves that do NOT make contact (everything else physical does) + the few special moves that do.
const NON_CONTACT_PHYSICAL = L("earthquake magnitude bulldoze rock-slide rock-throw rock-blast rock-tomb rock-wrecker razor-leaf pin-missile spike-cannon twineedle bonemerang bullet-seed seed-bomb egg-bomb barrage icicle-spear icicle-crash ice-shard stone-edge fissure sand-tomb smack-down thousand-arrows thousand-waves dragon-darts shell-trap magnet-bomb precipice-blades fling explosion self-destruct poison-sting fell-stinger leaf-blade bone-rush last-respects steel-roller");
const CONTACT_SPECIAL = L("draining-kiss grass-knot infestation petal-dance trump-card wring-out");

// ---- mechanics tables ----
const SELF_FAINT = L("explosion self-destruct misty-explosion");
const CRIT_ALWAYS = L("frost-breath storm-throw wicked-blow surging-strikes flower-trick");
const RECHARGE = L("hyper-beam giga-impact blast-burn hydro-cannon frenzy-plant rock-wrecker roar-of-time prismatic-laser eternabeam meteor-assault");
const COUNTER = { "counter": { damageType: "physical", multiplier: 2 }, "mirror-coat": { damageType: "special", multiplier: 2 }, "metal-burst": { damageType: "any", multiplier: 1.5 } };
const DELAYED = L("future-sight doom-desire");
const DYNAMIC = {
  "electro-ball": { dynamicPower: "speedFaster", bp: 60 }, "gyro-ball": { dynamicPower: "speedSlower", bp: 60 },
  "heavy-slam": { dynamicPower: "weightRatio", bp: 60 }, "heat-crash": { dynamicPower: "weightRatio", bp: 60 },
  "flail": { dynamicPower: "userHpLow", bp: 200 }, "reversal": { dynamicPower: "userHpLow", bp: 200 },
  "eruption": { dynamicPower: "userHpHigh", bp: 150 }, "water-spout": { dynamicPower: "userHpHigh", bp: 150 }, "dragon-energy": { dynamicPower: "userHpHigh", bp: 150 },
  "crush-grip": { dynamicPower: "targetHpHigh", bp: 120 }, "wring-out": { dynamicPower: "targetHpHigh", bp: 120 },
  "low-kick": { weightScaling: "crushHeavy", bp: 60 }, "grass-knot": { weightScaling: "crushHeavy", bp: 60 }
};
const DEF_BASIS = L("psyshock psystrike secret-sword");
const STATUS_MULT = { "hex": { mult: 2, filter: "any", on: "target" }, "venoshock": { mult: 2, filter: "poison", on: "target" }, "facade": { mult: 2, filter: "any", on: "user" } };
const HISTORY = { "fury-cutter": "consecutiveUse", "rollout": "consecutiveUse", "ice-ball": "consecutiveUse", "echoed-voice": "totalHits", "revenge": "damageTaken", "avalanche": "damageTaken" };
const FAIL = { "fake-out": { failCondition: "notFirstTurn" }, "first-impression": { failCondition: "notFirstTurn" }, "sucker-punch": { failCondition: "opponentNotOffensive" }, "dream-eater": { failCondition: "targetNoStatus", failStatus: "sleep" } };
const STANCE = {   // semi-invulnerable turns (Fly/Dig/Dive...) — immune to everything except the listed exceptions, for the round
  "fly": { key: "airborne", exceptions: ["Gust", "Twister", "Thunder", "Sky Uppercut", "Hurricane", "Smack Down"] },
  "bounce": { key: "airborne", exceptions: ["Gust", "Twister", "Thunder", "Sky Uppercut", "Hurricane", "Smack Down"] },
  "dig": { key: "underground", exceptions: ["Earthquake", "Magnitude", "Fissure"] },
  "dive": { key: "underwater", exceptions: ["Surf", "Whirlpool"] },
  "shadow-force": { key: "shadow", exceptions: [] }, "phantom-force": { key: "shadow", exceptions: [] }
};
// Protect family = a one-turn "shield" effect (your hit-count barrier), with its contact punishment where the shield system has one.
const BATTLE_LEVEL = 50;     // Seismic Toss / Night Shade deal "the user's level": your engine has no levels, so they deal this
const PROTECT_SHIELDS = {
  "protect": {}, "detect": {},
  "spiky-shield": { reaction: "damage", value: 12.5 },
  "baneful-bunker": { reaction: "status", status: "poison" },
  "burning-bulwark": { reaction: "status", status: "burn" },
  "kings-shield": {}, "obstruct": {}, "silk-trap": {}          // their stat-drop-on-contact reaction isn't a shield reaction type
};
const SCREENS = { "reflect": "physical", "light-screen": "special", "aurora-veil": "any" };   // 5-turn barriers
const FIXED_DAMAGE = { "seismic-toss": { n: BATTLE_LEVEL }, "night-shade": { n: BATTLE_LEVEL }, "dragon-rage": { n: 40 }, "sonic-boom": { n: 20 },
  "super-fang": { pct: 50 }, "natures-madness": { pct: 50 }, "ruination": { pct: 50 } };
const SELF_SWITCH = { "u-turn": "switch", "volt-switch": "switch", "flip-turn": "switch", "parting-shot": "switch", "teleport": "switch", "baton-pass": "baton", "chilly-reception": "switch" };
const CHARGE = {   // two-turn moves: your chargeUp (charge turn, then it fires). skip = weather that removes the charge turn
  "solar-beam": { skip: "sun" }, "solar-blade": { skip: "sun" }, "razor-wind": {}, "skull-bash": { cond: "shielded" }, "sky-attack": {},
  "freeze-shock": {}, "ice-burn": {}, "geomancy": {}, "meteor-beam": {}, "electro-shot": { skip: "rain" },
  "fly": {}, "bounce": {}, "dig": {}, "dive": {}, "shadow-force": {}, "phantom-force": {}
};
const shieldNode = o => fxNode("shield", { target: "self", shieldHitCapacity: o.capacity, shieldDuration: o.duration, shieldTriggerType: o.trigger || "any", shieldTypeFilter: "any",
  shieldReaction: o.reaction || "none", shieldReactionValue: o.value, shieldReactionStatus: o.status, shieldReactionChance: 100, shieldReactionContactOnly: true });
const FIELD_ACTIONS = {
  "rain-dance": { action: "weather", weather: "rain" }, "sunny-day": { action: "weather", weather: "sun" }, "sandstorm": { action: "weather", weather: "sand" },
  "hail": { action: "weather", weather: "snow" }, "snowscape": { action: "weather", weather: "snow" },
  "electric-terrain": { action: "field", field: "electric" }, "grassy-terrain": { action: "field", field: "grassy" },
  "misty-terrain": { action: "field", field: "misty" }, "psychic-terrain": { action: "field", field: "psychic" },
  "stealth-rock": { action: "hazard", hazardType: "stealthrock" }, "spikes": { action: "hazard", hazardType: "spikes" },
  "transform": { action: "transform" }, "mimic": { action: "copyMove" }, "skill-swap": { action: "swapAbility" }, "role-play": { action: "copyAbility" },
  "entrainment": { action: "forceAbility" }, "chilly-reception": { action: "weather", weather: "snow" }, "trick": { action: "swapItem" }, "switcheroo": { action: "swapItem" }
};
const fxNode = (type, extra) => ({ type, chance: 100, target: "opponent", ...(extra || {}) });
const UTILITY_EFFECTS = {   // utility moves built from your effect nodes (only fields I verified in normalizeEffect are set)
  "leech-seed": [fxNode("persistentDrain", { drainResource: "hp", drainPercent: 12.5, drainDuration: 0, drainDirection: "targetToUser" })],
  "toxic-spikes": [fxNode("customHazard", { hzName: "Toxic Spikes", hzStacking: true, hzStatusEffect: "poison", hzStatusChance: 100 })],
  "sticky-web": [fxNode("customHazard", { hzName: "Sticky Web", hzStatKey: "spe", hzStatStage: -1 })],
  "substitute": [fxNode("substitute", { target: "self" })], "destiny-bond": [fxNode("bond", { target: "self" })],
  "perish-song": [fxNode("doom")], "wish": [fxNode("wish", { target: "self" })],
  "revival-blessing": [fxNode("reviveAlly", { target: "self", revivePct: 50 })],   // team battles: revives a fainted teammate at 50% HP
  "telekinesis": [fxNode("lift")], "magnet-rise": [fxNode("lift", { target: "self" })],
  "haze": [fxNode("clearstatmod", { target: "opponent" }), fxNode("clearstatmod", { target: "self" })],
  "rest": [fxNode("heal", { target: "self", healType: "percent", healValue: 100 }), fxNode("status", { target: "self", statusEffect: "sleep", statusDurationMode: "fixed", statusDurationFixed: 2 })],
  "rapid-spin": [fxNode("clearFieldHazards", { target: "self" })], "defog": [fxNode("clearFieldHazards", { target: "self" })],
  "heal-bell": [fxNode("clearStatusEffects", { target: "self" })], "aromatherapy": [fxNode("clearStatusEffects", { target: "self" })],
  "metronome": [fxNode("metronome", { target: "self" })], "snatch": [fxNode("snatch", { target: "self" })],
  "recycle": [fxNode("recycleItem", { target: "self" })], "psych-up": [fxNode("copyStats")],
  "memento": [fxNode("statmod", { statKey: "atk", statStage: -3 }), fxNode("statmod", { statKey: "spa", statStage: -3 })]
};
const AILMENT = { paralysis: "paralysis", burn: "burn", poison: "poison", sleep: "sleep", freeze: "freeze", frostbite: "frostbite", confusion: "confusion", infatuation: "infatuated" };
const STAT_MAP = { "attack": "atk", "defense": "def", "special-attack": "spa", "special-defense": "spd", "speed": "spe" };
const SELF_TARGETS = new Set(["user", "user-or-ally", "users-field", "ally", "all-allies", "user-and-allies", "all-other-pokemon-no"]);

export function slugOfMoveName(name) {
  return String(name || "").toLowerCase().replace(/['’.:]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function mapMoveRich(api, level, report) {
  report = report || {};
  ["fixedDamage", "partial", "noEffect"].forEach(k => { if (!report[k]) report[k] = new Set(); });
  const slug = api.name;
  const category = ({ physical: "Physical", special: "Special", status: "Status" })[api.damage_class && api.damage_class.name] || "Status";
  const dealsDamage = category !== "Status";
  const meta = api.meta || {};
  const metaCat = (meta.category && meta.category.name) || "";
  const typeName = api.type && api.type.name;
  const type = KNOWN_TYPES().includes(typeName) ? typeName : "normal";
  const effText = en(api.effect_entries);
  const desc = clean((effText && (effText.short_effect || effText.effect) || "").replace(/\$effect_chance/g, api.effect_chance != null ? api.effect_chance : ""))
    || clean((en(api.flavor_text_entries) || {}).flavor_text);
  const name = (en(api.names) || {}).name || titleCase(slug);

  const m = {
    name, level: Math.max(1, level || 1), type, category, desc,
    accuracy: api.accuracy == null ? 1 : clamp(api.accuracy / 100, 0, 1),
    maxPP: api.pp || 5,
    basePower: dealsDamage ? (api.power || 0) : 0,
    priority: clamp(api.priority || 0, -3, 3),
    effects: [], tags: [], autoRule: true
  };
  let handled = dealsDamage && api.power != null;     // for the "does nothing" audit of status / fixed-damage moves
  const mark = () => { handled = true; };

  // ---------------- generic fields straight from PokéAPI ----------------
  if (metaCat === "ohko") { m.ohko = true; mark(); }
  if (meta.crit_rate > 0) m.critRateMode = "high";
  if (CRIT_ALWAYS.has(slug)) m.critRateMode = "always";
  if (meta.max_hits && meta.max_hits > 1) {
    const lo = meta.min_hits || meta.max_hits;
    m.hits = clamp(Math.floor((lo + meta.max_hits) / 2), 1, 5);
    if (slug === "triple-kick" || slug === "triple-axel") { m.hits = 3; m.multiHitScaling = "rampUp"; m.multiHitScalingPct = 100; }
  }
  if (meta.drain < 0) m.recoilPercent = -meta.drain;
  if (meta.drain > 0) m.drainPercent = meta.drain;                       // needs engine.js drainPercent support (patched copy)
  if (SELF_FAINT.has(slug)) { m.selfFaint = true; mark(); }
  if (RECHARGE.has(slug)) m.cooldownTurns = 1;

  // ---------------- ailments / flinch ----------------
  const ailName = meta.ailment && meta.ailment.name;
  let status = AILMENT[ailName];
  if (status === "poison" && /^(toxic|poison-fang)$/.test(slug)) status = "badlyPoisoned";
  if (slug === "taunt") status = "taunt";
  if (status) {
    if (!dealsDamage) { m.action = "status"; m.statusEffect = status; mark(); }
    else if (meta.ailment_chance > 0) m.effects.push({ type: "status", chance: meta.ailment_chance, target: "opponent", statusEffect: status, statusDurationMode: "random", statusDurationMin: 2, statusDurationMax: 4 });
  } else if (ailName && ailName !== "none" && !(slug in UTILITY_EFFECTS) && !(slug in FIELD_ACTIONS)) {
    report.partial.add(name);                                             // trap / disable / heal-block / embargo...: not in the status list
  }
  if (meta.flinch_chance > 0) m.effects.push({ type: "status", chance: meta.flinch_chance, target: "opponent", statusEffect: "flinch", statusDurationMode: "fixed", statusDurationFixed: 1 });

  // ---------------- healing ----------------
  if (!dealsDamage && meta.healing > 0) { m.action = "heal"; m.healType = "percent"; m.healValue = meta.healing; m.healTarget = "self"; mark(); }

  // ---------------- stat stages (who gets them: PokéAPI's move category + target) ----------------
  const tgt = api.target && api.target.name;
  const statsOnSelf = dealsDamage ? metaCat === "damage+raise" : (SELF_TARGETS.has(tgt) || tgt === "user");
  (api.stat_changes || []).forEach(sc => {
    const statName = sc.stat && sc.stat.name;
    // ---- accuracy / evasion stages -> the engine's "Modify Accuracy" effect (Sand Attack-style), ~25% per stage ----
    //   accuracy change on a creature  = that creature's OWN accuracy changes
    //   evasion  change on a creature  = the OPPONENT's accuracy changes the other way (Double Team: foe accuracy drops)
    if (statName === "accuracy" || statName === "evasion") {
      if (!sc.change) return;
      const chance = dealsDamage ? (meta.stat_chance || 100) : 100;
      let acTarget, acValue;
      if (statName === "accuracy") { acTarget = statsOnSelf ? "self" : "opponent"; acValue = sc.change * 25; }
      else { acTarget = statsOnSelf ? "opponent" : "self"; acValue = -sc.change * 25; }
      m.effects.push({ type: "accuracyMod", chance, target: acTarget, accuracyModValue: clamp(acValue, -100, 100) });
      mark();
      return;
    }
    const key = STAT_MAP[statName];
    if (!key) { report.partial.add(name); return; }
    if (!sc.change) return;
    m.effects.push({ type: "statmod", chance: dealsDamage ? (meta.stat_chance || 100) : 100, target: statsOnSelf ? "self" : "opponent", statKey: key, statStage: clamp(sc.change, -3, 3) });
    mark();
  });

  // ---------------- curated mechanic tables ----------------
  if (COUNTER[slug]) { m.counterMove = { enabled: true, ...COUNTER[slug] }; m.basePower = 0; mark(); }
  if (DELAYED.has(slug)) { m.delayedAttack = { enabled: true, delayTurns: 2, statSnapMode: "launch", ignoreTypeImmunity: false, effectTiming: "cast" }; mark(); }
  if (DYNAMIC[slug]) { const d = DYNAMIC[slug]; if (d.dynamicPower) m.dynamicPower = d.dynamicPower; if (d.weightScaling) m.weightScaling = d.weightScaling; m.basePower = d.bp; mark(); }
  if (slug === "body-press") { m.damageBasis = "defense"; mark(); }
  if (DEF_BASIS.has(slug)) m.defStatBasis = "def";
  if (STATUS_MULT[slug]) { const s = STATUS_MULT[slug]; m.statusDamageMultiplier = s.mult; m.statusDamageMultFilter = s.filter; m.statusDamageMultOn = s.on; }
  if (HISTORY[slug]) m.historyScaling = HISTORY[slug];
  if (FAIL[slug]) Object.assign(m, FAIL[slug]);
  if (STANCE[slug]) { m.stateImmunity = { enabled: true, key: STANCE[slug].key, exceptions: STANCE[slug].exceptions.slice(), expireEvent: "onAttack", expireDurationTurns: 2 }; }
  if (PROTECT_SHIELDS[slug]) {
    m.effects.push(shieldNode({ capacity: 99, duration: 1, ...PROTECT_SHIELDS[slug] }));
    m.priority = 3; m.consecutiveFail = true; m.tags.push(TAG.defending); mark();
  }
  if (SCREENS[slug]) {
    m.effects.push(shieldNode({ capacity: 4, duration: 5, trigger: SCREENS[slug] })); m.tags.push(TAG.defending);
    if (slug === "aurora-veil") { m.failCondition = "weatherIsNot"; m.failWeather = "snow"; }
    mark();
  }
  if (FIXED_DAMAGE[slug]) { const f = FIXED_DAMAGE[slug]; if (f.n) m.fixedDamage = f.n; if (f.pct) m.fixedDamagePct = f.pct; m.basePower = 1; mark(); }
  if (SELF_SWITCH[slug]) { m.selfSwitch = SELF_SWITCH[slug]; mark(); }
  if (CHARGE[slug]) {
    const c = CHARGE[slug];
    m.chargeUp = { enabled: true, duration: 1, condition: c.cond || "none", shieldPercent: 50, healPercent: 25, skipInWeather: c.skip || "none" };
    mark();
  }
  if (FIELD_ACTIONS[slug]) {
    const f = FIELD_ACTIONS[slug]; Object.assign(m, f);
    if (f.weather) m.weatherDuration = 5; if (f.field) m.fieldDuration = 5; mark();
  }
  if (UTILITY_EFFECTS[slug]) { UTILITY_EFFECTS[slug].forEach(e => m.effects.push({ ...e })); mark(); }

  // ---------------- tags ----------------
  Object.keys(TAG_SETS).forEach(k => { if (TAG_SETS[k].has(slug)) m.tags.push(TAG[k]); });
  if ((category === "Physical" && !NON_CONTACT_PHYSICAL.has(slug) && !TAG_SETS.bullet.has(slug) && !TAG_SETS.sound.has(slug)) || CONTACT_SPECIAL.has(slug)) m.tags.push(TAG.contact);
  if (m.drainPercent > 0) m.tags.push(TAG.draining);
  if (TAG_SETS.powder.has(slug)) m.tagRules = [{ tag: TAG.powder, effect: "powderImmune", convertType: "steel" }];
  m.tags = [...new Set(m.tags)];

  // ---------------- audit ----------------
  if (dealsDamage && api.power == null && !handled) report.fixedDamage.add(name);
  if (!dealsDamage && !handled && !m.effects.length && !m.stateImmunity) report.noEffect.add(name);
  return m;
}

// ---------------- creature (Pokémon) tags + gender pool ----------------
const GROUNDED_NAMES = L("diglett dugtrio wiglett wugtrio");     // buried in the ground (engine: "grounded" tag)
/** species = PokéAPI pokemon-species, abilities = the entry's ability list [{name,hidden}] */
export function creatureTagsFor(speciesName, species, abilities) {
  const tags = [];
  const base = String(speciesName || "").toLowerCase().replace(/^(alolan|galarian|hisuian|paldean)\s+/, "");
  if (GROUNDED_NAMES.has(base)) tags.push("grounded");
  if ((abilities || []).some(a => !a.hidden && String(a.name).toLowerCase() === "levitate")) tags.push("levitating");
  if (species) {
    if (species.is_legendary) tags.push("legendary");
    if (species.is_mythical) tags.push("mythical");
    if (species.is_baby) tags.push("baby");
  }
  return tags;
}
export function genderPoolFor(species) {
  if (!species || species.gender_rate == null) return "Genderless";
  if (species.gender_rate === -1) return "Genderless";
  if (species.gender_rate === 0) return "Male";
  if (species.gender_rate === 8) return "Female";
  return "Both";
}