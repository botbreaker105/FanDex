"use strict";

// ============================================================
// OFFICIAL ABILITY RULES — maps PokéAPI ability names onto the engine's REAL ability mechanics
// (engine.js: immuneToType, negateStatMod, ignoresRecoil, passive rules, active rules).
//
// Only abilities whose official behaviour matches an engine feature are mapped. Everything else is flagged
// descOnly:true — description text only, no battle effect — instead of silently carrying the engine's default
// rule ("Negate Damage on battle start"), which is what made every imported ability look identical in the Ability Dex.
// Mapped ones carry autoRule:true so the "Rebuild abilities" admin button knows they're safe to regenerate and
// never touches an ability an admin edited by hand.
// ============================================================

const P = (passive, extra) => ({ abilityType: "passive", passive, ...(extra || {}) });
const A = active => ({ abilityType: "active", active });
const IMMUNE = t => ({ abilityType: "passive", immuneToType: t });
const weather = w => P({ trigger: "battleStart", action: "setWeather", weatherSet: w, weatherSetDuration: 5 });
const field = f => P({ trigger: "battleStart", action: "setField", fieldSet: f, fieldSetDuration: 5 });
const tagBoost = (tag, m) => P({ trigger: "always", action: "boostTagMove", boostTagFilter: tag, boostTagMultiplier: m });
const typeSwap = (from, to) => P({ trigger: "always", action: "moveTypeOverride", moveTypeFrom: from, moveTypeTo: to, moveTypeBoost: 1.2 });
// Contact reactions: "When Receiving a Move With Tag [Contact]" (hitByTag). The status / stat drop / doom is an Additional Effect of the
// ability, aimed at the OPPONENT (= the attacker, from the ability owner's point of view). tagStatMod with a 0-stage change is the carrier.
const fxA = (type, extra) => ({ type, chance: 100, target: "opponent", ...(extra || {}) });
const statusFx = (st, chance) => fxA("status", { chance, statusEffect: st, statusDurationMode: "random", statusDurationMin: 2, statusDurationMax: 4 });
// ---- matrix helpers (WHO / WHAT / WHEN / HOW effect nodes on the ability's own effects list) ----
const mx = extra => ({ type: "matrix", chance: 100, who: "self", what: "statChange", when: "onMoveSelect", matrixStatKey: "atk", matrixMagnitude: 1, ...extra });
const FX = (effects, extra) => ({ abilityType: "passive", passive: { trigger: "always", action: "none" }, effects, ...(extra || {}) });
const hitBy = (type, stat, mag) => mx({ when: "onHitByType", matrixTypeFilter: type, matrixStatKey: stat, matrixMagnitude: mag });
const cure = st => mx({ what: "negateStatus", when: "onStatusActive", matrixStatusFilter: st });
const onContact = (chance, effects) => ({ abilityType: "passive", passive: { trigger: "hitByTag", hitTagFilter: "Contact", chance, action: "tagStatMod", statKey: "spe", statStage: 0 }, effects });
const contactChip = pct => ({ abilityType: "passive", passive: { trigger: "hitByTag", hitTagFilter: "Contact", chance: 100, action: "reflectDamage", reflectType: "percent", reflectValue: pct } });
const lowHp = (type) => A({ condition: "hpBelow33", action: "boostType", boostTypeTargets: [type], multiplier: 1.5 });

const RULES = {
  // ---- type immunities (the absorb abilities' healing half isn't modelled; the immunity is) ----
  "levitate": IMMUNE("ground"), "earth eater": IMMUNE("ground"),
  "volt absorb": IMMUNE("electric"), "lightning rod": IMMUNE("electric"), "motor drive": IMMUNE("electric"),
  "water absorb": IMMUNE("water"), "storm drain": IMMUNE("water"), "dry skin": IMMUNE("water"),
  "flash fire": IMMUNE("fire"), "well-baked body": IMMUNE("fire"), "sap sipper": IMMUNE("grass"),

  // ---- defensive ----
  "wonder guard": P({ trigger: "always", action: "wonderGuard" }, { lockAbility: true }),
  "thick fat": P({ trigger: "defending", action: "resistanceMult", resistRatio: 0.5, affectedTypes: ["fire", "ice"] }),
  "heatproof": P({ trigger: "defending", action: "resistanceMult", resistRatio: 0.5, affectedTypes: ["fire"] }),
  "filter": P({ trigger: "defending", action: "reduceSuperEffective", protectPercent: 25 }),
  "solid rock": P({ trigger: "defending", action: "reduceSuperEffective", protectPercent: 25 }),
  "prism armor": P({ trigger: "defending", action: "reduceSuperEffective", protectPercent: 25 }),
  "sturdy": P({ trigger: "always", action: "ohkoGuard", ohkoGuardHpPct: 100 }),               // OHKO-move immunity half only
  "clear body": { abilityType: "passive", negateStatMod: "blockDebuffs" },
  "white smoke": { abilityType: "passive", negateStatMod: "blockDebuffs" },
  "full metal body": { abilityType: "passive", negateStatMod: "blockDebuffs" },
  "contrary": { abilityType: "passive", negateStatMod: "contrary" },
  "rock head": { abilityType: "passive", ignoresRecoil: true },
  "reckless": { abilityType: "passive", boostsRecoilMoves: true },

  // ---- offensive ----
  "iron fist": tagBoost("punch", 1.2), "strong jaw": tagBoost("bite", 1.5), "sharpness": tagBoost("slash", 1.5),
  "normalize": typeSwap("any", "normal"),
  "aerilate": typeSwap("normal", "flying"), "pixilate": typeSwap("normal", "fairy"),
  "refrigerate": typeSwap("normal", "ice"), "galvanize": typeSwap("normal", "electric"),
  "blaze": lowHp("fire"), "overgrow": lowHp("grass"), "torrent": lowHp("water"), "swarm": lowHp("bug"),
  "adaptability": A({ condition: "stabMatch", action: "boostDamageCustom", multiplier: 1.33 }),   // STAB 1.5x -> 2x
  "tinted lens": A({ condition: "onHitting", hitEffectiveness: "notVeryEffective", action: "boostDamageCustom", multiplier: 2 }),
  "neuroforce": A({ condition: "onHitting", hitEffectiveness: "superEffective", action: "boostDamageCustom", multiplier: 1.25 }),

  // ---- contact reactions (need Contact-tagged moves: see official-moves.js) ----
  "static": onContact(30, [statusFx("paralysis", 100)]),
  "flame body": onContact(30, [statusFx("burn", 100)]),
  "poison point": onContact(30, [statusFx("poison", 100)]),
  "cute charm": onContact(30, [statusFx("infatuated", 100)]),
  "effect spore": onContact(100, [statusFx("poison", 10), statusFx("paralysis", 10), statusFx("sleep", 10)]),
  "rough skin": contactChip(12.5), "iron barbs": contactChip(12.5),
  "gooey": onContact(100, [fxA("statmod", { statKey: "spe", statStage: -1 })]),
  "tangling hair": onContact(100, [fxA("statmod", { statKey: "spe", statStage: -1 })]),
  "perish body": onContact(100, [fxA("doom")]),

  // ---- reactions ----
  "competitive": P({ trigger: "statLowered", action: "modifyStat", statKey: "spa", statStage: 2, statLoweredSource: "opponent" }),
  "defiant": P({ trigger: "statLowered", action: "modifyStat", statKey: "atk", statStage: 2, statLoweredSource: "opponent" }),

  // ---- field / weather setters ----
  "drizzle": weather("rain"), "drought": weather("sun"), "sand stream": weather("sand"), "snow warning": weather("snow"),
  "delta stream": weather("strongwinds"),
  "electric surge": field("electric"), "grassy surge": field("grassy"), "misty surge": field("misty"), "psychic surge": field("psychic"),

  // ---- turn / switching ----
  "truant": P({ trigger: "always", action: "loafAround", loafInterval: 2, loafStartsActive: true }),
  "slow start": P({ trigger: "battleStart", action: "slowStart" }),
  "shadow tag": P({ trigger: "always", action: "trapSwitch", trapScope: "all" }),
  "magnet pull": P({ trigger: "always", action: "trapSwitch", trapScope: "types", trapTypes: ["steel"] }),

  // ======== second wave: built from your WHO/WHAT/WHEN matrix, weather-speed, priority-block and knock-out hooks ========
  // (entries below override any earlier entry with the same name)

  // ---- speed that depends on weather / terrain (engine.js: weatherSpeedMult) ----
  "chlorophyll": P({ trigger: "always", action: "weatherSpeedMult", weatherCondition: "sun", speedMultiplier: 2 }),
  "swift swim": P({ trigger: "always", action: "weatherSpeedMult", weatherCondition: "rain", speedMultiplier: 2 }),
  "sand rush": P({ trigger: "always", action: "weatherSpeedMult", weatherCondition: "sand", speedMultiplier: 2 }),
  "slush rush": P({ trigger: "always", action: "weatherSpeedMult", weatherCondition: "snow", speedMultiplier: 2 }),
  "surge surfer": P({ trigger: "always", action: "weatherSpeedMult", speedFieldCondition: "electric", speedMultiplier: 2 }),

  // ---- blocks the foe's priority moves (engine.js: blockPriority) ----
  "dazzling": P({ trigger: "always", action: "blockPriority" }),
  "queenly majesty": P({ trigger: "always", action: "blockPriority" }),
  "armor tail": P({ trigger: "always", action: "blockPriority" }),

  // ---- weather-conditional healing ----
  "rain dish": P({ trigger: "weatherActive", weatherCondition: "rain", action: "heal", healType: "percent", healValue: 6.25, healTarget: "self" }),
  "ice body": P({ trigger: "weatherActive", weatherCondition: "snow", action: "heal", healType: "percent", healValue: 6.25, healTarget: "self" }),
  "dry skin": P({ trigger: "weatherActive", weatherCondition: "rain", action: "heal", healType: "percent", healValue: 12.5, healTarget: "self" }, { immuneToType: "water" }),

  // ---- knock-out boosts (matrix WHEN onKnockOut) ----
  "moxie": FX([mx({ when: "onKnockOut", matrixStatKey: "atk", matrixMagnitude: 1 })]),
  "chilling neigh": FX([mx({ when: "onKnockOut", matrixStatKey: "atk", matrixMagnitude: 1 })]),
  "grim neigh": FX([mx({ when: "onKnockOut", matrixStatKey: "spa", matrixMagnitude: 1 })]),
  "beast boost": FX([mx({ when: "onKnockOut", matrixStatKey: "atk", matrixMagnitude: 1 })]),          // really "highest stat"; Attack here

  // ---- every-turn ramp ----
  "speed boost": FX([mx({ when: "onMoveSelect", matrixStatKey: "spe", matrixMagnitude: 1 })]),

  // ---- entry effects ----
  "intimidate": { abilityType: "passive", passive: { trigger: "battleStart", action: "none" }, effects: [fxA("statmod", { statKey: "atk", statStage: -1 })] },
  "intrepid sword": P({ trigger: "battleStart", action: "modifyStat", statKey: "atk", statStage: 1 }),
  "dauntless shield": P({ trigger: "battleStart", action: "modifyStat", statKey: "def", statStage: 1 }),
  "huge power": P({ trigger: "battleStart", action: "modifyStat", statKey: "atk", statStage: 2 }),       // +2 stages = the x2 Attack
  "pure power": P({ trigger: "battleStart", action: "modifyStat", statKey: "atk", statStage: 2 }),
  "imposter": P({ trigger: "battleStart", action: "transformOnEntry" }),
  "serene grace": P({ trigger: "always", action: "secondaryChanceMult", secondaryChanceMultiplier: 2 }),

  // ---- stat boost when hit by a type (matrix WHEN onHitByType); absorbers also keep their immunity ----
  "justified": FX([hitBy("dark", "atk", 1)]),
  "water compaction": FX([hitBy("water", "def", 2)]),
  "thermal exchange": FX([hitBy("fire", "atk", 1)]),
  "steam engine": FX([hitBy("fire", "spe", 6), hitBy("water", "spe", 6)]),
  "rattled": FX([hitBy("bug", "spe", 1), hitBy("ghost", "spe", 1), hitBy("dark", "spe", 1)]),
  "lightning rod": FX([hitBy("electric", "spa", 1)], { immuneToType: "electric" }),
  "motor drive": FX([hitBy("electric", "spe", 1)], { immuneToType: "electric" }),
  "storm drain": FX([hitBy("water", "spa", 1)], { immuneToType: "water" }),
  "sap sipper": FX([hitBy("grass", "atk", 1)], { immuneToType: "grass" }),
  "well-baked body": FX([hitBy("fire", "def", 2)], { immuneToType: "fire" }),

  // ---- cures its own status condition (matrix negateStatus, re-checked every round) ----
  "limber": FX([cure("paralysis")]),
  "insomnia": FX([cure("sleep")]), "vital spirit": FX([cure("sleep")]), "sweet veil": FX([cure("sleep")]),
  "immunity": FX([cure("poison"), cure("badlyPoisoned")]), "pastel veil": FX([cure("poison"), cure("badlyPoisoned")]),
  "water veil": FX([cure("burn")]), "water bubble": FX([cure("burn")]),
  "magma armor": FX([cure("freeze"), cure("frostbite")]),
  "own tempo": FX([cure("confusion")]), "oblivious": FX([cure("infatuated")]),
  "purifying salt": FX(["paralysis", "burn", "poison", "badlyPoisoned", "sleep", "freeze", "frostbite", "confusion"].map(cure)),

  // ======== third wave: abilities that map onto engine features you already have ========
  // Abilities marked "(partial)" copy the main effect only; the rest of the official text stays in the description.

  // ---- move-tag immunities (hitByTag + negateTaggedMove: blocks the move completely) ----
  "soundproof": P({ trigger: "hitByTag", hitTagFilter: "Sound", chance: 100, action: "negateTaggedMove" }),
  "bulletproof": P({ trigger: "hitByTag", hitTagFilter: "Bullet", chance: 100, action: "negateTaggedMove" }),
  "overcoat": P({ trigger: "hitByTag", hitTagFilter: "Powder", chance: 100, action: "negateTaggedMove" }),             // (partial) powder half only
  "wind rider": P({ trigger: "hitByTag", hitTagFilter: "Wind", chance: 100, action: "tagStatMod", statKey: "atk", statStage: 1 }), // (partial) +1 Atk half only

  // ---- damage taken / dealt by move tag ----
  "fluffy": P({ trigger: "defending", action: "tagDamageMult", tagFilter: "Contact", tagMultiplier: 0.5 }),               // (partial) contact half only
  "mega launcher": tagBoost("pulse", 1.5),
  "tough claws": tagBoost("contact", 1.3),
  "punk rock": tagBoost("sound", 1.3),                                                                                    // (partial) boost half only
  "steelworker": tagBoost("steel", 1.5), "steely spirit": tagBoost("steel", 1.5),
  "dragon's maw": tagBoost("dragon", 1.5), "dragon\u2019s maw": tagBoost("dragon", 1.5),
  "transistor": tagBoost("electric", 1.5),
  "rocky payload": tagBoost("rock", 1.5),
  "dragonize": typeSwap("normal", "dragon"),                                                                              // Normal moves become Dragon (+boost)

  // ---- reactions when hit ----
  "stamina": P({ trigger: "afterHit", action: "modifyStat", statKey: "def", statStage: 1 }),
  "cotton down": { abilityType: "passive", passive: { trigger: "afterHit", action: "none" }, effects: [fxA("statmod", { statKey: "spe", statStage: -1 })] },
  "spicy spray": { abilityType: "passive", passive: { trigger: "afterHit", action: "none" }, effects: [statusFx("burn", 100)] },
  "poison touch": { abilityType: "passive", passive: { trigger: "onHitTag", hitTagFilter: "Contact", action: "none" }, effects: [statusFx("poison", 30)] },

  // ---- first-hit shield (engine: Active condition "hpFull" + negateDamage) ----
  "disguise": A({ condition: "hpFull", action: "negateDamage" }),
  "ice face": A({ condition: "hpFull", action: "negateDamage" }),                                                       // (partial) real one only blocks physical hits

  // ---- entry stat drops on the foe (the "Ruin" abilities; -1 stage is the closest engine equivalent) ----
  "sword of ruin": { abilityType: "passive", passive: { trigger: "battleStart", action: "none" }, effects: [fxA("statmod", { statKey: "def", statStage: -1 })] },
  "beads of ruin": { abilityType: "passive", passive: { trigger: "battleStart", action: "none" }, effects: [fxA("statmod", { statKey: "spd", statStage: -1 })] },
  "tablets of ruin": { abilityType: "passive", passive: { trigger: "battleStart", action: "none" }, effects: [fxA("statmod", { statKey: "atk", statStage: -1 })] },
  "vessel of ruin": { abilityType: "passive", passive: { trigger: "battleStart", action: "none" }, effects: [fxA("statmod", { statKey: "spa", statStage: -1 })] },

  // ---- weather / terrain on entry ----
  "desolate land": P({ trigger: "battleStart", action: "blockMoveType", blockType: "water", blockWeather: "sun" }),
  "primordial sea": P({ trigger: "battleStart", action: "blockMoveType", blockType: "fire", blockWeather: "rain" }),
  "orichalcum pulse": weather("sun"),                                                                                     // (partial) sets the sun only
  "hadron engine": field("electric"),                                                                                     // (partial) sets the terrain only

  // ---- recovery ----
  "regenerator": P({ trigger: "onSwitchOut", action: "heal", healType: "percent", healValue: 33, healTarget: "self" }),
  "shed skin": FX(["paralysis", "burn", "poison", "badlyPoisoned", "sleep", "freeze", "frostbite"].map(st => ({ ...cure(st), chance: 33 })))
};

/** Takes { name, desc, hidden } and returns it with a real rule (autoRule:true) or flagged descOnly:true. */
export function applyAbilityRules(ability) {
  const base = { name: ability.name, desc: ability.desc || "", hidden: !!ability.hidden };
  const rule = RULES[String(ability.name || "").trim().toLowerCase()];
  if (!rule) return { ...base, descOnly: true };
  return { ...base, ...JSON.parse(JSON.stringify(rule)), descOnly: false, autoRule: true };
}

/** Has nobody hand-edited this ability? (still the engine default, or one of ours) — only those are safe to regenerate. */
export function isRegenerable(a) {
  if (!a) return false;
  if (a.autoRule || a.descOnly) return true;
  const p = a.passive || {};
  const isDefault = (a.abilityType || "passive") === "passive" && (!a.passive || (p.trigger === "battleStart" && p.action === "negateDamage" && p.filterType === "any"))
    && (!a.immuneToType || a.immuneToType === "none") && (!a.negateStatMod || a.negateStatMod === "none")
    && !a.ignoresRecoil && !a.boostsRecoilMoves && !(a.effects && a.effects.length) && !a.manualCast;
  return isDefault;
}

export const MAPPED_ABILITY_NAMES = Object.keys(RULES);