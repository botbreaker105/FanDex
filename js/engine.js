"use strict";

// ================= ITEM DEX =================
// Each item is a small declarative object the battle engine reads at runtime:
//   id       — stable unique key, used as the <select> option value
//   name     — display name
//   type     — "held" (stays for the whole battle) or "consumable" (used once, then removed)
//   trigger  — when the engine should check this item:
//              "battleStart" | "onUse" | "turnEnd" | "onHpThreshold" (not move-specific), or
//              "onTakeDamage" (fires off a move used AGAINST the holder) |
//              "onDealDamage" (fires off a move the holder itself just used)
//              battleStart and onUse both fire once, right as the holder enters the fight, and are
//              interchangeable mechanically — battleStart reads as "this held item is already active",
//              onUse reads as "this item gets eaten/activated right now" (a food item, a one-shot
//              charm). Both fully support heal/boostStat/cureStatus/boostDamage.
//   action   — what it does: "heal" | "boostStat" | "preventFaint" | "recoil" | "cureStatus" | "boostDamage"
//              boostDamage means two different things depending on trigger: on onDealDamage it's a
//              one-shot bonus tacked onto the hit that just landed (Fire Gem-style); on battleStart/
//              onUse it instead ARMS a timed, Move-Filter-scoped outgoing-damage boost for the rest of
//              the fight (see boostDurationTurns below and armItemTimedDamageBoost in the sim core).
//   value    — numeric magnitude for the action (percent of max HP, stat stages, damage multiplier, etc.)
//   priority — effect ordering within THIS item's own effects[] list. Lower fires first (default 0);
//              use it to make a "2nd effect" reliably resolve after a "1st effect" whenever both are
//              eligible at the same trigger moment (e.g. cure a status before healing). Ties keep the
//              order the effects were added in. See effectsByPriority() in the sim core.
//   boostDurationTurns — ONLY read when action is "boostDamage" fired from battleStart/onUse: how long
//              the armed damage boost lasts. 0 (or blank) = infinite, lasts the rest of the battle;
//              any positive N = expires after N turns, counted down at the end of every round. Ignored
//              for onDealDamage's boostDamage (that one is already a single instant, so it has nothing
//              to time out).
//   filterKind  — "none" | "type" | "tag": restricts an onTakeDamage/onDealDamage trigger to only fire
//                 when the relevant MOVE matches. "type" checks the move's elemental type (e.g. "fire");
//                 "tag" checks the move's tags array (e.g. "contact", "projectile", "blade"). Ignored
//                 (treated as "none") for triggers that aren't tied to a specific move.
//   filterValue — the type name or tag string to match against, used only when filterKind isn't "none"
//   holderFilterKind/holderFilterValue — a SECOND, independent filter: same "none"|"type"|"tag" shape,
//                 but checked against the ITEM HOLDER's own Type or Creature Tag instead of the move
//                 (e.g. "only works if the holder IS a Water type"). Works on every effect/trigger, not
//                 just move-based ones. Both filters can be set on the same effect at once — it only
//                 fires when BOTH pass. See matchesHolderFilter() vs. matchesMoveFilter().
//   desc     — human-readable summary, shown in the Item Dex UI
//
// ---- Multi-Effect Builder / Consumable Charges / Immunities (post-13 additions) ----
//   effects  — the item's action list. Each entry is the old {trigger,action,value,filterKind,filterValue}
//              shape, but an item can now carry MANY of them (Heal + Stat Boost + Cure Status + Type
//              Boost all on one item), the same "+ Add Effect" pattern Moves/Abilities already use.
//              Legacy single-effect items (saved before this existed) are migrated into a 1-entry array
//              by normalizeItem() the moment they're loaded, so nothing on disk needs to change by hand.
//   maxUses  — Max Uses per Battle. 0 (or blank) means unlimited/every-turn (Leftovers, Rocky Helmet);
//              any positive N caps the item to N total activations for the whole battle, across ALL of
//              its effects combined, tracked at runtime as itemState[side].usesLeft and surfaced in the
//              battle log as "[Item] (x/n)". Once it hits 0 the item is depleted and stops firing.
//   immunities — passive protection granted just by holding the item, checked independently of the
//              effects/charges system above: { freeze,poison,burn,paralysis,sleep, hazard } booleans.
//
// ---- Terastallization Engine (Manual Activation / "ON_USER_INTENT" additions) ----
//   trigger: "onUserIntent" — a NEW category alongside battleStart/onUse/turnEnd/onHpThreshold/
//              onTakeDamage/onDealDamage above. It marks an effect as a MANUAL ACTIVATION: something
//              the holder's side chooses to pop off during turn selection (before a move is picked),
//              rather than something the engine fires automatically off a passive condition. Because
//              this simulator auto-resolves whole battles rather than prompting per turn, "the player
//              chooses to activate it" is modeled as "this side activates it the first legal turn it
//              can" — see activateTeraState()/tryTerastallize() in the sim core. It still only ever
//              fires ONCE per battle (maxUses effectively pinned to 1) and consumes that turn's
//              transformation allowance exactly like a Mega Evolution does.
//   teraType — (only meaningful on an onUserIntent effect) the Type this item overrides the holder's
//              typing to the instant it activates — "fire", "stellar", etc. "stellar" is a special
//              case: it does NOT replace the holder's own types for defensive type-chart purposes, but
//              DOES grant the boosted own-type STAB behavior below on every move the holder knows.
//   teraMove — (optional) a Dynamic Move Injector: a partial Move object temporarily added to the
//              holder's movepool for the rest of the battle the moment this item activates. Its `type`
//              is live-recalculated every time it's used to always match the holder's CURRENT teraType
//              (see buildTeraBlastMove()), and its `category` is recalculated the same way from
//              whichever of the holder's Attack/Sp. Atk is currently higher — exactly like Tera Blast.
//              Injection never mutates the holder's base/stored movepool (see injectTemporaryMove()):
//              it's appended only to this battle's throwaway fighters[side].moves clone, so re-running
//              the same Pokémon in another trial/battle starts with its untouched base moveset again.
const DEFAULT_ITEMS = [
  {
    id: "leftovers", name: "Leftovers", type: "held", maxUses: 0, immunities: {}, desc: "Restores 1/16th of the holder's Max HP at the end of every turn.",
    effects: [{ trigger: "turnEnd", action: "heal", value: 1 / 16, filterKind: "none", filterValue: "" }]
  },
  {
    id: "focussash", name: "Focus Sash", type: "held", maxUses: 1, immunities: {}, desc: "If the holder is at full HP and would faint from one hit, it survives with 1 HP instead. Works once per battle.",
    effects: [{ trigger: "onTakeDamage", action: "preventFaint", value: 1, filterKind: "none", filterValue: "" }]
  },
  {
    id: "sitrusberry", name: "Sitrus Berry", type: "consumable", maxUses: 1, immunities: {}, flavor: "Sweet", desc: "When the holder's HP drops below 50%, it's consumed to restore 25% of its Max HP. A Sweet-flavored Berry — picky eaters react accordingly.",
    effects: [{ trigger: "onHpThreshold", action: "heal", value: 0.25, filterKind: "none", filterValue: "" }]
  },
  {
    id: "choicescarf", name: "Choice Scarf", type: "held", maxUses: 1, immunities: {}, flavor: "none", desc: "Boosts the holder's Speed stat stage by +2 the moment the battle begins.",
    effects: [{ trigger: "battleStart", action: "boostStat", value: 2, filterKind: "none", filterValue: "" }]
  },
  {
    id: "lumberry", name: "Lum Berry", type: "consumable", maxUses: 1, immunities: {}, flavor: "Bitter", desc: "Cures the holder's status condition the first time it takes damage while afflicted. A Bitter-flavored Berry.",
    effects: [{ trigger: "onHpThreshold", action: "cureStatus", value: 1, filterKind: "none", filterValue: "" }]
  },
  {
    id: "rockyhelmet", name: "Rocky Helmet", type: "held", maxUses: 0, immunities: {}, desc: "Whenever the holder is hit by a [contact]-tagged move, the attacker takes 1/6th of its own Max HP in recoil.",
    effects: [{ trigger: "onTakeDamage", action: "recoil", value: 1 / 6, filterKind: "tag", filterValue: "contact" }]
  },
  {
    id: "firegem", name: "Fire Gem", type: "consumable", maxUses: 1, immunities: {}, desc: "The first time the holder deals damage with a Fire-type move, that hit deals 30% more damage. Consumed after use.",
    effects: [{ trigger: "onDealDamage", action: "boostDamage", value: 0.3, filterKind: "type", filterValue: "fire" }]
  },
  {
    id: "spicypizza", name: "Spicy Pizza", type: "consumable", maxUses: 1, immunities: {}, flavor: "Spicy", desc: "Eaten the instant it activates: restores a sliver of HP, then fires up the holder's Fire-type attacks for 3 turns. A Spicy-flavored food item.",
    effects: [
      { trigger: "onUse", action: "heal", value: 0.0012, priority: 0, filterKind: "none", filterValue: "" },
      { trigger: "onUse", action: "boostDamage", value: 0.2, priority: 1, filterKind: "type", filterValue: "fire", boostDurationTurns: 3 }
    ]
  },
  // ---- Terastallization Engine example item: a held Tera Orb. teraType/teraMove live directly on
  // the effect row (see the doc block above DEFAULT_ITEMS). Swap teraType per-battle from the Battle
  // Prep form (or hand-edit an exported JSON copy) to Terastallize into any of the 18 types, or the
  // special 19th "stellar" type. ----
  {
    id: "teraorb", name: "Tera Orb", type: "held", maxUses: 1, immunities: {}, teraType: "fire",
    desc: "Once per battle, the holder may Terastallize: its typing becomes the Orb's configured Tera Type, it gains Tera Blast (auto-matching that type and whichever of Atk/Sp.Atk is higher), and its STAB is recalculated to favor the new type.",
    teraMove: { name: "Tera Blast", basePower: 80, accuracy: 1, pp: 10, maxPP: 10, tags: ["tera"] },
    effects: [{ trigger: "onUserIntent", action: "terastallize", value: 1, filterKind: "none", filterValue: "" }]
  }
];
// ---- Migrates a legacy single-effect item (trigger/action/value/filterKind/filterValue on the root
// object) into the new effects[] array shape, and backfills maxUses/immunities defaults. Safe to call
// on an already-migrated item — it's a no-op in that case. ----
function normalizeItem(it) {
  if (!it.effects) {
    it.effects = [{
      trigger: it.trigger || "battleStart", action: it.action || "heal", value: it.value || 0,
      filterKind: it.filterKind || "none", filterValue: it.filterValue || "", priority: 0
    }];
  }
  // ---- Effect Priority backfill: items saved before the priority field existed just get 0 on every
  // effect, which keeps their original Effects-list order (the sort in effectsByPriority is stable). ----
  it.effects.forEach(fx => { if (fx.priority == null) fx.priority = 0; });
  if (it.maxUses == null) it.maxUses = 1;
  it.immunities = Object.assign({ freeze: false, poison: false, burn: false, paralysis: false, sleep: false, hazard: false }, it.immunities || {});
  // ---- Deal Status Effect on Use: a single optional block, independent of the effects[] array —
  // { effect: STATUS_EFFECTS kind (or "none" to disable), chance: 0-100, target: "opponent"|"self" }.
  // Resolved at battleStart (see applyItemStatusEffect() in the simulator core), the same "on
  // entering battle" moment as Choice Scarf's boostStat — the natural equivalent of a held Toxic
  // Orb/Flame Orb self-status, or a charm that infatuates whoever the holder is facing. ----
  it.statusEffectOnUse = Object.assign({ effect: "none", chance: 100, target: "opponent" }, it.statusEffectOnUse || {});
  // ---- Taste / Flavor (Conditional Consumption Engine): "none" means this item isn't food at all
  // (key items, held stat sticks, etc.) and skips the taste engine entirely. Any other value must be
  // one of FLAVORS ("Sweet","Spicy","Sour","Bitter","Dry","Savory") — see getTastePreference()/useItem() in the
  // simulator core for how a holder's Liked/Hated/Neutral reaction to this flavor scales the item's
  // effects at the moment it's actually consumed. ----
  it.flavor = (typeof FLAVORS !== "undefined" && FLAVORS.includes(it.flavor)) ? it.flavor : "none";
  // ---- Terastallization Engine defaults: teraType "none" means this item has no Tera behavior at
  // all (the vast majority of items) and activateTeraState()/tryTerastallize() skip it entirely.
  // teraMove defaults to a Tera Blast-shaped stub so hand-authored items don't need to specify every
  // Move field themselves — buildTeraBlastMove() layers the live type/category on top at use-time. ----
  it.teraType = it.teraType || "none";
  it.teraMove = Object.assign({ name: "Tera Blast", basePower: 80, accuracy: 1, pp: 10, maxPP: 10, tags: ["tera"] }, it.teraMove || {});
  // ---- "No Tera" toggle: when true, the Dynamic Move Injector move is learned the moment the holder
  // enters battle (see the battleStart loop) instead of being gated behind actually Terastallizing —
  // so the move is usable anytime, with no typing change or one-per-battle Tera activation required. ----
  it.noTeraRequired = !!it.noTeraRequired;
  return it;
}
function loadItems() {
  try { const raw = localStorage.getItem(ITEMS_KEY); if (raw) { const p = JSON.parse(raw); if (p.length) return p.map(normalizeItem); } } catch (e) { }
  saveItems(DEFAULT_ITEMS); return DEFAULT_ITEMS.map(normalizeItem);
}
function saveItems(data) { try { localStorage.setItem(ITEMS_KEY, JSON.stringify(data)); } catch (e) { } }
function itemById(id) { return items.find(i => i.id === id) || null; }

// ================= TERASTALLIZATION ENGINE =================
// Reference type shapes for the schema above (documentation only — this file ships as plain JS, so
// these are written as TypeScript interfaces for anyone porting this engine to a .ts build; the
// runtime objects below are the real, executable JS versions of the same shapes).
//
// interface BattleTrigger {
//   kind: "battleStart" | "onUse" | "turnEnd" | "onHpThreshold" | "onTakeDamage" | "onDealDamage"
//       | "onUserIntent";               // manual activation, consumed during turn selection
//   filterKind?: "none" | "type" | "tag";
//   filterValue?: string;
// }
// interface Item {
//   id: string; name: string; type: "held" | "consumable"; maxUses: number;
//   teraType?: string;                  // "none" disables Tera behavior entirely
//   teraMove?: Partial<Move>;           // Dynamic Move Injector payload (see buildTeraBlastMove)
//   effects: Array<{ trigger: BattleTrigger["kind"]; action: string; value: number;
//                     filterKind: string; filterValue: string; priority?: number }>;
// }
// interface Move {
//   name: string; type: string; category: "Physical" | "Special" | "Status";
//   basePower: number; accuracy: number; pp: number; maxPP: number; tags: string[];
//   dynamicType?: boolean;              // true for Tera Blast-style moves: type/category
// }                                     // are recomputed live at use-time, never stored fixed.
// interface Pokemon {
//   name: string; types: string[]; moves: Move[];
//   stats: { hp:number; atk:number; def:number; spa:number; spd:number; spe:number };
// }

// ---- Move Injection Engine ----------------------------------------------------------------------
// Returns a NEW moves array — pokemon.moves itself (and every move object already inside it) is left
// completely untouched. This is the same "never mutate the stored/base data" discipline the rest of
// the sim core already follows for types/moves cloning (see the `fighters` construction comment in
// simulateOneBattle) — it's what lets a Tera move disappear cleanly if this battle ends and the same
// Pokémon object gets reused for another trial (runBattleOdds) or another battle entirely.
// If a move with the same `name` already exists (e.g. re-activating, or a save that already had it),
// it's replaced in place rather than duplicated, so the movepool never grows an extra slot per call.
function injectTemporaryMove(pokemon, newMove) {
  const moves = [...(pokemon.moves || [])];
  const existingIdx = moves.findIndex(m => m.name === newMove.name);
  if (existingIdx >= 0) moves[existingIdx] = newMove;
  else moves.push(newMove);
  return moves;
}

// ---- Dynamic Move Injector: builds a live Tera Blast-shaped move for THIS use, matching the spec's
// "checks whether Attack or Sp. Atk is higher to determine damage type" rule. `teraType` is read fresh
// every call (not cached on the move object) so a single injected move slot always reflects whatever
// the holder's CURRENT Tera Type is, even if that could ever change mid-battle. `template` lets an
// item's own teraMove fields (basePower/accuracy/pp/tags, etc.) override the Tera Blast defaults. ----
function buildTeraBlastMove(teraType, attacker, template) {
  const atkStat = (attacker.stats && attacker.stats.atk) || 0;
  const spaStat = (attacker.stats && attacker.stats.spa) || 0;
  const category = spaStat > atkStat ? "Special" : "Physical";
  return Object.assign(
    {
      name: "Tera Blast", type: teraType, category, basePower: 80, accuracy: 1, pp: 10, maxPP: 10,
      desc: "A Tera-powered blast. Its type always matches the user's current Tera Type, and it becomes Physical or Special depending on whichever of the user's Attack or Sp. Atk is higher.",
      tags: ["tera"], dynamicType: true, action: "none", effects: []
    },
    template || {}
  );
}

// ---- STAB (Same-Type Attack Bonus) recalculation, Tera-aware. `teraState` is either null/inactive
// (untransformed — falls back to the plain "does this move's type appear in my own types?" rule used
// everywhere else in this file) or { active:true, type, originalTypes, stellar }. While Terastallized:
//   • a move matching the Tera Type gets the boosted bonus — 2x if that type was ALSO one of the
//     holder's original types (the type "doubled down" on itself), otherwise the standard 1.5x.
//   • a move matching one of the holder's ORIGINAL types (but not the Tera Type) still gets the
//     standard 1.5x — Terastallizing narrows/reshapes typing, it never revokes the base STAB the
//     holder already had.
//   • Tera Stellar is the one exception: it doesn't replace the holder's typing at all (so every
//     original-type STAB above just applies normally), but grants a one-time 2x boost specifically to
//     each of the holder's own move types the FIRST time that type is used post-activation. ----
function computeStabMultiplier(attacker, move, teraState) {
  const originalTypes = (teraState && teraState.originalTypes) || attacker.types || [];
  if (!teraState || !teraState.active) return originalTypes.includes(move.type) ? 1.5 : 1;
  if (teraState.stellar) {
    return originalTypes.includes(move.type) ? 1.5 : 1;
  }
  if (move.type === teraState.type) {
    return originalTypes.includes(teraState.type) ? 2 : 1.5;
  }
  return originalTypes.includes(move.type) ? 1.5 : 1;
}
// Shared by onTakeDamage ("receiving") and onDealDamage ("dealing") item triggers: does the move
// involved in this hit match the item's configured Move Filter? Items with filterKind "none" (or
// items saved before this field existed) always match — the filter is purely an opt-in narrowing.
function matchesMoveFilter(item, move) {
  const kind = item && item.filterKind || "none";
  if (kind === "none") return true;
  if (!move) return false;
  if (kind === "type") return String(move.type || "").toLowerCase() === String(item.filterValue || "").toLowerCase();
  if (kind === "tag") return (move.tags || []).some(t => String(t).toLowerCase() === String(item.filterValue || "").toLowerCase());
  return true;
}
// ---- Holder Filter: a SECOND, independent filter dimension on an item effect — gates the effect on the
// ITEM HOLDER's own Type or Creature Tag (entry.tags), rather than on the incoming/outgoing move like
// matchesMoveFilter does. Lets an item read like "only works if the holder IS a Water type" (e.g. a
// Water-only healing charm) instead of/alongside "only works against Water-type moves". Both filters can
// be set on the same effect row at once — an effect only fires when BOTH pass. holderFilterKind
// "none" (or unset, for older saved items) always passes, same convention as filterKind. ----
function matchesHolderFilter(item, holder) {
  const kind = item && item.holderFilterKind || "none";
  if (kind === "none") return true;
  if (!holder) return false;
  if (kind === "type") return (holder.types || []).some(t => String(t).toLowerCase() === String(item.holderFilterValue || "").toLowerCase());
  if (kind === "tag") return (holder.tags || []).some(t => String(t).toLowerCase() === String(item.holderFilterValue || "").toLowerCase());
  return true;
}
const THEME_KEY = "fielddex_theme_v1";

const REGION_COLORS = [
  { name: "Crimson", base: "#d1373a", dark: "#7a1f22" },
  { name: "Amber", base: "#e8a33d", dark: "#8a5c15" },
  { name: "Verdant", base: "#5fd68c", dark: "#2b7a52" },
  { name: "Azure", base: "#4f8ef7", dark: "#25478f" },
  { name: "Violet", base: "#8b5cf6", dark: "#4c2f96" },
  { name: "Slate", base: "#8a93a6", dark: "#454b58" }
];

function esc(str) {
  return String(str == null ? "" : str).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const MOVE_CATEGORIES = ["Physical", "Special", "Status"];

// ---- Ability / Move rule-builder vocab (drives the Boolean params the simulator reads) ----
const ABILITY_TYPES = [["passive", "Passive"], ["active", "Active"]];
const PASSIVE_TRIGGERS = [["always", "Passively (Always Active)"], ["battleStart", "On Battle Start (also fires every time it switches in)"], ["attacking", "When Attacking"], ["defending", "When Defending"], ["afterHit", "After Getting Hit"], ["weatherActive", "While Weather Is Active (Field State)"], ["statLowered", "When a Stat Is Lowered (by Opponent's Move)"], ["hitByTag", "When Receiving a Move With Tag [Select Tag]"]];
const PASSIVE_ACTIONS = [
  ["negateDamage", "Negate Damage (Immune / Disable)"],
  ["negateStatus", "Negate Status (immune to condition states)"],
  ["multiplyDamage", "Multiply Damage"],
  ["modifyStat", "Modify Stat Stage"],
  ["heal", "Absorb / Recover HP"],
  ["protect", "Protected (Custom Type Shield)"]
];
// "Offensive" conditions are checked on the ability owner's own turn; "Defensive" ones are checked
// the instant the owner is hit, before damage lands (Disguise / Mimikyu-style interception gates).
const ACTIVE_CONDITIONS = [
  ["hpBelow33", "If HP is Below 33% (Crisis)"],
  ["stabMatch", "If Move Type Matches Self Type (STAB Boost)"],
  ["hpFull", "When Hit While at 100% HP (First Hit Disguise)"],
  ["hpBelow50", "When Hit While Below 50% HP"],
  ["hitByType", "When Hit by a Specific Element Type"],
  ["weatherIs", "IF: Weather Is Active (Matches Selected State)"],
  ["lastMoveMissed", "If User's Previous Move Missed (Stomping Tantrum-style)"],
  ["onHitting", "When Hitting (Filter by Type Effectiveness)"]
];
const OFFENSIVE_ACTIVE_CONDITIONS = new Set(["hpBelow33", "stabMatch", "lastMoveMissed", "onHitting"]);
const DEFENSIVE_ACTIVE_CONDITIONS = new Set(["hpFull", "hpBelow50", "hitByType"]);
// ---- "When Hitting" effectiveness filter: which type-effectiveness bucket the ability owner's hit
// must fall into for the onHitting Active Condition to pass ----
const HIT_EFFECTIVENESS_OPTIONS = [["any", "Any"], ["superEffective", "Super Effective"], ["notVeryEffective", "Not Very Effective"], ["immune", "Immune (No Effect)"]];
// Environmental conditions are field-state checks (not tied to attacker/defender role) — evaluated
// the same way regardless of whether the owner is attacking or defending this turn.
const ENVIRONMENTAL_ACTIVE_CONDITIONS = new Set(["weatherIs"]);
const ACTIVE_ACTIONS = [
  ["boostDamage150", "Boost Damage by 1.5x"],
  ["boostSpeed1", "Boost Speed Stat Stage +1"],
  ["heal", "Absorb / Recover HP"],
  ["protect", "Protected (Custom Type Shield)"],
  ["negateDamage", "Negate All Damage From This Hit"],
  ["boostDamageCustom", "Boost Damage by Custom Multiplier (e.g. Stomping Tantrum after a Miss)"],
  ["boostType", "Boost Type Moves (Blaze-style — boosts moves matching one or more chosen Types)"],
  ["boostTagMove", "Boost Tag Moves (Iron Fist-style — boosts moves carrying one or more chosen Tags; a move's Type also counts as an implicit tag here)"]
];
const STAT_STAGE_KEYS = [["atk", "Attack"], ["def", "Defense"], ["spa", "Sp. Atk"], ["spd", "Sp. Def"], ["spe", "Speed"]];
const STAT_STAGE_VALUES = [3, 2, 1, -1, -2, -3];
const STATUS_EFFECTS = [["none", "None"], ["sleep", "Sleep"], ["paralysis", "Paralysis"], ["burn", "Burn"], ["poison", "Poison"], ["frostbite", "Frostbite"], ["badlyPoisoned", "Badly Poisoned"]];
const STATUS_DURATION_MODES = [["random", "Random Range"], ["fixed", "Fixed Turns"]];
const HEAL_TARGETS = [["self", "Self (User)"], ["opponent", "Opponent (Foe)"], ["both", "Both Combatants"]];
const MOVE_ACTIONS = [["status", "Inflict Status Effect"], ["heal", "Absorb / Recover HP"], ["weather", "Set Weather"], ["field", "Set Field Effect"], ["hazard", "Set Field Hazard"], ["copyMove", "Copy Opponent's Move (Mimic — One-Sided Copy)"], ["stealMove", "Steal Opponent's Move (One-Sided Theft)"], ["swapMove", "Swap Moves With Opponent (Skill Swap — Both Sides)"], ["forceMove", "Force Move Onto Opponent (Entrainment — One-Sided Transfer)"],
["copyAllMoves", "Copy ALL Opponent's Moves (Full Movepool Copy — Ditto-style)"],
["swapAllMoves", "Swap ALL Moves (Full Movepool Exchange — Whole Kit Swap)"],
["transform", "Full Transform (Ditto-style — Copies Moves + Ability + Type)"],
["copyAbility", "Copy Target's Ability (Role Play / Trace-style)"],
["swapAbility", "Swap Abilities With Opponent (Skill Swap-style)"],
["forceAbility", "Force Ability Onto Opponent (Entrainment-style)"],
["swapItem", "Swap Held Items (Trick — takes the opponent's item outright if either side has none)"], ["none", "No Secondary Effect"]];
// ---- Full Transform (Ditto-style) Revert Timing: controls when a "Full Transform" action's copied
// moves/ability/type wear off and the user reverts to its own base moves/ability/type. "permanent"
// (0 / infinite) never auto-reverts — it lasts the rest of the battle, same as every other move/ability
// exchange action above. "turns" counts down a fixed number of rounds, ticked at end-of-round. "onDamage"
// (Zoroark/Illusion-style) reverts the instant the transformed side takes damage from a hit. ----
const TRANSFORM_REVERT_MODES = [["permanent", "Never — Permanent for the Battle (0 / Infinite)"], ["turns", "After a Fixed Number of Turns"], ["onDamage", "The First Time It Takes Damage"]];
// ---- Move Exchange Targeting: sub-setting for Copy/Steal/Swap/Force — controls HOW the opponent's
// targeted move slot is chosen. "lastDamaging" preserves the original/default behavior (tracks the
// opponent's most recently used move via the shared lastUsedMove[] tracker). The others give the Move
// Builder full control over scope: a random slot, always the first slot, the first slot whose Type
// matches this move's own Type, or an exact slot number typed in by hand. ----
const MOVE_EXCHANGE_TARGETS = [
  ["lastDamaging", "Last Damaging Move Used (Default)"],
  ["random", "Random Move From Opponent's Active Kit"],
  ["firstSlot", "First Slot in Opponent's Kit"],
  ["matchingType", "First Opponent Move Matching This Move's Type"],
  ["specificSlot", "Specific Slot #"]
];
// ================= MOVE TRIGGERS & ATTRIBUTES =================
const CRIT_RATE_MODES = [["normal", "Normal (Default)"], ["high", "High (+1 Stage)"], ["always", "Always Crit"]];
// ---- Move Priority Brackets: standard -3..+3 range. Higher priority acts first regardless of raw
// Speed; ties within the same bracket fall back to the normal Speed-based ordering. ----
const MOVE_PRIORITIES = [-3, -2, -1, 0, 1, 2, 3];
// ---- Counter Mechanics (Counter / Mirror Coat / Metal Burst): which category of incoming damage
// this move is allowed to reflect. "any" covers both Physical and Special (Metal Burst-style). ----
const COUNTER_DAMAGE_TYPES = [["physical", "Physical Hits Only (Counter-style)"], ["special", "Special Hits Only (Mirror Coat-style)"], ["any", "Any Hit — Physical or Special (Metal Burst-style)"]];
const DYNAMIC_TYPE_MODES = [["superEffective", "Super Effective (x2)"], ["notVeryEffective", "Not Very Effective (x0.5)"], ["immune", "Immune (x0)"]];
// ================= STAT MODIFIER DURATION / DECAY =================
const STATMOD_EXPIRE_MODES = [["decay", "Decay / Disappear"], ["revert", "Revert Back to Original State"]];
const WEATHER_STATES = [["clear", "Clear Weather"], ["sun", "Sunny Day"], ["rain", "Rainy"], ["sand", "Sandstorm"], ["snow", "Snowy"], ["polluted", "Polluted"], ["strongwinds", "Strong Winds"], ["thunderstorm", "Thunderstorm"], ["nighttime", "Nighttime"]];

// ================= CUSTOM WEATHERS (made in Settings -> Custom Weather Maker, js/weather-maker.js) =================
// A custom weather is registered into WEATHER_STATES, so it shows up in every weather dropdown (weather-setting
// abilities, moves that set weather, weather accuracy rules, Auto-Fail abilities...). While it is active it can:
//   typeMods  — multiply the damage of moves of chosen types (x0.5 = weaker, x1.5 = stronger)
//   chipPct   — hurt every Fakemon for X% of its max HP each round, except the chipImmune types
//   healPct   — heal Fakemon of the healTypes X% of their max HP each round
//   accMult   — multiply every move's accuracy
// Definitions are saved in this browser (localStorage). Export / Import in the maker moves them between browsers.
const CUSTOM_WEATHERS_KEY = "fandex_custom_weathers_v1";
const CUSTOM_WEATHERS = {};
const BUILTIN_WEATHER_KEYS = ["clear", "sun", "rain", "sand", "snow", "polluted", "strongwinds", "thunderstorm", "nighttime"];
function weatherLabel(key) { const cw = CUSTOM_WEATHERS[key]; return cw ? cw.name : (key ? key[0].toUpperCase() + key.slice(1) : ""); }
function normalizeCustomWeather(w) {
  if (!w || typeof w !== "object") return null;
  const name = String(w.name || "").trim().slice(0, 30);
  if (!name) return null;
  let key = String(w.key || name).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24);
  if (!key) return null;
  if (BUILTIN_WEATHER_KEYS.includes(key)) key = "cw" + key;
  const typesOf = v => (Array.isArray(v) ? v : String(v || "").split(",")).map(t => String(t).trim().toLowerCase()).filter(t => TYPES.includes(t));
  const num = (v, lo, hi, d) => { const n = Number(v); return isNaN(n) ? d : Math.max(lo, Math.min(hi, n)); };
  return {
    key, name,
    emoji: String(w.emoji || "").trim().slice(0, 4) || "🌫️",
    typeMods: (Array.isArray(w.typeMods) ? w.typeMods : []).map(m => ({ type: String((m && m.type) || "").toLowerCase(), mult: num(m && m.mult, 0.1, 3, 1) }))
      .filter(m => TYPES.includes(m.type) && m.mult !== 1).slice(0, 12),
    chipPct: num(w.chipPct, 0, 25, 0), chipImmune: typesOf(w.chipImmune),
    healPct: num(w.healPct, 0, 25, 0), healTypes: typesOf(w.healTypes),
    accMult: num(w.accMult, 0.5, 1.5, 1),
    // cloud sharing info (set by cloud-sync.js / the maker): which Firestore doc it is and who made it
    firestoreId: w.firestoreId ? String(w.firestoreId).slice(0, 120) : undefined,
    creatorUid: w.creatorUid ? String(w.creatorUid).slice(0, 120) : undefined,
    creatorName: w.creatorName ? String(w.creatorName).slice(0, 60) : undefined
  };
}
function registerCustomWeather(w) {
  const def = normalizeCustomWeather(w);
  if (!def) return null;
  CUSTOM_WEATHERS[def.key] = def;
  const row = [def.key, `${def.emoji} ${def.name}`], i = WEATHER_STATES.findIndex(s => s[0] === def.key);
  if (i >= 0) WEATHER_STATES[i] = row; else WEATHER_STATES.push(row);
  return def;
}
function saveCustomWeathers() { try { localStorage.setItem(CUSTOM_WEATHERS_KEY, JSON.stringify(Object.values(CUSTOM_WEATHERS))); } catch (e) {} }
function deleteCustomWeather(key) {
  delete CUSTOM_WEATHERS[key];
  const i = WEATHER_STATES.findIndex(s => s[0] === key);
  if (i >= 0) WEATHER_STATES.splice(i, 1);
  saveCustomWeathers();
}
(function loadCustomWeathers() {
  try { JSON.parse(localStorage.getItem(CUSTOM_WEATHERS_KEY) || "[]").forEach(registerCustomWeather); } catch (e) {}
})();
// ---- Field Effects: distinct from Weather (both can be active at the same time). Grassy Field boosts
// every stat of Grass types + heals them each round; Flood speeds Water types up (and slows everyone
// else down), weakens Fire-type moves, and Flying types are fully immune to it. ----
const FIELD_STATES = [["none", "No Field Effect"], ["grassy", "Grassy Field"], ["flood", "Flood"], ["misty", "Misty Terrain"], ["electric", "Electric Terrain"], ["psychic", "Psychic Terrain"], ["poisonous", "Poisonous Terrain"]];
// ---- Move Fail Conditions: a simple per-Move "IF [X] THEN this move fails" gate, checked after the
// accuracy roll but before any damage/effects — e.g. Sucker Punch failing if the target isn't attacking ----
const MOVE_FAIL_CONDITIONS = [
  ["none", "Never (Default)"],
  ["opponentNotOffensive", "Opponent's Chosen Move Is Not Offensive (Sucker Punch-style)"],
  ["opponentOffensive", "Opponent's Chosen Move IS Offensive"],
  ["userHpAbove50", "User's HP Is Above 50%"],
  ["weatherIsNot", "Weather Doesn't Match Required State"],
  ["fieldIsNot", "Field Effect Doesn't Match Required State"]
];
// ---- Status Fail Conditions: the move fails if the USER / TARGET has (or does NOT have) the chosen status
// condition (Move field "Status for the Fail Condition": Any, or one specific status such as Sleep for a Dream
// Eater-style "fails unless the target is asleep") ----
MOVE_FAIL_CONDITIONS.push(["userHasStatus", "User HAS the chosen Status Condition"]);
MOVE_FAIL_CONDITIONS.push(["targetHasStatus", "Target HAS the chosen Status Condition"]);
MOVE_FAIL_CONDITIONS.push(["userNoStatus", "User does NOT have the chosen Status Condition"]);
MOVE_FAIL_CONDITIONS.push(["targetNoStatus", "Target does NOT have the chosen Status Condition"]);
const HAZARD_TYPES = [["stealthrock", "Stealth Rock (Sharp Stones)"], ["spikes", "Spikes (Stacking, up to 3)"]];
const HITS_OPTIONS = [1, 2, 3, 4, 5];
// ---- Multi-Hit Scaling: per-hit damage ramp for moves with Hits Count > 1. "none" (default) keeps
// every hit at the same Base Power, identical to the original behavior. "rampUp"/"rampDown" scale each
// SUBSEQUENT hit (the 1st hit is always unscaled, 1.0x) by +/- multiHitScalingPct% per hit, compounding
// — e.g. rampDown at 20% on a 3-hit move deals hit1 @ 100%, hit2 @ 80%, hit3 @ 60% of its own damage
// roll (Triple Kick/Triple Axel-style escalation, but tunable and percentage-based instead of fixed
// Base Power steps). See the multiHitScaling application in the per-hit damage loop in the sim core. ----
const MULTI_HIT_SCALING_MODES = [["none", "Flat (every hit same power)"], ["rampUp", "Ramp Up (+X% power per hit)"], ["rampDown", "Ramp Down (-X% power per hit)"]];
const HEAL_TYPES = [["percent", "% Base (Max HP)"], ["flat", "Flat #"]];
// Types fundamentally immune to certain status conditions
const STATUS_IMMUNITIES = {
  fire: new Set(["burn"]),
  electric: new Set(["paralysis"]),
  ice: new Set(["frostbite", "freeze"]),
  poison: new Set(["poison", "badlyPoisoned"]),
  steel: new Set(["poison", "badlyPoisoned"]),
  // ---- Water types are hard-immune to the "wet" status condition. (Note: this type-keyed entry is what
  // isStatusImmune() actually reads for any direct Move/Effect "Inflict Status Effect" application; it's
  // separate from the reversed STATUS_IMMUNITIES.wet set below, which only feeds isWetImmune()'s Rain
  // auto-apply sync. Both must list Water for "wet" immunity to hold under every application path.) ----
  water: new Set(["wet"]),
  // ---- Psychic types are immune to Confusion ----
  psychic: new Set(["confusion"])
};
// ---- Contextual Status Interaction ("Wet"): Ground / Steel / Water types are fully immune to the Wet
// status — neither Rain's automatic field-wide application nor a Move's direct "Inflict Status Effect"
// action can apply it to them. Checked by isStatusImmune() (elemental immunity table) and by the
// per-round Rain auto-apply sync in the simulator core (see isWetImmune()). ----
STATUS_IMMUNITIES.wet = new Set(["ground", "steel", "water"]);

// ---- Major Status Conditions: the conditions Terrain effects (Misty Terrain) can block outright from
// ever landing on a grounded target. Minor/volatile conditions (confusion, flinch, wet, etc.) are
// untouched by Terrain and are not part of this set. ----
const MAJOR_STATUS_KINDS = new Set(["burn", "freeze", "paralysis", "poison", "badlyPoisoned", "sleep"]);
// ---- Grounded Check ("Grounded" vs. "Un-grounded"): the universal gate for whether a fighter is affected
// by Terrain effects/protections at all. A Pokémon is NOT grounded — and so is untouched by any Terrain
// buff, protection, or terrain-based damage reduction — if EITHER: (1) it is Flying-type (primary or
// secondary), OR (2) it carries the "levitating" Pokémon Tag (see entry.tags / fighters[side].tags).
// Accepts either a fighter/entry object (reads .types/.tags off it) or a raw types array plus a separate
// tags array, so every call site — whichever shape it already has on hand — can use it directly. ----
const liftedFighters = new Set(); // fighters currently airborne from a Lift effect (managed by the simulator)
const groundedFighters = new Set(); // fighters currently forced onto the ground by Root Down (managed by the simulator)
function isGrounded(fighterOrTypes, maybeTags) {
  if (fighterOrTypes && !Array.isArray(fighterOrTypes)) {
    if (groundedFighters.has(fighterOrTypes)) return true;  // Root Down beats everything (types, tags, lift)
    if (liftedFighters.has(fighterOrTypes)) return false;
  }
  let types, tags;
  if (Array.isArray(fighterOrTypes)) { types = fighterOrTypes; tags = maybeTags || []; }
  else { types = (fighterOrTypes && fighterOrTypes.types) || []; tags = (fighterOrTypes && fighterOrTypes.tags) || []; }
  const isFlying = types.some(t => String(t).toLowerCase() === "flying");
  const isLevitating = tags.some(t => String(t).toLowerCase() === "levitating");
  return !(isFlying || isLevitating);
}

// ---- Dynamic Multi-Effect Sequence Array vocab (shared by Moves + Abilities) ----
// Each node: { chance, target, type, ...type-specific fields }. Unlimited nodes per Move/Ability.
const EFFECT_TYPES = [["hazard", "Field Hazard"], ["heal", "Heal / Recovery"], ["statmod", "Stat Modifier"], ["status", "Status Overlay"], ["copyStats", "Copy Stats (Match User's Stages to Opponent's)"], ["weightmod", "Modify Weight (Temporary Battle Weight)"], ["delayedQueue", "Delayed Effect Queue (Timed / Charge-Release)"], ["persistentDrain", "Multi-Turn Drain & Burnout"], ["customHazard", "Custom Entry Hazard (Modular Builder)"], ["recycleItem", "Recover Used Item (Recycle)"]];
// ---- Modular Custom Entry Hazard Builder: Entry Damage mode — a fixed flat amount, a % of the
// entrant's Max HP, or Stealth Rock-style logic where a base % of Max HP is scaled by the hazard's
// own configured Type's effectiveness against the entrant's types ----
const HAZARD_DAMAGE_MODES = [["none", "No Entry Damage"], ["flat", "Flat HP Amount"], ["maxhppct", "% of Max HP"], ["typescaled", "Type-Scaled (Stealth Rock logic)"]];
// ---- Delayed Effect Queue: mode that ticks the countdown down (Future Sight-style flat timer) vs. one
// that's tied to another move's active Charge-Up counter reaching 0 (charge-release, Solar Beam-adjacent
// "mark now, unload later" combos) ----
const DELAYQUEUE_TRIGGER_MODES = [["countdown", "Fixed Countdown (Future Sight-style)"], ["chargeRelease", "On Charge-Release (tied to a Charge-Up counter)"]];
const DELAYQUEUE_PAYLOADS = [["damage", "Delayed Damage"], ["statusMark", "Delayed Status Mark"], ["statChange", "Delayed Stat Change"], ["heal", "Delayed Heal (Wish-style)"]];
// ---- Multi-Turn Drain & Burnout: which resource is siphoned each turn between the tethered sides ----
const DRAIN_RESOURCES = [["hp", "HP"], ["energy", "Energy (PP of Last Used Move)"], ["stat", "Stat Stage"]];
const DRAIN_DIRECTIONS = [["targetToUser", "Target → User (Leech Seed-style)"], ["userToTarget", "User → Target (self-inflicted tether)"]];
const BURNOUT_SCOPES = [["primary", "Primary Type"], ["secondary", "Secondary Type (if any)"], ["chosen", "Specific Chosen Type"]];

// ---- Expanded ability vocab: resistance nodes, priority-hook nodes, type-override crit nodes ----
PASSIVE_ACTIONS.push(["resistanceMult", "Resistance Multiplier / Damage Negation (Custom Ratio)"]);
ACTIVE_CONDITIONS.push(["opponentOffensive", "If Opponent's Move Is Offensive (Priority Hook)"]);
ACTIVE_CONDITIONS.push(["typeMatchOverride", "If This Move's Type Matches (Type-Override Crit)"]);
OFFENSIVE_ACTIVE_CONDITIONS.add("typeMatchOverride");
ACTIVE_ACTIONS.push(["firstStrikePriority", "Force First-Strike Priority This Turn"]);
ACTIVE_ACTIONS.push(["typeOverrideCrit", "Type-Override Guaranteed Crit (Bypass Resistance)"]);
// ---- Boost Tag Move (Passive): Iron Fist-style — ALWAYS boosts only the ability owner's OWN attacks
// that carry one or more matching tags (comma-separated, and a move's Type counts as an implicit tag —
// see moveTagPool()). Fires unconditionally on the owner's own attack regardless of whatever this
// ability's Passive Trigger dropdown is set to, specifically so it can't accidentally be wired to
// "When Receiving a Move With Tag" and end up boosting the OPPONENT's incoming hit instead. ----
PASSIVE_ACTIONS.push(["boostTagMove", "Boost Tag Move (Iron Fist-style — ALWAYS boosts only YOUR OWN attacks with matching tags, regardless of Trigger)"]);
// ---- Move Type Override (Passive): Normalize/Galvanize/Pixilate/Refrigerate-style — rewrites the
// TYPE of the ability owner's own move right before it's used (so type effectiveness, STAB, and every
// other type-dependent check downstream all see the NEW type). "From" is either "any" (Normalize —
// converts every move regardless of its current type) or one specific type (Galvanize-family — only
// converts moves that are currently that one type). "To" is the resulting type. An optional Power
// Multiplier (1 = no boost, like Normalize; 1.2 = like the real Galvanize/Pixilate/Refrigerate/Aerilate)
// is applied to Base Power on conversion. Like Boost Tag Move above, this ALWAYS fires on the owner's
// own attack regardless of this ability's Trigger dropdown, so it can't be mis-wired to "When Defending"
// and rewrite the OPPONENT's incoming move instead. ----
PASSIVE_ACTIONS.push(["moveTypeOverride", "Move Type Override (Normalize/Galvanize-style — ALWAYS rewrites YOUR OWN move's Type right before it's used, regardless of Trigger)"]);
// ---- Wonder Guard (Passive): the owner takes damage ONLY from a Super-Effective hit (2x or more on the
// type chart, after tag matchups/Dynamic Type Matching/Strong Winds are all factored in) — anything
// neutral, resisted, or already-immune is treated as a total miss instead. Checked directly against the
// live type-effectiveness multiplier in the main damage pipeline (the same place Type Immunity Abilities
// are checked), NOT through the Trigger/Chance dispatch other passive actions use — so, like Boost Tag
// Move and Move Type Override above, it ALWAYS applies and can't be mis-wired to the wrong Trigger. ----
PASSIVE_ACTIONS.push(["wonderGuard", "Wonder Guard (ALWAYS ignores Trigger — the owner is immune to anything that ISN'T Super-Effective)"]);
// ---- Loaf Around (Passive): Truant-style — the owner skips its OWN turn entirely on a configurable
// cycle (whatever move was chosen that turn is simply never used), regardless of this ability's Trigger
// dropdown. The default Interval of 2 + "Starts Active" reproduces Truant exactly: acts turn 1, loafs
// turn 2, acts turn 3, loafs turn 4, forever. A bigger Interval gives a general "acts once every N turns"
// cooldown-style ability instead. ----
PASSIVE_ACTIONS.push(["loafAround", "Loafs Around Periodically (Truant-style — ALWAYS skips its own turn on a cycle, regardless of Trigger)"]);
// ---- Switch-Out Trigger (Zero to Hero-style): fires this ability's passive action + Additional Effects the
// moment its owner LEAVES the field by switching (not when it faints). Pair it with the "Trigger Alternate
// Form" effect and the Fakemon comes back in its new form the next time it switches in. Team battles only. ----
PASSIVE_TRIGGERS.push(["onSwitchOut", "When Switching Out (leaving the field, not fainting)"]);
// ---- Trap Opponent (Passive, Magnet Pull / Arena Trap / Shadow Tag-style): while its owner is ACTIVE, the
// opposing active Fakemon can't switch out on its own (bot switching is blocked). Forced switches (e.g. an
// ally-hit "Switch In") and fainting still work. ALWAYS ignores the Trigger dropdown. The scope picks who is
// trapped: everyone, or only opponents matching chosen Types and/or Tags. Tags "flying", "floating",
// "levitating" and "airborne" all match anything airborne (Flying-types and levitating-tagged Fakemon). ----
const TRAP_SCOPES = [
  ["all", "Every opponent"],
  ["types", "Only opponents of the chosen types (e.g. Steel)"],
  ["tags", "Only opponents with the chosen tags (e.g. flying)"],
  ["either", "Opponents matching a chosen type OR tag"]
];
PASSIVE_ACTIONS.push(["trapSwitch", "Trap Opponent (ALWAYS ignores Trigger — the opposing Fakemon can't switch out)"]);
// ---- Auto-Fail Moves of a Type (Desolate Land / Primordial Sea-style): while its owner is on the field, DAMAGING
// moves of the chosen type fail (the move still uses PP). Scope: only the opponent's moves, or everyone's. It can
// also whip up a weather on entry that other weather can't replace (optional). ALWAYS ignores the Trigger for the
// failing part. (The weather lasts for the battle; a custom Weather Builder is planned.) ----
PASSIVE_ACTIONS.push(["blockMoveType", "Auto-Fail Moves of a Type (Desolate Land / Primordial Sea-style — failing part ALWAYS ignores Trigger)"]);
// ---- Resist OHKO Moves (Sturdy-style): while the owner's HP is at or above the chosen %, one-hit-KO moves
// (a move with the "OHKO" check) have no effect on it. ALWAYS ignores the Trigger dropdown. ----
PASSIVE_ACTIONS.push(["ohkoGuard", "Resist OHKO Moves (Sturdy-style — immune while HP is at/above X%; ALWAYS ignores Trigger)"]);
// ---- Ally-Hit Trigger: a passive Trigger that works from the BENCH in a team battle. It fires when the ACTIVE
// teammate takes a "huge" hit: one that would KO it (it is then left at 1 HP instead), or one that takes at least
// the ability's [Huge Hit %] of its max HP. Once per battle per owner. The ability's Passive Action and Additional
// Effects then run (on the active teammate, so "Self" in an effect means the teammate that was hit). Add the
// "Switch In" effect to bring the benched owner onto the field. ----
PASSIVE_TRIGGERS.push(["allyHugeHit", "When a Teammate Takes a Huge Hit (works from the bench)"]);
// ---- Switch In (Effect): the ability's owner forcibly enters the field right after the current action,
// replacing the active teammate. Only does anything when run from a benched owner's Ally-Hit Trigger. ----
EFFECT_TYPES.push(["switchIn", "Switch In (benched owner forcibly enters the field)"]);
// ---- Doom Countdown / Wish / Revive / Snatch (all are normal Additional Effects, usable on Moves AND Abilities) ----
//  doom      — Perish Song-style: the target faints at the end of its Nth turn unless it switches out (the count
//              resets when it leaves; the bot gives switching top priority while doomed).
//  wish      — the USER'S SIDE heals X% of max HP after N end-of-turn ticks; the heal goes to whoever is on the
//              field then, so it can be passed on by switching.
//  reviveAlly— team battles: revives one fainted teammate at X% HP; the bot picks the strongest one.
//  snatch    — the user steals the foe's next STATUS move this turn (its Additional Effects apply to the
//              snatcher). Give the move a high Priority so it goes first. ----
EFFECT_TYPES.push(["doom", "Doom Countdown (target faints in N turns unless it switches out)"]);
EFFECT_TYPES.push(["wish", "Wish (heal the user's side after N turns — passes through switching)"]);
EFFECT_TYPES.push(["reviveAlly", "Revive a Fainted Teammate (bot picks who)"]);
EFFECT_TYPES.push(["snatch", "Snatch (steal the foe's next Status move this turn)"]);
// ---- Substitute: the user pays X% of its max HP to put up a decoy with that much HP. Damaging hits hit the decoy
// instead (moves that Ignore Defenses/Shields still hit the user), and harmful effects aimed at the user
// (stat drops, statuses...) are blocked while it stands. Lost on switching out. ----
EFFECT_TYPES.push(["substitute", "Substitute (pay HP for a decoy that takes the hits)"]);
// ---- Lift / Airborne (Telekinesis, Magnetic Lift, Magnet Rise-style): the target is airborne for N turns: Terrain
// effects skip it and (optionally) Ground-type damaging moves can't hit it. Wearing off logs "<move> wears off,
// <name> is back on the ground!". Pair it with the move's "Fails Against Fakemon Tags: grounded" so a buried
// Fakemon can't be lifted. ----
EFFECT_TYPES.push(["lift", "Lift / Airborne (target floats off the ground for N turns)"]);
// ---- Bond (Destiny Bond-style): links the user to the CURRENT opponent for N turns. Each check is optional:
//   On Faint  — if the user is knocked out by a hit from its bonded foe, the foe faints too.
//   On Damage — damage the user takes from the bonded foe is also dealt to the foe (a % of it).
//   On Status — a status condition the user gets is also given to the bonded foe.
// The bond ends when the turns run out, the user faints, or either Fakemon leaves the field. ----
// ---- Evade Inaccurate Attacks (Agility/Detect-style dodge): for N turns, attacks aimed at the USER whose Accuracy is
// BELOW the chosen % (default: anything under 100%) automatically miss. Never-miss moves and Root Down's
// "can't dodge" still get through. Combine it with a Speed stat-stage effect in the same move for "speed up + dodge". ----
EFFECT_TYPES.push(["evadeInaccurate", "Evade Inaccurate Attacks (user auto-dodges moves under X% accuracy for N turns)"]);
// ---- Root Down: pins the TARGET for N turns. Check 1 "Forces grounded": it is grounded no matter its type/tags/lift
// (Terrain applies, Ground-type moves can hit Flying types, any lift ends). Check 2 "Accuracy checks skipped": every
// move used against it ignores accuracy and dodge (its dodge rate is effectively 0%). ----
EFFECT_TYPES.push(["rootDown", "Root Down (target is grounded and/or can't dodge for N turns)"]);
// ---- Add Type (Forest's Curse / Trick-or-Treat / Soak-style): gives the target a THIRD type (up to 3 in total).
// Its matchups stack with the Fakemon's own types (weaknesses and resistances multiply) and the new type also
// grants STAB. Duration: "battle" = the rest of the battle (survives switching out), "switch" = until it switches
// out, "turns" = for X turns (also ends if it leaves the field). Fails if it already has the type or has 3. ----
EFFECT_TYPES.push(["addType", "Add Type (give the target an extra type, max 3 types)"]);
EFFECT_TYPES.push(["bond", "Bond (link the user to the opponent: faint / damage / status sharing)"]);
// ---- Metronome: when the move that carries this effect is used, it is REPLACED by a random move taken from every
// Fakemon in the roster (never another Metronome/Snatch move), then runs exactly like that move would. ----
EFFECT_TYPES.push(["metronome", "Metronome (use a random move from the whole roster)"]);
function fxInt(v, lo, hi, d) { const n = Math.round(Number(v)); return isNaN(n) ? d : Math.max(lo, Math.min(hi, n)); }
// ---- Slow Start (Passive): temporarily weakens the selected stats for the battle's first N turns, then
// automatically returns to normal — checked live against the round counter every time it's relevant
// (turn order / damage calc), so no separate duration-tracking state is needed. ----
PASSIVE_ACTIONS.push(["slowStart", "Slow Start (weakens chosen stats for the first N turns of the battle, then returns to normal)"]);

// ================= DYNAMIC PP COST SYSTEM =================
// Lets an Ability (or a Move's own unified rule) raise/lower the PP cost paid for a use of a targeted
// move — targeted either by "Highest Base Power" (recomputed off the user's live movepool each turn)
// or "Last Used Move" (the move the user executed the previous turn it acted). Works as both a Passive
// action (gated by Trigger/Filter/Chance, same as any other passive) and an Active action (gated by the
// existing Boolean Condition — HP / STAB / Weather — same as any other active trigger).
const PP_COST_TARGETS = [["highestBasePower", "Highest Base Power Move (User's Movepool)"], ["lastUsedMove", "Last Used Move (User)"]];
const PP_COST_DIRECTIONS = [["increase", "Increase PP Cost"], ["decrease", "Decrease PP Cost"]];
PASSIVE_ACTIONS.push(["modifyPPCost", "Modify PP Cost (Dynamic, Targeted)"]);
ACTIVE_ACTIONS.push(["modifyPPCost", "Modify PP Cost (Dynamic, Targeted)"]);

// ================= MOVE KEYWORD & TAGGING SYSTEM =================
// Auto-detected from name/description text; merged with any manually entered tags.
const KEYWORD_TAG_MAP = {
  slash: "Slash", claw: "Slash", punch: "Punch", fist: "Punch", knuckle: "Punch",
  kick: "Kick", stomp: "Kick", bite: "Bite", fang: "Bite", chomp: "Bite",
  drain: "Draining", absorb: "Draining", leech: "Draining",
  guard: "Defending", shield: "Defending", protect: "Defending", brace: "Defending"
};
function deriveAutoTags(name, desc) {
  const hay = `${name || ""} ${desc || ""}`.toLowerCase();
  const found = new Set();
  Object.keys(KEYWORD_TAG_MAP).forEach(kw => { if (hay.includes(kw)) found.add(KEYWORD_TAG_MAP[kw]); });
  return [...found];
}
function normalizeTags(explicitTags, name, desc) {
  const manual = Array.isArray(explicitTags) ? explicitTags.map(t => String(t).trim()).filter(Boolean)
    : (typeof explicitTags === "string" ? explicitTags.split(",").map(t => t.trim()).filter(Boolean) : []);
  return [...new Set([...manual, ...deriveAutoTags(name, desc)])];
}
// ================= TAG-BASED MOVE TRANSFORMATIONS (MULTI-TAG STACKING) =================
// A move carries an array of independent Tag Rules — each one watches for a specific tag on the move's
// OWN tags list and, if present, transforms a resolved WORKING COPY of the move for this use only. The
// stored move object itself is never mutated (see applyMoveTagRules() in the simulator core), so multiple
// rules on the same move (e.g. a [blade] type-conversion rule AND a [projectile] invuln-bypass rule) stack
// sequentially without overwriting base move parameters or clobbering each other.
const TAG_RULE_EFFECTS = [
  ["convertType", "Tag-to-Type Conversion (e.g. [blade] -> Steel-type)"],
  ["bypassInvuln", "Bypass Airborne/Invulnerable Stances (e.g. [projectile])"],
  ["powderImmune", "Powder-Style Immunity Check (Grass types + immune abilities, e.g. [powder])"]
];
function normalizeTagRule(t) {
  t = t || {};
  return {
    tag: String(t.tag || "").trim(),
    effect: TAG_RULE_EFFECTS.some(e => e[0] === t.effect) ? t.effect : "convertType",
    convertType: TYPES.includes(t.convertType) ? t.convertType : "steel"
  };
}
function normalizeTagRules(list) {
  return Array.isArray(list) ? list.map(normalizeTagRule).filter(r => r.tag) : [];
}

// ==================== ENTRY-LEVEL TAG MATCHUPS (WEAKNESSES & STRENGTHS AGAINST TAGS) ====================
// Lives on the CREATURE itself (entry.tagMatchups), not on any Ability — so it always applies, the same
// way the Type Chart always applies, regardless of which Ability (if any) is active in battle. Each row
// is {tag, multiplier}: any landed hit whose move carries that tag has its damage multiplied accordingly
// (0.5 = resists it, 2 = weak to it, 0 = fully immune to it). See tagMatchupMultiplier() in the simulator
// core for how multiple matching rows stack.
function normalizeTagMatchup(tm) {
  tm = tm || {};
  return {
    tag: String(tm.tag || "").trim(),
    multiplier: tm.multiplier != null && !isNaN(Number(tm.multiplier)) ? Math.max(0, Number(tm.multiplier)) : 1
  };
}
function normalizeTagMatchups(list) {
  return Array.isArray(list) ? list.map(normalizeTagMatchup).filter(t => t.tag) : [];
}

// ==================== POKÉMON TAGS (entry.tags) ====================
// Free-text custom tags living on the CREATURE itself (e.g. "levitating", "boss", "heavyweight") —
// distinct from a Move's own Tags and from Tag Matchups above. Carried straight through onto the battle
// engine's fighter objects as fighters[side].tags. Currently checked by isGrounded() ("levitating" exempts
// a fighter from Terrain effects/protections the same way being Flying-type does), and available for any
// future custom rule that wants to key off a creature-level tag. ----
// ---- Tag Synonyms: every spelling in a group (any capitalization) is stored and matched as the group's
// canonical tag. "grounded" = buried in the ground (Diglett / Dugtrio / Wugtrio / Mega Gengar-style): moves with
// "Fails Against Fakemon Tags: grounded" (Whirlwind, Telekinesis, Sky Drop...) fail against it. ----
const TAG_SYNONYMS = { grounded: ["grounded", "buried", "burrowed", "underground", "subterranean"] };
function canonTag(t) {
  const s = String(t == null ? "" : t).trim(), l = s.toLowerCase();
  for (const k in TAG_SYNONYMS) if (TAG_SYNONYMS[k].includes(l)) return k;
  return s;
}
function fighterHasTag(f, tag) {
  const want = canonTag(tag).toLowerCase();
  return !!want && ((f && f.tags) || []).some(t => canonTag(t).toLowerCase() === want);
}
function normalizeCreatureTags(list) {
  const arr = Array.isArray(list) ? list.map(t => String(t).trim()).filter(Boolean)
    : (typeof list === "string" ? list.split(",").map(t => t.trim()).filter(Boolean) : []);
  const seen = new Set(), out = [];
  arr.forEach(t => { const c = canonTag(t), k = c.toLowerCase(); if (c && !seen.has(k)) { seen.add(k); out.push(c); } });
  return out;
}

// ==================== GENDER SYSTEM (entry.genderPool -> fighters[side].gender) ====================
// genderPool lives on the dex entry: which gender(s) this species CAN be. "Both" rolls Male/Female
// 50/50 fresh each time it enters battle (see rollGender(), called once per side when `fighters` is
// built in simulateOneBattle — the result is cached on fighters[side].gender for the rest of that
// battle, never re-rolled turn to turn). The resolved gender is never shown directly in the UI; it
// only ever surfaces through effect text, e.g. the Infatuated reveal line below.
const GENDER_POOL_OPTIONS = [["Male", "Male Only"], ["Female", "Female Only"], ["Both", "Both (rolled randomly per battle)"], ["Genderless", "Genderless"]];
function normalizeGenderPool(v) {
  return GENDER_POOL_OPTIONS.some(g => g[0] === v) ? v : "Genderless";
}
function rollGender(genderPool) {
  switch (genderPool) {
    case "Male": return "Male";
    case "Female": return "Female";
    case "Both": return Math.random() < 0.5 ? "Male" : "Female";
    default: return "Genderless";
  }
}

// ==================== TASTES / FLAVOR PREFERENCES (entry.tastes) ====================
// Sparse map — a flavor missing from the object means "neutral" (the default), so entries only need
// to declare their standout likes/hates. Feeds any berry-liking / preference-gated effect; also
// auto-derives quick-check tags (e.g. "hatesSweet") merged into entry.tags via deriveTasteTags(), the
// same "derive + merge" pattern normalizeTags()/deriveAutoTags() already use for Move tags.
const FLAVORS = ["Sweet", "Spicy", "Sour", "Bitter", "Dry", "Savory"];
const TASTE_PREFERENCE_OPTIONS = [["neutral", "Neutral"], ["likes", "Likes"], ["hates", "Hates"]];
function normalizeTastes(tastes) {
  const out = {};
  FLAVORS.forEach(f => {
    const v = tastes && tastes[f];
    if (v === "likes" || v === "hates") out[f] = v;
  });
  return out;
}
function deriveTasteTags(tastes) {
  const out = [];
  FLAVORS.forEach(f => {
    const pref = (tastes || {})[f];
    if (pref === "likes") out.push(`likes${f}`);
    if (pref === "hates") out.push(`hates${f}`);
  });
  return out;
}

// ==================== TASTE / FLAVOR CONDITIONAL ENGINE (If/Else Consumption Logic) ====================
const TASTE_LIKE_MULTIPLIER = 1.2;
const TASTE_HATE_MULTIPLIER = 0.5;
const TASTE_HATE_CONFUSION_CHANCE = 0.5;
function getTastePreference(pokemon, flavor) {
  if (!pokemon || !flavor || flavor === "none") return "neutral";
  const tastes = pokemon.tastes || {};
  if (tastes[flavor] === "likes" || tastes[flavor] === "hates") return tastes[flavor];
  const tags = (pokemon.tags || []).map(t => String(t).toLowerCase());
  if (tags.includes(`hates${flavor}`.toLowerCase())) return "hates";
  if (tags.includes(`likes${flavor}`.toLowerCase())) return "likes";
  return "neutral";
}

// ================= STATUS-BYPASS & FORCED ACTION MECHANICS =================
// Per-move override flags checked at the top of the pre-turn status-lockout phase in simulateOneBattle,
// before the normal Sleep/Freeze/Confusion continue-and-skip-turn logic runs.
function normalizeStatusBypass(sb) {
  sb = sb || {};
  return {
    sleep: !!sb.sleep,       // Sleep Talk/Snore-style: usable while asleep, without waking up
    freeze: !!sb.freeze,     // thaws the user automatically and executes anyway
    confusion: !!sb.confusion // forces execution, skipping the confusion self-hit/no-act roll entirely
  };
}

PASSIVE_ACTIONS.push(["tagDamageMult", "Damage Multiplier vs Moves With a Specific Tag"]);
// ---- Defensive Ability Tag Triggers: the three response actions available to the "hitByTag" Passive
// Trigger above. All three are gated by the same tag match (hitTagFilter) + Effect Chance % as every
// other passive action; dispatched in the dedicated "hitByTag" block in simulateOneBattle (not through
// the generic runAbilityAction ctx.hasDamage dispatcher, since Negate Move must also short-circuit the
// move's own secondary effects and works on Status moves too, not just damaging ones). ----
PASSIVE_ACTIONS.push(["negateTaggedMove", "Negate Move (Block Damage + Secondary Effects, Tag-Triggered)"]);
PASSIVE_ACTIONS.push(["reflectDamage", "Reflect Damage to Attacker (Flat # or % of Attacker's Max HP)"]);
PASSIVE_ACTIONS.push(["tagStatMod", "Apply Stat Modification (+ Secondary Matrix Effect Sequence, Tag-Triggered)"]);
PASSIVE_ACTIONS.push(["auraField", "Aura Field (Passive Field Damage Each Turn)"]);
PASSIVE_ACTIONS.push(["chipOnHit", "Chip Damage On Hit Landed/Taken"]);
PASSIVE_ACTIONS.push(["setWeather", "Set Weather On Entry"]);
ACTIVE_ACTIONS.push(["setWeather", "Set Weather (Active Trigger)"]);
// ---- Set Field Effect: distinct from Set Weather (both can be active at once) — sets/overwrites the
// battlefield's Field Effect (Grassy Field / Flood) instead of its Weather. ----
PASSIVE_ACTIONS.push(["setField", "Set Field Effect On Entry"]);
ACTIVE_ACTIONS.push(["setField", "Set Field Effect (Active Trigger)"]);

// ---- Ability-Driven Transformation (Ditto/Imposter-style): a Passive Action, gated on the "On Battle
// Start" Trigger just like Set Weather/Field On Entry above — the instant this ability's owner enters
// battle, it overwrites its OWN runtime fighter state with a full copy of the opponent's (stats, types,
// moves, ability, name, sprite), keeping its own current HP. See performImposterTransform() in the
// simulator. "No Effect" is a no-op placeholder Action, same role as a Status move's "No Secondary
// Effect" — pick it when a rule is only there to exist but shouldn't do anything.
PASSIVE_ACTIONS.push(["transformOnEntry", "Transform on Entry (Ditto/Imposter-style — Copies Opponent's Stats/Types/Moves/Ability/Sprite)"]);
PASSIVE_ACTIONS.push(["none", "No Effect"]);

// ================= SERENE GRACE MECHANIC: SECONDARY EFFECT CHANCE MULTIPLIERS =================
// A passive action that scales the base Effect Chance % of a move's own secondary effect (status
// infliction, Additional Effects array) by a flat multiplier — either globally or scoped to moves
// carrying a specific Move Tag. Rolled via secondaryChanceMultiplierFor() right before the move's
// own chanceHits() secondary-effect roll in simulateOneBattle (not through the generic
// runAbilityAction ctx.hasDamage dispatcher, since it modifies a probability, not a damage value).
PASSIVE_ACTIONS.push(["secondaryChanceMult", "Secondary Effect Chance Multiplier (Serene Grace-style)"]);
PASSIVE_ACTIONS.push(["categoryDamageMult", "Damage Multiplier vs Move Category (Fur Coat / Ice Scales-style — Physical or Special; use Trigger Defending to resist, Attacking to boost)"]);
PASSIVE_ACTIONS.push(["critMod", "Critical Hit Modifier (Super Luck / Sniper / Battle Armor-style — ALWAYS ignores Trigger: extra crit stages, bigger crit damage, or crit immunity)"]);
PASSIVE_ACTIONS.push(["evasionMult", "Evasion (Sand Veil / Snow Cloak-style — ALWAYS ignores Trigger: foe hit chance x factor, optionally only in one weather)"]);

// ================= MOVEMENT TAG TRIGGERS (EXPANDED) =================
// Three additional Passive Triggers layered onto the existing "hitByTag" (When Receiving a Move With
// Tag) trigger, all reusing the same tag-filter text field: hitting with a tagged move, the opponent
// merely attempting a tagged move (fires on cast, hit or miss), and the user itself using a tagged move.
PASSIVE_TRIGGERS.push(
  ["onHitTag", "When Hitting With a Move Tag [Select Tag]"],
  ["opponentUsesTag", "When Opponent Uses a Move With Tag [Select Tag] (fires on attempt, hit or miss)"],
  ["selfUsesTag", "When You Use a Move With Tag [Select Tag]"]
);

// ================= WEIGHT-BASED MECHANICS =================
const WEIGHT_SCALING_MODES = [
  ["none", "No Weight Interaction"],
  ["crushHeavy", "Crush: Bonus Damage vs Heavier Target"],
  ["leverageLight", "Leverage: Bonus Damage vs Lighter Target"]
];

// ================= DEFENSE-SCALING DAMAGE BASIS =================
const DAMAGE_BASIS_OPTIONS = [
  ["standard", "Standard (Attack / Sp. Attack by Category)"],
  ["defense", "User's Own Defense Stat (Body-Press style)"]
];

// ================= BATTLE HISTORY & DAMAGE SCALING TRACKERS =================
// Lets a move's damage scale off of turn-by-turn battle history rather than a fixed Base Power.
// Tracked live in simulateOneBattle's combatant state and applied as a damage multiplier alongside
// the existing Weight Interaction multiplier (see historyScalingMultiplier()).
const HISTORY_SCALING_MODES = [
  ["none", "No History Scaling"],
  ["consecutiveUse", "Stronger the More Consecutive Times Used (Fury Cutter-style; resets on a different move or a miss)"],
  ["totalHits", "Stronger the More Times It Hits In Total This Battle (Echoed Voice-style)"],
  ["damageTaken", "Stronger Based on Total Damage Received This Match (Revenge-style)"]
];

// ================= ADVANCED STATUS CONDITIONS MATRIX =================
STATUS_EFFECTS.push(["flinch", "Flinch (1 Turn Only)"], ["confusion", "Confusion"], ["freeze", "Freeze"], ["taunt", "Taunt"]);
STATUS_IMMUNITIES.freeze = new Set(["ice", "fire", "rock", "steel"]);
// ---- Contextual Status Interaction: "Wet" makes the target take elevated Electric-type damage. It can
// be inflicted directly by a Move (via the normal Inflict Status Effect path, immunity-checked like any
// other status) OR applied automatically field-wide while Rain is active (see simulator core). ----
STATUS_EFFECTS.push(["wet", "Wet (Boosts Incoming Electric Damage)"]);
// ---- Forced Action Status: "Repeat" locks the target into re-using only its Last Used Move for the
// status's duration — enforced at move-selection time in the simulator core (see chosenMove loop). ----
STATUS_EFFECTS.push(["repeat", "Repeat (Forced to Reuse Last Move)"]);
STATUS_EFFECTS.push(["mirrorstance", "Mirror Stance (Reflect % Damage Taken)"]);

// ================= CUSTOM STATUS: INFATUATED (Attract-style) =================
// Applied via a Move/Effect's normal Inflict Status Effect path OR an item's `statusEffectOnUse`
// block (see applyItemStatusEffect() in the simulator core). Deliberately left OUT of
// MAJOR_STATUS_KINDS — like mainline Attract, it isn't blocked by Misty Terrain or counted for
// Terrain's "grounded major status" checks — and its status[side] object carries turnsLeft:Infinity
// (see createInfatuatedStatus()) since it persists until cured/switch, not a fixed number of turns.
// Compatibility is gender-based (see isGenderCompatible()); the 50%-can't-move roll and its reveal
// line ("It's a Male/Female! Can't move ❤️") happen in the pre-turn status-lockout phase, right
// alongside the existing paralysis check.
STATUS_EFFECTS.push(["infatuated", "Infatuated (50% Can't Move vs. Compatible Gender)"]);
function createInfatuatedStatus(infatuatedWith) {
  return { kind: "infatuated", counter: 1, turnsLeft: Infinity, infatuatedWith };
}
// Genderless is never compatible with anything, mirroring mainline Attract — both sides must be
// Male/Female AND differ. A "genderfluid" Pokémon Tag (entry.tags/fighters[side].tags) on EITHER
// side is a custom override that allows infatuation regardless of the resolved genders, as a hook
// for creatures you don't want gender-gated at all.
function isGenderCompatible(attackerGender, targetGender, attackerTags, targetTags) {
  if (attackerGender === "Genderless" || targetGender === "Genderless") return false;
  const aTags = (attackerTags || []).map(t => String(t).toLowerCase());
  const tTags = (targetTags || []).map(t => String(t).toLowerCase());
  if (aTags.includes("genderfluid") || tTags.includes("genderfluid")) return true;
  return attackerGender !== targetGender;
}

// ================= CUSTOM STATUS: LOST CONTROL (Rampage/Thrash-style forced offense) =================
// Action Lock: only Physical/Special (attacking) moves are selectable while active — enforced in the
// chosenMove pool filter in simulateOneBattle. Stat Buff: outgoing damage is multiplied by
// LOST_CONTROL_ATK_MULTIPLIER for the duration. Self-Damage Chance: each attack attempt rolls
// LOST_CONTROL_SELF_HIT_CHANCE (60%) to redirect the hit onto the user instead of the target — resolved
// once per attack attempt in the pre-move resolution check, before the accuracy roll.
STATUS_EFFECTS.push(["lostcontrol", "Lost Control (Rampage-style: attack-only, boosted, 60% self-hit)"]);
const LOST_CONTROL_ATK_MULTIPLIER = 1.3; // configurable: try 1.5 for a harsher variant
const LOST_CONTROL_SELF_HIT_CHANCE = 0.6; // 60% self-hit / 40% lands on the target

// ================= ACCURACY / DODGE / PRECISION MECHANICS =================
// Speed doubles as a unit's Dodge/Evasion stat: the bigger the Speed gap between attacker and defender,
// the more the base Accuracy value swings up or down. DODGE_SPEED_WEIGHT tunes how strongly that gap
// matters (0 = Speed has no effect on accuracy, 1 = a huge Speed gap can nearly double or halve the hit
// chance on its own). MIN/MAX_DODGE_HIT_MULT floor and ceiling the swing so no matchup ever becomes a
// guaranteed miss or guaranteed hit purely from a stat difference — the move's own Accuracy value still
// matters. See computeDodgeHitMultiplier() below for the formula, and the "unavoidable"/"undodgeable"
// move tag for moves that skip this (and the base accuracy roll) entirely. ----
const DODGE_SPEED_WEIGHT = 0.5;
const MIN_DODGE_HIT_MULT = 0.5;
const MAX_DODGE_HIT_MULT = 1.2;
// ---- Accuracy vs Dodge formula: finalHitChance = move.accuracy * otherModifiers * dodgeMult, where
// dodgeMult = 1 - ((defSpeed - atkSpeed) / (defSpeed + atkSpeed)) * DODGE_SPEED_WEIGHT, clamped to
// [MIN_DODGE_HIT_MULT, MAX_DODGE_HIT_MULT]. Equal Speed -> dodgeMult of exactly 1 (no change). A much
// faster defender pulls the multiplier toward the floor; a much faster attacker pulls it toward the
// ceiling. Moves carrying the "unavoidable" (or "undodgeable") tag bypass this function's result
// entirely and always connect, unless blocked by an unrelated hard immunity (e.g. Powder vs Grass). ----
function computeDodgeHitMultiplier(atkSpeed, defSpeed) {
  const raw = 1 - ((defSpeed - atkSpeed) / Math.max(1, defSpeed + atkSpeed)) * DODGE_SPEED_WEIGHT;
  return Math.max(MIN_DODGE_HIT_MULT, Math.min(MAX_DODGE_HIT_MULT, raw));
}
function moveIsUnavoidable(move) {
  return (move.tags || []).some(t => { const tl = String(t).toLowerCase(); return tl === "unavoidable" || tl === "undodgeable"; });
}

// ================= SPEED-SCALING OFFENSE =================
// Lets a move's damage scale off Speed instead of (or in addition to) the standard Attack/Sp.Atk stat.
// move.speedScaling selects the paradigm:
//  - "none"            : standard damage calc, unaffected (default).
//  - "relativeFaster"  : bonus damage scaling with how much FASTER the user is than the target this turn.
//  - "relativeSlower"  : bonus damage scaling with how much SLOWER the user is than a faster target —
//                        rewards a slow user for tanking a hit before striking back at a speedy foe.
//  - "absolute"        : base power scales directly off the user's own raw Speed stat, regardless of the
//                        target's Speed at all (a pure "the faster I am, the harder I hit" move).
// move.speedScalingFactor is the tunable strength of the scaling (default 0.5 = up to +50% damage at the
// formula's cap). See speedScalingMultiplier() below for the exact math, applied in the main damage loop
// alongside the other multiplicative modifiers (type effectiveness, weather, weight, etc). ----
function speedScalingMultiplier(move, atkSpeed, defSpeed) {
  const mode = move.speedScaling || "none";
  const factor = move.speedScalingFactor != null && !isNaN(Number(move.speedScalingFactor)) ? Number(move.speedScalingFactor) : 0.5;
  if (mode === "relativeFaster") {
    // Capped at +factor (e.g. +50%) once the user is roughly 2x+ the target's Speed or faster.
    const gapRatio = Math.max(0, (atkSpeed - defSpeed) / Math.max(1, defSpeed));
    return 1 + Math.min(factor, gapRatio * factor);
  }
  if (mode === "relativeSlower") {
    // Capped at +factor once the TARGET is roughly 2x+ the user's Speed or faster.
    const gapRatio = Math.max(0, (defSpeed - atkSpeed) / Math.max(1, atkSpeed));
    return 1 + Math.min(factor, gapRatio * factor);
  }
  if (mode === "absolute") {
    // Every 100 points of the user's raw Speed adds `factor`*100% damage, uncapped except by the
    // move's own basePower ceiling elsewhere in the pipeline.
    return 1 + Math.max(0, atkSpeed / 100) * factor;
  }
  return 1;
}

// ================= EXPANDED STAT/WEIGHT DAMAGE SCALING (DYNAMIC BASE POWER) =================
// Unlike speedScalingMultiplier() above (a multiplier layered alongside type effectiveness, weight,
// etc.), these formulas REPLACE the move's effective Base Power outright before the existing bpScale
// baseline conversion runs — matching how Electro Ball/Gyro Ball/Heavy Slam/Low Kick actually work in
// the source games (a fixed BP tier or computed value, not a percentage bonus on top of a set number).
// move.dynamicPower selects the paradigm; "none" (default) leaves move.basePower completely untouched.
const DYNAMIC_POWER_MODES = [
  ["none", "No Dynamic Base Power Scaling"],
  ["speedFaster", "Scale with Speed Ratio (Faster) — Electro Ball-style"],
  ["speedSlower", "Scale with Speed Ratio (Slower) — Gyro Ball-style"],
  ["weightAbsolute", "Scale with User Weight (Absolute) — Heavy Hitter-style"],
  ["weightRatio", "Scale with Weight Differential — Heavy Slam-style"],
  ["userHpHigh", "Scale with User's HP — MORE HP = more power (Eruption / Water Spout-style)"],
  ["userHpLow", "Scale with User's HP — LESS HP = more power (Flail / Reversal-style)"],
  ["targetHpHigh", "Scale with Target's HP — MORE HP = more power (Crush Grip-style)"],
  ["targetHpLow", "Scale with Target's HP — LESS HP = more power (Wring Out inverse / Brine-style)"]
];
// Returns a replacement Base Power number, or null if mode is "none" (meaning: use move.basePower as-is).
function dynamicBasePower(move, atkSpeed, defSpeed, atkWeight, defWeight, userHpFrac, targetHpFrac) {
  const mode = move.dynamicPower || "none";
  if (mode === "userHpHigh" || mode === "userHpLow" || mode === "targetHpHigh" || mode === "targetHpLow") {
    // HP-scaled power: the move's Base Power is its power at the EXTREME (full HP for "More HP", near-0 HP for
    // "Less HP"), scaling linearly down to a floor of 10% of that so it never drops to nothing.
    const base = move.basePower || 60;
    const f = Math.max(0, Math.min(1, mode.startsWith("user") ? userHpFrac : targetHpFrac));
    const frac = mode.endsWith("High") ? f : 1 - f;
    return Math.max(1, Math.round(base * Math.max(0.1, frac)));
  }
  if (mode === "speedFaster") {
    // Electro Ball formula: the faster the user is relative to the target this turn, the higher the
    // fixed Base Power tier awarded — capped at 150 BP once the user hits ~4x the target's Speed.
    const ratio = atkSpeed / Math.max(1, defSpeed);
    if (ratio < 1) return 40;
    if (ratio < 2) return 60;
    if (ratio < 3) return 80;
    if (ratio < 4) return 120;
    return 150;
  }
  if (mode === "speedSlower") {
    // Gyro Ball formula: the SLOWER the user is compared to the target, the higher the resulting
    // Base Power — floored at 1, capped at 150 to stay in line with Electro Ball's own ceiling.
    return Math.max(1, Math.min(150, Math.floor((25 * defSpeed) / Math.max(1, atkSpeed)) + 1));
  }
  if (mode === "weightAbsolute") {
    // Heavy Hitter formula: a logarithmic multiplier on the move's OWN Base Power based on the user's
    // raw Weight (kg) — heavier users hit meaningfully harder without the bonus ever running away
    // unbounded (a 100kg user gets ~1.48x, a 500kg user gets ~2.08x).
    const base = move.basePower || 60;
    return Math.max(1, Math.round(base * (1 + Math.log10(1 + Math.max(0, atkWeight) / 50))));
  }
  if (mode === "weightRatio") {
    // Heavy Slam / Low Kick formula: fixed Base Power tiers based on how many times heavier the user
    // is than the target this turn (reads tempWeight, so a live Weight modifier is respected).
    const ratio = atkWeight / Math.max(0.1, defWeight);
    if (ratio < 2) return 40;
    if (ratio < 3) return 60;
    if (ratio < 4) return 80;
    if (ratio < 5) return 100;
    return 120;
  }
  return null;
}

// ================= WHO / WHAT / WHEN / HOW ADVANCED RULE MATRIX =================
EFFECT_TYPES.push(["matrix", "Advanced WHO / WHAT / WHEN / HOW Rule"]);
const MATRIX_WHO = [
  ["self", "WHO: Self (User)"],
  ["ally", "WHO: Ally (reserved for team battles; resolves to Self in 1v1)"],
  ["enemy", "WHO: Enemy"],
  ["field", "WHO: All Field (Both Combatants)"]
];
const MATRIX_WHAT = [
  ["statChange", "WHAT: Stat Change"],
  ["typeDamageMult", "WHAT: Type-Damage Multiplier"],
  ["negateStatus", "WHAT: Negate Specific Status Condition"],
  ["weightMultiplier", "WHAT: Weight-Based Damage Multiplier"],
  ["drainLife", "WHAT: Drain Life (Deal Damage, Heal Self by % Dealt)"]
];
const MATRIX_WHEN = [
  ["onMoveSelect", "WHEN: On Move Selection (Pre-Turn)"],
  ["onHitSuperEffective", "WHEN: When Hit By a Super-Effective Move"],
  ["onHitByType", "WHEN: When Hit By a Specific Type"],
  ["onDealByType", "WHEN: When Hitting With a Specific Type"],
  ["onDealSuperEffective", "WHEN: When Dealing Super-Effective Damage"],
  ["onDealNotVeryEffective", "WHEN: When Dealing Not-Very-Effective Damage"],
  ["onDealImmune", "WHEN: When a Move Would Deal No Damage (Immune)"],
  ["onHpThreshold", "WHEN: Under a Specific HP % Threshold"],
  ["onStatusActive", "WHEN: While Under a Specific Status Condition"]
];
MATRIX_WHEN.push(["onKnockOut", "WHEN: When This Combatant Knocks Out the Foe (Moxie / Beast Boost-style)"]);
const MATRIX_HOW_BASIS = [
  ["flat", "HOW: Flat Magnitude"],
  ["defenseScaled", "HOW: Scaled by User's Defense"],
  ["weightScaled", "HOW: Scaled by Weight Difference"]
];

// ================= STAT/STATUS MANIPULATION, RECOIL & RESOURCE SYSTEMS =================
// ---- Stat Comparison Trigger: an optional gate on any Advanced Rule Matrix node — "If [Self/Opponent]
// [Stat] is [Higher/Lower/Equal] than [Self/Opponent] [Stat], execute X" — evaluated in runMatrixEffects
// right alongside the existing HP-threshold / status-active / type-filter gates. ----
const STAT_COMPARE_WHO = [["self", "Self"], ["opponent", "Opponent"]];
const STAT_COMPARE_OPS = [["higher", "Is Higher Than"], ["lower", "Is Lower Than"], ["equal", "Is Equal To"]];
// ---- Ability Stat Mod Blockers: dropdown on the Ability row itself (not the rule builder) that gates
// EVERY incoming stat-stage change against that ability's owner, checked by statModAllowed() ----
const NEGATE_STATMOD_MODES = [["none", "None"], ["blockDebuffs", "Block Debuffs"], ["blockBuffs", "Block Buffs"], ["blockAll", "Block All Stat Changes"], ["contrary", "Contrary (flips the direction of EVERY stat change — drops become rises and vice versa, from any source)"]];
// ---- Debuff Trigger Tracker source filter (Competitive/Defiant-style): which side must have CAUSED the
// stat drop for the "When a Stat Is Lowered" Passive Trigger to fire. Defaults to "opponent" because that's
// the real mechanic — Competitive/Defiant never trigger off your own self-inflicted drops (Overheat,
// Leaf Storm, etc.), only off a drop the OPPONENT caused (their move or ability). ----
const STAT_LOWERED_SOURCES = [["opponent", "Only When Lowered By the Opponent (Competitive/Defiant-style)"], ["any", "Any Source (Opponent OR Self-Inflicted)"], ["self", "Only When Self-Inflicted (e.g. after using a draining move)"]];
// ---- Clear Stat Modifiers (Haze-style) + Field/Status Clearers + PP Spite + Random Move Transmutation:
// new Dynamic Multi-Effect Sequence Array node types, appended to the existing EFFECT_TYPES vocab ----
const CLEAR_STATMOD_MODES = [["buffs", "Clear Buffs"], ["debuffs", "Clear Debuffs"], ["all", "Clear All (Haze)"]];
const HAZARD_CLEAR_SCOPES = [["self", "User's Field Only"], ["both", "Both Fields"]];
const STATUS_CLEAR_SCOPES = [["self", "User Only"], ["both", "Both Combatants"], ["opponent", "Target (Opponent) Only — removes the foe's status"]];
EFFECT_TYPES.push(["clearstatmod", "Clear Stat Modifiers (Haze-style)"]);
EFFECT_TYPES.push(["clearFieldHazards", "Clear Field Hazards (Rapid Spin / Defog)"]);
EFFECT_TYPES.push(["clearStatusEffects", "Cure Status Condition(s)"]);
EFFECT_TYPES.push(["ppcost", "Increase Target's PP Cost (Spite)"]);
EFFECT_TYPES.push(["randomizemove", "Randomly Transmute a Move (Metronome / Mirror Move)"]);
// ---- Customizable Hit-Count Attack Shields: a new Dynamic Multi-Effect Sequence Array node type that
// erects a barrier absorbing a fixed number of direct hits before shattering. Trigger Type filters which
// move CATEGORIES it blocks (Physical/Special/Any); Type Filter filters which move TYPE it blocks
// ("any" = blocks all types). "Unignorable Shield" overrides a move's own "Ignore Defenses/Shields"
// attribute, so this specific shield can never be bypassed no matter what hits it. ----
const SHIELD_TRIGGER_TYPES = [["any", "Any Hit (Physical or Special)"], ["physical", "Physical Hits Only"], ["special", "Special Hits Only"]];
const SHIELD_TYPE_FILTERS = [["any", "Any Type (blocks all)"], ...TYPES.map(t => [t, cap(t)])];
// ---- Extended Shield Vulnerabilities: an optional set of MOVE TAGS this shield reacts to (independent
// of its Type Filter above), entered as free-text (comma-separated) so custom tags match the same
// freeform convention as a move's own Tags field, plus which outcome fires when a tag matches. ----
const SHIELD_VULN_OUTCOMES = [
  ["bypass", "Direct Bypassing (tagged hits ignore the shield entirely)"],
  ["bonusDeplete", "Bonus Depletion (tagged hits remove extra hits/durability)"],
  ["shatter", "Shield Shatter (tagged hits break the shield instantly)"],
  ["damageMult", "Damage Multiplier (tagged hits deal increased durability damage)"]
];
// ---- Reactive Shield Triggers: what happens to an ATTACKER whenever this shield blocks one of their
// hits — on top of the shield absorbing the hit itself. "none" is a purely defensive barrier with no
// punish. "damage" reflects a % of the shield-owner's max HP back onto the attacker (Thorns/Spikes-style).
// "status" inflicts a status condition on the attacker instead (Molten Moat-style), gated by its own
// Effect Chance %. Both reaction kinds can additionally be restricted to Contact-only hits, so a purely
// ranged/special attack isn't punished by what's meant to be a physical barrier. ----
const SHIELD_REACTION_TYPES = [
  ["none", "None (Purely Defensive Barrier)"],
  ["damage", "Direct Damage (Thorns/Spikes-style — % of Owner's Max HP)"],
  ["status", "Status Infliction (e.g. Molten Moat-style Burn)"]
];
EFFECT_TYPES.push(["shield", "Generate Shield (Hit-Count Attack Barrier)"]);
EFFECT_TYPES.push(["statusTransfer", "Status Transfer / Swap"]);
// ---- Multi-Stat Modifier (Ominous Wind-style): choose ANY subset of the five primary stats (2 or more,
// up to all 5) and raise or lower all of them together under this ONE node's single Chance % roll — one
// roll, one direction, several stats at once, instead of stacking several separate "Stat Modifier" nodes
// that each roll independently. Leaving every stat unchecked falls back to all 5 (the old hardcoded
// "Omni-Boost" behavior, kept for legacy saves). ----
EFFECT_TYPES.push(["omniBoost", "Multi-Stat Modifier (choose 2+ stats — ONE roll, ONE direction, e.g. Ominous Wind)"]);
// ---- In-Battle Form Change (Standalone Mega Mechanics): a Move Effect that triggers a form change
// directly, with no dependency on the Mega Evolution activation system, the "Allow Mega Evolution"
// Battle Simulator toggle, or a Mega Bracelet/Held Item requirement. Bundles the same Target Form,
// Stat Boost, Ability/Type swap, and Visual Transformation Log Line options a Mega Evolution profile
// offers, just packaged as a single effect node so a move like Dragon Ascent (Rayquaza-style) or any
// other stance/form-change move can carry its own transformation with zero Mega setup. See the
// "changeForm" branch in runEffectsArray() for the runtime swap logic. ----
EFFECT_TYPES.push(["changeForm", "Change Form in Battle (Standalone Transformation)"]);
// ---- Trigger Alternate Form: a generic effect with NO form data of its own. When it fires, the USER
// switches into one of ITS OWN alternate forms (a form profile whose Activation Requirement is set to
// "Trigger Alternate Form effect"). Works on moves AND abilities, so one imported move (e.g. "Evolve")
// can trigger a different form on any Fakemon that has one. See the "triggerForm" branch in
// runEffectsArray() and tryTriggerForm() in the simulator core. ----
EFFECT_TYPES.push(["triggerForm", "Trigger Alternate Form (user switches into its own alt form)"]);
EFFECT_TYPES.push(["accuracyMod", "Modify Accuracy (Temporary Battle Accuracy %, Sand Attack-style)"]);
// ---- Delayed Attack Events (Future Sight / Doom Desire Mechanic): a Move-level (not effect-level)
// matrix. Damage is queued instead of applied immediately, then lands automatically after Delay
// Duration turns pass. Stat Calculation Snap decides whether the attacker's offensive stat is frozen
// at the moment of launch, or freshly recalculated (using whatever stat stages/status apply) at the
// moment it lands. Type Immunity Bypass lets the delayed hit ignore a 0x type-immunity result on landing. ----
const DELAY_STAT_SNAP_MODES = [["launch", "Snap Stats at Launch Time"], ["landing", "Calculate Stats at Landing Time"]];
// ---- Delayed Attack Events: independently controls WHEN a delayed move's own secondary Effects list
// (status/stat mods/heal/etc., via the shared Additional Effects array) actually runs — either
// immediately "With Cast" (the instant the move is used) or held back to fire "With Resolve" (the
// instant the delayed hit actually lands, alongside its damage). ----
const DELAY_EFFECT_TIMING_MODES = [["cast", "With Cast (runs immediately when the move is used)"], ["resolve", "With Resolve (runs later, when the delayed attack lands)"]];
// ---- Multi-Turn Charge Execution (Solar Beam / Skull Bash-style): the user locks into the move for
// `chargeDuration` turns before it actually fires. Each charging turn applies one conditional stance
// instead of dealing damage; the final turn clears the stance and resolves the move normally. ----
MOVE_FAIL_CONDITIONS.push(["notFirstTurn", "Fails Unless It Is the User's First Turn on the Field (Fake Out-style)"]);
const CHARGE_CONDITIONS = [["none", "Standard / Nothing"], ["shielded", "Shielded (Reduces Damage Taken by X%)"], ["healing", "Healing (Heals X% Max HP per Turn)"], ["statusImmune", "Immune to Status"]];
// ---- Conditional Status Damage Boosters (Hex/Facade-style) — Move-level fields, vocab shared with the
// existing STATUS_EFFECTS list plus an "Any Status" wildcard ----
const STATUS_DMG_FILTERS = [["any", "Any Status Condition"], ...STATUS_EFFECTS.filter(s => s[0] !== "none")];
// ---- Super Effective Reaction Triggers (Solid Rock / Filter) — new Passive Trigger + Passive Action ----
PASSIVE_TRIGGERS.push(["hitBySuperEffective", "When Hit By a Super Effective Move"]);
PASSIVE_ACTIONS.push(["reduceSuperEffective", "Reduce Super-Effective Damage Taken by X% (Solid Rock / Filter)"]);
PASSIVE_ACTIONS.push(["weatherSpeedMult", "Speed Multiplier While a Weather (or Terrain) Is Active (Chlorophyll / Swift Swim / Sand Rush / Surge Surfer-style — ALWAYS ignores Trigger)"]);
PASSIVE_ACTIONS.push(["blockPriority", "Block Opponent's Priority Moves (Dazzling / Queenly Majesty / Armor Tail-style — ALWAYS ignores Trigger)"]);
// ---- Recoil-Interaction Abilities: custom trigger counter for "When taking recoil damage, execute [X]" ----
PASSIVE_TRIGGERS.push(["takingRecoil", "When Taking Recoil Damage"]);

function seedRegions() {
  return [
    { id: 1, name: "Kanto Prime", subtitle: "Temperate mainland, first charted", color: REGION_COLORS[0], createdAt: Date.now() },
    { id: 2, name: "Umbra Isles", subtitle: "Fog-shrouded volcanic archipelago", color: REGION_COLORS[4], createdAt: Date.now() }
  ];
}
function seedEntries() {
  return [
    {
      id: 1, regionId: 1, name: "Emberling", category: "Kindling Pokémon", creator: "Mika", types: ["fire"], icon: "🔥", imageUrl: "", height: 0.4, weight: 5.1, rarity: "common", preEvo: null, preEvoMethod: "", variantOf: null,
      // REFERENCE CONFIG: "Molten Moat" demonstrates a Shield / Barrier effect with a Status Infliction
      // reactive trigger (Reaction: Status, Burn, 60% chance, Contact Only) — see the Advanced Battle
      // Systems Reference (Settings tab) section 1 for the full Shield mechanic writeup.
      abilities: [{ name: "Blaze Core", desc: "When HP falls low, this Pokémon's Fire-type moves grow stronger.", hidden: false }],
      moves: [{ name: "Ember", type: "fire", category: "Special", desc: "A weak fire attack that may leave the target with a burn." }, { name: "Growl", type: "normal", category: "Status", desc: "Lowers the target's Attack stat by lowering its guard." },
      {
        name: "Molten Moat", type: "fire", category: "Status", desc: "Surrounds the user with a ring of magma that absorbs 4 hits. Contact moves that strike it have a 60% chance to Burn the attacker.", pp: 10,
        tags: ["Shield"],
        effects: [{ type: "shield", shieldHitCapacity: 4, shieldTriggerType: "any", shieldTypeFilter: "any", shieldReaction: "status", shieldReactionStatus: "burn", shieldReactionChance: 60, shieldReactionContactOnly: true }]
      }],
      desc: "A palm-sized cinder given form. The flame on its tail flares brighter whenever it senses danger nearby.", stats: { hp: 40, atk: 48, def: 38, spa: 55, spd: 38, spe: 52 }
    },
    {
      id: 2, regionId: 1, name: "Cindrake", category: "Ember Wyrm Pokémon", creator: "Mika", types: ["fire", "dragon"], icon: "🐉", imageUrl: "", height: 1.4, weight: 32.0, rarity: "rare", preEvo: 1, preEvoMethod: "Level 16", variantOf: null,
      // ---- REFERENCE CONFIG: this entry demonstrates the Dynamic Multi-Effect Sequence Array (on "Ember Slash"),
      // a Resistance Multiplier passive node (on "Wing Guard"), and a Mega Form runtime state (see `mega` below). ----
      abilities: [
        {
          name: "Blaze Core", desc: "When HP falls low, this Pokémon's Fire-type moves grow stronger.", hidden: false,
          abilityType: "active", active: { condition: "hpBelow33", action: "boostDamage150", chance: 100, oncePerBattle: false }
        },
        {
          name: "Wing Guard", desc: "Reduces damage taken from the first hit of any attack each battle by resisting it.", hidden: false,
          abilityType: "passive", passive: { trigger: "defending", filterType: "any", action: "resistanceMult", resistRatio: 0.5, chance: 100 }
        },
        { name: "Solar Furnace", desc: "In harsh sunlight, this Pokémon's Speed is boosted.", hidden: true }
      ],
      moves: [
        {
          name: "Ember Slash", type: "fire", category: "Physical", desc: "Claws wreathed in flame slash the target, with a chance to burn.", pp: 20,
          // Dynamic Multi-Effect Sequence Array: unlimited nested nodes, each with its own chance / target / type
          effects: [{ type: "status", chance: 20, target: "opponent", statusEffect: "burn", statusDurationMode: "random", statusDurationMin: 2, statusDurationMax: 4 }]
        },
        { name: "Dragon Breath", type: "dragon", category: "Special", desc: "Exhales a stream of destructive energy that may cause paralysis." },
        { name: "Wing Buffet", type: "flying", category: "Physical", desc: "Batters the target with wings on both sides to inflict damage." }
      ],
      desc: "A young wyrm whose scales glow like embers when agitated. Nests in volcanic crags and hoards warm stones to sleep on.", stats: { hp: 68, atk: 82, def: 64, spa: 90, spd: 60, spe: 75 },
      // Mega Form runtime state: Support Mega Form toggle + Mega Form Name / Emoji Badge / Types / Base Stats
      mega: { enabled: true, name: "Mega Cindrake", emoji: "🐲", types: ["fire", "dragon"], stats: { hp: 68, atk: 110, def: 80, spa: 120, spd: 75, spe: 100 } }
    },
    {
      id: 3, regionId: 1, name: "Mossapod", category: "Tidepool Pokémon", creator: "Renna", types: ["water", "grass"], icon: "🐌", imageUrl: "", height: 0.5, weight: 6.2, rarity: "common", preEvo: null, preEvoMethod: "", variantOf: null,
      // REFERENCE CONFIG: "Bramble Ward" demonstrates a Shield / Barrier effect with a Direct Damage
      // reactive trigger (Reaction: Damage, 12.5% max HP, Contact Only), "Last Stand Slam" demonstrates
      // Relative Speed Scaling's "Slower" paradigm — fitting, since Mossapod's 30 Speed is the slowest base
      // stat in the starter roster — and "Rising Tide" demonstrates a Status move's own "Set Field Effect"
      // action (Flood). See the Advanced Battle Systems Reference (Settings tab), sections 1 & 3.
      abilities: [{ name: "Damp Shell", desc: "Prevents the user from being statused by burn, and halves recoil damage taken.", hidden: false }],
      moves: [{ name: "Tidal Slap", type: "water", category: "Physical", desc: "Slaps the foe with a wave-charged tail." }, { name: "Spore Cloud", type: "grass", category: "Status", desc: "Releases spores that may put the target to sleep." },
      {
        name: "Bramble Ward", type: "grass", category: "Status", desc: "Raises a thorned barrier for 3 turns. Any contact move that hits it reflects 12.5% of the user's max HP back onto the attacker.", pp: 10,
        tags: ["Shield"],
        effects: [{ type: "shield", shieldDuration: 3, shieldTriggerType: "any", shieldTypeFilter: "any", shieldReaction: "damage", shieldReactionValue: 12.5, shieldReactionContactOnly: true }]
      },
      {
        name: "Last Stand Slam", type: "ground", category: "Physical", desc: "A crushing counter-blow that hits harder the more the user is outsped by its target.", pp: 10, basePower: 60, accuracy: 0.9,
        tags: ["contact"], speedScaling: "relativeSlower", speedScalingFactor: 0.6
      },
      {
        name: "Rising Tide", type: "water", category: "Status", desc: "Floods the battlefield for 5 turns, speeding up Water types (and sharpening their dodges), slowing everyone else, and dousing Fire-type moves — Flying types are untouched.", pp: 5,
        action: "field", field: "flood", fieldDuration: 5
      },
      {
        name: "Shell Retort", type: "ground", category: "Physical", desc: "Braces behind its shell and slams back with double whatever physical damage it just took. Fails if it wasn't hit by a physical move this turn.", pp: 10, accuracy: 1, priority: -3,
        counterMove: { enabled: true, damageType: "physical", multiplier: 2 }
      }],
      desc: "Lives in coastal rockpools. The moss on its shell filters plankton and provides camouflage against predators.", stats: { hp: 55, atk: 40, def: 70, spa: 45, spd: 65, spe: 30 }
    },
    {
      id: 4, regionId: 1, name: "Voltispire", category: "Storm Spire Pokémon", creator: "Kade", types: ["electric", "flying"], icon: "⚡", imageUrl: "", height: 1.8, weight: 18.4, rarity: "legendary", preEvo: null, preEvoMethod: "", variantOf: null,
      // REFERENCE CONFIG: "Tailwind" demonstrates the First-Strike Priority Hook trigger. With the roster's
      // highest Speed (120), Voltispire also hosts "Static Bulwark" (Shield with an Any-Hit, non-contact-gated
      // Status Infliction reaction), "Afterimage Strike" (Relative Speed Scaling's "Faster" paradigm), and
      // "Velocity Fang" (Absolute Speed Scaling) — see Advanced Battle Systems Reference (Settings tab),
      // sections 1 & 3.
      abilities: [
        { name: "Static Field", desc: "Contact with this Pokémon may cause paralysis.", hidden: false },
        {
          name: "Tailwind", desc: "Reads the storm and always strikes first against an aggressor.", hidden: true,
          abilityType: "active", active: { condition: "opponentOffensive", action: "firstStrikePriority", chance: 100, oncePerBattle: false }
        }
      ],
      moves: [{ name: "Spire Bolt", type: "electric", category: "Special", desc: "Channels a stored charge into a single devastating bolt." }, { name: "Gale Dive", type: "flying", category: "Physical", desc: "Drops from altitude at speed; hits before most other moves." },
      {
        name: "Static Bulwark", type: "electric", category: "Status", desc: "A crackling energy wall that blocks 2 hits of any category, contact or not. Every blocked hit has a 100% chance to Paralyze the attacker.", pp: 10,
        tags: ["Shield"],
        effects: [{ type: "shield", shieldHitCapacity: 2, shieldTriggerType: "any", shieldTypeFilter: "any", shieldReaction: "status", shieldReactionStatus: "paralysis", shieldReactionChance: 100, shieldReactionContactOnly: false }]
      },
      {
        name: "Afterimage Strike", type: "fighting", category: "Physical", desc: "Vanishes and reappears behind the target, striking harder the faster the user is compared to the target.", pp: 15, basePower: 70, accuracy: 0.95,
        tags: ["contact"], speedScaling: "relativeFaster", speedScalingFactor: 0.5
      },
      {
        name: "Velocity Fang", type: "normal", category: "Physical", desc: "A frenzied bite whose force scales purely with the user's own raw Speed. Thrown so fast it leaves the user half-dodged out of position already.", pp: 15, basePower: 40, accuracy: 1, dodgeChance: 35,
        tags: ["contact"], speedScaling: "absolute", speedScalingFactor: 0.5
      }],
      desc: "Said to circle the peaks of stormy mountains, drawing lightning into the spire on its back before releasing it in a single bolt.", stats: { hp: 80, atk: 70, def: 65, spa: 110, spd: 80, spe: 120 }
    },
    {
      id: 5, regionId: 2, name: "Umbra Cindrake", category: "Fogwyrm Pokémon", creator: "Mika", types: ["fire", "ghost"], icon: "👻", imageUrl: "", height: 1.4, weight: 27.5, rarity: "rare", preEvo: null, preEvoMethod: "", variantOf: 2,
      // REFERENCE CONFIG: "Will-Ember" demonstrates a Type-Specific Overriding Critical Hit — its Fire moves
      // bypass type resistance/immunity and guarantee a critical hit, e.g. scorching a normally-resistant Water type.
      abilities: [
        {
          name: "Will-Ember", desc: "This Pokémon's Fire-type moves corrode straight through resistant defenses for a guaranteed critical hit.", hidden: false,
          abilityType: "active", active: { condition: "typeMatchOverride", action: "typeOverrideCrit", overrideType: "fire", chance: 100, oncePerBattle: false }
        }
      ],
      moves: [{ name: "Shadow Ember", type: "fire", category: "Special", desc: "A ghostly flame that always finds its target, ignoring accuracy checks.", tags: ["unavoidable"] }, { name: "Dragon Breath", type: "dragon", category: "Special", desc: "Exhales a stream of destructive energy that may cause paralysis." },
      {
        name: "Executioner's Mark", type: "dark", category: "Special", desc: "A curse-laced strike that always finds its target regardless of Speed or evasion.", pp: 5, basePower: 65, accuracy: 1,
        tags: ["unavoidable"]
      }],
      desc: "Cut off from the mainland and steeped in the Umbra Isles' fog for generations, this Cindrake's flame burned itself down to a cold violet ghostlight.", stats: { hp: 66, atk: 74, def: 64, spa: 98, spd: 70, spe: 70 }
    }
  ];
}

function clampPct(v, dflt) { const n = Number(v); return !isNaN(n) ? Math.max(0, Math.min(100, n)) : dflt; }

// ---- Normalizes one node of the Dynamic Multi-Effect Sequence Array (shared by Moves + Abilities) ----
function normalizeEffect(fx) {
  fx = fx || {};
  const type = EFFECT_TYPES.some(t => t[0] === fx.type) ? fx.type : "statmod";
  const durMin = Number(fx.statusDurationMin), durMax = Number(fx.statusDurationMax), durFixed = Number(fx.statusDurationFixed);
  return {
    type,
    chance: clampPct(fx.chance, 100),
    target: HEAL_TARGETS.some(t => t[0] === fx.target) ? fx.target : "opponent",
    hazardType: HAZARD_TYPES.some(h => h[0] === fx.hazardType) ? fx.hazardType : "stealthrock",
    healType: fx.healType === "flat" ? "flat" : "percent",
    healValue: fx.healValue != null && !isNaN(Number(fx.healValue)) ? Number(fx.healValue) : 25,
    statKey: STAT_STAGE_KEYS.some(t => t[0] === fx.statKey) ? fx.statKey : "atk",
    statStage: STAT_STAGE_VALUES.includes(Number(fx.statStage)) ? Number(fx.statStage) : 1,
    // ---- Multi-Stat Modifier (omniBoost): which stats this ONE roll raises/lowers together. Empty/
    // legacy saves fall back to all five primary stats (the old hardcoded Omni-Boost behavior). ----
    statKeys: Array.isArray(fx.statKeys) && fx.statKeys.length ? fx.statKeys.filter(k => STAT_STAGE_KEYS.some(t => t[0] === k)) : ["atk", "def", "spa", "spd", "spe"],
    // ---- Turn-Based Duration & Decay: 0 = permanent (legacy behavior). >0 = the stat change is reverted
    // or decayed away after that many turns (see the end-of-round timed stat mod tracker in the simulator). ----
    statModDuration: fx.statModDuration != null && !isNaN(Number(fx.statModDuration)) ? Math.max(0, Math.round(Number(fx.statModDuration))) : 0,
    statModExpireMode: STATMOD_EXPIRE_MODES.some(m => m[0] === fx.statModExpireMode) ? fx.statModExpireMode : "decay",
    statusEffect: STATUS_EFFECTS.some(s => s[0] === fx.statusEffect && s[0] !== "none") ? fx.statusEffect : "paralysis",
    // ---- Status Fallback: if the primary status above can't land on a target (already statused, or
    // immune to it), optionally change a stat on that same target instead ----
    statusFallbackEnabled: !!fx.statusFallbackEnabled,
    statusFallbackStatKey: STAT_STAGE_KEYS.some(t => t[0] === fx.statusFallbackStatKey) ? fx.statusFallbackStatKey : "spe",
    statusFallbackStatStage: STAT_STAGE_VALUES.includes(Number(fx.statusFallbackStatStage)) ? Number(fx.statusFallbackStatStage) : -1,
    statusDurationMode: STATUS_DURATION_MODES.some(d => d[0] === fx.statusDurationMode) ? fx.statusDurationMode : "random",
    statusDurationMin: !isNaN(durMin) && durMin > 0 ? Math.round(durMin) : 1,
    statusDurationMax: !isNaN(durMax) && durMax > 0 ? Math.round(durMax) : 3,
    statusDurationFixed: !isNaN(durFixed) && durFixed > 0 ? Math.round(durFixed) : 5,
    // ---- Status Transfer / Swap: "give" hands the user's own status to the target (curing the user);
    // "steal" pulls the target's status onto the user (curing the target); "swap" exchanges whatever
    // both sides currently carry, including a "no status" side wiping the other's. All three respect
    // the receiving side's normal status-type immunities — a transfer simply fizzles if it wouldn't
    // stick, and the source keeps carrying whatever it had. ----
    transferMode: ["give", "steal", "swap"].includes(fx.transferMode) ? fx.transferMode : "swap",
    // ---- Lock-In Attack End Consequence: read by "repeat"-kind statuses (Multi-Turn Lock-In Attacks)
    // when their duration runs out — "confusion" (default, Outrage/Thrash/Petal Dance-style self-daze),
    // "cooldown" (locks the just-repeated move out for lockInCooldownTurns instead of confusing), or
    // "none" (the lock just ends cleanly, no drawback). Irrelevant for any other status kind. ----
    lockInEndEffect: ["confusion", "cooldown", "none"].includes(fx.lockInEndEffect) ? fx.lockInEndEffect : "confusion",
    lockInCooldownTurns: fx.lockInCooldownTurns != null && !isNaN(Number(fx.lockInCooldownTurns)) ? Math.max(1, Math.round(Number(fx.lockInCooldownTurns))) : 2,
    // ---- WHO / WHAT / WHEN / HOW matrix fields (only meaningful when type==="matrix") ----
    who: MATRIX_WHO.some(w => w[0] === fx.who) ? fx.who : "enemy",
    what: MATRIX_WHAT.some(w => w[0] === fx.what) ? fx.what : "statChange",
    when: MATRIX_WHEN.some(w => w[0] === fx.when) ? fx.when : "onMoveSelect",
    matrixStatKey: STAT_STAGE_KEYS.some(t => t[0] === fx.matrixStatKey) ? fx.matrixStatKey : "atk",
    matrixMagnitude: fx.matrixMagnitude != null && !isNaN(Number(fx.matrixMagnitude)) ? Number(fx.matrixMagnitude) : 1,
    matrixHowBasis: MATRIX_HOW_BASIS.some(h => h[0] === fx.matrixHowBasis) ? fx.matrixHowBasis : "flat",
    matrixTypeFilter: TYPES.includes(fx.matrixTypeFilter) ? fx.matrixTypeFilter : "normal",
    matrixStatusFilter: STATUS_EFFECTS.some(s => s[0] === fx.matrixStatusFilter && s[0] !== "none") ? fx.matrixStatusFilter : "burn",
    matrixThresholdPct: clampPct(fx.matrixThresholdPct, 30),
    // ---- Dynamic Weight Modifier: adjusts the target's temporary in-battle weight by a flat delta,
    // which then feeds into weightMultiplier()'s crushHeavy / leverageLight damage-scaling calcs ----
    weightModValue: fx.weightModValue != null && !isNaN(Number(fx.weightModValue)) ? Number(fx.weightModValue) : 10,
    weightModMode: fx.weightModMode === "mult" ? "mult" : "flat",   // "mult": weightModValue is a MULTIPLIER (x2, x0.5) instead of +/- kg
    // ---- Accuracy Modifier (Sand Attack-style): a % change applied to the target's OWN accuracy for
    // the rest of the battle (negative = lowers its future hit chance, positive = raises it) — see
    // tempAccuracyMult in the simulator, which reads this exactly like weightModValue reads into tempWeight. ----
    accuracyModValue: fx.accuracyModValue != null && !isNaN(Number(fx.accuracyModValue)) ? Math.max(-100, Math.min(100, Number(fx.accuracyModValue))) : -20,
    // ---- Clear Stat Modifiers (Haze-style) ----
    clearStatModMode: CLEAR_STATMOD_MODES.some(c => c[0] === fx.clearStatModMode) ? fx.clearStatModMode : "all",
    // ---- Field & Status Clearers (Rapid Spin / Defog / cure-status) ----
    hazardClearScope: HAZARD_CLEAR_SCOPES.some(c => c[0] === fx.hazardClearScope) ? fx.hazardClearScope : "self",
    statusClearScope: STATUS_CLEAR_SCOPES.some(c => c[0] === fx.statusClearScope) ? fx.statusClearScope : "self",
    // ---- PP Cost Increaser (Spite mechanic) ----
    ppSpiteAmount: fx.ppSpiteAmount != null && !isNaN(Number(fx.ppSpiteAmount)) ? Math.max(0, Math.round(Number(fx.ppSpiteAmount))) : 5,
    // ---- Customizable Hit-Count Attack Shields: absorbs `shieldHitCapacity` direct hits (filtered by
    // category via shieldTriggerType and by move-type via shieldTypeFilter) before shattering. When
    // shieldUnignorable is set, this shield can never be bypassed by a move's "Ignore Defenses/Shields"
    // attribute — that override always loses to an Unignorable Shield. ----
    shieldHitCapacity: fx.shieldHitCapacity != null && !isNaN(Number(fx.shieldHitCapacity)) ? Math.max(1, Math.round(Number(fx.shieldHitCapacity))) : 3,
    shieldTriggerType: SHIELD_TRIGGER_TYPES.some(s => s[0] === fx.shieldTriggerType) ? fx.shieldTriggerType : "any",
    shieldTypeFilter: SHIELD_TYPE_FILTERS.some(s => s[0] === fx.shieldTypeFilter) ? fx.shieldTypeFilter : "any",
    shieldUnignorable: !!fx.shieldUnignorable,
    // ---- Breakable Stat-Specific & Weakness-Specific Attack Shields: an optional turn-based expiry
    // (0 = no turn limit, only hit-capacity matters) alongside the hit-capacity expiry above, and an
    // elemental "Weakness" type that instantly shatters the shield when a matching move connects. ----
    shieldDuration: fx.shieldDuration != null && !isNaN(Number(fx.shieldDuration)) && Number(fx.shieldDuration) > 0 ? Math.max(1, Math.round(Number(fx.shieldDuration))) : 0,
    shieldWeaknessType: (fx.shieldWeaknessType === "none" || TYPES.includes(fx.shieldWeaknessType)) ? fx.shieldWeaknessType : "none",
    // ---- Extended Shield Vulnerabilities: an optional set of Move Tags this shield reacts to (checked
    // against the incoming move's own tags list, independent of shieldTypeFilter above), plus which
    // outcome fires when one of those tags is present on the hit. ----
    vulnerableToTags: Array.isArray(fx.vulnerableToTags) ? fx.vulnerableToTags.map(t => String(t).trim()).filter(Boolean)
      : (typeof fx.vulnerableToTags === "string" ? fx.vulnerableToTags.split(",").map(t => t.trim()).filter(Boolean) : []),
    vulnerableTagOutcome: SHIELD_VULN_OUTCOMES.some(o => o[0] === fx.vulnerableTagOutcome) ? fx.vulnerableTagOutcome : "bypass",
    // ---- Reactive Shield Triggers: on top of absorbing/blocking a hit, a shield can strike back at
    // whoever hit it. "damage" (Thorns/Spikes-style) reflects a % of the shield-owner's max HP straight
    // onto the attacker; "status" (Molten Moat-style) inflicts a status condition on the attacker
    // instead. "none" (default) is a purely defensive shield with no reactive component. Only fires when
    // the shield actually blocks a hit (see applyShieldHit / the shield-block branch in the main damage
    // loop) — contact-only shields (shieldReactionContactOnly) additionally require the incoming move to
    // carry a "contact" tag, since a reflective barrier shouldn't punish a ranged beam attack. ----
    shieldReaction: ["none", "damage", "status"].includes(fx.shieldReaction) ? fx.shieldReaction : "none",
    shieldReactionValue: fx.shieldReactionValue != null && !isNaN(Number(fx.shieldReactionValue)) ? Math.max(0, Number(fx.shieldReactionValue)) : 12.5,
    shieldReactionStatus: fx.shieldReactionStatus || "burn",
    shieldReactionChance: fx.shieldReactionChance != null && !isNaN(Number(fx.shieldReactionChance)) ? Math.max(0, Math.min(100, Number(fx.shieldReactionChance))) : 100,
    shieldReactionContactOnly: fx.shieldReactionContactOnly != null ? !!fx.shieldReactionContactOnly : true,
    vulnerableTagBonusHits: fx.vulnerableTagBonusHits != null && !isNaN(Number(fx.vulnerableTagBonusHits)) ? Math.max(1, Math.round(Number(fx.vulnerableTagBonusHits))) : 1,
    vulnerableTagMultiplier: fx.vulnerableTagMultiplier != null && !isNaN(Number(fx.vulnerableTagMultiplier)) ? Math.max(0, Number(fx.vulnerableTagMultiplier)) : 2,
    // ---- Mirror Damage Reflection: % of damage taken that's reflected back onto the attacker while the
    // "Mirror Stance" status is active on this effect's target ----
    mirrorReflectPercent: clampPct(fx.mirrorReflectPercent, 0),
    // ---- Stat Comparison Trigger: optional gate on any Advanced Rule Matrix node ----
    compareEnabled: !!fx.compareEnabled,
    compareWhoA: STAT_COMPARE_WHO.some(w => w[0] === fx.compareWhoA) ? fx.compareWhoA : "self",
    compareStatA: STAT_STAGE_KEYS.some(t => t[0] === fx.compareStatA) ? fx.compareStatA : "spe",
    compareOp: STAT_COMPARE_OPS.some(o => o[0] === fx.compareOp) ? fx.compareOp : "higher",
    compareWhoB: STAT_COMPARE_WHO.some(w => w[0] === fx.compareWhoB) ? fx.compareWhoB : "opponent",
    compareStatB: STAT_STAGE_KEYS.some(t => t[0] === fx.compareStatB) ? fx.compareStatB : "spe",
    // ---- Delayed Effect Queue: supports Future Sight-style flat countdowns as well as charge-release
    // timers, and can release a delayed hit, a status mark, a stat change, or a Wish-style heal ----
    delayQueueTurns: fx.delayQueueTurns != null && !isNaN(Number(fx.delayQueueTurns)) ? Math.max(1, Math.round(Number(fx.delayQueueTurns))) : 3,
    delayQueueTrigger: DELAYQUEUE_TRIGGER_MODES.some(m => m[0] === fx.delayQueueTrigger) ? fx.delayQueueTrigger : "countdown",
    delayQueuePayload: DELAYQUEUE_PAYLOADS.some(p => p[0] === fx.delayQueuePayload) ? fx.delayQueuePayload : "damage",
    delayQueueDamagePct: clampPct(fx.delayQueueDamagePct, 25),
    delayQueueStatusEffect: STATUS_EFFECTS.some(s => s[0] === fx.delayQueueStatusEffect && s[0] !== "none") ? fx.delayQueueStatusEffect : "paralysis",
    delayQueueStatKey: STAT_STAGE_KEYS.some(t => t[0] === fx.delayQueueStatKey) ? fx.delayQueueStatKey : "atk",
    delayQueueStatStage: STAT_STAGE_VALUES.includes(Number(fx.delayQueueStatStage)) ? Number(fx.delayQueueStatStage) : -1,
    delayQueueHealPct: clampPct(fx.delayQueueHealPct, 25),
    delayQueueIgnoreSwitch: !!fx.delayQueueIgnoreSwitch,
    // ---- Multi-Turn Drain & Burnout: persistent per-turn siphoning of HP / Energy(PP) / a Stat Stage
    // between two tethered sides, plus an independent Type Burnout toggle that strips the user's own
    // type the instant this effect executes (not tied to the drain's duration) ----
    drainResource: DRAIN_RESOURCES.some(r => r[0] === fx.drainResource) ? fx.drainResource : "hp",
    drainStatKey: STAT_STAGE_KEYS.some(t => t[0] === fx.drainStatKey) ? fx.drainStatKey : "atk",
    drainPercent: fx.drainPercent != null && !isNaN(Number(fx.drainPercent)) ? Math.max(0, Number(fx.drainPercent)) : 12.5,
    drainDuration: fx.drainDuration != null && !isNaN(Number(fx.drainDuration)) ? Math.max(0, Math.round(Number(fx.drainDuration))) : 0,
    drainDirection: DRAIN_DIRECTIONS.some(d => d[0] === fx.drainDirection) ? fx.drainDirection : "targetToUser",
    burnoutEnabled: !!fx.burnoutEnabled,
    burnoutScope: BURNOUT_SCOPES.some(s => s[0] === fx.burnoutScope) ? fx.burnoutScope : "primary",
    burnoutType: TYPES.includes(fx.burnoutType) ? fx.burnoutType : "normal",
    burnoutBecomeNormal: !!fx.burnoutBecomeNormal,
    // ---- Modular Custom Entry Hazard Builder: a fully custom field hazard — entry damage (flat /
    // Max HP % / type-scaled), an entry status application, an entry stat debuff, and an optional
    // turn-based lingering penalty applied every turn the hazard remains active on the field ----
    hzName: fx.hzName ? String(fx.hzName).slice(0, 40) : "Custom Hazard",
    hzStacking: !!fx.hzStacking,
    hzDamageMode: HAZARD_DAMAGE_MODES.some(m => m[0] === fx.hzDamageMode) ? fx.hzDamageMode : "none",
    hzDamageValue: fx.hzDamageValue != null && !isNaN(Number(fx.hzDamageValue)) ? Math.max(0, Number(fx.hzDamageValue)) : 12.5,
    hzDamageType: TYPES.includes(fx.hzDamageType) ? fx.hzDamageType : "rock",
    hzStatusEffect: STATUS_EFFECTS.some(s => s[0] === fx.hzStatusEffect) ? fx.hzStatusEffect : "none",
    hzStatusChance: clampPct(fx.hzStatusChance, 100),
    hzStatKey: STAT_STAGE_KEYS.some(t => t[0] === fx.hzStatKey) ? fx.hzStatKey : "spe",
    hzStatStage: STAT_STAGE_VALUES.includes(Number(fx.hzStatStage)) ? Number(fx.hzStatStage) : -1,
    hzTurnBasedEnabled: !!fx.hzTurnBasedEnabled,
    hzTurnDamagePct: clampPct(fx.hzTurnDamagePct, 0),
    hzTurnStatKey: STAT_STAGE_KEYS.some(t => t[0] === fx.hzTurnStatKey) ? fx.hzTurnStatKey : "spe",
    hzTurnStatStage: [0, ...STAT_STAGE_VALUES].includes(Number(fx.hzTurnStatStage)) ? Number(fx.hzTurnStatStage) : 0,
    // ---- In-Battle Form Change (Standalone Mega Mechanics): mirrors a Mega Evolution profile's
    // Target Form Name, Transformation Verb (log line phrase), Emoji/Image art, Types, Base Stats,
    // and a single dedicated Ability — but fires directly off this Move Effect node instead of the
    // Mega Evolution activation/duration/cooldown system. Types/Stats/Ability left unset (null) simply
    // keep whatever the transforming fighter already had, exactly like an unset Mega profile field. ----
    changeFormName: fx.changeFormName ? String(fx.changeFormName).slice(0, 40) : "",
    changeFormVerb: (fx.changeFormVerb || "transforms into").trim(),
    changeFormEmoji: fx.changeFormEmoji || "",
    changeFormImageUrl: fx.changeFormImageUrl || "",
    changeFormTypes: Array.isArray(fx.changeFormTypes) && fx.changeFormTypes.length ? fx.changeFormTypes.slice(0, 2) : null,
    changeFormStats: (fx.changeFormStats && STAT_KEYS.every(([k]) => fx.changeFormStats[k] != null)) ? { ...fx.changeFormStats } : null,
    changeFormAbility: fx.changeFormAbility ? normalizeAbility(fx.changeFormAbility) : null,
    // ---- Recover Used Item (Recycle): restores one charge to the target's depleted held item. The
    // optional efficiency % scales that item's effects for the rest of the battle (100 = full strength). ----
    recycleEfficiencyPct: clampPct(fx.recycleEfficiencyPct, 100),
    // ---- Trigger Alternate Form: optional label. Blank = triggers any alt form set to "Trigger Alternate
    // Form effect". Filled = only alt forms with the same label (case-insensitive) or a blank label. ----
    triggerFormLabel: (fx.triggerFormLabel || "").trim().slice(0, 40),
    doomTurns: fxInt(fx.doomTurns, 1, 10, 3),
    wishPct: fxInt(fx.wishPct, 1, 100, 50),
    wishTurns: fxInt(fx.wishTurns, 1, 10, 2),
    revivePct: fxInt(fx.revivePct, 1, 100, 50),
    subHpPct: fxInt(fx.subHpPct, 1, 50, 25),
    liftTurns: fxInt(fx.liftTurns, 1, 10, 3),
    liftGroundImmune: fx.liftGroundImmune == null ? true : !!fx.liftGroundImmune,
    bondTurns: fxInt(fx.bondTurns, 1, 10, 2),
    bondOnFaint: fx.bondOnFaint == null ? true : !!fx.bondOnFaint,
    bondOnDamage: !!fx.bondOnDamage,
    bondDamagePct: fxInt(fx.bondDamagePct, 1, 100, 50),
    bondOnStatus: !!fx.bondOnStatus,
    metronomePool: fx.metronomePool === "own" ? "own" : "roster",
    addTypeChoice: TYPES.includes(String(fx.addTypeChoice || "").toLowerCase()) ? String(fx.addTypeChoice).toLowerCase() : "ghost",
    addTypeDuration: ["battle", "switch", "turns"].includes(fx.addTypeDuration) ? fx.addTypeDuration : "switch",
    addTypeTurns: fxInt(fx.addTypeTurns, 1, 10, 3),
    evadeTurns: fxInt(fx.evadeTurns, 1, 10, 2),
    evadeBelowAcc: fxInt(fx.evadeBelowAcc, 1, 100, 100),
    rootTurns: fxInt(fx.rootTurns, 1, 10, 3),
    rootGround: fx.rootGround == null ? true : !!fx.rootGround,
    rootSureHit: fx.rootSureHit == null ? true : !!fx.rootSureHit
  };
}
function normalizeEffects(list) {
  if (Array.isArray(list)) return list.map(fx => { try { return normalizeEffect(fx); } catch (e) { return normalizeEffect({}); } });
  if (list && typeof list === "object") return [normalizeEffect(list)]; // legacy single-object shape safety net
  return [];
}

// ---- Normalizes ONE Mega Evolution profile in a creature's registry entry. A single entry can now carry
// several of these (Mega X, Mega Y, a Regional Mega, etc.) — each is a fully independent Ability, Move
// Slots, Lore/Description, and Image profile — a completely isolated nested profile the Battle Arena
// swaps the fighter into wholesale when THAT profile's own Activation Requirement fires. ----
function normalizeMegaProfile(mg) {
  if (!mg) return null;
  const stats = mg.stats || {};
  const act = mg.activation || {};
  return {
    id: mg.id || ("mega_" + Math.random().toString(36).slice(2, 9)),
    enabled: mg.enabled !== false,
    name: mg.name || "",
    // ---- Transformation Verb Phrase: the battle log reads "[Name] [this phrase] [New Form Name]!" —
    // free text so the exact same profile mechanic (name/stats/types/ability/moves swap + an Activation
    // Requirement) can represent a Mega Evolution, a Dynamax, a Gigantamax, a Transform, or anything else
    // with a distinct verb, with zero code changes needed per new transformation kind. ----
    transformVerb: (mg.transformVerb || "Mega Evolves into").trim(),
    // ---- Transformation Kind: distinct from the free-text Verb Phrase above — this is what the ENGINE
    // actually branches on. "mega" (default) keeps the classic Mega Evolution move-restriction behavior:
    // only base-movepool moves flagged "Can Be Used In Mega Evolution" (megaUsable) carry over, same as
    // before. "dynamax" ignores that restriction entirely and carries over every base-movepool move
    // unchanged, matching normal Dynamax move behavior. "other" behaves like "mega" (kept conservative
    // for any custom transformation that isn't specifically a Dynamax). See buildMegaMovepool() below. ----
    kind: ["mega", "dynamax", "other"].includes(mg.kind) ? mg.kind : "mega",
    emoji: mg.emoji || "",
    types: Array.isArray(mg.types) && mg.types.length ? mg.types.slice(0, 2) : null,
    stats: STAT_KEYS.every(([k]) => stats[k] != null) ? { ...stats } : null,
    // ---- Dedicated Mega Custom Ability: same normalizer/shape as a regular Ability, so it plugs
    // straight into pickBattleAbility()/runAbilityAction() with zero simulator-side special-casing ----
    ability: mg.ability ? normalizeAbility(mg.ability) : null,
    // ---- Special Mega Move Slots: same normalizer/shape as regular Moves ----
    moves: Array.isArray(mg.moves) ? mg.moves.map(normalizeMove) : [],
    // ---- Independent Lore/Description text block ----
    desc: mg.desc || "",
    // ---- Mega Images: 4-slot pixel/artwork (+shiny) system, same shape as a base entry's own
    // entry.images, plus per-slot crop/focus points. imageUrl is kept read-only for saves made before
    // this existed — applyMegaEvolution() still falls back to it if images is empty. ----
    images: mg.images ? {
      pixel: mg.images.pixel || "",
      pixelShiny: mg.images.pixelShiny || "",
      artwork: mg.images.artwork || "",
      artworkShiny: mg.images.artworkShiny || "",
      focus: mg.images.focus || {}
    } : null,
    imageUrl: mg.imageUrl || "",
    // ---- Community Form ownership (only set for forms submitted via the "＋ Add a Form" feature —
    // see js/forms-sync.js. Untouched/undefined for a base entry owner's own authored Mega profiles). ----
    isCommunityForm: !!mg.isCommunityForm,
    creatorUid: mg.creatorUid || null,
    creatorName: mg.creatorName || null,
    // ---- Activation Requirement: what must be true before THIS specific Mega profile can trigger mid-battle.
    // heldStone = fires on the arena's per-round Mega chance roll (classic "holding a Mega Stone" behavior).
    // triggerMove = fires the turn this creature successfully uses a specific named move.
    // turnThreshold = fires once the battle's turn counter reaches a configured number.
    // requiredItem is a SEPARATE, ADDITIONAL gate layered on top of whichever requirement above is chosen
    // (it is not itself a requirement type) — an actual Item Dex entry (Leftovers, a custom "Mega Stone"
    // the user defines, etc.) that the fighter must be holding via the Battle Prep Held Item dropdown, or
    // this profile can never trigger no matter how many times its requirement condition is met. Empty
    // string = no item gate (default; fully backward compatible with saves made before this field existed). ----
    activation: {
      requirement: ["heldStone", "triggerMove", "turnThreshold", "triggerEffect"].includes(act.requirement) ? act.requirement : "heldStone",
      triggerMoveName: (act.triggerMoveName || "").trim(),
      triggerLabel: (act.triggerLabel || "").trim().slice(0, 40),
      turnThreshold: act.turnThreshold != null && !isNaN(Number(act.turnThreshold)) ? Math.max(1, Number(act.turnThreshold)) : 3,
      requiredItem: (act.requiredItem || "").trim()
    },
    // ---- Transformation Duration (Turn Limit): how many turns this Mega form stays active before the
    // fighter automatically reverts to its base form. 0 = permanent for the rest of the battle (classic
    // Mega Evolution behavior — never reverts on its own). Any number > 0 = active for exactly that many
    // turns, then auto-reverts (see revertTransformation() in the simulator core). ----
    // ---- Dynamax / Gigantamax support: maxMoves = this form's own move list REPLACES the base movepool outright
    // (every move becomes a Max Move), hpMultiplier > 1 scales current + max HP on transformation (ratio kept) and is
    // undone on revert. Both default off, so every existing Mega/alternate form behaves exactly as before. ----
    maxMoves: !!mg.maxMoves,
    hpMultiplier: mg.hpMultiplier != null && !isNaN(Number(mg.hpMultiplier)) ? Math.max(1, Number(mg.hpMultiplier)) : 1,
    durationLimit: mg.durationLimit != null && !isNaN(Number(mg.durationLimit)) ? Math.max(0, Math.round(Number(mg.durationLimit))) : 0,
    // ---- Reuse Cooldown: once this side has reverted out of this transformation, how many turns (in
    // base form) must pass before it may transform again. 0 = it can never transform again for the rest
    // of the battle/session once it reverts. > 0 = must wait that many turns in base form. Irrelevant
    // while durationLimit is 0, since a permanent transformation never reverts to trigger this. ----
    reuseCooldown: mg.reuseCooldown != null && !isNaN(Number(mg.reuseCooldown)) ? Math.max(0, Math.round(Number(mg.reuseCooldown))) : 0
  };
}
// ---- Normalizes the full list of Mega Evolution profiles on an entry. Also transparently migrates
// legacy single-mega saves (the old `entry.mega` object shape) into a one-item `megas` array. ----
function normalizeMegas(list) {
  if (Array.isArray(list)) return list.map(normalizeMegaProfile).filter(Boolean);
  if (list && typeof list === "object" && list.enabled) return [normalizeMegaProfile(list)];
  return [];
}

// ---- Unified Rule Builder schema (shared by Abilities AND Moves) ----
// These two normalizers are the single source of truth for the Passive Rule / Active Trigger (Boolean
// Gate) shapes. Both entity types render the exact same rule-builder markup (see ruleBuilderBlockHtml)
// and route through the exact same normalizer here, so a rule built for a Move is structurally
// identical to one built for an Ability — including the shared "weatherCondition" boolean gate.
function normalizePassiveRule(p) {
  p = p || {};
  return {
    trigger: PASSIVE_TRIGGERS.some(t => t[0] === p.trigger) ? p.trigger : "battleStart",
    filterType: (p.filterType === "any" || TYPES.includes(p.filterType)) ? p.filterType : "any",
    action: PASSIVE_ACTIONS.some(t => t[0] === p.action) ? p.action : "negateDamage",
    multiplier: p.multiplier != null && !isNaN(Number(p.multiplier)) ? Number(p.multiplier) : 1.5,
    statKey: STAT_STAGE_KEYS.some(t => t[0] === p.statKey) ? p.statKey : "atk",
    statStage: p.statStage != null && !isNaN(Number(p.statStage)) ? Number(p.statStage) : 1,
    chance: clampPct(p.chance, 100),
    healType: p.healType === "flat" ? "flat" : "percent",
    healValue: p.healValue != null && !isNaN(Number(p.healValue)) ? Number(p.healValue) : 25,
    healTarget: HEAL_TARGETS.some(t => t[0] === p.healTarget) ? p.healTarget : "self",
    protectType: TYPES.includes(p.protectType) ? p.protectType : "fire",
    protectPercent: clampPct(p.protectPercent, 50),
    resistRatio: p.resistRatio != null && !isNaN(Number(p.resistRatio)) ? Math.max(0, Math.min(1, Number(p.resistRatio))) : 0.5,
    tagFilter: (p.tagFilter || "Punch").trim(),
    tagMultiplier: p.tagMultiplier != null && !isNaN(Number(p.tagMultiplier)) ? Number(p.tagMultiplier) : 1.2,
    // ---- categoryDamageMult / critMod / evasionMult (official-abilities.js) ----
    damageCategory: p.damageCategory === "Special" ? "Special" : "Physical",
    categoryMultiplier: p.categoryMultiplier != null && !isNaN(Number(p.categoryMultiplier)) ? Number(p.categoryMultiplier) : 0.5,
    critStage: p.critStage != null && !isNaN(Number(p.critStage)) ? Math.max(0, Math.min(3, Math.round(Number(p.critStage)))) : 0,
    critDamageMult: p.critDamageMult != null && !isNaN(Number(p.critDamageMult)) ? Math.max(0.5, Math.min(3, Number(p.critDamageMult))) : 1,
    critImmune: !!p.critImmune,
    evasionFactor: p.evasionFactor != null && !isNaN(Number(p.evasionFactor)) ? Math.max(0.1, Math.min(1, Number(p.evasionFactor))) : 0.8,
    evasionWeather: WEATHER_STATES.some(w => w[0] === p.evasionWeather) ? p.evasionWeather : "none",
    // ---- Boost Tag Move (self-only): comma-separated tag/type list + its multiplier. A move's Type
    // also counts as an implicit tag here (see moveTagPool()), so e.g. "fire" also matches Fire moves. ----
    boostTagFilter: (p.boostTagFilter || "punch").trim(),
    boostTagMultiplier: p.boostTagMultiplier != null && !isNaN(Number(p.boostTagMultiplier)) ? Number(p.boostTagMultiplier) : 1.3,
    // ---- Move Type Override (self-only): "From" type ("any" = Normalize-style, or one specific type
    // = Galvanize-family-style), the resulting "To" type, and an optional Base Power multiplier applied
    // on conversion (1 = no boost). ----
    moveTypeFrom: (p.moveTypeFrom === "any" || TYPES.includes(p.moveTypeFrom)) ? p.moveTypeFrom : "any",
    moveTypeTo: TYPES.includes(p.moveTypeTo) ? p.moveTypeTo : "electric",
    moveTypeBoost: p.moveTypeBoost != null && !isNaN(Number(p.moveTypeBoost)) ? Number(p.moveTypeBoost) : 1.2,
    // ---- Defensive Ability Tag Triggers: the tag the "hitByTag" Passive Trigger reacts to, plus the
    // Reflect Damage action's Flat #/% Max HP toggle value ----
    hitTagFilter: (p.hitTagFilter || "Sound").trim(),
    // ---- Serene Grace: multiplies the base Effect Chance % of a move's own secondary effect. Scope
    // is blank/"any" for global, or a Move Tag string to only affect moves carrying that tag. ----
    secondaryChanceMultiplier: p.secondaryChanceMultiplier != null && !isNaN(Number(p.secondaryChanceMultiplier)) ? Number(p.secondaryChanceMultiplier) : 2.0,
    secondaryChanceScope: (p.secondaryChanceScope || "any").trim(),
    reflectType: p.reflectType === "flat" ? "flat" : "percent",
    reflectValue: p.reflectValue != null && !isNaN(Number(p.reflectValue)) ? Number(p.reflectValue) : 25,
    // ---- Targeted Type Filters: multi-type override for filterType (empty = affects all types) ----
    affectedTypes: Array.isArray(p.affectedTypes) ? p.affectedTypes.filter(t => TYPES.includes(t)) : [],
    // ---- Aura / Field Abilities: passive per-turn field damage ----
    auraFieldType: TYPES.includes(p.auraFieldType) ? p.auraFieldType : "electric",
    auraFieldPercent: clampPct(p.auraFieldPercent, 5),
    auraFieldTarget: HEAL_TARGETS.some(t => t[0] === p.auraFieldTarget) ? p.auraFieldTarget : "opponent",
    // ---- Contact / On-Hit Chip Damage ----
    chipDamageType: p.chipDamageType === "flat" ? "flat" : "percent",
    chipDamageValue: p.chipDamageValue != null && !isNaN(Number(p.chipDamageValue)) ? Number(p.chipDamageValue) : 6,
    chipDamageTrigger: ["onDealHit", "onGetHit"].includes(p.chipDamageTrigger) ? p.chipDamageTrigger : "onDealHit",
    // ---- Weather-Changing (passive, e.g. on entry / always) ----
    weatherSet: WEATHER_STATES.some(w => w[0] === p.weatherSet) ? p.weatherSet : "rain",
    weatherSetDuration: p.weatherSetDuration != null && !isNaN(Number(p.weatherSetDuration)) ? Math.round(Number(p.weatherSetDuration)) : 5,
    // ---- Weather Overridable: if false, a Move's own "Set Weather" effect can't change the field while
    // this Ability's weather is still active — defaults true (moves can always override) ----
    weatherOverridable: p.weatherOverridable != null ? !!p.weatherOverridable : true,
    // ---- Weather Boolean Gate: "While Weather Is Active" trigger checks the field state against this ----
    weatherCondition: WEATHER_STATES.some(w => w[0] === p.weatherCondition) ? p.weatherCondition : "sun",
    // ---- weatherSpeedMult: Speed multiplier while weatherCondition (or, if speedFieldCondition is set, that terrain) is active ----
    speedMultiplier: p.speedMultiplier != null && !isNaN(Number(p.speedMultiplier)) ? Math.max(0.1, Number(p.speedMultiplier)) : 2,
    speedFieldCondition: FIELD_STATES.some(f => f[0] === p.speedFieldCondition && f[0] !== "none") ? p.speedFieldCondition : "none",
    // ---- Set Field Effect (passive, e.g. on entry / always) — independent of the Weather fields above ----
    fieldSet: FIELD_STATES.some(f => f[0] === p.fieldSet) ? p.fieldSet : "grassy",
    fieldSetDuration: p.fieldSetDuration != null && !isNaN(Number(p.fieldSetDuration)) ? Math.round(Number(p.fieldSetDuration)) : 5,
    fieldOverridable: p.fieldOverridable != null ? !!p.fieldOverridable : true,
    // ---- Polluted Weather: customizable turn-end % chance to Poison non-immune targets, carried by
    // whichever rule actually set the weather to Polluted ----
    pollutedPoisonChance: clampPct(p.pollutedPoisonChance, 15),
    // ---- Dynamic PP Cost System: which move this rule's PP-cost delta applies to, which direction, and by how much ----
    ppCostTarget: PP_COST_TARGETS.some(t => t[0] === p.ppCostTarget) ? p.ppCostTarget : "highestBasePower",
    ppCostDirection: p.ppCostDirection === "decrease" ? "decrease" : "increase",
    ppCostAmount: p.ppCostAmount != null && !isNaN(Number(p.ppCostAmount)) ? Math.max(0, Math.round(Number(p.ppCostAmount))) : 1,
    // ---- Debuff Trigger Tracker source filter — see STAT_LOWERED_SOURCES above ----
    statLoweredSource: STAT_LOWERED_SOURCES.some(t => t[0] === p.statLoweredSource) ? p.statLoweredSource : "opponent",
    // ---- Loaf Around (Truant-style): skips the owner's turn on a cycle. Interval 2 + Starts Active
    // reproduces Truant exactly (acts turn 1, loafs turn 2, acts turn 3, ...). ----
    loafInterval: p.loafInterval != null && !isNaN(Number(p.loafInterval)) ? Math.max(2, Math.round(Number(p.loafInterval))) : 2,
    loafStartsActive: p.loafStartsActive != null ? !!p.loafStartsActive : true,
    // ---- Ally-Hit Trigger: a hit counts as "huge" if it would KO the teammate, or takes at least this % of its max HP ----
    ohkoGuardHpPct: p.ohkoGuardHpPct != null && !isNaN(Number(p.ohkoGuardHpPct)) ? Math.max(1, Math.min(100, Math.round(Number(p.ohkoGuardHpPct)))) : 100,
    // ---- Auto-Fail Moves of a Type ----
    blockType: TYPES.includes(String(p.blockType || "").toLowerCase()) ? String(p.blockType).toLowerCase() : "water",
    blockScope: p.blockScope === "opponent" ? "opponent" : "all",
    blockWeather: WEATHER_STATES.some(([k]) => k === p.blockWeather) && p.blockWeather !== "clear" ? p.blockWeather : "none",
    // ---- Trap Opponent: who is trapped (scope) + optional Type / Tag filters ----
    trapScope: TRAP_SCOPES.some(([v]) => v === p.trapScope) ? p.trapScope : "all",
    trapTypes: Array.isArray(p.trapTypes) ? p.trapTypes.map(t => String(t).toLowerCase()).filter(t => TYPES.includes(t)) : [],
    trapTags: String(p.trapTags || "").slice(0, 200),
    allyHitPct: p.allyHitPct != null && !isNaN(Number(p.allyHitPct)) ? Math.max(1, Math.min(100, Math.round(Number(p.allyHitPct)))) : 50,
    // ---- Slow Start: weakens the selected stats for the battle's first N turns, then returns to normal ----
    slowStartTurns: p.slowStartTurns != null && !isNaN(Number(p.slowStartTurns)) ? Math.max(1, Math.round(Number(p.slowStartTurns))) : 5,
    slowStartKeys: Array.isArray(p.slowStartKeys) && p.slowStartKeys.length ? p.slowStartKeys.filter(k => STAT_STAGE_KEYS.some(t => t[0] === k)) : ["atk", "spe"],
    slowStartMultiplier: p.slowStartMultiplier != null && !isNaN(Number(p.slowStartMultiplier)) ? Number(p.slowStartMultiplier) : 0.5
  };
}
function normalizeActiveRule(ac) {
  ac = ac || {};
  return {
    condition: ACTIVE_CONDITIONS.some(t => t[0] === ac.condition) ? ac.condition : "hpBelow33",
    action: ACTIVE_ACTIONS.some(t => t[0] === ac.action) ? ac.action : "boostDamage150",
    chance: clampPct(ac.chance, 100),
    healType: ac.healType === "flat" ? "flat" : "percent",
    healValue: ac.healValue != null && !isNaN(Number(ac.healValue)) ? Number(ac.healValue) : 25,
    healTarget: HEAL_TARGETS.some(t => t[0] === ac.healTarget) ? ac.healTarget : "self",
    protectType: TYPES.includes(ac.protectType) ? ac.protectType : "fire",
    protectPercent: clampPct(ac.protectPercent, 50),
    hitType: TYPES.includes(ac.hitType) ? ac.hitType : "fire",
    overrideType: TYPES.includes(ac.overrideType) ? ac.overrideType : "poison",
    oncePerBattle: !!ac.oncePerBattle,
    // ---- Boost Type Moves (Blaze-style): one or more Types this ability's Damage Multiplier applies
    // to. Reuses the same multi-checkbox pattern as Affected Types elsewhere. ----
    boostTypeTargets: Array.isArray(ac.boostTypeTargets) ? ac.boostTypeTargets.filter(t => TYPES.includes(t)) : [],
    // ---- Boost Tag Moves (Iron Fist-style): comma-separated tag/type list. A move's Type also counts
    // as an implicit tag here (see moveTagPool()). ----
    boostTagFilter: (ac.boostTagFilter || "punch").trim(),
    // ---- "When Hitting" Active Condition: which type-effectiveness bucket the owner's hit must land in ----
    hitEffectiveness: HIT_EFFECTIVENESS_OPTIONS.some(h => h[0] === ac.hitEffectiveness) ? ac.hitEffectiveness : "any",
    // ---- Weather-Changing (active trigger variant) ----
    weatherSet: WEATHER_STATES.some(w => w[0] === ac.weatherSet) ? ac.weatherSet : "rain",
    weatherSetDuration: ac.weatherSetDuration != null && !isNaN(Number(ac.weatherSetDuration)) ? Math.round(Number(ac.weatherSetDuration)) : 5,
    // ---- Weather Overridable: if false, a Move's own "Set Weather" effect can't change the field while
    // this Ability's weather is still active — defaults true (moves can always override) ----
    weatherOverridable: ac.weatherOverridable != null ? !!ac.weatherOverridable : true,
    // ---- Weather Boolean Gate: "IF Weather Is Active" condition checks the field state against this ----
    weatherCondition: WEATHER_STATES.some(w => w[0] === ac.weatherCondition) ? ac.weatherCondition : "sun",
    // ---- Set Field Effect (active trigger variant) — independent of the Weather fields above ----
    fieldSet: FIELD_STATES.some(f => f[0] === ac.fieldSet) ? ac.fieldSet : "grassy",
    fieldSetDuration: ac.fieldSetDuration != null && !isNaN(Number(ac.fieldSetDuration)) ? Math.round(Number(ac.fieldSetDuration)) : 5,
    fieldOverridable: ac.fieldOverridable != null ? !!ac.fieldOverridable : true,
    // ---- Polluted Weather: customizable turn-end % chance to Poison non-immune targets, carried by
    // whichever rule actually set the weather to Polluted ----
    pollutedPoisonChance: clampPct(ac.pollutedPoisonChance, 15),
    // ---- Custom Damage Multiplier: used by the "Boost Damage by Custom Multiplier" active action
    // (e.g. Stomping Tantrum-style: If Previous Move Missed -> Boost Damage by 2x) ----
    multiplier: ac.multiplier != null && !isNaN(Number(ac.multiplier)) ? Number(ac.multiplier) : 2,
    // ---- Dynamic PP Cost System (Active variant): same target/direction/amount, gated by the Active Condition above ----
    ppCostTarget: PP_COST_TARGETS.some(t => t[0] === ac.ppCostTarget) ? ac.ppCostTarget : "highestBasePower",
    ppCostDirection: ac.ppCostDirection === "decrease" ? "decrease" : "increase",
    ppCostAmount: ac.ppCostAmount != null && !isNaN(Number(ac.ppCostAmount)) ? Math.max(0, Math.round(Number(ac.ppCostAmount))) : 1
  };
}
function normalizeAbility(a) {
  if (typeof a === "string") a = { name: a };
  a = a || {};
  const abilityType = a.abilityType === "active" ? "active" : "passive";
  return {
    name: a.name || "",
    desc: a.desc || "",
    hidden: !!a.hidden,
    // ---- Official/imported abilities: descOnly = description text only, no battle rule (the passive/active fields
    // below are just engine defaults and must not be shown or treated as real). autoRule = rule was generated by
    // the official importer (official-abilities.js), so the admin "Rebuild abilities" button may regenerate it. ----
    descOnly: !!a.descOnly,
    autoRule: !!a.autoRule,
    abilityType,
    // ---- Ability Lock (Wonder Guard / Multitype-style): when set, this ability can never be copied,
    // swapped away, or overwritten by Role Play/Trace, Skill Swap, Entrainment, or a Ditto-style Full
    // Transform — checked by every one of those actions in the simulator and logged as a graceful failure. ----
    lockAbility: !!a.lockAbility,
    effects: normalizeEffects(a.effects),
    passive: normalizePassiveRule(a.passive),
    active: normalizeActiveRule(a.active),
    // ---- Ability Stat Mod Blockers (Clear Body / Mist-style): negates incoming stat-stage changes
    // against this ability's owner, checked by statModAllowed() in the simulator ----
    negateStatMod: NEGATE_STATMOD_MODES.some(n => n[0] === a.negateStatMod) ? a.negateStatMod : "none",
    // ---- Recoil-Interaction Abilities: Reckless-style power boost for recoil moves, and Rock Head-style
    // full recoil negation, checked in the simulator's post-hit recoil block ----
    boostsRecoilMoves: !!a.boostsRecoilMoves,
    ignoresRecoil: !!a.ignoresRecoil,
    // ---- Type Damage Immunity Abilities: any damage of the selected type drops to 0 on arrival ----
    immuneToType: (a.immuneToType === "none" || TYPES.includes(a.immuneToType)) ? a.immuneToType : "none",
    // ---- Ignores Weather Effects: exempts this ability's owner from a chosen weather's built-in passive
    // penalties/bonuses (e.g. Nighttime's Grass slow + move weakening) without needing a move/ability tag —
    // checked via ignoresWeatherEffect() anywhere a weather's type-based effect is applied ----
    ignoresWeatherEffects: !!a.ignoresWeatherEffects,
    ignoredWeather: (a.ignoredWeather === "any" || WEATHER_STATES.some(w => w[0] === a.ignoredWeather)) ? a.ignoredWeather : "any",
    // ---- Breakable Attack Shields: passive multiplier on how much Hit-Count Capacity is removed from
    // an opposing shield each time this ability's owner lands a hit against it (1 = normal, unmodified) ----
    shieldBreakerMultiplier: a.shieldBreakerMultiplier != null && !isNaN(Number(a.shieldBreakerMultiplier)) ? Math.max(0, Number(a.shieldBreakerMultiplier)) : 1,
    // ---- Mirror Damage Reflection: always-on passive % of any damage taken that's immediately reflected
    // back onto the attacker as feedback damage (0 = disabled) ----
    mirrorReflectPercent: clampPct(a.mirrorReflectPercent, 0),
    // ---- Blurring Abilities & Moves: an Active Ability flagged Manually Castable stops being purely
    // reactive (gated on a Boolean condition like hpBelow33) and instead gets folded into its owner's
    // own movepool as a selectable action for the rest of the battle — see abilityToSyntheticMove()
    // below. It can be an attack (manualCastCategory Physical/Special + manualCastBasePower/Type),
    // a status-inflictor, or a pure field effect — all driven by this same ability's own `effects`
    // array (identical Dynamic Multi-Effect Sequence Array used by Moves), so a manually-cast ability
    // can raise hazards, apply statuses, etc. exactly like a Status-category move would. ----
    manualCast: !!a.manualCast,
    manualCastCategory: MOVE_CATEGORIES.includes(a.manualCastCategory) ? a.manualCastCategory : "Status",
    manualCastType: TYPES.includes(a.manualCastType) ? a.manualCastType : "normal",
    manualCastBasePower: a.manualCastBasePower != null && !isNaN(Number(a.manualCastBasePower)) ? Math.max(0, Math.min(250, Math.round(Number(a.manualCastBasePower)))) : 60,
    manualCastAccuracy: a.manualCastAccuracy != null && !isNaN(Number(a.manualCastAccuracy)) ? Math.max(0, Math.min(1, Number(a.manualCastAccuracy))) : 1,
    manualCastPP: a.manualCastPP != null && !isNaN(Number(a.manualCastPP)) ? Math.max(1, Math.round(Number(a.manualCastPP))) : 5,
    manualCastCooldown: a.manualCastCooldown != null && !isNaN(Number(a.manualCastCooldown)) ? Math.max(0, Math.round(Number(a.manualCastCooldown))) : 0
  };
}
// ---- Blurring Abilities & Moves: builds a Struggle-shaped synthetic move from a manually-castable
// Active Ability, so it can flow through the exact same selection/PP/cooldown/execution pipeline as a
// real movepool entry — see the injection point in simulateOneBattle (near movePP construction). A
// Status-category cast (the default) deals no damage and just runs the ability's own `effects` array;
// a Physical/Special cast additionally deals damage off manualCastBasePower/Type/Accuracy. ----
function abilityToSyntheticMove(ab) {
  const dealsDamage = ab.manualCastCategory !== "Status";
  return {
    name: ab.name, type: ab.manualCastType, category: ab.manualCastCategory, desc: ab.desc,
    accuracy: ab.manualCastAccuracy, pp: ab.manualCastPP, maxPP: ab.manualCastPP,
    basePower: dealsDamage ? ab.manualCastBasePower : 0, hits: 1,
    action: dealsDamage ? "none" : "status", statusEffect: "none",
    statusDurationMode: "random", statusDurationMin: 1, statusDurationMax: 3, statusDurationFixed: 5,
    effectChance: 100, healType: "percent", healValue: 25, healTarget: "self",
    weather: "clear", weatherDuration: 5, field: "none", fieldDuration: 5, setsField: false, hazardType: "stealthrock",
    effects: ab.effects || [], tags: ["abilityCast"],
    weightScaling: "none", damageBasis: "standard", historyScaling: "none", historyScalingStepPct: 100,
    pollutedPoisonChance: 15, ignoreDefense: false, ignoreShields: false,
    stateImmunity: { enabled: false, key: "hidden", exceptions: [], expireEvent: "onAttack", expireDurationTurns: 2 },
    chargeUp: { enabled: false, duration: 1, condition: "none", shieldPercent: 50, healPercent: 25 },
    delayedAttack: { enabled: false, delayTurns: 2, statSnapMode: "launch", ignoreTypeImmunity: false },
    critRateMode: "normal", cooldownTurns: ab.manualCastCooldown,
    dynamicTypeEnabled: false, dynamicTypeTarget: "normal", dynamicTypeMode: "superEffective",
    recoilPercent: 0, statusDamageMultiplier: 1, statusDamageMultFilter: "any",
    failCondition: "none", failWeather: "sun", failField: "grassy",
    rule: { enabled: false, ruleType: "passive", passive: normalizePassiveRule(), active: normalizeActiveRule() },
    speedScaling: "none", speedScalingFactor: 0.5
  };
}
// ---- "TRADEOFF" Move Matrix (Ghost-type Curse-style): a move can charge the USER a self-cost
// (HP sacrifice or a stat-stage drop) in exchange for forcing a consequence onto the TARGET (a status
// condition, a per-turn HP drain, or a stat-stage drop), tracked over a configurable turn Duration.
// Gated by an optional Conditional Type Override — if the user isn't the required type, the whole
// costing block is skipped and the move just runs its normal damage/stat calculation path. ----
function normalizeTradeoff(t) {
  t = t || {};
  return {
    enabled: !!t.enabled,
    // ---- Conditional Type Override: "any" = always apply; otherwise only applies if the user is that type ----
    requireUserType: (t.requireUserType === "any" || TYPES.includes(t.requireUserType)) ? t.requireUserType : "any",
    // ---- Cost paid by the user ----
    costType: t.costType === "statStage" ? "statStage" : "hpPercent",
    costHpPercent: clampPct(t.costHpPercent, 50),
    costStatKey: STAT_STAGE_KEYS.some(k => k[0] === t.costStatKey) ? t.costStatKey : "atk",
    costStatStage: t.costStatStage != null && !isNaN(Number(t.costStatStage)) ? Math.max(1, Math.min(6, Math.round(Number(t.costStatStage)))) : 1,
    // ---- Consequence forced onto the target ----
    consequenceType: ["status", "drain", "statStage"].includes(t.consequenceType) ? t.consequenceType : "status",
    consequenceStatus: STATUS_EFFECTS.some(s => s[0] === t.consequenceStatus && s[0] !== "none") ? t.consequenceStatus : "paralysis",
    consequenceDrainPercent: clampPct(t.consequenceDrainPercent, 12.5),
    consequenceStatKey: STAT_STAGE_KEYS.some(k => k[0] === t.consequenceStatKey) ? t.consequenceStatKey : "def",
    consequenceStatStage: t.consequenceStatStage != null && !isNaN(Number(t.consequenceStatStage)) ? Math.max(1, Math.min(6, Math.round(Number(t.consequenceStatStage)))) : 1,
    // ---- Duration: span of turns the consequence (Status/Drain) is tracked for ----
    durationTurns: t.durationTurns != null && !isNaN(Number(t.durationTurns)) ? Math.max(1, Math.round(Number(t.durationTurns))) : 3
  };
}
// ---- Weather Accuracy Rules (Thunder / Hurricane / Blizzard / Bleakwind Storm-style): per weather, a move can get a
// different Accuracy (0..1) and/or "never misses". Stored on the move as [{ weather, accuracy|null, neverMiss }]. ----
function normalizeWeatherAccuracy(list) {
  if (!Array.isArray(list)) return [];
  return list.map(r => ({
    weather: String((r && r.weather) || ""),
    accuracy: r && r.accuracy != null && r.accuracy !== "" && !isNaN(Number(r.accuracy)) ? Math.max(0, Math.min(1, Number(r.accuracy))) : null,
    neverMiss: !!(r && r.neverMiss)
  })).filter(r => r.weather !== "clear" && WEATHER_STATES.some(([k]) => k === r.weather) && (r.accuracy != null || r.neverMiss));
}
function normalizeMove(m) {
  if (typeof m === "string") m = { name: m };
  m = m || {};
  const category = MOVE_CATEGORIES.includes(m.category) ? m.category : "Physical";
  const accNum = Number(m.accuracy);
  const ppNum = Number(m.maxPP != null ? m.maxPP : m.pp);
  const hitsNum = Number(m.hits);
  const durMin = Number(m.statusDurationMin), durMax = Number(m.statusDurationMax), durFixed = Number(m.statusDurationFixed);
  const weatherDur = Number(m.weatherDuration);
  const fieldDur = Number(m.fieldDuration);
  const maxPP = !isNaN(ppNum) && ppNum > 0 ? Math.round(ppNum) : 15;
  // ---- Base Power only has meaning for damaging categories (Physical/Special); Status moves deal no damage ----
  const dealsDamage = category === "Physical" || category === "Special";
  const bpNum = Number(m.basePower);
  const r = m.rule || {};
  return {
    name: m.name || "",
    type: m.type || "normal",
    category,
    desc: m.desc || "",
    accuracy: !isNaN(accNum) ? Math.max(0, Math.min(1, accNum)) : 1,
    // ---- Dodge Chance: raises the USER's own chance to dodge an incoming attack the turn this move
    // is used, layered on top of the existing Speed-based dodge factor (see computeDodgeHitMultiplier/
    // dodgeMult in the sim core). 0-100%, default 0 (no effect — existing moves are untouched). Meant
    // for evasive, high-Speed moves like a custom Quick Attack. ----
    dodgeChance: m.dodgeChance != null && !isNaN(Number(m.dodgeChance)) ? Math.max(0, Math.min(100, Number(m.dodgeChance))) : 0,
    pp: maxPP, // kept for backward compatibility with older saved data / earlier engine code
    maxPP,
    basePower: dealsDamage ? (!isNaN(bpNum) ? Math.max(0, Math.min(250, Math.round(bpNum))) : 60) : 0,
    hits: HITS_OPTIONS.includes(hitsNum) ? hitsNum : 1,
    // ---- Multi-Hit Scaling defaults: "none" (flat, matches every pre-existing save's behavior)
    // unless the move data explicitly sets rampUp/rampDown. Percent clamped to a sane 0-90% band —
    // 100%+ on rampDown would zero out (or invert) damage by the last hit of a 5-hit move. ----
    multiHitScaling: MULTI_HIT_SCALING_MODES.some(t => t[0] === m.multiHitScaling) ? m.multiHitScaling : "none",
    multiHitScalingPct: m.multiHitScalingPct != null && !isNaN(Number(m.multiHitScalingPct)) ? Math.max(0, Math.min(90, Number(m.multiHitScalingPct))) : 20,
    action: category === "Status" && MOVE_ACTIONS.some(t => t[0] === m.action) ? m.action : (category === "Status" ? "status" : "none"),
    // ---- Move Exchange Targeting (Copy/Steal/Swap/Force sub-setting): which of the opponent's move
    // slots gets targeted, and — for "specificSlot" mode — exactly which 1-based slot number to use. ----
    moveExchangeTarget: MOVE_EXCHANGE_TARGETS.some(t => t[0] === m.moveExchangeTarget) ? m.moveExchangeTarget : "lastDamaging",
    moveExchangeSlot: m.moveExchangeSlot != null && !isNaN(Number(m.moveExchangeSlot)) ? Math.max(1, Math.min(4, Math.round(Number(m.moveExchangeSlot)))) : 1,
    // ---- Full Transform (Ditto-style) Revert Timing sub-setting — only relevant to the "transform"
    // action; see TRANSFORM_REVERT_MODES above ----
    transformRevertMode: TRANSFORM_REVERT_MODES.some(t => t[0] === m.transformRevertMode) ? m.transformRevertMode : "permanent",
    transformRevertTurns: m.transformRevertTurns != null && !isNaN(Number(m.transformRevertTurns)) ? Math.max(1, Math.round(Number(m.transformRevertTurns))) : 3,
    statusEffect: category === "Status" && STATUS_EFFECTS.some(s => s[0] === m.statusEffect) ? m.statusEffect : "none",
    statusDurationMode: STATUS_DURATION_MODES.some(d => d[0] === m.statusDurationMode) ? m.statusDurationMode : "random",
    statusDurationMin: !isNaN(durMin) && durMin > 0 ? Math.round(durMin) : 1,
    statusDurationMax: !isNaN(durMax) && durMax > 0 ? Math.round(durMax) : 3,
    statusDurationFixed: !isNaN(durFixed) && durFixed > 0 ? Math.round(durFixed) : 5,
    effectChance: clampPct(m.effectChance, 100),
    healType: m.healType === "flat" ? "flat" : "percent",
    healValue: m.healValue != null && !isNaN(Number(m.healValue)) ? Number(m.healValue) : 25,
    healTarget: HEAL_TARGETS.some(t => t[0] === m.healTarget) ? m.healTarget : "self",
    weather: WEATHER_STATES.some(w => w[0] === m.weather) ? m.weather : "rain",
    weatherDuration: !isNaN(weatherDur) && weatherDur > 0 ? Math.round(weatherDur) : 5,
    // ---- Weather picker is now available on damaging moves too: an independent toggle (doesn't ride
    // on the Status-only `action` field) so a Physical/Special move can deal damage AND set weather ----
    setsWeather: !!m.setsWeather,
    // ---- Field Effect picker: independent of Weather (both can be active at once), and available on
    // any move via the "Also Sets Field Effect When It Hits" toggle, same pattern as setsWeather above ----
    field: FIELD_STATES.some(f => f[0] === m.field) ? m.field : "grassy",
    fieldDuration: !isNaN(fieldDur) && fieldDur > 0 ? Math.round(fieldDur) : 5,
    setsField: !!m.setsField,
    // ---- Polluted Weather: customizable turn-end % chance to Poison non-immune targets, set when
    // this move's own "Set Weather" effect chooses Polluted ----
    pollutedPoisonChance: clampPct(m.pollutedPoisonChance, 15),
    hazardType: HAZARD_TYPES.some(h => h[0] === m.hazardType) ? m.hazardType : "stealthrock",
    effects: normalizeEffects(m.effects),
    tags: normalizeTags(m.tags, m.name, m.desc),
    // ---- Tag-Based Move Transformations: unlimited stacking rules, resolved non-destructively per-use ----
    tagRules: normalizeTagRules(m.tagRules),
    weatherAccuracy: normalizeWeatherAccuracy(m.weatherAccuracy),
    failsAgainstTags: normalizeCreatureTags(m.failsAgainstTags), // the move FAILS against a target carrying any of these Fakemon tags
    failsAgainstTagsOn: m.failsAgainstTagsOn === "self" ? "self" : "opponent", // whose tags are checked
    targetScope: ["enemy", "you", "bothEnemies", "bothAllies", "all", "allButYou"].includes(m.targetScope) ? m.targetScope : "enemy", // who the move hits (used by 2v2 battles)
    // ---- Effectiveness vs Pokémon Tags: mirror-image of the entry-level Tag Matchups — this list lives
    // on the MOVE and is checked against the DEFENDER's own Pokémon Tags (entry.tags/fighters[side].tags)
    // instead of the move's own tags. Lets a move be built as, say, useless against anything tagged
    // "heavyweight" regardless of type (see moveVsCreatureTagMultiplier() in the simulator core). Reuses
    // the same {tag, multiplier} shape/normalizer as Tag Matchups since it's identical. ----
    vsTags: normalizeTagMatchups(m.vsTags),
    // ---- Status-Bypass & Forced Action Mechanics (Sleep Talk / Snore, auto-thaw, forced confusion action) ----
    statusBypass: normalizeStatusBypass(m.statusBypass),
    weightScaling: WEIGHT_SCALING_MODES.some(w => w[0] === m.weightScaling) ? m.weightScaling : "none",
    damageBasis: DAMAGE_BASIS_OPTIONS.some(d => d[0] === m.damageBasis) ? m.damageBasis : "standard",
    // ---- Battle History & Damage Scaling: lets this move's power scale off live turn-by-turn battle
    // history state instead of a fixed Base Power (see historyScalingMultiplier() in the simulator) ----
    historyScaling: HISTORY_SCALING_MODES.some(h => h[0] === m.historyScaling) ? m.historyScaling : "none",
    historyScalingStepPct: m.historyScalingStepPct != null && !isNaN(Number(m.historyScalingStepPct)) ? Math.max(0, Number(m.historyScalingStepPct)) : 100,
    // ---- Custom Damage Scaling: e.g. Psyshock (User SpAtk vs Target Def) ----
    atkStatBasis: ["auto", "atk", "spa"].includes(m.atkStatBasis) ? m.atkStatBasis : "auto",
    defStatBasis: ["auto", "def", "spd"].includes(m.defStatBasis) ? m.defStatBasis : "auto",
    // ---- MOVE TRIGGERS & ATTRIBUTES ----
    // Ignore Defense: damage calc treats the target's Def/SpD stat stages as 0 (base value), ignoring boosts/drops.
    ignoreDefense: !!m.ignoreDefense,
    // Ignore Defenses/Shields (Bypass Protection Override): this move's damage skips past any active
    // Hit-Count Attack Shield UNLESS that specific shield stack is flagged Unignorable.
    ignoreShields: !!m.ignoreShields,
    // ---- Speed-Scaling Offense: see speedScalingMultiplier() near the top of this script for the four
    // modes ("none" default, "relativeFaster", "relativeSlower", "absolute") and the exact formula. ----
    speedScaling: ["none", "relativeFaster", "relativeSlower", "absolute"].includes(m.speedScaling) ? m.speedScaling : "none",
    speedScalingFactor: m.speedScalingFactor != null && !isNaN(Number(m.speedScalingFactor)) ? Math.max(0, Number(m.speedScalingFactor)) : 0.5,
    // ---- Expanded Stat/Weight Damage Scaling: see DYNAMIC_POWER_MODES/dynamicBasePower() near
    // speedScalingMultiplier() for the four formulas (Electro Ball/Gyro Ball/Heavy Hitter/Heavy Slam-
    // style). Overrides move.basePower outright for the hit rather than multiplying it. ----
    dynamicPower: DYNAMIC_POWER_MODES.some(d => d[0] === m.dynamicPower) ? m.dynamicPower : "none",
    // ---- Delayed Attack Events (Future Sight / Doom Desire Mechanic) ----
    delayedAttack: (() => {
      const da = m.delayedAttack || {};
      const delayNum = Number(da.delayTurns);
      return {
        enabled: !!da.enabled,
        delayTurns: !isNaN(delayNum) && delayNum > 0 ? Math.max(1, Math.round(delayNum)) : 2,
        statSnapMode: DELAY_STAT_SNAP_MODES.some(s => s[0] === da.statSnapMode) ? da.statSnapMode : "launch",
        ignoreTypeImmunity: !!da.ignoreTypeImmunity,
        // With Cast (default, matches prior behavior) vs. With Resolve (deferred to landing)
        effectTiming: DELAY_EFFECT_TIMING_MODES.some(s => s[0] === da.effectTiming) ? da.effectTiming : "cast"
      };
    })(),
    // Critical Rate Selector: normal (default roll) / high (+1 stage, boosted roll) / always (guaranteed crit).
    critRateMode: CRIT_RATE_MODES.some(c => c[0] === m.critRateMode) ? m.critRateMode : "normal",
    // Move Cooldowns: turns this move is locked out for after use (0 = no cooldown).
    cooldownTurns: m.cooldownTurns != null && !isNaN(Number(m.cooldownTurns)) ? Math.max(0, Math.round(Number(m.cooldownTurns))) : 0,
    // ---- Move Priority: -3 (moves last within the round, e.g. Trick Room-adjacent moves) to +3
    // (moves first, e.g. Extreme Speed-style). 0 is standard Speed-order priority. ----
    priority: (() => {
      const pNum = Number(m.priority);
      return !isNaN(pNum) ? Math.max(-3, Math.min(3, Math.round(pNum))) : 0;
    })(),
    // ---- Counter Mechanics (Counter / Mirror Coat / Metal Burst): when enabled, this move ignores
    // its own Base Power entirely and instead reflects `multiplier`x whatever damage the user took
    // THIS turn (tracked in fighters[side].turnState), bypassing the target's Def/SpD stat outright.
    // Fails outright if the user wasn't hit this turn, or was hit by a damage type this move doesn't
    // match (damageType: "physical"/"special"/"any"). ----
    counterMove: (() => {
      const cm = m.counterMove || {};
      const multNum = Number(cm.multiplier);
      return {
        enabled: !!cm.enabled,
        damageType: COUNTER_DAMAGE_TYPES.some(d => d[0] === cm.damageType) ? cm.damageType : "physical",
        multiplier: !isNaN(multNum) && multNum > 0 ? multNum : 2
      };
    })(),
    // Dynamic Type Matching (Freedom Selection): if the target has `dynamicTypeTarget`, force/override the
    // standard type-chart multiplier with `dynamicTypeMode`'s multiplier instead.
    dynamicTypeEnabled: !!m.dynamicTypeEnabled,
    dynamicTypeTarget: TYPES.includes(m.dynamicTypeTarget) ? m.dynamicTypeTarget : "normal",
    dynamicTypeMode: DYNAMIC_TYPE_MODES.some(d => d[0] === m.dynamicTypeMode) ? m.dynamicTypeMode : "superEffective",
    // ---- Recoil Mechanics: % of the calculated damage dealt that's applied back onto the user ----
    recoilPercent: m.recoilPercent != null && !isNaN(Number(m.recoilPercent)) ? Math.max(0, Number(m.recoilPercent)) : 0,
    // ---- Drain (Absorb / Giga Drain / Drain Punch / Leech Life...): the user heals this % of the damage it dealt ----
    drainPercent: m.drainPercent != null && !isNaN(Number(m.drainPercent)) ? Math.max(0, Number(m.drainPercent)) : 0,
    // ---- autoRule = generated by the official importer (official-moves.js); the admin "Rebuild moves & tags" button
    // may regenerate it. The move editor doesn't carry this flag, so a hand-edited move is never overwritten. ----
    autoRule: !!m.autoRule,
    // ---- Fixed Damage (Seismic Toss / Night Shade / Dragon Rage / Sonic Boom: flat HP; Super Fang: % of the target's CURRENT HP).
    // Replaces the computed damage after every ability/rule modifier, so type immunities, Wonder Guard, shields, Substitute and
    // Protect all still apply to it. ----
    fixedDamage: m.fixedDamage != null && !isNaN(Number(m.fixedDamage)) ? Math.max(0, Math.round(Number(m.fixedDamage))) : 0,
    fixedDamagePct: m.fixedDamagePct != null && !isNaN(Number(m.fixedDamagePct)) ? Math.max(0, Math.min(100, Number(m.fixedDamagePct))) : 0,
    // ---- Self-Switch (U-turn / Volt Switch / Flip Turn / Parting Shot / Teleport = "switch", Baton Pass = "baton": the switch also
    // passes the user's stat stages). Team battles only; queued like the Switch In effect and carried out after the move resolves. ----
    selfSwitch: ["none", "switch", "baton"].includes(m.selfSwitch) ? m.selfSwitch : "none",
    // ---- Consecutive-Use Failure (Protect / Detect): each use in a row has only a 1/3 chance (then 1/9...) of working. ----
    consecutiveFail: !!m.consecutiveFail,
    // ---- Conditional Status Damage Boosters (Hex/Facade-style): multiplies this move's damage if the
    // target is afflicted with the configured status (or any status at all) ----
    statusDamageMultiplier: m.statusDamageMultiplier != null && !isNaN(Number(m.statusDamageMultiplier)) ? Math.max(0, Number(m.statusDamageMultiplier)) : 1,
    statusDamageMultFilter: STATUS_DMG_FILTERS.some(s => s[0] === m.statusDamageMultFilter) ? m.statusDamageMultFilter : "any",
    statusDamageMultOn: m.statusDamageMultOn === "user" ? "user" : "target", // whose status condition triggers the multiplier (Hex = target, Facade = user)
    failStatus: STATUS_DMG_FILTERS.some(s => s[0] === m.failStatus) ? m.failStatus : "any", // status checked by the status Fail Conditions
    ohko: !!m.ohko,           // one-hit KO move (Fissure / Guillotine / Sheer Cold): a connecting hit deals the target's whole HP
    selfFaint: !!m.selfFaint, // the user faints after using this move (Explosion / Self-Destruct)
    // ---- Move Fail Conditions (Sucker Punch-style if/else gate): checked after the accuracy roll but
    // before damage/effects — if the condition is met, the move simply fails ----
    failCondition: MOVE_FAIL_CONDITIONS.some(f => f[0] === m.failCondition) ? m.failCondition : "none",
    failWeather: WEATHER_STATES.some(w => w[0] === m.failWeather) ? m.failWeather : "sun",
    failField: FIELD_STATES.some(f => f[0] === m.failField) ? m.failField : "grassy",
    // ---- Unified Rule Builder: identical passive/active schema to Abilities (see normalizePassiveRule/
    // normalizeActiveRule), so a Move can gate its own Dynamic Multi-Effect Sequence Array behind the
    // exact same Boolean conditions/triggers an Ability can — including "IF Weather Is Active" ----
    rule: {
      enabled: !!r.enabled,
      ruleType: r.ruleType === "active" ? "active" : "passive",
      passive: normalizePassiveRule(r.passive),
      active: normalizeActiveRule(r.active)
    },
    // ---- "TRADEOFF" Move Matrix: Cost / Target Consequence / Duration / Conditional Type Override ----
    // ---- "TRADEOFF" Move Matrix: Cost / Target Consequence / Duration / Conditional Type Override ----
    tradeoff: normalizeTradeoff(m.tradeoff),
    // ---- Dynamic State-Binding Partial Immunity (Fly / Dig / Bury Mechanics): when enabled, USING this
    // move puts its user into a named stance/state for the rest of the round. While in that state the
    // user takes 0 damage and is immune to all incoming attacks UNLESS the attacking move's name or one
    // of its tags case-insensitively matches an entry in `exceptions` (e.g. Bury -> immune to everything
    // except "Earthquake" or moves tagged "Ground"). ----
    stateImmunity: (() => {
      const si = m.stateImmunity || {};
      const exceptionsRaw = Array.isArray(si.exceptions) ? si.exceptions.join(",") : (si.exceptions || "");
      return {
        enabled: !!si.enabled,
        key: (si.key || "").trim() || "hidden",
        exceptions: exceptionsRaw.split(",").map(s => s.trim()).filter(Boolean),
        // ---- Invulnerability Expiration Event: "onAttack" is the original behavior (stance decays at
        // end of the round it's entered on — standard Fly/Dig). "fixedDuration" instead ignores attack
        // resolution entirely and just counts down `expireDurationTurns` rounds. ----
        expireEvent: si.expireEvent === "fixedDuration" ? "fixedDuration" : "onAttack",
        expireDurationTurns: si.expireDurationTurns != null && !isNaN(Number(si.expireDurationTurns)) ? Math.max(1, Math.round(Number(si.expireDurationTurns))) : 2
      };
    })(),
    // ---- Multi-Turn Charge Execution (Solar Beam / Skull Bash Mechanics): when enabled, using this move
    // locks the user in for `duration` charging turns (buffed by `condition`) before it fires for real. ----
    chargeUp: (() => {
      const cu = m.chargeUp || {};
      return {
        enabled: !!cu.enabled,
        duration: cu.duration != null && !isNaN(Number(cu.duration)) ? Math.max(1, Math.round(Number(cu.duration))) : 1,
        condition: CHARGE_CONDITIONS.some(c => c[0] === cu.condition) ? cu.condition : "none",
        shieldPercent: clampPct(cu.shieldPercent, 50),
        healPercent: clampPct(cu.healPercent, 25),
        // charge turn is skipped while this weather is active (Solar Beam in "sun", Electro Shot in "rain"); "none" = never skipped
        skipInWeather: (typeof cu.skipInWeather === "string" && cu.skipInWeather !== "clear" && WEATHER_STATES.some(w => w[0] === cu.skipInWeather)) ? cu.skipInWeather : "none"
      };
    })(),
    // ---- Mega Evolution Move Restrictions: does this BASE-movepool move stay usable after the creature
    // Mega Evolves? Default false = it drops out of the usable list once Mega'd (Special Mega Move Slots
    // fill in instead). A move living only in the Mega's own move slots is always Mega-only regardless of
    // this flag, since it was never in the base movepool to begin with. ----
    megaUsable: !!m.megaUsable
  };
}
// ---- Steal Move Fallback: when Steal Opponent's Move empties out a slot on the victim's side, that
// slot gets backfilled with a bare-bones Struggle-style placeholder (routed through normalizeMove so it
// carries every field the engine expects — no more risk of an undefined property downstream) instead of
// leaving a hole in fighters[side].moves or collapsing the movepool down. ----
function makeStruggleFallback(type) {
  return normalizeMove({ name: "Struggle", type: type || "normal", category: "Physical", basePower: 50, maxPP: 1, accuracy: 1, desc: "A last-resort move used when nothing else is available." });
}
function migrateEntry(e) {
  return {
    ...e,
    abilities: (e.abilities || []).map(normalizeAbility),
    moves: (e.moves || []).map(normalizeMove),
    tagMatchups: normalizeTagMatchups(e.tagMatchups),
    genderPool: normalizeGenderPool(e.genderPool),
    tastes: normalizeTastes(e.tastes),
    tags: [...new Set([...normalizeCreatureTags(e.tags), ...deriveTasteTags(normalizeTastes(e.tastes))])],
    preEvo: e.preEvo != null ? Number(e.preEvo) : null,
    preEvoMethod: e.preEvoMethod || "",
    evolvesInto: e.evolvesInto != null ? Number(e.evolvesInto) : null,
    evolvesAt: (e.evolvesAt && e.evolvesAt.type) ? { type: e.evolvesAt.type, value: e.evolvesAt.value } : null,
    variantOf: e.variantOf != null ? Number(e.variantOf) : null,
    megas: normalizeMegas(e.megas || e.mega)
  };
}

let regions = loadRegions();
let entries = loadEntries();
window.entries = entries; // see saveEntries() above for why this copy exists
let items = loadItems();
let favorites = loadFavorites();
let editingId = null;
let pickedRegionColor = REGION_COLORS[0];
let activeTabName = "complete";
let filters = { region: "", type: "", rarity: "", sort: "id" };

function loadRegions() {
  try { const raw = localStorage.getItem(REGIONS_KEY); if (raw) { const p = JSON.parse(raw); if (p.length) return p; } } catch (e) { }
  const seed = seedRegions(); saveRegions(seed); return seed;
}
function loadEntries() {
  try { const raw = localStorage.getItem(ENTRIES_KEY); if (raw) { const p = JSON.parse(raw); return p.map(migrateEntry); } } catch (e) { }
  const seed = seedEntries().map(migrateEntry); saveEntries(seed); return seed;
}
function saveRegions(data) { try { localStorage.setItem(REGIONS_KEY, JSON.stringify(data)); } catch (e) { } }
function saveEntries(data) {
  try { localStorage.setItem(ENTRIES_KEY, JSON.stringify(data)); } catch (e) { }
  // evolution.js / roster.js (both ES modules) can't see this file's
  // classic-script `entries` variable directly, so they read window.entries
  // instead (see the note in evolution.js's getEvolutionTarget()). Keep
  // that copy in sync on every save so a level-based evolution check
  // always sees the latest dex data instead of whatever main.js's
  // Firestore loadDex() last put there (or nothing, if that never ran).
  window.entries = data;
}
function loadFavorites() {
  try { const raw = localStorage.getItem(FAVORITES_KEY); if (raw) return new Set(JSON.parse(raw)); } catch (e) { }
  return new Set();
}
function saveFavorites() { try { localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favorites])); } catch (e) { } }
function isFavorite(id) { return favorites.has(Number(id)); }
function toggleFavorite(id) {
  id = Number(id);
  if (favorites.has(id)) favorites.delete(id); else favorites.add(id);
  saveFavorites();
}
function nextEntryId() { return entries.reduce((m, e) => Math.max(m, e.id), 0) + 1; }
function nextRegionId() { return regions.reduce((m, r) => Math.max(m, r.id), 0) + 1; }
function pad(n) { return String(n).padStart(3, "0"); }
function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
function powerOf(e) { const s = e.stats || {}; return STAT_KEYS.reduce((sum, [k]) => sum + (Number(s[k]) || 0), 0); }
function regionById(id) { return regions.find(r => r.id === id); }
function entryById(id) { return id == null ? null : entries.find(e => e.id === Number(id)) || null; }
function childrenOf(id) { return entries.filter(e => e.preEvo === id); }
function variantSiblingsOf(entry) {
  const baseId = entry.variantOf != null ? entry.variantOf : entry.id;
  return entries.filter(e => e.id !== entry.id && (e.id === baseId || e.variantOf === baseId));
}
function rowBg(entry) {
  const t1 = `var(--t-${entry.types[0]})`;
  if (entry.types[1]) { return `linear-gradient(135deg, ${t1} 55%, var(--t-${entry.types[1]}) 100%)`; }
  return t1;
}
function rowTextColor(entry) { return DARK_TEXT_TYPES.has(entry.types[0]) ? "var(--text-ink)" : "#fff"; }
function typeMultiplier(atkType, defTypes) {
  return defTypes.reduce((m, dt) => m * ((TYPE_CHART[atkType] || {})[dt] ?? 1), 1);
}
// ---- Tag Matchups: a per-entry list of {tag, multiplier} baked directly onto the species itself — e.g.
// "sound" tags always deal 0.5x to this Fakemon, or "punch" tags always deal 1.5x. This is intentionally
// NOT an ability: it's checked unconditionally for every landed hit, the same way the Type Chart above is,
// so it can never be silenced by an ability-negating effect and doesn't cost an ability slot. Every rule
// whose tag the incoming move carries stacks multiplicatively (mirrors how dual-typing stacks in
// typeMultiplier above); an entry with no tagMatchups (or none matching) just multiplies by 1. ----
function tagMatchupMultiplier(defenderEntry, moveTags) {
  const tagsLower = (moveTags || []).map(t => String(t).toLowerCase());
  return (defenderEntry.tagMatchups || []).reduce((m, tm) => {
    if (!tm.tag) return m;
    return tagsLower.includes(String(tm.tag).toLowerCase()) ? m * tm.multiplier : m;
  }, 1);
}
// ---- Effectiveness vs Pokémon Tags: the mirror image of Tag Matchups above — a per-MOVE list of
// {tag, multiplier} (move.vsTags) checked against the DEFENDER's own Pokémon Tags (entry.tags /
// fighters[side].tags) instead of the move's own tags. Independent of, and stacks multiplicatively with,
// both the Type Chart and Tag Matchups — lets a move be built as, say, useless against anything tagged
// "heavyweight" no matter its type (e.g. a Flying move with a 0 rule for "heavyweight"). A move with no
// vsTags (or none matching the defender's tags) just multiplies by 1. ----
function moveVsCreatureTagMultiplier(move, defenderEntry) {
  const defTagsLower = ((defenderEntry && defenderEntry.tags) || []).map(t => String(t).toLowerCase());
  return ((move && move.vsTags) || []).reduce((m, vt) => {
    if (!vt.tag) return m;
    return defTagsLower.includes(String(vt.tag).toLowerCase()) ? m * vt.multiplier : m;
  }, 1);
}
// ---- Shared Tag Pool: "Types Are Tags Too". Any tag-matching check (Boost Tag Move, etc.) treats a
// move's own elemental Type as ONE MORE implicit tag it carries, alongside whatever custom tags it has
// — so writing "fire" into a tag-matching filter also catches Fire-type moves for free, no need to hand-tag
// every Fire move with a literal "fire" tag. This is STRICTLY one-directional and interaction-only: it
// never feeds back into typeMultiplier() or the real type chart. Slapping a "fire" tag onto a Water-type
// move can trigger a tag-based boost/matchup, but that move is still Water for every type-effectiveness
// purpose — it will never become super-effective against Grass just because it's tagged "fire". ----
function moveTagPool(move) {
  const pool = (move.tags || []).map(t => String(t).toLowerCase());
  if (move.type) pool.push(String(move.type).toLowerCase());
  return pool;
}
// ---- Parses a free-text, comma-separated field (e.g. "punch, fire, sound") into a clean lowercase
// array, letting every "Boost Tag" field accept more than one tag/type at once. ----
function parseTagList(str) {
  return String(str || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}
// ---- Does `move` carry ANY of the tags in a comma-separated filter string? Checked against the move's
// full tag pool (custom tags + its own Type as an implicit tag — see moveTagPool() above). ----
function moveMatchesAnyTag(move, tagFilterStr) {
  const wanted = parseTagList(tagFilterStr);
  if (!wanted.length) return false;
  const pool = moveTagPool(move);
  return wanted.some(t => pool.includes(t));
}
// ---- "When Hitting" Active Condition helper: does this hit's live type-effectiveness multiplier fall
// into the bucket the Ability/Move rule asked for? ----
function effectivenessMatches(mult, want) {
  if (want === "superEffective") return mult > 1;
  if (want === "notVeryEffective") return mult > 0 && mult < 1;
  if (want === "immune") return mult === 0;
  return true; // "any"
}
function battlePower(entry) { return STAT_KEYS.reduce((s, [k]) => s + ((entry.stats && entry.stats[k]) || 50), 0); }

// ---- Stat-stage helper (standard Pokémon-style stage curve, clamped -6..+6) ----
function stageMult(stage) {
  stage = Math.max(-6, Math.min(6, stage || 0));
  return stage >= 0 ? (2 + stage) / 2 : 2 / (2 - stage);
}

// ---- Fakemon "have" several possible abilities; each battle randomly picks which one is active ----
function pickBattleAbility(entry) {
  const list = (entry.abilities || []).filter(ab => ab && ab.name);
  if (!list.length) return null;
  return list[Math.floor(Math.random() * list.length)];
}
// ---- "When" trigger match: the "always" (Passively / Always Active) trigger matches every event check ----
function triggerMatches(trigger, eventName) {
  return trigger === eventName || trigger === "always";
}
function passiveApplies(ability, moveType) {
  if (!ability || ability.abilityType !== "passive") return false;
  const p = ability.passive;
  if (Array.isArray(p.affectedTypes) && p.affectedTypes.length) return p.affectedTypes.includes(moveType);
  const f = p.filterType;
  return f === "any" || f === moveType;
}
// ---- The "CHANCE" gate: an effect's [Effect Chance] field (0-100) is rolled via Math.random() before it processes ----
function chanceHits(pct) {
  const p = pct == null ? 100 : Number(pct);
  return Math.random() * 100 < p;
}
// ---- Environmental Boolean Gate Evaluator: the canonical "IF weather is active, THEN do X" check.
// Shared by any rule owner (Ability OR Move) whose Active Trigger condition is ENVIRONMENTAL_ACTIVE_CONDITIONS
// (currently just "weatherIs"), and by the Passive Rule "weatherActive" trigger. Kept as one small
// if/else so every rule owner evaluates weather identically instead of re-implementing the check. ----
function evaluateEnvironmentalCondition(condition, ruleParams, currentWeather) {
  if (condition === "weatherIs") {
    // TRUE only if a weather is actually in effect AND it matches the state the rule asked for.
    return currentWeather !== "clear" && currentWeather === ruleParams.weatherCondition;
  }
  return false;
}

// ---- defenderTags/fieldEffect are optional — every existing call site keeps working unchanged; only
// sites that want the Misty Terrain status-block need to pass them. ----
function isStatusImmune(defenderTypes, statusKind, move, defenderTags, fieldEffect) {
  if (!statusKind || statusKind === "none") return false;
  // built-in elemental immunities, e.g. Fire types can't be Burned, Electric types can't be Paralyzed
  for (const t of defenderTypes) {
    // ---- Poisonous Terrain: Steel types lose their normal Poison/Bad Poison immunity while it's active ----
    if (t === "steel" && (statusKind === "poison" || statusKind === "badlyPoisoned") && fieldEffect === "poisonous") continue;
    if (STATUS_IMMUNITIES[t] && STATUS_IMMUNITIES[t].has(statusKind)) return true;
  }
  // types are fundamentally immune to their own-type status moves (e.g. Fire immune to Fire-type status moves)
  if (move && move.category === "Status" && defenderTypes.includes(move.type)) return true;
  // ---- Misty Terrain: blocks any of the major status conditions from being inflicted on a GROUNDED
  // target (see isGrounded()) while Misty Terrain is the active Field Effect ----
  if (fieldEffect === "misty" && MAJOR_STATUS_KINDS.has(statusKind) && isGrounded(defenderTypes, defenderTags || [])) return true;
  // ---- Electric Terrain: GROUNDED targets (see isGrounded()) simply cannot be put to Sleep while it's
  // active — narrower than Misty (Sleep only, not the full Major Status set) ----
  if (fieldEffect === "electric" && statusKind === "sleep" && isGrounded(defenderTypes, defenderTags || [])) return true;
  return false;
}
// ---- HEAL resolver: shared by both Ability responses and Move effects; toggles between [% Base] and [Flat #] ----
function resolveHeal(healType, healValue, maxHpVal) {
  const v = Number(healValue) || 0;
  return healType === "flat" ? Math.round(v) : Math.round(maxHpVal * (v / 100));
}
function applyHeal(hpObj, maxHpObj, side, healType, healValue, name, who, log) {
  const before = hpObj[side];
  hpObj[side] = Math.min(maxHpObj[side], hpObj[side] + resolveHeal(healType, healValue, maxHpObj[side]));
  const healed = hpObj[side] - before;
  if (healed > 0) log.push(`${who}'s ${name} restores ${healed} HP!`);
}
// ---- Targetable healing: Self / Opponent / Both, used by move-level heal effects ----
function applyHealTarget(hpObj, maxHpObj, side, otherSide, target, healType, healValue, name, who, fighters, log) {
  if (target === "self" || target === "both") {
    applyHeal(hpObj, maxHpObj, side, healType, healValue, name, who, log);
  }
  if (target === "opponent" || target === "both") {
    if (hpObj[otherSide] > 0) {
      applyHeal(hpObj, maxHpObj, otherSide, healType, healValue, name, fighters[otherSide].name, log);
    }
  }
}
// ---- Targetable stat-stage change: Self / Opponent / Both, used by the Dynamic Multi-Effect Array ----
function applyStatModTarget(stages, side, otherSide, target, statKey, statStage, who, otherWho, log) {
  if (target === "self" || target === "both") {
    stages[side][statKey] = Math.max(-6, Math.min(6, (stages[side][statKey] || 0) + statStage));
    log.push(`${who}'s ${statKey.toUpperCase()} ${statStage > 0 ? "rose" : "fell"}!`);
  }
  if (target === "opponent" || target === "both") {
    stages[otherSide][statKey] = Math.max(-6, Math.min(6, (stages[otherSide][statKey] || 0) + statStage));
    log.push(`${otherWho}'s ${statKey.toUpperCase()} ${statStage > 0 ? "rose" : "fell"}!`);
  }
}
// ---- Multi-Mega Evolution: builds the merged movepool for whichever Mega profile just activated (see
// checkMegaEvolution/applyMegaEvolution above), swapping the fighter's base stats, TYPES, ability, move
// availability, passive/active kit, lore, and art wholesale into that profile's isolated Mega dataset for
// the rest of the battle. A Mega profile with no custom Ability configured simply falls back to the base
// creature's own abilities — nothing is lost there. Move availability is its own state-check filter
// (see buildMegaMovepool below): base movepool moves are dropped once Mega Evolved UNLESS individually
// flagged "Can Be Used In Mega Evolution", while that profile's Special Mega Move Slots are folded in on
// top and are always Mega-exclusive (they were never part of the base movepool to begin with). This
// restriction is a MEGA EVOLUTION-specific rule: a profile whose Transformation Kind (mg.kind) is
// "dynamax" ignores it entirely and carries over every base-movepool move unchanged, matching normal
// Dynamax move behavior — see mg.kind in normalizeMegaProfile(). ----
function buildMegaMovepool(entry, mg) {
  // ---- State-check filter: only base moves explicitly marked megaUsable survive the transformation —
  // UNLESS this profile is a Dynamax, in which case every base move carries over untouched. ----
  const carriedOver = mg.maxMoves ? []   // Max-Move forms: ONLY the profile's own (Max) moves are usable
    : mg.kind === "dynamax"
    ? (entry.moves || []).filter(m => m.name)
    : (entry.moves || []).filter(m => m.name && m.megaUsable);
  const megaExclusive = (mg.moves || []).filter(m => m.name);
  // ---- De-dupe by name: a Special Mega Move Slot always wins over a same-named carried-over base move ----
  const seen = new Set(megaExclusive.map(m => m.name));
  const merged = [...megaExclusive, ...carriedOver.filter(m => !seen.has(m.name))];
  return merged; // empty is valid — the simulator's Struggle fallback covers a Mega with zero usable moves
}
// ---- Multi-Mega: picks the first enabled profile on `entry.megas` whose Activation Requirement is
// satisfied right now. heldStone re-rolls megaConfig.chance every round (classic "holding a Mega Stone"
// behavior). triggerMove fires the instant its named move lands. turnThreshold fires once `turn` reaches
// its configured value. `canTransform` is the Transformation Lifecycle gate (see canAttemptTransform()
// in the simulator core below) — it replaces the old "one evolution per battle, ever" boolean flag with
// the fuller active/reverted/cooldown/locked-out state machine that Duration & Reuse Cooldown need.
// `heldItemId` is the id of whatever item this side is actually holding this battle (from the Battle Prep
// Held Item dropdown, resolved via itemConfig/itemState) — if a profile's activation.requiredItem is set,
// that profile is skipped entirely unless heldItemId matches it exactly, regardless of whether its own
// Requirement condition (heldStone/triggerMove/turnThreshold) is otherwise satisfied. ----
function checkMegaEvolution(side, entry, megaConfig, turn, justUsedMoveName, canTransform, heldItemId) {
  if (!megaConfig || !megaConfig.enabled || !canTransform(side) || !entry.megas || !entry.megas.length) return null;
  for (const mg of entry.megas) {
    if (!mg.enabled) continue;
    const act = mg.activation;
    if (act.requiredItem && act.requiredItem !== heldItemId) continue; // not holding the required item — this profile can't fire
    const ready =
      (act.requirement === "heldStone" && chanceHits(megaConfig.chance)) ||
      (act.requirement === "triggerMove" && justUsedMoveName && act.triggerMoveName && justUsedMoveName === act.triggerMoveName) ||
      (act.requirement === "turnThreshold" && turn >= act.turnThreshold);
    if (ready) return mg;
  }
  return null;
}
// ---- Trigger Alternate Form: picks the first enabled form on `entry.megas` whose requirement is
// "triggerEffect" and whose label matches the effect's label (a blank label on either side matches
// anything). Ignores the "Allow Mega Evolution" toggle and chance roll, like the standalone Change Form
// effect. A Required Held Item on the form is still enforced. ----
function pickTriggeredForm(entry, label, heldItemId) {
  if (!entry || !entry.megas || !entry.megas.length) return null;
  const want = (label || "").trim().toLowerCase();
  for (const mg of entry.megas) {
    if (!mg.enabled) continue;
    const act = mg.activation || {};
    if (act.requirement !== "triggerEffect") continue;
    if (act.requiredItem && act.requiredItem !== heldItemId) continue;
    const have = (act.triggerLabel || "").trim().toLowerCase();
    if (want && have && want !== have) continue;
    return mg;
  }
  return null;
}
function applyMegaEvolution(entry, mg, log) {
  const evolved = {
    ...entry,
    name: mg.name || ("Mega " + entry.name),
    types: (mg.types && mg.types.length) ? mg.types : entry.types,
    stats: mg.stats || entry.stats,
    icon: mg.emoji || entry.icon,
    // ---- Independent Mega Lore/Description + Images: isolated from the base entry's own desc/images.
    // Falls back to the base entry's own images if this profile didn't set any of its own (also covers
    // profiles saved before the 4-slot image system existed, which only ever had a flat imageUrl). ----
    desc: mg.desc || entry.desc,
    images: (mg.images && (mg.images.pixel || mg.images.artwork)) ? mg.images
      : mg.imageUrl ? { pixel: "", pixelShiny: "", artwork: mg.imageUrl, artworkShiny: "", focus: {} }
        : entry.images,
    // ---- Dedicated Mega Custom Ability: replaces the base ability list outright when configured, so
    // pickBattleAbility() (called right after this on the returned entry) draws only from the Mega kit ----
    abilities: mg.ability ? [mg.ability] : entry.abilities,
    // ---- Mega Evolution Move Restrictions: movePP/moveCooldowns for any newly-introduced move names are
    // topped up right after this call, at the call site, so the swap is complete and clean mid-battle ----
    moves: buildMegaMovepool(entry, mg)
  };
  log.push(`✨ ${entry.name} ${mg.transformVerb} ${evolved.name}!`);
  return evolved;
}

// ---- Dex Visibility for Forms/Megas ----
// Turns one enabled Mega/Alternate-Form profile (configured inside a base entry's own editor — see
// megaProfileBlockHtml/collectMegas) into a standalone, read-only "virtual" Dex entry so it can be
// browsed and inspected (own stats/types/ability/moves page) just like a real entry. It reuses
// applyMegaEvolution()'s exact stat/type/ability/move merge, so the Dex page always matches what the
// battle simulator actually uses. Crucially this virtual object is built on demand and NEVER pushed
// into the `entries` array itself — that's what keeps it out of populateFighterSelects()'s battle
// roster pool automatically, with zero extra filtering logic needed there. Its id is the string
// "mega-<baseEntryId>-<megaProfileId>", which the #/dex/ router (see updateViewVisibility) recognizes
// and rebuilds fresh from the live base entry + profile every time, so edits stay in sync.
function buildVirtualMegaEntry(baseEntry, mg) {
  const evolved = applyMegaEvolution(baseEntry, mg, []); // same merge battles use; log is thrown away here
  const act = mg.activation || {};
  const itemLabel = act.requiredItem ? ((itemById(act.requiredItem) || {}).name || act.requiredItem) : "";
  const activationLabel = itemLabel
    || (act.requirement === "triggerMove" ? `using ${act.triggerMoveName || "its trigger move"}`
      : act.requirement === "triggerEffect" ? (act.triggerLabel ? `a Trigger Alternate Form move/ability ("${act.triggerLabel}")` : "a Trigger Alternate Form move/ability")
      : act.requirement === "turnThreshold" ? `turn ${act.turnThreshold}+`
        : "a held Mega Stone-style item");
  return {
    ...evolved,
    id: `mega-${baseEntry.id}-${mg.id}`,
    regionId: baseEntry.regionId,
    category: baseEntry.category,
    creator: baseEntry.creator,
    height: baseEntry.height,
    weight: baseEntry.weight,
    rarity: baseEntry.rarity,
    preEvo: null,
    variantOf: null,
    isVirtualMega: true,
    baseEntryId: baseEntry.id,
    megaId: mg.id,
    megaKind: mg.kind,
    megaActivationLabel: activationLabel,
    // ---- Community Form ownership: a form anyone-can-add is owned by whoever MADE it, not by
    // whoever owns the base creature it's attached to — this is what the detail page's Edit/Delete
    // buttons key off of for a community form, instead of the base entry's own creatorUid. ----
    isCommunityForm: !!mg.isCommunityForm,
    creatorUid: mg.isCommunityForm ? mg.creatorUid : baseEntry.creatorUid,
    formCreatorName: mg.creatorName || null
  };
}
function enabledMegasOf(entry) {
  // Three sources merge here: entry.megas is the base entry OWNER's own
  // authored forms (embedded on the entry doc itself, edited via the big
  // creature form). window.communityForms is the "anyone can add a form"
  // pool (separate Firestore docs, entries/{id}/forms/{formId}). And now
  // window.acceptedMegaSuggestions is the "Suggest Something" pool —
  // proposals that started as entries/{id}/suggestions/{id} docs and got
  // accepted by the base entry's owner. All three carry their own
  // creatorUid/creatorName so credit always points at whoever actually
  // designed that particular form, never at the base creature's owner.
  const owned = (entry.megas || []).filter(mg => mg.enabled);
  const community = ((window.communityForms && window.communityForms[entry.id]) || [])
    .map(mg => ({ ...mg, enabled: true, isCommunityForm: true }));
  const suggested = ((window.acceptedMegaSuggestions && window.acceptedMegaSuggestions[entry.id]) || [])
    .map(mg => ({ ...mg, enabled: true, isCommunityForm: true, isAcceptedSuggestion: true }));
  return [...owned, ...community, ...suggested];
}

// ---- Contextual Status Interaction ("Wet") Immunity Check: Ground / Steel / Water types can never be Wet ----
function isWetImmune(types) {
  return (types || []).some(t => STATUS_IMMUNITIES.wet.has(t));
}
// ---- Ignores Weather Effects: does this combatant's ability exempt it from the given weather's built-in
// type-based passive effects (e.g. Nighttime's Grass slow/weaken, without needing a move/ability tag)? ----
function ignoresWeatherEffect(ab, weatherName) {
  return !!(ab && ab.ignoresWeatherEffects && (ab.ignoredWeather === "any" || ab.ignoredWeather === weatherName));
}
// ---- Dynamic PP Cost System: does `move` match the rule's configured target selector? ----
function ppCostTargetMatches(targetMode, move, attackerMoveList, lastUsedName) {
  if (targetMode === "highestBasePower") {
    const maxBP = attackerMoveList.reduce((m, mv) => Math.max(m, mv.basePower || 0), 0);
    return maxBP > 0 && (move.basePower || 0) === maxBP;
  }
  if (targetMode === "lastUsedMove") {
    return lastUsedName != null && move.name === lastUsedName;
  }
  return false;
}

// ================= SIMULATOR CORE =================
// Boolean-gated engine: creature.abilities / creature.moves (built via the Rule Builder UI)
// are read here as plain `if` checks against trigger / filter / condition / chance / weather fields.
// ---- Move Exchange Target Resolution: shared by Copy/Steal/Swap/Force. Given the SIDE being targeted
// (the opponent, from the acting side's perspective), the acting move's own config, the live `fighters`
// runtime state, and the `lastUsedMove` tracker, returns the array index of the targeted move slot inside
// fighters[targetSide].moves — or -1 if no valid slot could be found (triggers the graceful fail log). ----
function pickExchangeTargetIdx(targetSide, moveDef, fighters, lastUsedMove) {
  const pool = (fighters[targetSide] && fighters[targetSide].moves) || [];
  const validIdxs = pool.map((m, i) => i).filter(i => pool[i] && pool[i].name);
  if (!validIdxs.length) return -1;
  const mode = moveDef.moveExchangeTarget || "lastDamaging";
  if (mode === "random") {
    return validIdxs[Math.floor(Math.random() * validIdxs.length)];
  } else if (mode === "firstSlot") {
    return validIdxs[0];
  } else if (mode === "matchingType") {
    const found = validIdxs.find(i => pool[i].type === moveDef.type);
    return found != null ? found : -1;
  } else if (mode === "specificSlot") {
    const idx = (moveDef.moveExchangeSlot || 1) - 1;
    return (idx >= 0 && idx < pool.length && pool[idx] && pool[idx].name) ? idx : -1;
  } else {
    // "lastDamaging" (default): mirrors the original behavior — only ever targets the move the
    // opponent most recently used, tracked via lastUsedMove[]. No fallback to another slot on a miss;
    // that's a deliberate, distinct failure case ("no move to swap/copy") rather than a silent retry.
    const nm = lastUsedMove[targetSide];
    const idx = nm ? pool.findIndex(m => m.name === nm) : -1;
    return idx;
  }
}
// teamOpts (optional): { a:[entry x N], b:[entry x N] } turns this into a TEAM battle. Slot 0 of each team
// leads; whenever the active Fakemon faints (or the bot decides it is badly matched, see planSwitch()), a teammate is sent in (see enterSlot() below). Weather, Field
// Effects, hazards, the turn counter and the log all carry across Fakemon; everything else (HP, stat stages,
// status, ability, PP, shields, transforms, timers) starts fresh for each arrival. Omit teamOpts for the
// classic 1v1 — behavior is unchanged. itemConfig.a / itemConfig.b may be a single item id (lead only) or an
// array of item ids, one per team slot.
function simulateOneBattle(a, b, megaConfig, fieldConfig, itemConfig, teamOpts) {
  const teamMode = !!(teamOpts && Array.isArray(teamOpts.a) && Array.isArray(teamOpts.b) && teamOpts.a.length && teamOpts.b.length);
  if (teamMode) { a = teamOpts.a[0]; b = teamOpts.b[0]; }
  function itemIdOf(side, idx) {
    const v = itemConfig && itemConfig[side];
    return Array.isArray(v) ? (v[idx] || null) : (idx === 0 ? (v || null) : null);
  }
  const preLog = [];
  // ---- Multi-Mega Evolution: fighters now enter the arena unevolved. Each side's configured Mega
  // profiles (see entry.megas) are checked against their own Activation Requirement every turn inside
  // the round loop below, and swapped in wholesale — mid-battle — the moment one qualifies. ----
  // ---- Type Burnout: fighters carry their own shallow-cloned `types` array (instead of aliasing the
  // source Pokédex entry's array directly) so a burnout move splicing/reassigning a type mid-battle can
  // never leak into the original entry data or bleed across repeated trials in runBattleOdds(). ----
  // ---- Move-Swap Runtime Isolation (BUGFIX): `moves` gets the exact same shallow-clone treatment as
  // `types` above. Without this, fighters[side].moves was the SAME array reference as the source Dex
  // entry's own entry.moves — so Copy/Steal/Swap/Force writing into fighters[side].moves[slotIdx] was
  // silently mutating the permanent registry entry itself, and since runBattleOdds() reuses the same `a`/
  // `b` entry objects across all 300 trials, that corruption compounded trial-over-trial (this is what
  // caused an entire movepool to collapse into a single copied move after enough battles). Cloning the
  // array here means every slot write only ever touches this battle's throwaway copy — the individual
  // move objects inside are still shared by reference, but slot assignment always REPLACES the array
  // element wholesale (never mutates a move object's own properties in place), so that's safe too. ----
  // ---- Gender System: resolved ONCE here from each entry's genderPool (rollGender() coin-flips
  // "Both" 50/50) and cached on the fighter for the rest of this battle instance — re-rolling
  // mid-battle would let Infatuation compatibility "flicker" turn to turn. Never displayed directly;
  // only surfaced via effect text (see the Infatuation pre-turn lock-in check below). ----
  const fighters = { a: { ...a, types: [...(a.types || [])], moves: [...(a.moves || [])], tags: [...(a.tags || [])], gender: rollGender(a.genderPool) }, b: { ...b, types: [...(b.types || [])], moves: [...(b.moves || [])], tags: [...(b.tags || [])], gender: rollGender(b.genderPool) } };
  const maxHp = { a: ((a.stats && a.stats.hp) || 50) * 3, b: ((b.stats && b.stats.hp) || 50) * 3 };
  const hp = { a: maxHp.a, b: maxHp.b };
  const stages = { a: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }, b: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0 } };
  const status = { a: null, b: null }; // { kind, counter, turnsLeft }
  // ---- Counter Mechanics: per-side tracker of the damage this side took THIS TURN ONLY, read by
  // Counter/Mirror Coat/Metal Burst-style moves (see executeCounterMove()). Reset to a clean state
  // every round in the end-of-turn cleanup block further below (resetTurnState()). ----
  const turnState = {
    a: { lastDamageTaken: 0, lastDamageType: null, gotHitThisTurn: false },
    b: { lastDamageTaken: 0, lastDamageType: null, gotHitThisTurn: false }
  };
  // ---- Records an incoming hit against `side` for this turn's Counter tracking. `category` should
  // be the attacking move's own category ("Physical"/"Special"); anything else is stored as "other"
  // and only ever matches a Counter-style move configured for damageType "any". ----
  function recordTurnDamage(side, amount, category) {
    if (!(amount > 0)) return;
    turnState[side].lastDamageTaken = amount;
    turnState[side].lastDamageType = category === "Physical" ? "physical" : category === "Special" ? "special" : "other";
    turnState[side].gotHitThisTurn = true;
  }
  // ---- Clears every side's turn-scoped Counter tracking. Called once at the very end of each round
  // so a Counter-style move can only ever reflect damage taken DURING that same round. ----
  function resetTurnState() {
    roundsOnField.a++; roundsOnField.b++;   // called exactly once per finished round
    ["a", "b"].forEach(s => {
      turnState[s].lastDamageTaken = 0;
      turnState[s].lastDamageType = null;
      turnState[s].gotHitThisTurn = false;
    });
  }
  // ---- Counter Mechanics execution: reflects `move.counterMove.multiplier`x the damage `side` took
  // this turn straight back onto `otherSide`, entirely bypassing the target's Def/SpD stat (and any
  // stat stages on it) since the output is derived purely from the incoming damage number, not from
  // a fresh atk/def calculation. Fails (does nothing but log) if the user wasn't hit this turn, or if
  // the damage it took doesn't match this move's configured damageType filter. Returns the amount of
  // damage actually reflected (0 on failure). ----
  function executeCounterMove(side, otherSide, move, attackerName, defenderName) {
    const ts = turnState[side];
    const cfg = move.counterMove || {};
    if (!ts.gotHitThisTurn) {
      log.push(`${attackerName} used ${move.name}, but it failed!`);
      return 0;
    }
    if (cfg.damageType !== "any" && ts.lastDamageType !== cfg.damageType) {
      log.push(`${attackerName} used ${move.name}, but it failed!`);
      return 0;
    }
    const reflectDmg = Math.max(1, Math.round(ts.lastDamageTaken * (cfg.multiplier || 2)));
    const finalDmg = Math.min(hp[otherSide], reflectDmg);
    hp[otherSide] = Math.max(0, hp[otherSide] - finalDmg);
    if (finalDmg > 0) totalDamageTaken[otherSide] += finalDmg;
    log.push(`${attackerName} used ${move.name}! It strikes back at ${defenderName} for ${finalDmg} damage!`);
    return finalDmg;
  }

  // ================= ITEM DEX: PER-BATTLE STATE =================
  // Each side carries at most one held/consumable item, resolved from the id passed in via itemConfig
  // (set from the Fighter A/B Held Item dropdowns in Battle Prep). `used` marks a one-shot item (Focus
  // Sash's save, a consumable berry) as spent so it can't trigger again for the rest of this battle.
  // `item` itself can also be reassigned mid-battle by a Status move's "Swap Held Items" action (see the
  // Item Swap Engine further below) — that's runtime-only too, same as Move Exchange: it only ever
  // touches this object, never itemConfig or the registry, so it fully resets between battles/trials.
  // `usesLeft` is the Consumable Charges counter — seeded from item.maxUses (0 = unlimited, matching the
  // old always-on Leftovers/Rocky Helmet behavior). `efficiency` is a 0-1 multiplier applied to every
  // numeric effect value; it starts at 1 (full strength) and is only ever changed by a "Recover Used
  // Item" (Recycle) Move/Ability effect with a reduced-efficiency parameter. Both are runtime-only —
  // built fresh here every trial from itemConfig/the registry, never written back to either.
  const itemState = {
    // New runtime-only fields (Extended Item Effect Hooks, below): abilityNullifyTurns counts down an
    // Ability Nullifier applied BY the opponent's item; firstMoveBonusArmed/tempStatBuff/statShiftPct/
    // timedDamageBoosts are all consumed/ticked over the course of the battle and never written back
    // to itemConfig. timedDamageBoosts (armed by a battleStart/onUse boostDamage effect) starts absent
    // and is lazily created as an array the first time one arms — see armItemTimedDamageBoost.
    a: {
      item: itemById(itemIdOf("a", 0)), usesLeft: 0, efficiency: 1,
      abilityNullifyTurns: 0, firstMoveBonusArmed: false, tempStatBuff: null, statShiftPct: null
    },
    b: {
      item: itemById(itemIdOf("b", 0)), usesLeft: 0, efficiency: 1,
      abilityNullifyTurns: 0, firstMoveBonusArmed: false, tempStatBuff: null, statShiftPct: null
    }
  };
  ["a", "b"].forEach(s => { if (itemState[s].item) itemState[s].usesLeft = Math.max(0, Number(itemState[s].item.maxUses) || 0); });
  // 0/blank maxUses = unlimited (always has "charge" left); otherwise fires only while usesLeft>0.
  function itemHasCharge(st) { return !!st.item && (!(Number(st.item.maxUses) > 0) || st.usesLeft > 0); }
  function useItemCharge(st) { if (Number(st.item.maxUses) > 0 && st.usesLeft > 0) st.usesLeft--; }
  // "[Item] (x/n)" charge tag for the battle log — blank for unlimited-use items.
  function itemChargeTag(st) {
    const mu = Number(st.item.maxUses) || 0;
    if (mu <= 0) return "";
    return ` (${mu - st.usesLeft}/${mu})`;
  }
  // ---- Immunities: passive, always-on while the item is held — independent of the charges/effects
  // system above. Logs the 🛡️ protection message and returns true the moment it actually blocks
  // something; callers should short-circuit on this before falling through to elemental/ability checks.
  function itemBlocksStatus(side, statusKind) {
    const st = itemState[side];
    if (!st.item || !statusKind || statusKind === "none") return false;
    const key = statusKind === "badlyPoisoned" ? "poison" : statusKind;
    if (st.item.immunities && st.item.immunities[key]) {
      log.push(`🛡️ ${fighters[side].name}'s ${st.item.name} protected it!`);
      return true;
    }
    return false;
  }
  function itemBlocksHazard(side) {
    const st = itemState[side];
    if (!st.item || !(st.item.immunities && st.item.immunities.hazard)) return false;
    log.push(`🛡️ ${fighters[side].name}'s ${st.item.name} protected it!`);
    return true;
  }
  // ---- Effect Priority: an item can carry many effects (heal + a type boost + ...). `priority`
  // (default 0, lower number fires first) lets the author control which one resolves before the
  // other whenever more than one is eligible at the same trigger moment — e.g. cure a status before
  // healing, or land the heal before the "2nd effect" (a type boost) arms. Ties keep their original
  // Effects-list order (stable sort), so untouched items behave exactly as before. Used everywhere an
  // item's effects[] is read, not just here. ----
  function effectsByPriority(item) {
    return (item && item.effects || [])
      .map((e, i) => ({ e, i }))
      .sort((a, b) => (Number(a.e.priority) || 0) - (Number(b.e.priority) || 0) || a.i - b.i)
      .map(x => x.e);
  }
  // battleStart / onUse triggers — both fire once, right as the holder enters the fight (battleStart
  // reads like "this held item is already active"; onUse reads like "this item gets eaten/activated
  // right now" — pick whichever fits an item's flavor). Shared handler: previously only boostStat
  // worked here, silently dropping heal/cureStatus/boostDamage effects set to fire this early (e.g. a
  // food item meant to heal the instant it's eaten) — all four now resolve properly, and boostDamage
  // arms a timed, Move-Filter-scoped outgoing-damage boost (see armItemTimedDamageBoost).
  function applyItemImmediateEffects(side, triggerName) {
    const st = itemState[side];
    if (!st.item) return;
    effectsByPriority(st.item).filter(e => e.trigger === triggerName).forEach(it => {
      if (!itemHasCharge(st)) return;
      if (!matchesHolderFilter(it, fighters[side])) return;
      if (it.action === "heal" || it.action === "boostStat" || it.action === "cureStatus") {
        const result = useItem(side, side, st.item, it);
        if (result.success) log.push(result.message);
      } else if (it.action === "boostDamage") {
        armItemTimedDamageBoost(side, st, it);
      }
    });
  }
  function applyItemBattleStart(side) { applyItemImmediateEffects(side, "battleStart"); }
  function applyItemOnUse(side) { applyItemImmediateEffects(side, "onUse"); }
  // ---- Timed Type/Tag Damage Boost: what a boostDamage effect arms when it fires from battleStart/
  // onUse, as opposed to onDealDamage's one-shot bonus tacked onto a single hit already landing. Reuses
  // the effect's own Move Filter (filterKind/filterValue — "none" boosts every outgoing hit, "type"/
  // "tag" narrows it, e.g. boosting only Fire-type moves) via matchesMoveFilter. boostDurationTurns 0
  // (or blank) = lasts the rest of the battle; a positive N ticks down by 1 at the end of every turn
  // (tickItemTimedBoosts) and is removed once it hits 0. Multiple armed boosts stack additively. ----
  function armItemTimedDamageBoost(side, st, fx) {
    st.timedDamageBoosts = st.timedDamageBoosts || [];
    st.timedDamageBoosts.push({
      filterKind: fx.filterKind || "none", filterValue: fx.filterValue || "",
      value: Number(fx.value || 0),
      turnsLeft: Number(fx.boostDurationTurns || 0) > 0 ? Math.round(Number(fx.boostDurationTurns)) : null
    });
    useItemCharge(st);
    const durText = Number(fx.boostDurationTurns || 0) > 0 ? ` for ${Math.round(Number(fx.boostDurationTurns))} turns` : ` for the rest of the battle`;
    log.push(`🎒 ${fighters[side].name}'s ${st.item.name}${itemChargeTag(st)} powers up its attacks${durText}!`);
  }
  function getItemTimedDamageBoostMultiplier(side, move) {
    const list = itemState[side].timedDamageBoosts;
    if (!list || !list.length) return 1;
    let mult = 1;
    list.forEach(b => { if (matchesMoveFilter(b, move)) mult *= (1 + (b.value || 0)); });
    return mult;
  }
  function tickItemTimedBoosts(side) {
    const st = itemState[side];
    if (!st.timedDamageBoosts || !st.timedDamageBoosts.length) return;
    st.timedDamageBoosts.forEach(b => { if (b.turnsLeft != null) b.turnsLeft--; });
    if (st.timedDamageBoosts.some(b => b.turnsLeft != null && b.turnsLeft <= 0)) {
      log.push(`🎒 ${fighters[side].name}'s boosted attack fades.`);
    }
    st.timedDamageBoosts = st.timedDamageBoosts.filter(b => b.turnsLeft == null || b.turnsLeft > 0);
  }
  // ---- Deal Status Effect on Use: resolves an item's `statusEffectOnUse` block the moment its
  // holder enters battle. Runs the same gauntlet every other status-infliction path in this engine
  // uses — single-status-slot check, item-immunity, elemental/Terrain immunity via isStatusImmune()
  // — then, for "infatuated" specifically, also requires the two fighters' genders to actually be
  // compatible (see isGenderCompatible()); a same-gender or Genderless pairing just fizzles instead
  // of silently doing nothing visible. `target:"self"` afflicts the holder itself (Toxic Orb/Flame
  // Orb-style); `target:"opponent"` afflicts whoever it's facing. ----
  function applyItemStatusEffect(side) {
    const st = itemState[side];
    if (!st.item) return;
    const fx = st.item.statusEffectOnUse;
    if (!fx || !fx.effect || fx.effect === "none") return;
    if (!itemHasCharge(st)) return;
    const otherSide = otherOf(side);
    const recipientSide = fx.target === "self" ? side : otherSide;
    const sourceSide = fx.target === "self" ? otherSide : side;
    if (hp[recipientSide] <= 0) return;
    if (status[recipientSide]) return;
    if (Math.random() * 100 > Number(fx.chance ?? 100)) return;
    if (itemBlocksStatus(recipientSide, fx.effect)) return;
    if (isStatusImmune(fighters[recipientSide].types, fx.effect, null, fighters[recipientSide].tags, fieldEffect)) return;

    if (fx.effect === "infatuated") {
      const source = fighters[sourceSide], recipient = fighters[recipientSide];
      if (!isGenderCompatible(source.gender, recipient.gender, source.tags, recipient.tags)) {
        log.push(`🎒 ${fighters[side].name}'s ${st.item.name} had no effect on ${recipient.name}.`);
        return;
      }
      status[recipientSide] = createInfatuatedStatus(sourceSide);
      useItemCharge(st);
      log.push(`🎒 ${fighters[side].name}'s ${st.item.name}${itemChargeTag(st)} made ${recipient.name} fall for ${source.name}! ❤️`);
      return;
    }

    status[recipientSide] = { kind: fx.effect, counter: 1, turnsLeft: 3 + Math.floor(Math.random() * 3) + pollutedDurationBonus(fx.effect) };
    useItemCharge(st);
    log.push(`🎒 ${fighters[side].name}'s ${st.item.name}${itemChargeTag(st)} inflicted ${fx.effect} on ${fighters[recipientSide].name}!`);
  }
  // ================= ITEM PROCESSING ENGINE: useItem() =================
  // Central execution point for a single item Effect actually landing on its target. Called by every
  // trigger-timing function (applyItemBattleStart, applyItemTurnEnd, applyItemHpThreshold, ...) AFTER
  // they've already confirmed the effect's own trigger/charges/move-filter/holder-filter all check out
  // — this function's only job is to apply that effect and fold in the Taste/Flavor conditional layer:
  //   1. Evaluates item taste relative to the target's preferences/tags (getTastePreference()).
  //   2. Scales the effect's numeric value up (Liked), down (Disliked), or leaves it alone (Neutral/no
  //      flavor) — and gives a Disliked flavor a chance to also inflict Confusion as a side effect.
  //   3. Applies the resulting heal/stat-boost/status-cure to the target's live battle state.
  //   4. Returns a structured result object describing exactly what happened, so callers can log it
  //      instead of reaching into hp/stages/status themselves.
  // `userSide` is whoever's item is firing (the holder); `targetSide` is who receives the effect — the
  // same side for every built-in action here (held/consumable items in this engine self-target), but
  // kept as a separate parameter so a future ally-targeted item isn't a structural change.
  function useItem(userSide, targetSide, item, effect) {
    const st = itemState[userSide];
    const target = fighters[targetSide];
    const flavor = item.flavor && item.flavor !== "none" ? item.flavor : null;
    const taste = flavor ? getTastePreference(target, flavor) : "neutral";

    // ---- Taste Preference Modifiers: Liked = +20% value, Disliked = -50% value plus a chance of
    // Confusion, Neutral/no flavor = the item's base value untouched. ----
    let value = effect.value;
    let tasteNote = "";
    let confusionChance = 0;
    if (flavor) {
      if (taste === "likes") {
        value = value * TASTE_LIKE_MULTIPLIER;
        tasteNote = ` ${target.name} loves the ${flavor.toLowerCase()} taste!`;
      } else if (taste === "hates") {
        value = value * TASTE_HATE_MULTIPLIER;
        tasteNote = ` ${target.name} hated the ${flavor.toLowerCase()} taste...`;
        confusionChance = TASTE_HATE_CONFUSION_CHANCE;
      }
    }

    const result = { success: false, action: effect.action, flavor: flavor || "none", taste, hpDelta: 0, statusInflicted: null, message: "" };

    if (effect.action === "heal" && hp[targetSide] > 0) {
      const before = hp[targetSide];
      const healAmt = Math.max(1, Math.round(maxHp[targetSide] * value * (st.efficiency || 1)));
      hp[targetSide] = Math.min(maxHp[targetSide], hp[targetSide] + healAmt);
      result.hpDelta = hp[targetSide] - before;
      result.success = true;
      useItemCharge(st);
      result.message = `🎒 ${target.name} ate the ${item.name}${itemChargeTag(st)} and restored ${result.hpDelta} HP!${tasteNote}`;
    } else if (effect.action === "boostStat") {
      stages[targetSide].spe = Math.max(-6, Math.min(6, stages[targetSide].spe + value));
      result.success = true;
      useItemCharge(st);
      result.message = `🎒 ${target.name}'s ${item.name}${itemChargeTag(st)} boosts its Speed!${tasteNote}`;
    } else if (effect.action === "cureStatus" && status[targetSide]) {
      result.success = true;
      useItemCharge(st);
      result.message = `🎒 ${target.name}'s ${item.name}${itemChargeTag(st)} cures its ${status[targetSide].kind}!${tasteNote}`;
      status[targetSide] = null;
    }

    // ---- Tag & Type Conditional Check: hating this item's flavor gives it a chance to also confuse
    // the target on top of the (reduced) base effect — skipped if already afflicted, or immune to
    // Confusion outright (Psychic-types, see isStatusImmune()). ----
    if (confusionChance > 0 && !status[targetSide] && Math.random() < confusionChance &&
      !isStatusImmune(target.types, "confusion", null, target.tags, fieldEffect)) {
      status[targetSide] = { kind: "confusion", counter: 1, turnsLeft: 2 + Math.floor(Math.random() * 2) };
      result.statusInflicted = "confusion";
      result.message += ` ${target.name} got Confused from the awful taste!`;
    }

    return result;
  }
  // turnEnd trigger — e.g. Leftovers restoring 1/16th Max HP at the end of every round.
  function applyItemTurnEnd(side) {
    const st = itemState[side];
    if (!st.item || hp[side] <= 0) return;
    effectsByPriority(st.item).filter(e => e.trigger === "turnEnd").forEach(it => {
      if (!itemHasCharge(st)) return;
      if (!matchesHolderFilter(it, fighters[side])) return;
      if (it.action === "heal" && hp[side] < maxHp[side]) {
        const result = useItem(side, side, st.item, it);
        if (result.success) log.push(result.message);
      }
    });
  }
  // onHpThreshold trigger — checked right after a side takes damage: Sitrus Berry heals under 50% HP,
  // Lum Berry cures a status condition. Charges (not a single "used" flag) now gate repeat firing.
  function applyItemHpThreshold(side) {
    const st = itemState[side];
    if (!st.item || hp[side] <= 0) return;
    effectsByPriority(st.item).filter(e => e.trigger === "onHpThreshold").forEach(it => {
      if (!itemHasCharge(st)) return;
      if (!matchesHolderFilter(it, fighters[side])) return;
      if (it.action === "heal") {
        if ((hp[side] / maxHp[side]) < 0.5) {
          const result = useItem(side, side, st.item, it);
          if (result.success) log.push(result.message);
        }
      } else if (it.action === "cureStatus") {
        if (status[side]) {
          const result = useItem(side, side, st.item, it);
          if (result.success) log.push(result.message);
        }
      }
    });
  }
  // onTakeDamage trigger — checked at the moment a hit lands: Focus Sash intercepts what would be a
  // fainting blow (only from full HP), Rocky Helmet punishes the attacker for a contact hit. Both
  // actions respect the item's per-effect Move Filter (type/tag) before firing. Always finishes by
  // re-checking onHpThreshold, since HP just changed.
  function applyItemOnHit(defSide, atkSide, move, hpBeforeHit) {
    const st = itemState[defSide];
    if (st.item) {
      effectsByPriority(st.item).filter(e => e.trigger === "onTakeDamage").forEach(it => {
        if (!itemHasCharge(st)) return;
        if (!matchesMoveFilter(it, move)) return;
        if (!matchesHolderFilter(it, fighters[defSide])) return;
        if (it.action === "preventFaint" && hp[defSide] <= 0 && hpBeforeHit >= maxHp[defSide]) {
          hp[defSide] = 1;
          useItemCharge(st);
          log.push(`🎒 ${fighters[defSide].name} hangs on with 1 HP thanks to its ${st.item.name}${itemChargeTag(st)}!`);
        } else if (it.action === "recoil" && atkSide !== defSide && hp[defSide] > 0 && hp[atkSide] > 0) {
          const recoilDmg = Math.max(1, Math.round(maxHp[atkSide] * it.value * (st.efficiency || 1)));
          hp[atkSide] = Math.max(0, hp[atkSide] - recoilDmg);
          useItemCharge(st);
          log.push(`🎒 ${fighters[atkSide].name} is hurt by ${fighters[defSide].name}'s ${st.item.name}${itemChargeTag(st)}! (-${recoilDmg})`);
        } else if (it.action === "heal" && hp[defSide] > 0 && hp[defSide] < maxHp[defSide]) {
          const healAmt = Math.max(1, Math.round(maxHp[defSide] * it.value * (st.efficiency || 1)));
          hp[defSide] = Math.min(maxHp[defSide], hp[defSide] + healAmt);
          useItemCharge(st);
          log.push(`🎒 ${fighters[defSide].name}'s ${st.item.name}${itemChargeTag(st)} heals it on the hit! (+${healAmt} HP)`);
        }
      });
    }
    applyAllyHitTriggers(defSide, atkSide, hpBeforeHit);
    applyBondOnHit(defSide, atkSide, hpBeforeHit);
    applyItemHpThreshold(defSide);
  }
  // onDealDamage trigger — the mirror of onTakeDamage, checked against the ATTACKER's own item right
  // after its hit lands, gated the same way by each effect's Move Filter (e.g. Fire Gem only cares
  // about Fire-type moves). "boostDamage" adds bonus damage to the hit that just landed; "heal" is a
  // simple lifesteal that restores the attacker some % of the damage it just dealt.
  function applyItemOnDeal(atkSide, defSide, move, dmgDealt) {
    const st = itemState[atkSide];
    if (!st.item) return;
    effectsByPriority(st.item).filter(e => e.trigger === "onDealDamage").forEach(it => {
      if (!itemHasCharge(st)) return;
      if (!matchesMoveFilter(it, move)) return;
      if (!matchesHolderFilter(it, fighters[atkSide])) return;
      if (it.action === "boostDamage" && dmgDealt > 0 && hp[defSide] > 0) {
        const bonus = Math.max(1, Math.round(dmgDealt * it.value * (st.efficiency || 1)));
        hp[defSide] = Math.max(0, hp[defSide] - bonus);
        useItemCharge(st);
        log.push(`🎒 ${fighters[atkSide].name}'s ${st.item.name}${itemChargeTag(st)} empowers the hit for ${bonus} extra damage!`);
      } else if (it.action === "heal" && dmgDealt > 0 && hp[atkSide] > 0 && hp[atkSide] < maxHp[atkSide]) {
        const healAmt = Math.max(1, Math.round(dmgDealt * it.value * (st.efficiency || 1)));
        hp[atkSide] = Math.min(maxHp[atkSide], hp[atkSide] + healAmt);
        useItemCharge(st);
        log.push(`🎒 ${fighters[atkSide].name} drains HP back through its ${st.item.name}${itemChargeTag(st)}!`);
      }
    });
  }
  // ---- Recover Used Item (Recycle mechanic): restores one charge to a depleted item and, if the
  // effect specifies a reduced efficiency %, permanently scales that item's future numeric effects by
  // it for the rest of the battle. No-op if the item still has charges left or isn't held at all.
  function applyItemRecycle(side, efficiencyPct) {
    const st = itemState[side];
    if (!st.item) return;
    const mu = Number(st.item.maxUses) || 0;
    if (mu > 0 && st.usesLeft <= 0) {
      st.usesLeft = 1;
      st.efficiency = Math.max(0, Math.min(100, efficiencyPct == null ? 100 : Number(efficiencyPct))) / 100;
      log.push(`♻️ ${fighters[side].name} recovered its used ${st.item.name}!`);
    }
  }
  // ================= ITEM DEX: EXTENDED PASSIVE EFFECT HOOKS =================
  // 13 additional configurable held-item mechanics, on top of the base Item Dex above. Same rules apply:
  // runtime-only, built fresh above, cleared automatically at the end of the battle/trial. Each reuses
  // itemHasCharge()/useItemCharge()/itemChargeTag() as its "breaks after N uses"/"X% chance" gate exactly
  // like the base Item Dex effects do, and matchesMoveFilter() for any type/tag-scoped effect.

  // ---- 1. FAIL-SAFE: "Missed move -> trigger random damaging move." Called from the miss branch below
  // with the move pool to pick from; runs a free extra swing (no PP cost) once per charge. ----
  function applyItemFailSafe(side, otherSide) {
    const st = itemState[side];
    if (!st.item || !itemHasCharge(st)) return false;
    const fx = effectsByPriority(st.item).find(e => e.trigger === "onMoveMiss" && e.action === "failSafeRandomMove");
    if (!fx || !matchesHolderFilter(fx, fighters[side])) return false;
    const pool = (fighters[side].moves || []).filter(m => m.name && (m.basePower || 0) > 0);
    if (!pool.length) return false;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    useItemCharge(st);
    log.push(`🎒 ${fighters[side].name}'s ${st.item.name}${itemChargeTag(st)} kicks in after the miss — it lashes out with ${pick.name}!`);
    const dmg = Math.max(1, Math.round(((fighters[side].stats && fighters[side].stats.atk) || 50) / 2));
    hp[otherSide] = Math.max(0, hp[otherSide] - dmg);
    if (dmg > 0) { totalDamageTaken[otherSide] += dmg; applyItemOnHit(otherSide, side, pick, hp[otherSide] + dmg); applyItemOnDeal(side, otherSide, pick, dmg); }
    log.push(`${fighters[side].name}'s ${pick.name} deals ${dmg} damage!`);
    return true;
  }

  // ---- 2. STAT COPY: "On-entry, copy enemy stat stages." Fires once at battle start. ----
  function applyItemStatCopy(side, otherSide) {
    const st = itemState[side];
    if (!st.item || !itemHasCharge(st)) return;
    const fx = effectsByPriority(st.item).find(e => e.trigger === "onSwitchIn" && e.action === "copyStatStages");
    if (!fx || !matchesHolderFilter(fx, fighters[side])) return;
    stages[side] = { ...stages[otherSide] };
    useItemCharge(st);
    log.push(`🎒 ${fighters[side].name}'s ${st.item.name}${itemChargeTag(st)} copies ${fighters[otherSide].name}'s stat changes!`);
  }

  // ---- 3. STAT MODIFIER (timed): "+N stat effect for N turns, do something while active." Armed once
  // at battle start; ticked every turnEnd alongside applyItemTurnEnd. whileActiveAction: "heal" |
  // "cureStatus" | "boostDamage" (read via getActiveStatBuffDamageBonus at damage-calc time). ----
  function applyItemStatModifierArm(side) {
    const st = itemState[side];
    if (!st.item || st.tempStatBuff) return;
    const fx = effectsByPriority(st.item).find(e => e.action === "statModifierTimed");
    if (!fx || !itemHasCharge(st) || !matchesHolderFilter(fx, fighters[side])) return;
    stages[side][fx.statKey] = Math.max(-6, Math.min(6, (stages[side][fx.statKey] || 0) + Number(fx.value || 1)));
    st.tempStatBuff = { statKey: fx.statKey, turnsLeft: Number(fx.durationTurns || 3), whileActive: fx.whileActiveAction || "none", whileActiveValue: fx.whileActiveValue || 0 };
    useItemCharge(st);
    log.push(`🎒 ${fighters[side].name}'s ${st.item.name}${itemChargeTag(st)} sharply raises its ${fx.statKey.toUpperCase()}!`);
  }
  function tickItemStatModifier(side) {
    const st = itemState[side];
    const buf = st.tempStatBuff;
    if (!buf || hp[side] <= 0) return;
    if (buf.whileActive === "heal" && hp[side] < maxHp[side]) {
      const amt = Math.max(1, Math.round(maxHp[side] * (buf.whileActiveValue || 0.1) * (st.efficiency || 1)));
      hp[side] = Math.min(maxHp[side], hp[side] + amt);
      log.push(`🎒 ${fighters[side].name}'s ${st.item.name} keeps its stat surge topped up, healing a little!`);
    } else if (buf.whileActive === "cureStatus" && status[side]) {
      log.push(`🎒 ${fighters[side].name}'s ${st.item.name} clears its ${status[side].kind} while boosted!`);
      status[side] = null;
    }
    buf.turnsLeft--;
    if (buf.turnsLeft <= 0) { log.push(`🎒 ${fighters[side].name}'s ${st.item.name} effect fades.`); st.tempStatBuff = null; }
  }
  function getActiveStatBuffDamageBonus(side) {
    const buf = itemState[side].tempStatBuff;
    return (buf && buf.whileActive === "boostDamage") ? 1 + Number(buf.whileActiveValue || 0) : 1;
  }

  // ---- 4. STATUS EFFECT CHANGE: "Convert incoming status to another, or vice-versa." Call in place of
  // a direct `status[X] = {...}` assignment: returns the (possibly rewritten) status kind string. ----
  function resolveItemStatusConversion(receivingSide, inflictingSide, statusKind) {
    const recvSt = itemState[receivingSide];
    if (recvSt.item) {
      const fx = effectsByPriority(recvSt.item).find(e => e.action === "convertIncoming" && e.fromStatus === statusKind);
      if (fx && itemHasCharge(recvSt) && matchesHolderFilter(fx, fighters[receivingSide])) {
        useItemCharge(recvSt);
        log.push(`🎒 ${fighters[receivingSide].name}'s ${recvSt.item.name}${itemChargeTag(recvSt)} twists the incoming ${statusKind} into ${fx.toStatus}!`);
        return fx.toStatus;
      }
    }
    const sendSt = itemState[inflictingSide];
    if (sendSt.item) {
      const fx = effectsByPriority(sendSt.item).find(e => e.action === "convertOutgoing" && e.fromStatus === statusKind);
      if (fx && itemHasCharge(sendSt) && matchesHolderFilter(fx, fighters[inflictingSide])) {
        useItemCharge(sendSt);
        log.push(`🎒 ${fighters[inflictingSide].name}'s ${sendSt.item.name}${itemChargeTag(sendSt)} changes the status it deals into ${fx.toStatus}!`);
        return fx.toStatus;
      }
    }
    return statusKind;
  }

  // ---- 5. CONTACT COUNTER: "X% chance to inflict status when struck by contact moves." Slots into the
  // same onTakeDamage moment as applyItemOnHit above. ----
  function applyItemContactCounter(defSide, atkSide, move) {
    const st = itemState[defSide];
    if (!st.item) return;
    effectsByPriority(st.item).filter(e => e.trigger === "onTakeDamage" && e.action === "contactCounterStatus").forEach(fx => {
      if (!itemHasCharge(st)) return;
      if (!(move.tags || []).some(t => String(t).toLowerCase() === "contact")) return;
      if (!matchesHolderFilter(fx, fighters[defSide])) return;
      if (status[atkSide]) return;
      if (Math.random() * 100 > Number(fx.chance ?? 30)) return;
      if (isStatusImmune(fighters[atkSide].types, fx.statusKind, move, fighters[atkSide].tags, fieldEffect)) return;
      status[atkSide] = { kind: fx.statusKind, counter: 1, turnsLeft: 2 + Math.floor(Math.random() * 3) };
      useItemCharge(st);
      log.push(`🎒 ${fighters[atkSide].name} is ${fx.statusKind} by ${fighters[defSide].name}'s ${st.item.name}${itemChargeTag(st)} on contact!`);
    });
  }

  // ---- 6. ABILITY NULLIFIER: "Suppress opponent ability for N turns." Applied from the attacker's item
  // right after it deals damage; ticked at turnEnd; checked via isAbilityNullified() at ability-trigger
  // sites (gated on the two main damage-time trigger checks — "attacking"/"defending" passives and the
  // active offensive/defensive condition checks). ----
  function applyItemAbilityNullifier(atkSide, defSide) {
    const st = itemState[atkSide];
    if (!st.item) return;
    const fx = effectsByPriority(st.item).find(e => e.action === "suppressAbility");
    if (!fx || !itemHasCharge(st) || !matchesHolderFilter(fx, fighters[atkSide])) return;
    itemState[defSide].abilityNullifyTurns = Math.max(itemState[defSide].abilityNullifyTurns || 0, Number(fx.durationTurns || 3));
    useItemCharge(st);
    log.push(`🎒 ${fighters[atkSide].name}'s ${st.item.name}${itemChargeTag(st)} suppresses ${fighters[defSide].name}'s Ability!`);
  }
  function tickAbilityNullifier(side) { const st = itemState[side]; if (st.abilityNullifyTurns > 0) st.abilityNullifyTurns--; }
  function isAbilityNullified(side) { return !!(itemState[side] && itemState[side].abilityNullifyTurns > 0); }

  // ---- 7. FIRST-TURN PRIORITY: "+1 priority on first move post-entry." Armed at battle start, consumed
  // (one-shot per charge) the first time the holder's priority is actually read. ----
  function armItemFirstTurnPriority(side) {
    const st = itemState[side];
    if (!st.item) return;
    if (effectsByPriority(st.item).some(e => e.action === "firstTurnPriority" && matchesHolderFilter(e, fighters[side]))) st.firstMoveBonusArmed = true;
  }
  // read-only priority of a move (no item charges consumed) — used by Block Priority
  function getEffectivePriorityPeek(side, mv) { return (mv && mv.priority) || 0; }
  function getEffectivePriority(side, chosenMoveForSide) {
    const base = (chosenMoveForSide && chosenMoveForSide.priority) || 0;
    const st = itemState[side];
    if (st.firstMoveBonusArmed && itemHasCharge(st)) {
      st.firstMoveBonusArmed = false;
      useItemCharge(st);
      const fx = effectsByPriority(st.item).find(e => e.action === "firstTurnPriority");
      const bonus = Number((fx && fx.value) ?? 1);
      log.push(`🎒 ${fighters[side].name}'s ${st.item.name}${itemChargeTag(st)} lets it strike first this turn!`);
      return base + bonus;
    }
    return base;
  }

  // ---- 8. STAT SHIFTS: "Apply %-based stat boosts/penalties." A straight multiplier on the raw stat
  // value (distinct from integer stat STAGES) — set once at battle start, read at damage-calc time. ----
  function applyItemStatShiftBattleStart(side) {
    const st = itemState[side];
    if (!st.item) return;
    effectsByPriority(st.item).filter(e => e.trigger === "battleStart" && e.action === "percentStatShift").forEach(fx => {
      if (!itemHasCharge(st)) return;
      if (!matchesHolderFilter(fx, fighters[side])) return;
      st.statShiftPct = st.statShiftPct || {};
      st.statShiftPct[fx.statKey] = (st.statShiftPct[fx.statKey] || 0) + Number(fx.value || 0);
      useItemCharge(st);
      log.push(`🎒 ${fighters[side].name}'s ${st.item.name}${itemChargeTag(st)} ${fx.value >= 0 ? "raises" : "lowers"} its ${fx.statKey.toUpperCase()} by ${Math.abs(Math.round(fx.value * 100))}%!`);
    });
  }
  function getStatShiftMultiplier(side, statKey) {
    const st = itemState[side];
    const pct = st.statShiftPct && st.statShiftPct[statKey];
    return pct ? Math.max(0.1, 1 + pct) : 1;
  }

  // ---- 9. MULTI-HIT BREAK: "+X% move-type power; item breaks after N uses." Reuses the existing
  // maxUses/usesLeft charge system as the "breaks after N uses" counter outright. ----
  function applyItemTypePowerBoost(side, move, basePower) {
    const st = itemState[side];
    if (!st.item) return basePower;
    const fx = effectsByPriority(st.item).find(e => e.action === "boostTypePower");
    if (!fx || !itemHasCharge(st) || !matchesMoveFilter(fx, move) || !matchesHolderFilter(fx, fighters[side])) return basePower;
    const boosted = Math.round(basePower * (1 + Number(fx.value || 0.2)));
    useItemCharge(st);
    if (st.item.maxUses > 0 && st.usesLeft <= 0) log.push(`🎒 ${fighters[side].name}'s ${st.item.name} boosts the hit one final time, then shatters!`);
    else log.push(`🎒 ${fighters[side].name}'s ${st.item.name}${itemChargeTag(st)} empowers the move!`);
    return boosted;
  }

  // ---- 10. NEVER-MISS TYPE/TAG: "Tag/type moves never miss." Passive, always-on — no charge spent,
  // checked before the accuracy roll instead of after. ----
  function itemMoveNeverMisses(side, move) {
    const st = itemState[side];
    if (!st.item) return false;
    const fx = effectsByPriority(st.item).find(e => e.action === "neverMissFilter");
    if (!fx || !matchesHolderFilter(fx, fighters[side])) return false;
    return matchesMoveFilter(fx, move);
  }

  // ---- 11. WEAKNESS: "Take +X% damage from target type/tag." A drawback multiplier on the FINAL damage
  // number, applied right before it's subtracted from hp[defSide]. ----
  function itemIncomingDamageMultiplier(defSide, move) {
    const st = itemState[defSide];
    if (!st.item) return 1;
    const fx = effectsByPriority(st.item).find(e => e.action === "weaknessSurge");
    if (!fx || !matchesMoveFilter(fx, move) || !matchesHolderFilter(fx, fighters[defSide])) return 1;
    return 1 + Number(fx.value || 0.25);
  }

  // ---- 12. MITIGATION: "-X% damage from super-effective, or type X hits." Same call site as Weakness
  // above; `typeMult` is the already-computed type-effectiveness number for this hit. ----
  function itemDamageMitigation(defSide, move, typeMult) {
    const st = itemState[defSide];
    if (!st.item) return 1;
    const fx = effectsByPriority(st.item).find(e => e.action === "mitigation");
    if (!fx || !matchesHolderFilter(fx, fighters[defSide])) return 1;
    const gate = fx.filterMode || "superEffective";
    if (gate === "superEffective" && typeMult <= 1) return 1;
    if (gate === "typeFilter" && !matchesMoveFilter(fx, move)) return 1;
    return Math.max(0, 1 - Number(fx.value || 0.25));
  }

  // ---- 13. MOVE REPEAT (ECHO): "X% chance to re-execute move at Y% power." Checked right after
  // applyItemOnDeal resolves for a landed hit; the caller re-runs the same single-hit damage step at
  // the returned power multiplier if shouldEcho comes back true. ----
  function checkItemEcho(atkSide, defSide, move, dmgDealt) {
    const st = itemState[atkSide];
    if (!st.item || dmgDealt <= 0) return { shouldEcho: false };
    const fx = effectsByPriority(st.item).find(e => e.action === "echoRepeat");
    if (!fx || !itemHasCharge(st) || !matchesMoveFilter(fx, move) || !matchesHolderFilter(fx, fighters[atkSide])) return { shouldEcho: false };
    if (Math.random() * 100 > Number(fx.chance ?? 20)) return { shouldEcho: false };
    useItemCharge(st);
    log.push(`🎒 ${fighters[atkSide].name}'s ${st.item.name}${itemChargeTag(st)} echoes the attack!`);
    return { shouldEcho: true, powerMult: Number(fx.powerPct ?? 50) / 100 };
  }

  const hazards = { a: { stealthrock: false, spikesStacks: 0 }, b: { stealthrock: false, spikesStacks: 0 } };
  // ---- Modular Custom Entry Hazard Builder: field-side arrays of active custom hazards, one entry per
  // distinct "Custom Entry Hazard" effect that has landed (stackable ones carry a `stacks` counter up to
  // 3, non-stackable ones just get re-applied/overwritten by name). Entry effects run once via the
  // onSwitchIn-equivalent hook (runHazardEntryEffects, below); the optional turn-based penalty is
  // processed every round in the end-of-round onTurnEnd block. ----
  const customHazards = { a: [], b: [] };
  // ---- Customizable Hit-Count Attack Shields: each side carries an array of active shield stacks, one
  // entry per "Generate Shield" effect that has landed: { hitsLeft, capacity, triggerType, typeFilter,
  // unignorable }. `hitsLeft` is the live `activeShieldHitsLeft` counter for that stack. ----
  const shields = { a: [], b: [] };
  // ---- Per-battle state for the newer mechanics. Declared HERE (early in the battle closure) because entry abilities
  // run effects at battle start, before the later helper code is reached. ----
  const pendingSwitchIn = { a: null, b: null };   // Switch In effect: queued forced switch-ins
  const allyTriggerUsed = {};                     // Ally-Hit Trigger: owners that already reacted this battle
  let benchSwitchCtx = null;                      // { side, idx } while a benched owner's Ally-Hit trigger runs
  const doomCount = { a: 0, b: 0 };               // Doom Countdown: turns left before the active Fakemon faints (0 = none)
  const wishQueue = { a: [], b: [] };             // Wish: pending heals for each SIDE (not each Fakemon)
  const snatchReady = { a: false, b: false };     // Snatch: waiting to steal the foe's next Status move this round
  const substitute = { a: null, b: null };        // Substitute: { hp, max } decoy for each active Fakemon
  const liftState = { a: null, b: null };         // Lift: { turns, name, groundImmune } for each active Fakemon
  const bondState = { a: null, b: null };         // Bond: { turns, partner, onFaint, onDamage, damagePct, onStatus, lastStatus, name }
  const pendingSelfFaint = { a: false, b: false };// Self-Destruct: the user faints right after using the move
  const typeAdds = { a: [], b: [] };               // Add Type: [{ type, mode, turns }] still active on each side
  const dodgeShield = { a: null, b: null };       // Evade Inaccurate Attacks: { turns, below (0..1), name }
  const rootState = { a: null, b: null };         // Root Down: { turns, ground, sureHit, name }
  liftedFighters.clear();
  groundedFighters.clear();
  let currentSourceName = "";                     // name of the move/ability whose effects are running (for wear-off logs)
  let metronomePool = null;                       // Metronome: every usable move in the roster (built on first use)
  // ---- Dynamic State-Binding Partial Immunity (Fly / Dig / Bury Mechanics): at most one active stance
  // per side — { key, exceptions, turnsLeft }. Set when a side uses a move with stateImmunity.enabled;
  // ticked down and cleared in the end-of-round block below. While active, findStateException() gates
  // every incoming hit against this side in the main action loop. ----
  const stateImmunity = { a: null, b: null };
  function isStateImmuneTo(side, move) {
    const si = stateImmunity[side];
    if (!si) return false;
    // ---- Tag-Based Move Transformations: a resolved move carrying the bypassInvuln flag (set by
    // applyMoveTagRules() when one of its tags matches a "Bypass Airborne/Invulnerable Stances" rule,
    // e.g. [projectile]) always reaches its target regardless of the defender's stance/exceptions list. ----
    if (move.bypassesInvuln) return false;
    const exceptionHits = si.exceptions.some(ex => {
      const exLow = ex.toLowerCase();
      return String(move.name || "").toLowerCase() === exLow || (move.tags || []).some(t => String(t).toLowerCase() === exLow);
    });
    return !exceptionHits;
  }
  // ---- Tag-Based Move Transformations & Multi-Tag Stacking: array-driven, non-destructive tag
  // resolution pipeline. Walks the move's own tagRules array and, for every rule whose tag is present
  // on the move's tags list, layers its effect onto a fresh WORKING COPY (`resolved`) via object
  // spread — never mutating the move object stored on the combatant (chosenMove[side] / the original
  // movepool entry). Because each rule spreads onto the previous `resolved` snapshot rather than a
  // shared mutable object, several tag effects (e.g. a [blade] type conversion AND a [projectile]
  // invuln-bypass on the same move) apply sequentially without overwriting base move parameters or
  // stepping on each other's output. ----
  function applyMoveTagRules(baseMove) {
    let resolved = baseMove;
    const moveTagsLower = (baseMove.tags || []).map(t => String(t).toLowerCase());
    (baseMove.tagRules || []).forEach(rule => {
      if (!rule.tag || !moveTagsLower.includes(rule.tag.toLowerCase())) return;
      if (rule.effect === "convertType") {
        resolved = { ...resolved, type: rule.convertType };
      } else if (rule.effect === "bypassInvuln") {
        resolved = { ...resolved, bypassesInvuln: true };
      } else if (rule.effect === "powderImmune") {
        resolved = { ...resolved, tagPowderImmune: true };
      }
    });
    return resolved;
  }
  // ================= TRANSFORMATION / MEGA-EVOLUTION LIFECYCLE =================
  // Per-side runtime state for the active transformation, replacing the old "evolves at most once per
  // battle, forever" boolean flag with a full lifecycle: active -> (Duration countdown) -> revert ->
  // (Reuse Cooldown countdown OR permanent lockout) -> eligible to transform again.
  //   active          — is this side currently transformed?
  //   mega            — the normalized Mega profile currently active (null when not transformed)
  //   turnsRemaining  — turns left in the current transformation; null = permanent (durationLimit 0)
  //   preForm         — snapshot of the exact fighter object right before transforming, so reverting
  //                     restores base stats/movepool/ability/types/name exactly rather than approximating
  //   cooldownRemaining — turns left (in base form) before this side may transform again
  //   lockedOut       — true forever once a transformation with reuseCooldown===0 has reverted; this
  //                     side can never transform again for the rest of the battle
  const transformState = {
    a: { active: false, mega: null, turnsRemaining: null, preForm: null, cooldownRemaining: 0, lockedOut: false },
    b: { active: false, mega: null, turnsRemaining: null, preForm: null, cooldownRemaining: 0, lockedOut: false }
  };
  // ---- Terastallization state: independent of transformState (a fighter can be either Mega'd or
  // Tera'd, never both — see activateTeraState() below). Lasts the rest of the battle once active;
  // there is no revert/duration timer, mirroring how Terastallization works in the source games.
  //   active         — true once this side has Terastallized this battle
  //   type           — the Tera Type it activated into ("fire", "stellar", etc.)
  //   originalTypes  — the holder's pre-Tera typing, kept for STAB recalculation (see computeStabMultiplier)
  //   stellar        — true if type==="stellar" (typing itself is left untouched — see activateTeraState)
  //   used           — one-shot gate: once true, this side can never Terastallize again this battle
  const teraState = {
    a: { active: false, type: null, originalTypes: null, stellar: false, used: false },
    b: { active: false, type: null, originalTypes: null, stellar: false, used: false }
  };
  // ---- Transformation Lock (Rule 4) + Cooldown/Reuse Limit (Rule 3) gate, checked by checkMegaEvolution
  // before it even looks at Activation Requirements: a side must be un-transformed, not permanently
  // locked out, and past any active reuse cooldown before it's allowed to attempt a new transformation. ----
  function canAttemptTransform(side) {
    const st = transformState[side];
    if (st.active) return false;        // already transformed — must fully revert first
    if (st.lockedOut) return false;      // reuseCooldown was 0 on a previous transformation — never again
    if (st.cooldownRemaining > 0) return false; // still waiting out the post-revert cooldown
    return true;
  }
  // ---- Reversion & Cleanup (Rule 2): restores the exact pre-transformation fighter snapshot — which
  // wholesale drops every special ability and temporary move gained while transformed (they were never
  // part of that snapshot to begin with) and restores base stats/movepool/types/name/ability in one
  // step — then starts this side's Reuse Cooldown (Rule 3): reuseCooldown===0 permanently locks the side
  // out of transforming again this battle, otherwise it must wait reuseCooldown turns in base form. ----
  function revertTransformation(side) {
    const st = transformState[side];
    if (!st.active || !st.preForm) return;
    const mg = st.mega;
    if (st.baseMaxHp) {   // undo the Dynamax HP surge, keeping the current HP ratio
      const ratio = maxHp[side] > 0 ? hp[side] / maxHp[side] : 0;
      maxHp[side] = st.baseMaxHp; st.baseMaxHp = null;
      if (hp[side] > 0) hp[side] = Math.max(1, Math.round(ratio * maxHp[side]));
    }
    fighters[side] = st.preForm;
    // Re-derive the active ability from the restored base kit (drops any Mega-only ability) and re-run
    // the manual-cast synthetic-move fold so a base Active Ability's cast-move is present again if it
    // has one, mirroring what battle start / tryMegaEvolve both already do.
    ability[side] = pickBattleAbility(fighters[side]);
    log.push(`${fighters[side].name} reverts to its base form!`);
    // Drop PP/cooldown bookkeeping for any move name that no longer exists on the restored movepool
    // (temporary Mega-exclusive moves), and top up PP for any base move missing an entry (shouldn't
    // normally happen, but keeps this safe if the base kit itself changed shape mid-battle).
    const validMoveNames = new Set((fighters[side].moves || []).filter(m => m.name).map(m => m.name));
    Object.keys(movePP[side]).forEach(name => { if (!validMoveNames.has(name)) delete movePP[side][name]; });
    Object.keys(moveCooldowns[side]).forEach(name => { if (!validMoveNames.has(name)) delete moveCooldowns[side][name]; });
    (fighters[side].moves || []).forEach(m => { if (m.name && movePP[side][m.name] == null) movePP[side][m.name] = m.maxPP ?? m.pp ?? 15; });
    // Reset active-transformation state, then start the cooldown/lockout clock for next time.
    st.active = false;
    st.mega = null;
    st.turnsRemaining = null;
    st.preForm = null;
    if (mg.reuseCooldown === 0) {
      st.lockedOut = true;
    } else {
      st.cooldownRemaining = mg.reuseCooldown;
    }
  }
  // ---- Full Transform (Ditto-style) Runtime State: separate from the Mega Evolution transformState
  // above — a Full Transform copies Moves + Ability + Type (not a whole fighter profile/stat block), and
  // its revert timing is configured per-move (TRANSFORM_REVERT_MODES) rather than tied to a Mega profile.
  // { active, revertMode, revertTurnsRemaining (null unless mode is "turns"), preMoves, preAbility,
  //   preTypes } — the pre-transform snapshot restored by revertDittoTransform() below. BATTLE-ONLY: this
  // only ever mutates fighters[side].moves/.types (this battle's own cloned arrays) and ability[side]
  // (this battle's own ability tracker) — never anything in the permanent Dex registry. ----
  const dittoState = {
    a: { active: false, revertMode: null, revertTurnsRemaining: null, preMoves: null, preAbility: null, preTypes: null },
    b: { active: false, revertMode: null, revertTurnsRemaining: null, preMoves: null, preAbility: null, preTypes: null }
  };
  // ---- Reverts a Full Transform: restores the exact pre-transform moves/ability/type snapshot, cleans
  // up PP/cooldown bookkeeping for any move name that no longer exists on the restored kit (mirrors
  // revertTransformation()'s cleanup above), and resets the state so the side can transform again later
  // if its kit includes another Full Transform move. ----
  function revertDittoTransform(side) {
    const st = dittoState[side];
    if (!st.active) return;
    fighters[side].moves = st.preMoves;
    fighters[side].types = st.preTypes;
    ability[side] = st.preAbility;
    log.push(`🔁 ${fighters[side].name} transforms back to normal!`);
    const validMoveNames = new Set((fighters[side].moves || []).filter(m => m.name).map(m => m.name));
    Object.keys(movePP[side]).forEach(name => { if (!validMoveNames.has(name)) delete movePP[side][name]; });
    Object.keys(moveCooldowns[side]).forEach(name => { if (!validMoveNames.has(name)) delete moveCooldowns[side][name]; });
    (fighters[side].moves || []).forEach(m => { if (m.name && movePP[side][m.name] == null) movePP[side][m.name] = m.maxPP ?? m.pp ?? 15; });
    st.active = false;
    st.revertMode = null;
    st.revertTurnsRemaining = null;
    st.preMoves = null;
    st.preAbility = null;
    st.preTypes = null;
  }

  // ================= ABILITY-DRIVEN TRANSFORMATION (Ditto / Imposter-style) =================
  // Distinct from the Full Transform MOVE action above (dittoState — copies Moves + Ability + Type
  // only): this is a Passive Ability Action ("transformOnEntry", gated on the "On Battle Start" Trigger
  // — same pattern as Set Weather/Field On Entry) that fires the instant its owner enters battle, via
  // activateEntryAbility() below. It overwrites the owner's own runtime fighter state with a FULL copy
  // of the opponent's — stats, types, moves, ability, and visual sprite/name — while keeping the
  // owner's own current HP. { active } tracks whether this side has already used its one entry-transform
  // this battle (Imposter only ever triggers on entry, and this engine has no switch-in/out mechanic, so
  // it's a permanent one-shot for the fight). BATTLE-ONLY: only ever mutates fighters[side]/ability[side]/
  // hp[side]/maxHp[side]/movePP[side]/moveCooldowns[side] (this battle's own runtime trackers) — the
  // permanent Pokédex/Dex registry entry passed in as `a`/`b` is never touched.
  const imposterState = { a: { active: false }, b: { active: false } };
  function performImposterTransform(side) {
    const otherSide = otherOf(side);
    const ab = ability[side];
    const isTransformAbility = ab && ab.abilityType === "passive" && ab.passive.action === "transformOnEntry"
      && triggerMatches(ab.passive.trigger, "battleStart");
    if (!isTransformAbility) return;
    if (imposterState[side].active) return; // Imposter only ever fires once, on entry
    // Safety Check: refuse if the opponent is already a transformed copy of someone else (Full
    // Transform or a prior Imposter activation) — Imposter never copies a copy. This engine has no
    // Substitute mechanic yet, so that half of the check is a no-op reserved for future support.
    const oppIsTransformed = (dittoState[otherSide] && dittoState[otherSide].active) || imposterState[otherSide].active;
    const oppMoves = (fighters[otherSide].moves || []).filter(m => m.name);
    if (oppIsTransformed || !oppMoves.length) {
      log.push(`${fighters[side].name}'s ${ab.name} failed to activate!`);
      return;
    }
    const selfName = fighters[side].name, oppName = fighters[otherSide].name;
    const keepHp = hp[side];
    const targetAbility = ability[otherSide];
    const abilityCopyable = targetAbility && targetAbility.name && !targetAbility.lockAbility;
    const copiedMoves = oppMoves.map(m => ({ ...m }));
    // Overwrite fighters[side] wholesale with a copy of the opponent's runtime state — stats, types,
    // moves, name, and visual sprite (imageUrl/icon) all come along via the spread; only the moves
    // array gets its own independent clone (mirrors the Move-Swap Runtime Isolation pattern used
    // everywhere else in this engine) so neither side's movepool can bleed into the other's afterward.
    // The copied name gets a "(?)" faker mark appended so every subsequent log line/UI reference to
    // this side reads as the impostor it is, instead of silently looking identical to the real thing.
    fighters[side] = {
      ...fighters[otherSide],
      name: `${oppName} (?)`,
      types: [...(fighters[otherSide].types || [])],
      moves: copiedMoves,
      tags: [...(fighters[otherSide].tags || [])]
    };
    ability[side] = abilityCopyable ? { ...targetAbility } : null;
    maxHp[side] = ((fighters[side].stats && fighters[side].stats.hp) || 50) * 3;
    hp[side] = Math.min(maxHp[side], keepHp); // keeps its own current HP, clamped to the new max
    movePP[side] = {}; moveCooldowns[side] = {};
    copiedMoves.forEach(m => { movePP[side][m.name] = m.maxPP ?? m.pp ?? 15; });
    imposterState[side].active = true;
    log.push(`✨ ${selfName}'s ${ab.name} activated! It transformed into ${oppName}!`);
  }
  // ---- Multi-Turn Charge Execution (Solar Beam / Skull Bash Mechanics): at most one active charge-up
  // per side — { moveName, turnsRemaining, condition, shieldPercent, healPercent }. Forces move-selection
  // to keep re-picking the same move (see chosenMove pre-selection block) until it fires. ----
  const charging = { a: null, b: null };
  // ---- Multi-Turn Charge Execution: while mid-charge under the "Immune to Status" condition, this side
  // cannot have a new status condition inflicted on it ----
  function isChargeStatusImmune(side) {
    return !!(charging[side] && charging[side].condition === "statusImmune");
  }
  // ---- Delayed Attack Events (Future Sight / Doom Desire Mechanic): queued future-landing hits, one
  // entry per in-flight delayed move: { turnsLeft, side (attacker), targetSide, move, snappedAtkStat,
  // snappedAtkStages, ignoreTypeImmunity }. Ticked down in the end-of-round block below. ----
  const delayedAttacks = [];
  // ---- Delayed Effect Queue (Future Sight-style timers, delayed marks, charge-release countdowns):
  // one entry per queued node: { side (owner), targetSide, turnsLeft, payload, ...payload-specific data,
  // ignoreSwitch }. Ticked down / resolved in the end-of-round block below, independent of the legacy
  // single-purpose delayedAttacks queue used by the Delayed Attack move toggle. ----
  const delayedEffectQueue = { a: [], b: [] };
  // ---- Multi-Turn Drain & Burnout: active persistent siphon tethers, one entry per "Multi-Turn Drain &
  // Burnout" effect that has landed: { drainSide (loses the resource), gainSide (receives it, or null),
  // resource, statKey, percent, turnsLeft (null = until switch/faint) }. Processed at end-of-round below. ----
  const persistentDrains = { a: [], b: [] };
  const abilityTriggered = { a: false, b: false }; // "Once Per Battle" boolean flags for active abilities
  const ability = { a: pickBattleAbility(a), b: pickBattleAbility(b) };
  // ---- Blurring Abilities & Moves: fold any Manually Castable Active Ability into its owner's own
  // movepool as a synthetic move for the rest of the battle, so it's picked up by the same PP/cooldown/
  // selection machinery below as a normal move (see abilityToSyntheticMove up top). ----
  ["a", "b"].forEach(s => {
    const ab = ability[s];
    if (ab && ab.manualCast && ab.name) {
      fighters[s] = { ...fighters[s], moves: [...(fighters[s].moves || []), abilityToSyntheticMove(ab)] };
    }
  });
  const movePP = {
    a: Object.fromEntries((fighters.a.moves || []).filter(m => m.name).map(m => [m.name, m.maxPP ?? m.pp ?? 15])),
    b: Object.fromEntries((fighters.b.moves || []).filter(m => m.name).map(m => [m.name, m.maxPP ?? m.pp ?? 15]))
  };
  // ---- Move Cooldowns: turns remaining before a move with cooldownTurns>0 can be selected again ----
  const moveCooldowns = { a: {}, b: {} };
  // ---- Multi-Mega Evolution: checks `side`'s configured Mega profiles against the current turn / just-used
  // move, and if one qualifies, swaps the fighter into it — re-picks its battle ability and tops up PP for
  // any newly-introduced Mega-exclusive move names (carried-over moves keep whatever PP they already have). ----
  function tryMegaEvolve(side, justUsedMoveName) {
    const heldItemId = itemState[side].item ? itemState[side].item.id : null;
    const mg = checkMegaEvolution(side, fighters[side], megaConfig, turn, justUsedMoveName, canAttemptTransform, heldItemId);
    if (!mg) return;
    applyFormTransform(side, mg);
  }
  // ---- Trigger Alternate Form: called by the "triggerForm" effect (on a move or ability). Returns true if the
  // side switched forms. Logs a short message when it cannot (no alt form, already transformed, etc.). ----
  function tryTriggerForm(side, label) {
    const heldItemId = itemState[side].item ? itemState[side].item.id : null;
    if (!canAttemptTransform(side)) {
      log.push(`But ${fighters[side].name} cannot change form right now!`);
      return false;
    }
    const mg = pickTriggeredForm(fighters[side], label, heldItemId);
    if (!mg) {
      log.push(`But ${fighters[side].name} has no alternate form to trigger!`);
      return false;
    }
    applyFormTransform(side, mg);
    return true;
  }
  // ---- Shared swap logic for Mega Evolution checks and Trigger Alternate Form. ----
  function applyFormTransform(side, mg) {
    // ---- Transformation Duration (Rule 1) + Reversion snapshot (Rule 2): capture the exact fighter
    // object as it stood right before transforming, so revertTransformation() can restore it precisely —
    // this is what guarantees every ability/move gained by the Mega form is fully removed on revert. ----
    const st = transformState[side];
    st.preForm = fighters[side];
    fighters[side] = applyMegaEvolution(fighters[side], mg, log);
    st.active = true;
    st.mega = mg;
    // ---- Dynamax-style HP surge: scale max + current HP, keeping the HP ratio; undone in revertTransformation() ----
    if (mg.hpMultiplier > 1 && maxHp[side] > 0) {
      const ratio = hp[side] / maxHp[side];
      st.baseMaxHp = maxHp[side];
      maxHp[side] = Math.round(maxHp[side] * mg.hpMultiplier);
      hp[side] = Math.max(1, Math.round(ratio * maxHp[side]));
      log.push(`${fighters[side].name}'s HP surges to ${hp[side]}/${maxHp[side]}!`);
    }
    // durationLimit 0 = permanent (never auto-reverts); >0 = counts down turns-remaining, ticked at
    // end-of-round below and reverted via revertTransformation() the moment it hits 0.
    st.turnsRemaining = mg.durationLimit > 0 ? mg.durationLimit : null;
    // ---- Mega Evolution Ability Updates: reassign the active battle ability from the new Mega form's
    // kit, announce the swap (so the visible battle state/log reflects the new ability immediately
    // rather than silently changing an internal property), then re-run the same onSwitchIn/onTransform
    // entry-ability pipeline used at battle start — so instant abilities (Drizzle/Drought-style weather
    // setters, Aura Field, etc.) fire the moment the Mega ability takes hold instead of never activating. ----
    ability[side] = pickBattleAbility(fighters[side]);
    log.push(`${fighters[side].name}'s Ability is now ${ability[side] ? ability[side].name : "None"}!`);
    if (!suppressFormEntryAbility) activateEntryAbility(side); // skipped while switching out: it fires on re-entry instead
    (fighters[side].moves || []).forEach(m => { if (m.name && movePP[side][m.name] == null) movePP[side][m.name] = m.maxPP ?? m.pp ?? 15; });
  }
  let suppressFormEntryAbility = false;

  // ================= TERASTALLIZATION CORE =================
  // activateTeraState(side, teraItem) — the requested core function. Validates the "ON_USER_INTENT"
  // manual-activation trigger, changes the holder's typing to the item's teraType, injects the item's
  // Dynamic Move (Tera Blast by default) into its active moveset, and hands back the teraState entry so
  // the STAB pipeline (computeStabMultiplier, wired into the damage formula below) picks it up from here
  // on. Steps map 1:1 onto the four numbered requirements in the spec:
  //   1. validate the ON_USER_INTENT trigger can fire this turn
  //   2. change base typing to the item's designated Tera Type
  //   3. inject the Dynamic Move for the duration of the state (rest of the battle)
  //   4. STAB is recalculated on every hit afterward by computeStabMultiplier(), not here — Terastallize
  //      only needs to record `type`/`originalTypes`/`stellar` for that function to read.
  function activateTeraState(side, teraItem) {
    const st = teraState[side];
    // ---- 1. Validation: already Tera'd this battle, no qualifying item, mid-Mega-transformation, or
    // the item's own effects[] doesn't actually carry an onUserIntent+terastallize row all block it. ----
    if (st.used || st.active) return false;
    if (transformState[side] && transformState[side].active) return false; // can't Tera while Mega'd
    if (!teraItem || !teraItem.teraType || teraItem.teraType === "none") return false;
    const hasIntentEffect = (teraItem.effects || []).some(fx => fx.trigger === "onUserIntent" && fx.action === "terastallize");
    if (!hasIntentEffect) return false;

    const attacker = fighters[side];
    const isStellar = teraItem.teraType === "stellar";
    // ---- 2. Base typing change: Stellar is the one Tera Type that doesn't overwrite the holder's own
    // types (see the doc block above teraState) — every other Tera Type replaces `types` outright. ----
    const originalTypes = [...(attacker.types || [])];
    if (!isStellar) attacker.types = [teraItem.teraType];

    // ---- 3. Dynamic Move Injector: build a live Tera Blast for this holder/type and splice it into
    // this battle's throwaway moves clone only (injectTemporaryMove never touches base/stored data). ----
    const injected = buildTeraBlastMove(teraItem.teraType, attacker, teraItem.teraMove);
    attacker.moves = injectTemporaryMove(attacker, injected);
    if (movePP[side][injected.name] == null) movePP[side][injected.name] = injected.maxPP ?? injected.pp ?? 10;

    st.active = true;
    st.used = true;
    st.type = teraItem.teraType;
    st.originalTypes = originalTypes;
    st.stellar = isStellar;

    log.push(`${attacker.name} Terastallized into the ${cap(teraItem.teraType)} Tera Type!`);
    // ---- Dynamic Move Injector notice: distinct 🪄 marker so the battle log can color this line
    // magenta (see the move-learn-line class), separate from the plain Tera announcement above. ----
    log.push(`🪄 ${attacker.name} learned ${injected.name} from ${teraItem.name}!`);
    return true;
  }
  // ---- Per-turn gate, called the same way/place as tryMegaEvolve: fires the moment it's this side's
  // legal turn to act and it holds a qualifying item — i.e. "the first opportunity the player has to
  // manually activate it" (see the onUserIntent doc note above DEFAULT_ITEMS for why an auto-resolving
  // simulator models manual intent this way). One-shot: activateTeraState() itself enforces st.used. ----
  function tryTerastallize(side) {
    const teraItem = itemState[side].item;
    if (!teraItem || teraItem.teraType === "none" || !itemHasCharge(itemState[side])) return;
    if (activateTeraState(side, teraItem)) useItemCharge(itemState[side]);
  }

  // ---- Turn-Based Duration & Decay: active timed stat modifiers, one entry per applied statmod-with-duration
  // effect: { statKey, amount (the stage delta that was applied), turnsLeft, expireMode, baselineStage
  // (the stage value on that stat right before this modifier was applied — used by "revert") } ----
  const timedStatMods = { a: [], b: [] };
  // ---- "TRADEOFF" Move Matrix: active per-turn HP drains inflicted by a Tradeoff Action's "Drain % HP"
  // consequence, one entry per stack: { dot (flat HP removed from the afflicted side each round),
  // turnsLeft, healSide (which side receives the drained HP back, if still standing) } ----
  const tradeoffDots = { a: [], b: [] };
  let weather = "clear"; // field condition state: clear | sun | rain | sand | snow | polluted | strongwinds
  let weatherTurns = 0;
  // ---- Field Effects: a battlefield-wide state that's separate from Weather (both can be active at
  // once). Starts from whatever the Battle Simulator's Field Effect dropdown says (lasting effectively
  // the whole battle — see fieldTurns below), and from then on can be changed by any Move's "Set Field
  // Effect" effect/toggle or any Ability's "Set Field Effect" action, exactly the way Weather works. ----
  let fieldEffect = FIELD_STATES.some(f => f[0] === (fieldConfig && fieldConfig.field)) ? fieldConfig.field : "none";
  // ---- A field picked from the Battle Simulator's own dropdown is meant to hold for the whole fight,
  // so it starts with an effectively-unlimited timer — comfortably longer than the ~40-round battle cap.
  // A field set mid-battle by a Move/Ability below overwrites this with its own configured duration. ----
  let fieldTurns = fieldEffect !== "none" ? 999 : 0;
  // ---- Field Lock: true when an Ability set the current Field Effect with "Can Be Overridden By a
  // Move" switched OFF — while locked, a Move's own "Set Field Effect" fails instead of changing it ----
  let fieldLocked = false;
  const GRASSY_FIELD_STAT_MULT = 1.2;
  const GRASSY_FIELD_HEAL_PERCENT = 0.05;
  // ---- Flood: Water types run 1.5x hot on Speed (which also makes them meaningfully harder to hit,
  // since Speed feeds directly into the Dodge calculation below); every OTHER type is slowed to the
  // inverse (1/1.5 ≈ 0.667x); Fire-type MOVES are weakened 0.5x regardless of the attacker's own type
  // (mirrors how Sun/Rain weaken/boost by move type, not by the user's type); and Flying types are fully
  // immune to Flood's stat effects either way (neither sped up nor slowed down). ----
  const FLOOD_WATER_SPEED_MULT = 1.5;
  const FLOOD_OTHER_SPEED_MULT = 1 / 1.5;
  const FLOOD_FIRE_MOVE_WEAKEN_MULT = 0.5;
  // ---- Misty Terrain: halves incoming Dragon-type move damage for GROUNDED targets only (see
  // isGrounded()) — Flying-types and "levitating"-tagged Pokémon aren't affected by the terrain at all. ----
  const MISTY_DRAGON_MOVE_WEAKEN_MULT = 0.5;
  // ---- Electric Terrain: boosts Electric-type move power; grounded targets (see isGrounded()) can't be
  // put to Sleep while it's active; Steel-type targets are auto-hit by Electric moves (accuracy/dodge
  // gate is skipped entirely for them, same treatment as an "unavoidable"-tagged move). ----
  const ELECTRIC_TERRAIN_MOVE_BOOST_MULT = 1.3;
  // ---- Psychic Terrain: boosts Psychic-type move power; blocks ANY move with priority > 0 from landing
  // on a grounded target (see isGrounded()) — checked before the move is even allowed to act. ----
  const PSYCHIC_TERRAIN_MOVE_BOOST_MULT = 1.3;
  // ---- Poisonous Terrain: halves Defense AND Sp. Def for every non-Poison GROUNDED unit (see
  // isGrounded()) while active; Steel types also lose their built-in Poison/Bad Poison immunity for as
  // long as it's active (handled in isStatusImmune()). ----
  const POISONOUS_TERRAIN_DEFENSE_WEAKEN_MULT = 0.5;
  // ---- Grassy Field's stat boost (used for Atk/Def/SpA/SpD/Spe alike). Flood does NOT touch Atk/Def at
  // all, so this correctly no-ops (returns 1) whenever fieldEffect is "flood" or "none". ----
  function fieldStatMult(who) {
    return (fieldEffect === "grassy" && fighters[who].types.includes("grass")) ? GRASSY_FIELD_STAT_MULT : 1;
  }
  // ---- Speed-specific field multiplier: this is the ONE place both Grassy Field's Speed boost and
  // Flood's Speed boost/slow/immunity are computed, so it's used everywhere raw Speed is read for combat
  // purposes (the Dodge calculation's effective Speed, and turn order below) — meaning Flood's "faster
  // AND dodges more" is genuinely the same mechanism, not two separately-tuned numbers. ----
  function floodTypeSpeedFactor(types) {
    if (fieldEffect !== "flood") return 1;
    if (types.includes("flying")) return 1; // Flying is fully immune to Flood
    return types.includes("water") ? FLOOD_WATER_SPEED_MULT : FLOOD_OTHER_SPEED_MULT;
  }
  // ---- Chlorophyll / Swift Swim / Sand Rush / Slush Rush / Surge Surfer: ability Speed multiplier while a weather (or terrain) is up ----
  function abilitySpeedMult(who) {
    const ab = ability[who];
    if (!ab || ab.abilityType !== "passive" || ab.passive.action !== "weatherSpeedMult") return 1;
    const p = ab.passive;
    const on = p.speedFieldCondition !== "none" ? fieldEffect === p.speedFieldCondition : (weather !== "clear" && weather === p.weatherCondition);
    return on ? (p.speedMultiplier || 2) : 1;
  }
  function fieldSpeedMult(who) {
    const base = (fieldEffect === "grassy") ? fieldStatMult(who) : floodTypeSpeedFactor(fighters[who].types);
    return base * abilitySpeedMult(who);
  }
  // ---- Weather Lock: true when an Ability set the current weather with "Can Be Overridden By a Move"
  // switched OFF — while locked, a Move's own "Set Weather" effect fails instead of changing the field ----
  let weatherLocked = false;
  // ---- Polluted Weather: turn-end % chance to Poison, carried over from whichever rule set the weather ----
  let pollutedPoisonChance = 15;
  // ---- Shared "Set Weather" resolver: used by a Status move's "Set Weather" Effect action AND by a
  // damaging move's independent "Also Sets Weather When It Hits" toggle, so both paths get identical
  // Weather Lock handling / duration / Polluted poison-chance carry-over / log wording. ----
  function applyMoveWeatherSet(move, attacker, log) {
    if (weatherLocked) {
      log.push(`${attacker.name} used ${move.name}, but the weather wouldn't budge!`);
      return;
    }
    weather = move.weather || "clear";
    weatherTurns = Math.max(1, Math.round(move.weatherDuration || 5));
    if (weather === "polluted") pollutedPoisonChance = move.pollutedPoisonChance;
    const label = WEATHER_STATES.find(w => w[0] === weather);
    log.push(`${attacker.name} used ${move.name}! The weather turns ${label ? label[1] : weather}!`);
  }
  // ---- Shared "Set Field Effect" resolver — identical shape/behavior to applyMoveWeatherSet above, just
  // targeting the independent Field Effect state instead of Weather. ----
  function applyMoveFieldSet(move, attacker, log) {
    if (fieldLocked) {
      log.push(`${attacker.name} used ${move.name}, but the field wouldn't budge!`);
      return;
    }
    fieldEffect = move.field || "none";
    fieldTurns = Math.max(1, Math.round(move.fieldDuration || 5));
    const label = FIELD_STATES.find(f => f[0] === fieldEffect);
    log.push(`${attacker.name} used ${move.name}! The field turns into ${label ? label[1] : fieldEffect}!`);
  }
  // ---- Dynamic Weight Modifier: each side's temporary in-battle weight, starts at the registry value and
  // can be nudged by a "Modify Weight by [Value]" effect node for the rest of the battle ----
  const tempWeight = { a: Number(a.weight) || 1, b: Number(b.weight) || 1 };
  // ---- Accuracy Modifier (Sand Attack-style) Runtime State: a multiplier on EACH side's own accuracy
  // for the rest of the battle (1 = normal/unmodified). Set by the "accuracyMod" Dynamic Effect below —
  // read directly into both accuracy-roll formulas in the turn loop, the same way tempWeight feeds
  // weightMultiplier(). BATTLE-ONLY: reset fresh every simulateOneBattle call, never persisted. ----
  const tempAccuracyMult = { a: 1, b: 1 };
  // ---- Move Miss Tracker: did this side's PREVIOUS move miss? Read by the "lastMoveMissed" Active
  // Condition (Stomping Tantrum-style) BEFORE it's updated for the current turn's outcome. ----
  const lastMoveMissed = { a: false, b: false };
  // ---- Battle History & Damage Scaling: per-side trackers feeding historyScalingMultiplier() ----
  const moveStreak = { a: { name: null, count: 0 }, b: { name: null, count: 0 } }; // consecutive-use counter (Fury Cutter-style)
  const moveHitTotals = { a: {}, b: {} }; // total times each named move has landed a hit this battle (Echoed Voice-style)
  const totalDamageTaken = { a: 0, b: 0 }; // cumulative move damage received this match (Revenge-style)
  let auraField = null; // { side, type, percent, target } — set by an Aura Field ability at battleStart
  const wetFlag = { a: false, b: false }; // ---- Advanced Status Matrix: Rain (type-immunity checked) OR a direct "wet" status apply this ----
  // ---- Forced Action Status ("Repeat") + Dynamic PP Cost ("Last Used Move" target): name of the move
  // each side last actually executed. null until a side has acted at least once. ----
  // ---- Random Move Transmutation (Metronome/Mirror Move-style): when true for a side, that side's next
  // move selection is replaced with a fully random pick from its movepool, bypassing normal AI logic ----
  const forcedRandomMove = { a: false, b: false };
  const lastUsedMove = { a: null, b: null };
  const log = [...preLog, teamMode
    ? `Team A (${teamOpts.a.map(e => e.name).join(", ")}) faces Team B (${teamOpts.b.map(e => e.name).join(", ")})!`
    : `${a.name} and ${b.name} face off!`];
  if (fieldEffect === "grassy") log.push(`The battlefield is blanketed in thick grass!`);
  else if (fieldEffect === "flood") log.push(`The battlefield is flooded with rushing water!`);
  else if (fieldEffect === "misty") log.push(`🌫️ Misty Terrain swirls across the battlefield!`);
  else if (fieldEffect === "electric") log.push(`⚡ Electric Terrain crackles across the battlefield!`);
  else if (fieldEffect === "psychic") log.push(`🔮 Psychic Terrain warps the battlefield!`);
  else if (fieldEffect === "poisonous") log.push(`☠️ Poisonous Terrain seeps across the battlefield!`);
  if (ability.a) log.push(`${a.name} is using its ability: ${ability.a.name}.`);
  if (ability.b) log.push(`${b.name} is using its ability: ${ability.b.name}.`);

  function otherOf(side) { return side === "a" ? "b" : "a"; }
  // ---- Extended Shield Vulnerabilities: does `move`'s own tags list contain any tag this shield is
  // configured to be vulnerable to? Case-insensitive, mirrors the existing tagRules/tagDamageMult
  // matching convention used elsewhere in the engine. ----
  function moveHasVulnerableTag(shield, move) {
    if (!shield.vulnerableToTags || !shield.vulnerableToTags.length) return false;
    const moveTagsLower = (move.tags || []).map(t => String(t).toLowerCase());
    return shield.vulnerableToTags.some(vt => moveTagsLower.includes(String(vt).toLowerCase()));
  }
  // ---- Customizable Hit-Count Attack Shields: finds the first active shield stack on `side` that
  // matches the incoming move's category (Trigger Type) and type (Type Filter). Returns null if no
  // shield stack currently qualifies to intercept this hit. ----
  function findBlockingShield(side, move) {
    const list = shields[side];
    for (let i = 0; i < list.length; i++) {
      const sh = list[i];
      if (sh.hitsLeft <= 0) continue;
      const categoryOk = sh.triggerType === "any"
        || (sh.triggerType === "physical" && move.category === "Physical")
        || (sh.triggerType === "special" && move.category === "Special");
      const typeOk = sh.typeFilter === "any" || sh.typeFilter === move.type;
      if (!categoryOk || !typeOk) continue;
      // ---- Extended Shield Vulnerabilities: a "Direct Bypassing" outcome means a tagged hit skips
      // this shield stack entirely (same effect as the move ignoring shields), so damage lands normally. ----
      if (sh.vulnerableTagOutcome === "bypass" && moveHasVulnerableTag(sh, move)) continue;
      return sh;
    }
    return null;
  }

  // ---- Breakable Stat-Specific & Weakness-Specific Attack Shields: called whenever a qualifying shield
  // intercepts a hit. A move whose type matches the shield's configured Element Weakness shatters it
  // instantly regardless of remaining hit capacity; otherwise a matching Vulnerable Tag applies its
  // configured outcome (Bonus Depletion / Shatter / Damage Multiplier); otherwise the attacker's ability
  // may carry a "Damage Multiplier against Shields" that multiplies how much hit capacity this hit removes. ----
  function applyShieldHit(blockingShield, attackerSide, move, log, defenderName) {
    const weaknessBreak = blockingShield.weaknessType && blockingShield.weaknessType !== "none" && blockingShield.weaknessType === move.type;
    const tagVulnerable = !weaknessBreak && moveHasVulnerableTag(blockingShield, move);
    let hitCost = 1;
    if (weaknessBreak) {
      hitCost = blockingShield.capacity;
    } else if (tagVulnerable && blockingShield.vulnerableTagOutcome === "shatter") {
      hitCost = blockingShield.capacity;
    } else if (tagVulnerable && blockingShield.vulnerableTagOutcome === "bonusDeplete") {
      hitCost = 1 + Math.max(0, Math.round(blockingShield.vulnerableTagBonusHits || 0));
    } else if (tagVulnerable && blockingShield.vulnerableTagOutcome === "damageMult") {
      hitCost = Math.max(1, Math.round(hitCost * (blockingShield.vulnerableTagMultiplier || 1)));
    } else {
      const breakerAbility = ability[attackerSide];
      if (breakerAbility && breakerAbility.shieldBreakerMultiplier != null && breakerAbility.shieldBreakerMultiplier !== 1) {
        hitCost = Math.max(1, Math.round(hitCost * breakerAbility.shieldBreakerMultiplier));
      }
    }
    blockingShield.hitsLeft -= hitCost;
    if (weaknessBreak) {
      log.push(`It's a shattering weakness! ${defenderName}'s shield breaks instantly against the ${cap(move.type)}-type hit!`);
    } else if (tagVulnerable && blockingShield.vulnerableTagOutcome === "shatter") {
      log.push(`${defenderName}'s shield shatters instantly against the tagged hit!`);
    } else if (tagVulnerable && blockingShield.vulnerableTagOutcome === "bonusDeplete") {
      log.push(`${defenderName}'s shield takes extra strain from the tagged hit!`);
    } else if (tagVulnerable && blockingShield.vulnerableTagOutcome === "damageMult") {
      log.push(`${defenderName}'s shield is battered harder by the tagged hit!`);
    }
  }

  // ---- Delayed Attack Events (Future Sight / Doom Desire Mechanic): executes one queued delayed hit
  // once its counter reaches 0. Rebuilds a damage number using either the snapshot taken at launch time
  // or a fresh recalculation against the target's CURRENT stats/stages, applies the configured Type
  // Immunity Bypass, then runs the hit back through Type Immunity Abilities and the Hit-Count Attack
  // Shield check exactly like a normal direct hit would. ----
  function resolveDelayedAttack(entry) {
    const { side, targetSide, move, attackerName } = entry;
    const attacker = fighters[side], defender = fighters[targetSide];
    if (hp[targetSide] <= 0) {
      log.push(`${attackerName}'s delayed ${move.name} fizzles out — there's no target left!`);
      return;
    }
    const atkKey = move.atkStatBasis && move.atkStatBasis !== "auto" ? move.atkStatBasis
      : (move.category === "Special" ? "spa" : "atk");
    const defKey = move.defStatBasis && move.defStatBasis !== "auto" ? move.defStatBasis
      : (move.category === "Special" ? "spd" : "def");
    // ---- Stat Calculation Snap: "launch" reuses the frozen number captured when the move was used;
    // "landing" (snappedAtkStat===null) recalculates the attacker's offensive stat fresh, against its
    // CURRENT stage — so a stat change after launch but before landing actually matters. ----
    const atkStat = entry.snappedAtkStat != null
      ? entry.snappedAtkStat
      : ((attacker.stats && attacker.stats[atkKey]) || 50) * stageMult(stages[side][atkKey]) * fieldStatMult(side);
    let defStat = (defender.stats && defender.stats[defKey]) || 50;
    if (!move.ignoreDefense) defStat *= stageMult(stages[targetSide][defKey]);
    defStat *= fieldStatMult(targetSide);
    // ---- Poisonous Terrain: halves Defense/Sp. Def for every non-Poison GROUNDED defender (see isGrounded()) ----
    if (fieldEffect === "poisonous" && !defender.types.includes("poison") && isGrounded(defender)) {
      defStat *= POISONOUS_TERRAIN_DEFENSE_WEAKEN_MULT;
    }
    let mult = typeMultiplier(move.type, defender.types);
    // ---- Type Immunity Bypass: forces an outright Type Immunity (0x) up to neutral (1x) on landing.
    // Resistances/weaknesses elsewhere on the type chart are left untouched — this only strips full
    // immunity, matching the "Ignore Type Immunities When Landing" checkbox's stated scope. ----
    if (entry.ignoreTypeImmunity && mult === 0) mult = 1;
    // ---- Tag Matchups: applies no matter what ability the defender has, same as a direct hit; not
    // affected by the Type Immunity Bypass above since it's a wholly separate baked-in property. ----
    mult *= tagMatchupMultiplier(defender, move.tags);
    // ---- Effectiveness vs Pokémon Tags: mirror-image direction — checks the DEFENDER's own
    // Pokémon Tags against this move's vsTags rules, independent of move.tags/Type Chart above ----
    mult *= moveVsCreatureTagMultiplier(move, defender);
    // ---- Wonder Guard applies to a landing delayed hit too (Future Sight/Doom Desire-style) ----
    const defWonderGuardAbilityDelayed = ability[targetSide];
    if (defWonderGuardAbilityDelayed && defWonderGuardAbilityDelayed.abilityType === "passive" && defWonderGuardAbilityDelayed.passive.action === "wonderGuard" && mult > 0 && mult < 2) {
      mult = 0;
    }
    if (mult === 0) {
      log.push(`${attackerName}'s delayed ${move.name} strikes, but it has no effect on ${defender.name}!`);
      if (entry.effectTiming === "resolve") runEffectsFrom(move, move.effects, side, secondaryChanceMultiplierFor(side, move.tags));
      return;
    }
    const critChance = move.critRateMode === "always" ? 1 : (move.critRateMode === "high" ? 0.25 : 0.08);
    const crit = Math.random() < critChance ? 1.5 : 1;
    const variance = 0.85 + Math.random() * 0.3;
    const bpScale = Math.max(0.2, (move.basePower || 60) / 60);
    const ctx = { dmg: Math.max(1, Math.round((atkStat / Math.max(20, defStat)) * 26 * mult * crit * variance * bpScale)), hasDamage: true, moveType: move.type, moveTags: move.tags || [], moveCategory: move.category };
    // ---- Type Damage Immunity Abilities still apply on landing, UNLESS this move's own Type Immunity
    // Bypass is enabled (mirrors the type-chart bypass above) ----
    const immunityAbility = ability[targetSide];
    if (immunityAbility && immunityAbility.immuneToType && immunityAbility.immuneToType !== "none"
      && immunityAbility.immuneToType === move.type && !entry.ignoreTypeImmunity) {
      ctx.dmg = 0;
      log.push(`${defender.name}'s ${immunityAbility.name} grants full immunity to ${cap(move.type)}-type moves!`);
    }
    // ---- Customizable Hit-Count Attack Shields: a delayed hit is still a direct hit, so it's checked
    // against the target's active shields exactly like an ordinary attack ----
    const blockingShield = findBlockingShield(targetSide, move);
    let delayedShieldBlocked = false;
    if (blockingShield && (blockingShield.unignorable || !move.ignoreShields)) {
      ctx.dmg = 0;
      delayedShieldBlocked = true;
      applyShieldHit(blockingShield, side, move, log, defender.name);
      // ---- Shield Interruption Log Override: suppress the standard "strikes from out of nowhere
      // (dmg)" result line below when the shield fully absorbed it — this block line stands alone. ----
      log.push(`${defender.name}'s shield blocked the hit! (${Math.max(0, blockingShield.hitsLeft)}/${blockingShield.capacity} hits left)`);
      if (blockingShield.hitsLeft <= 0) {
        shields[targetSide] = shields[targetSide].filter(s => s !== blockingShield);
        log.push(`${defender.name}'s shield shatters!`);
      }
    } else if (blockingShield && move.ignoreShields) {
      log.push(`${attackerName}'s delayed ${move.name} tears straight through ${defender.name}'s shield!`);
    }
    const finalDmg = Math.max(0, ctx.dmg);
    hp[targetSide] = Math.max(0, hp[targetSide] - finalDmg);
    if (finalDmg > 0) totalDamageTaken[targetSide] += finalDmg;
    if (!delayedShieldBlocked) {
      log.push(`${attackerName}'s ${move.name} strikes ${defender.name} from out of nowhere! (${finalDmg} dmg)`);
    }
    // ---- Secondary Effect Timing: "With Resolve" moves held their Additional Effects list back until
    // right now — fire it after the damage log line, same ordering a normal hit uses (damage, then effects).
    // Skipped if a shield fully absorbed this delayed hit — same "no secondary effects off a blocked hit"
    // rule as a direct attack. ----
    if (entry.effectTiming === "resolve" && !delayedShieldBlocked) {
      runEffectsFrom(move, move.effects, side, secondaryChanceMultiplierFor(side, move.tags));
    }
  }
  // ---- Delayed Effect Queue resolver: fires whichever payload a queued node was carrying once its
  // countdown (or linked charge-release) reaches 0. Mirrors resolveDelayedAttack's target-gone check,
  // but honors the "Ignore Switch" flag so a Doom Desire-style node can still land on an empty slot. ----
  function resolveDelayedEffect(entry) {
    const owner = fighters[entry.side];
    const target = fighters[entry.targetSide];
    if (hp[entry.targetSide] <= 0 && !entry.ignoreSwitch) {
      log.push(`${owner.name}'s delayed effect fizzles out — there's no target left!`);
      return;
    }
    if (entry.payload === "damage") {
      const dmg = Math.max(1, Math.round(maxHp[entry.targetSide] * (entry.damagePct / 100)));
      hp[entry.targetSide] = Math.max(0, hp[entry.targetSide] - dmg);
      totalDamageTaken[entry.targetSide] += dmg;
      log.push(`${owner.name}'s delayed effect strikes ${target.name} from out of nowhere! (${dmg} dmg)`);
    } else if (entry.payload === "statusMark") {
      if (hp[entry.targetSide] > 0 && !status[entry.targetSide] && !itemBlocksStatus(entry.targetSide, entry.statusEffect) && !isStatusImmune(target.types, entry.statusEffect, null, target.tags, fieldEffect)) {
        status[entry.targetSide] = { kind: entry.statusEffect, counter: 1, turnsLeft: 3 + pollutedDurationBonus(entry.statusEffect), mirrorReflectPercent: 0 };
        log.push(`${owner.name}'s delayed mark resolves — ${target.name} is afflicted with ${entry.statusEffect}!`);
      }
    } else if (entry.payload === "statChange") {
      if (hp[entry.targetSide] > 0) {
        applyStatModTarget(stages, entry.side, entry.targetSide, entry.side === entry.targetSide ? "self" : "opponent", entry.statKey, contraryAdjustedStage(entry.targetSide, entry.statStage), owner.name, target.name, log);
      }
    } else if (entry.payload === "heal") {
      if (hp[entry.targetSide] > 0) {
        applyHealTarget(hp, maxHp, entry.targetSide, entry.side, "self", "percent", entry.healPct, "effect", owner.name, fighters, log);
      }
    }
  }
  // ---- Modular Custom Entry Hazard Builder: onSwitchIn hook. This simulator runs a single fighter per
  // side for the whole battle rather than a full roster (see the legacy Stealth Rock/Spikes chip-damage
  // note further below), so there is no repeated "a new Pokémon walks onto a hazard-laden field" event
  // to hang a real switch-in trigger off of. This hook is invoked the instant a custom hazard lands on
  // `side`'s field — the one moment in a 1v1 encounter that's functionally equivalent to an entrant
  // meeting the hazard for the first time — and stays ready to be re-invoked per-entrant unchanged the
  // moment this simulator grows multi-Pokémon roster/switching support. ----
  function runHazardEntryEffects(side, hz) {
    if (hp[side] <= 0) return;
    if (itemBlocksHazard(side)) return;
    const entrant = fighters[side];
    // ---- Entry Damage: Flat HP, % of Max HP, or Stealth Rock-style Type-Scaled (base % of Max HP
    // multiplied by the hazard's configured element's effectiveness against the entrant's own types) ----
    if (hz.dmgMode !== "none") {
      const stackMult = hz.stacking ? hz.stacks : 1;
      let dmg = 0;
      if (hz.dmgMode === "flat") dmg = hz.dmgValue * stackMult;
      else if (hz.dmgMode === "maxhppct") dmg = maxHp[side] * (hz.dmgValue / 100) * stackMult;
      else if (hz.dmgMode === "typescaled") dmg = maxHp[side] * (hz.dmgValue / 100) * typeMultiplier(hz.dmgType, entrant.types);
      dmg = Math.max(0, Math.round(dmg));
      if (dmg > 0) {
        hp[side] = Math.max(0, hp[side] - dmg);
        totalDamageTaken[side] += dmg;
        log.push(`${entrant.name} is hurt by ${hz.name}! (${dmg} dmg)`);
      }
    }
    if (hp[side] <= 0) return;
    // ---- Entry Status: applies a specific status condition on arrival, gated by its own chance roll
    // and the entrant's existing status-immunity/occupied-status checks ----
    if (hz.statusEffect !== "none" && !status[side] && chanceHits(hz.statusChance) && !itemBlocksStatus(side, hz.statusEffect) && !isStatusImmune(entrant.types, hz.statusEffect, null, entrant.tags, fieldEffect)) {
      status[side] = { kind: hz.statusEffect, counter: 1, turnsLeft: 3 + Math.floor(Math.random() * 3) + pollutedDurationBonus(hz.statusEffect), mirrorReflectPercent: 0 };
      log.push(`${entrant.name} is afflicted with ${hz.statusEffect} by ${hz.name}!`);
    }
    // ---- Entry Stat Debuff: e.g. Sticky Web-style Speed drop on arrival ----
    if (hz.statStage !== 0 && statModAllowed(side, hz.statStage)) {
      applyStatModTarget(stages, side, otherOf(side), "self", hz.statKey, contraryAdjustedStage(side, hz.statStage), entrant.name, "", log);
    }
  }
  function rollStatusDuration(move) {
    if (move.statusDurationMode === "fixed") return Math.max(1, Math.round(move.statusDurationFixed || 5));
    const lo = Math.max(1, Math.round(move.statusDurationMin || 1));
    const hi = Math.max(lo, Math.round(move.statusDurationMax || 3));
    return lo + Math.floor(Math.random() * (hi - lo + 1));
  }

  // ---- Pokémon Weight Impact: gives the registry `weight` field a functional battle role. Reads from
  // tempWeight (the live, possibly Dynamic-Weight-Modifier-adjusted value) rather than the raw registry
  // stat, so a "Modify Weight by [Value]" effect actually changes crushHeavy/leverageLight outcomes. ----
  function weightMultiplier(move, side, otherSide) {
    if (!move.weightScaling || move.weightScaling === "none") return 1;
    const wAtk = tempWeight[side] || 1, wDef = tempWeight[otherSide] || 1;
    const ratio = wDef / Math.max(0.1, wAtk);
    if (move.weightScaling === "crushHeavy") return Math.max(0.5, Math.min(2, ratio));       // heavier target -> more dmg
    if (move.weightScaling === "leverageLight") return Math.max(0.5, Math.min(2, 1 / Math.max(0.1, ratio))); // lighter target -> more dmg
    return 1;
  }

  // ---- Battle History & Damage Scaling: computes the extra damage multiplier for a move whose power
  // scales off live turn-by-turn history state instead of a fixed Base Power. Soft-capped at 8x so an
  // unbounded streak (or a very long battle) can't produce an absurd/overflowing number. ----
  function historyScalingMultiplier(move, side) {
    if (!move.historyScaling || move.historyScaling === "none") return 1;
    const step = (move.historyScalingStepPct || 0) / 100;
    let mult = 1;
    if (move.historyScaling === "consecutiveUse") {
      // moveStreak[side].count is 1 on the first use of a streak, 2 on the second consecutive use, etc.
      // -> 0 extra stacks on first use, matching Fury Cutter's "first hit is base power" behavior.
      const stacks = moveStreak[side].name === move.name ? Math.max(0, moveStreak[side].count - 1) : 0;
      mult = 1 + stacks * step;
    } else if (move.historyScaling === "totalHits") {
      const landed = moveHitTotals[side][move.name] || 0;
      mult = 1 + landed * step;
    } else if (move.historyScaling === "damageTaken") {
      const dmgRatio = totalDamageTaken[side] / Math.max(1, maxHp[side]);
      mult = 1 + dmgRatio * step;
    }
    return Math.max(1, Math.min(8, mult));
  }

  // ---- Polluted Weather: if a fighter becomes Poisoned or Badly Poisoned WHILE Polluted weather is
  // active, its duration tracking counter gets +1 extra turn. ----
  function pollutedDurationBonus(statusKind) {
    return (weather === "polluted" && (statusKind === "poison" || statusKind === "badlyPoisoned")) ? 1 : 0;
  }

  // ---- Ability Stat Mod Blockers: does `side`'s active ability allow an incoming stat-stage change of
  // the given sign to land? Checked before any stat-stage effect (move OR ability) is actually applied. ----
  function statModAllowed(side, statStage) {
    const ab = ability[side];
    if (!ab || !ab.negateStatMod || ab.negateStatMod === "none") return true;
    if (ab.negateStatMod === "blockAll") return false;
    if (ab.negateStatMod === "blockDebuffs" && statStage < 0) return false;
    if (ab.negateStatMod === "blockBuffs" && statStage > 0) return false;
    return true;
  }
  // ---- Contrary: flips the sign of a stat-stage change landing on `side`, regardless of what caused it
  // (the owner's own move, an opponent's move, a hazard, anything) — a drop becomes a rise and vice versa.
  // Call this on EVERY stat change right before applying it, not in statModAllowed() above, since Contrary
  // doesn't block anything, it redirects it. ----
  function contraryAdjustedStage(side, statStage) {
    const ab = ability[side];
    return (ab && ab.negateStatMod === "contrary") ? -statStage : statStage;
  }
  // ---- Slow Start: returns the live multiplier for `side`'s given stat key — the configured weakening
  // multiplier while the battle is still within the first N turns AND that stat is one of the ones this
  // ability targets, 1 (no change) otherwise. Checked live against the round counter rather than tracked
  // as a timed effect, so it always self-corrects the instant turn > slowStartTurns. ----
  function slowStartMult(side, statKey) {
    const ab = ability[side];
    if (!ab || isAbilityNullified(side) || ab.abilityType !== "passive" || ab.passive.action !== "slowStart") return 1;
    if (turn > ab.passive.slowStartTurns) return 1;
    if (!ab.passive.slowStartKeys.includes(statKey)) return 1;
    return ab.passive.slowStartMultiplier;
  }
  // ---- Stat Comparison Trigger: resolves a live (stage-adjusted) stat value for the WHO/STAT pair used
  // by the Advanced Rule Matrix's optional comparison gate ----
  function getComparableStatValue(ownerSide, otherSide, who, statKey) {
    const target = who === "opponent" ? otherSide : ownerSide;
    const base = (fighters[target].stats && fighters[target].stats[statKey]) || 50;
    return base * stageMult(stages[target][statKey]);
  }

  // ---- WHO / WHAT / WHEN / HOW advanced rule matrix executor ----
  function resolveMatrixTargets(who, side, otherSide) {
    if (who === "enemy") return [otherSide];
    if (who === "field") return [side, otherSide];
    return [side]; // self / ally (ally resolves to self in a 1v1 duel)
  }
  function runMatrixEffects(effects, side, when, extra) {
    if (!effects || !effects.length || !when) return;
    const otherSide = otherOf(side);
    effects.forEach(fx => {
      if (fx.type !== "matrix" || fx.when !== when) return;
      if (!chanceHits(fx.chance)) return;
      if (when === "onHpThreshold" && !(hp[side] > 0 && (hp[side] / maxHp[side]) * 100 <= fx.matrixThresholdPct)) return;
      if (when === "onStatusActive" && !(status[side] && status[side].kind === fx.matrixStatusFilter)) return;
      if (fx.what === "typeDamageMult" && extra && extra.moveType !== fx.matrixTypeFilter) return;
      // ---- WHEN: When Hit By a Specific Type / When Hitting With a Specific Type — both reuse the same
      // Type filter field as typeDamageMult ----
      if ((when === "onHitByType" || when === "onDealByType") && !(extra && extra.moveType === fx.matrixTypeFilter)) return;
      // ---- Stat Comparison Trigger: "If [Self/Opponent] [Stat] is [Higher/Lower/Equal] than
      // [Self/Opponent] [Stat]" — an optional additional gate checked before the action runs ----
      if (fx.compareEnabled) {
        const valA = getComparableStatValue(side, otherSide, fx.compareWhoA, fx.compareStatA);
        const valB = getComparableStatValue(side, otherSide, fx.compareWhoB, fx.compareStatB);
        const passes = fx.compareOp === "higher" ? valA > valB : fx.compareOp === "lower" ? valA < valB : valA === valB;
        if (!passes) return;
      }
      const targets = resolveMatrixTargets(fx.who, side, otherSide);
      if (fx.what === "statChange") {
        // ---- Ability Stat Mod Blockers: skip any target whose active ability blocks this category ----
        targets.filter(t => statModAllowed(t, fx.matrixMagnitude)).forEach(t => {
          stages[t][fx.matrixStatKey] = Math.max(-6, Math.min(6, (stages[t][fx.matrixStatKey] || 0) + fx.matrixMagnitude));
          log.push(`${fighters[t].name}'s ${fx.matrixStatKey.toUpperCase()} ${fx.matrixMagnitude > 0 ? "rose" : "fell"} (matrix rule)!`);
        });
      } else if (fx.what === "typeDamageMult" && extra && extra.bonusDmg) {
        extra.bonusDmg(fx.matrixMagnitude);
      } else if (fx.what === "negateStatus") {
        targets.forEach(t => {
          if (status[t] && status[t].kind === fx.matrixStatusFilter) {
            status[t] = null;
            log.push(`${fighters[t].name}'s ${fx.matrixStatusFilter} is cured by a matrix rule!`);
          }
        });
      } else if (fx.what === "weightMultiplier" && extra && extra.bonusDmg) {
        extra.bonusDmg(fx.matrixMagnitude);
      } else if (fx.what === "drainLife" && extra && extra.dmgDealt != null) {
        const pct = fx.matrixMagnitude > 1 ? fx.matrixMagnitude / 100 : fx.matrixMagnitude;
        const healAmt = Math.max(1, Math.round(extra.dmgDealt * pct));
        hp[side] = Math.min(maxHp[side], hp[side] + healAmt);
        log.push(`${fighters[side].name} drains life via a matrix rule! (+${healAmt} HP)`);
      }
    });
  }

  // ---- Serene Grace: computes the live secondary-effect chance multiplier granted by `side`'s ability
  // against a move carrying `moveTags`, or 1 if no such ability is active or the tag scope doesn't match. ----
  function secondaryChanceMultiplierFor(side, moveTags) {
    const ab = ability[side];
    if (!ab || ab.abilityType !== "passive" || ab.passive.action !== "secondaryChanceMult") return 1;
    const scope = String(ab.passive.secondaryChanceScope || "any").trim().toLowerCase();
    if (scope && scope !== "any" && !(moveTags || []).some(t => String(t).toLowerCase() === scope)) return 1;
    return ab.passive.secondaryChanceMultiplier || 1;
  }

  // ---- Dynamic Multi-Effect Sequence Array executor: shared by Moves (on use) and Abilities (on trigger).
  // `chanceMult` (default 1) scales every node's Effect Chance roll — used to apply Serene Grace-style
  // multipliers to a MOVE's own effects list without touching Ability-triggered effect lists. ----
  const SUB_BLOCKED_FX = new Set(["statmod", "status", "persistentDrain", "weightmod", "ppcost", "randomizemove", "accuracyMod", "statusTransfer", "lift", "doom", "rootDown", "addType"]);
  function runEffectsArray(effects, side, chanceMult) {
    if (!effects || !effects.length) return;
    chanceMult = chanceMult || 1;
    const otherSide = otherOf(side);
    const who = fighters[side].name, otherWho = fighters[otherSide].name;
    let subBlockLogged = false;
    effects.forEach(fx => {
      if (!chanceHits(fx.chance * chanceMult)) return;
      // ---- Substitute: harmful effects aimed at the opponent are blocked while its decoy stands. ----
      if (SUB_BLOCKED_FX.has(fx.type) && fx.target === "opponent" && substitute[otherSide] && substitute[otherSide].hp > 0) {
        if (!subBlockLogged) { log.push(`${otherWho}'s substitute blocked ${currentSourceName || "the effect"}!`); subBlockLogged = true; }
        return;
      }
      if (fx.type === "hazard") {
        const targets = fx.target === "both" ? [side, otherSide] : [fx.target === "self" ? side : otherSide];
        targets.forEach(t => {
          if (fx.hazardType === "spikes") hazards[t].spikesStacks = Math.min(3, hazards[t].spikesStacks + 1);
          else hazards[t].stealthrock = true;
        });
        log.push(`A field hazard (${fx.hazardType === "spikes" ? "Spikes" : "Stealth Rock"}) is set!`);
      } else if (fx.type === "heal") {
        applyHealTarget(hp, maxHp, side, otherSide, fx.target, fx.healType, fx.healValue, "effect", who, fighters, log);
      } else if (fx.type === "statmod") {
        // ---- Turn-Based Duration & Decay: capture the pre-modification stage (baseline) for each affected
        // side BEFORE applying the change, so "Revert to Original" can snap back to it later. ----
        // ---- Ability Stat Mod Blockers: any side whose active ability blocks this category of change
        // (buffs/debuffs/all) is excluded from the target list entirely, so the change never lands there.
        // Checked against the ORIGINAL (pre-Contrary) sign, since blocking is about the intended change,
        // not whatever Contrary ends up flipping it into. ----
        const requestedSides = fx.target === "both" ? [side, otherSide] : [fx.target === "self" ? side : otherSide];
        const blockedSides = requestedSides.filter(t => !statModAllowed(t, fx.statStage));
        blockedSides.forEach(t => log.push(`${fighters[t].name}'s ability blocks the stat change!`));
        const affectedSides = requestedSides.filter(t => statModAllowed(t, fx.statStage));
        if (!affectedSides.length) return;
        // ---- Contrary: each affected side's own ability decides whether THIS change lands as given or
        // flipped — applied per-side rather than once for the whole node, since "both" can hit a Contrary
        // side and a normal side in the same effect. ----
        affectedSides.forEach(t => {
          const baseline = stages[t][fx.statKey] || 0;
          const appliedStage = contraryAdjustedStage(t, fx.statStage);
          stages[t][fx.statKey] = Math.max(-6, Math.min(6, baseline + appliedStage));
          log.push(`${fighters[t].name}'s ${fx.statKey.toUpperCase()} ${appliedStage > 0 ? "rose" : "fell"}!`);
          if (fx.statModDuration > 0) {
            timedStatMods[t].push({ statKey: fx.statKey, amount: appliedStage, turnsLeft: fx.statModDuration, expireMode: fx.statModExpireMode, baselineStage: baseline });
          }
          // ---- Debuff Trigger Tracker: notify this side only by the ACTUAL resulting direction (post-
          // Contrary), with `side` (this effect's user) passed as the source so a Competitive/Defiant-style
          // ability can tell whether the drop was opponent-caused or self-inflicted. ----
          if (appliedStage < 0) notifyStatLowered(t, side);
        });
      } else if (fx.type === "clearstatmod") {
        // ---- Clear Stat Modifiers Move (Haze-style): resets the designated combatant's stat modifiers
        // back to stage 0, honoring Buffs-only / Debuffs-only / All scoping ----
        const targets = fx.target === "both" ? [side, otherSide] : [fx.target === "self" ? side : otherSide];
        targets.forEach(t => {
          STAT_STAGE_KEYS.forEach(([key]) => {
            const cur = stages[t][key] || 0;
            if (fx.clearStatModMode === "all" || (fx.clearStatModMode === "buffs" && cur > 0) || (fx.clearStatModMode === "debuffs" && cur < 0)) {
              stages[t][key] = 0;
            }
          });
          timedStatMods[t] = timedStatMods[t].filter(m => {
            if (fx.clearStatModMode === "all") return false;
            if (fx.clearStatModMode === "buffs") return m.amount <= 0;
            if (fx.clearStatModMode === "debuffs") return m.amount >= 0;
            return true;
          });
          log.push(`${fighters[t].name}'s stat changes are cleared!`);
        });
      } else if (fx.type === "clearFieldHazards") {
        // ---- Field Clearer (Rapid Spin / Defog-style): wipes entry hazards from the user's own field,
        // or from both fields if configured ----
        const targets = fx.hazardClearScope === "both" ? [side, otherSide] : [side];
        targets.forEach(t => { hazards[t] = { stealthrock: false, spikesStacks: 0 }; });
        log.push(`${who} clears away the field's hazards!`);
      } else if (fx.type === "clearStatusEffects") {
        // ---- Status Clearer: cures the user's own non-volatile condition, or both combatants' ----
        const targets = fx.statusClearScope === "both" ? [side, otherSide] : fx.statusClearScope === "opponent" ? [otherSide] : [side];
        targets.forEach(t => {
          if (status[t]) { log.push(`${fighters[t].name} is cured of its ${status[t].kind}!`); status[t] = null; }
        });
      } else if (fx.type === "ppcost") {
        // ---- PP Cost Increaser (Spite mechanic): raises the PP cost already paid for the opponent's
        // most recently selected move, targeted via the same lastUsedMove tracker the Dynamic PP Cost
        // System's "Last Used Move" target uses ----
        const targets = fx.target === "both" ? [side, otherSide] : [fx.target === "self" ? side : otherSide];
        targets.forEach(t => {
          const targetMoveName = lastUsedMove[t];
          if (targetMoveName != null && movePP[t][targetMoveName] != null) {
            movePP[t][targetMoveName] = Math.max(0, movePP[t][targetMoveName] - fx.ppSpiteAmount);
            log.push(`${fighters[t].name}'s ${targetMoveName} loses ${fx.ppSpiteAmount} PP!`);
          }
        });
      } else if (fx.type === "randomizemove") {
        // ---- Random Move Transmutation (Metronome/Mirror Move-style): flags the target side so its
        // NEXT move-selection step (see chosenMove pre-selection block) picks a fully random move ----
        const targets = fx.target === "both" ? [side, otherSide] : [fx.target === "self" ? side : otherSide];
        targets.forEach(t => { forcedRandomMove[t] = true; });
        log.push(`${who}'s move causes a random transmutation!`);
      } else if (fx.type === "copyStats") {
        // ---- Stat Copying: the user matches its own current stat stages to the opponent's current stages ----
        stages[side] = { ...stages[otherSide] };
        log.push(`${who} copies ${otherWho}'s stat changes!`);
      } else if (fx.type === "status") {
        const applyTo = (t) => {
          if (hp[t] <= 0) return;
          // ---- Status Fallback: if this target can't actually receive the status — most commonly
          // because it's already carrying a different status condition, but also covers item/type/charge
          // immunity to THIS status — optionally apply a configured stat-stage change to that SAME target
          // instead (e.g. "try to Poison; if it's already statused, lower Speed instead"). Never fires for
          // an already-fainted target, and only fires when the status itself was genuinely blocked —
          // not just because the Effect Chance roll missed (that gate already happened in runEffectsArray). ----
          const blocked = !!status[t] || itemBlocksStatus(t, fx.statusEffect)
            || isStatusImmune(fighters[t].types, fx.statusEffect, null, fighters[t].tags, fieldEffect)
            || isChargeStatusImmune(t);
          if (blocked) {
            if (fx.statusFallbackEnabled && statModAllowed(t, fx.statusFallbackStatStage)) {
              const baseline = stages[t][fx.statusFallbackStatKey] || 0;
              const appliedStage = contraryAdjustedStage(t, fx.statusFallbackStatStage);
              stages[t][fx.statusFallbackStatKey] = Math.max(-6, Math.min(6, baseline + appliedStage));
              log.push(`${fighters[t].name} couldn't be affected, so its ${fx.statusFallbackStatKey.toUpperCase()} ${appliedStage > 0 ? "rose" : "fell"} instead!`);
              if (appliedStage < 0) notifyStatLowered(t, side);
            }
            return;
          }
          const dur = fx.statusDurationMode === "fixed" ? Math.max(1, Math.round(fx.statusDurationFixed || 5))
            : (() => { const lo = Math.max(1, Math.round(fx.statusDurationMin || 1)); const hi = Math.max(lo, Math.round(fx.statusDurationMax || 3)); return lo + Math.floor(Math.random() * (hi - lo + 1)); })();
          // ---- Item Dex: Status Effect Change — same conversion pass used by the dedicated "Inflict
          // Status Effect" Status-move action above, so an item like a poison->badly-poisoned converter
          // also fires off THIS node (a move's secondary/on-hit status chance, the far more common way
          // moves inflict status). Immunity above is still checked against the ORIGINAL status, matching
          // that other call site's behavior. ----
          const finalStatusKind = resolveItemStatusConversion(t, side, fx.statusEffect);
          // ---- Polluted Weather: Poison / Badly Poisoned durations get +1 extra turn while Polluted is active ----
          status[t] = {
            kind: finalStatusKind, counter: 1, turnsLeft: dur + pollutedDurationBonus(finalStatusKind), mirrorReflectPercent: fx.mirrorReflectPercent || 0,
            // ---- Multi-Turn Lock-In Attacks: only meaningful for kind==="repeat" — read when this
            // status's duration expires (see the end-of-round status-decay block below). ----
            lockInEndEffect: fx.lockInEndEffect, lockInCooldownTurns: fx.lockInCooldownTurns
          };
          log.push(`${fighters[t].name} is afflicted with ${finalStatusKind}!`);
        };
        if (fx.target === "self" || fx.target === "both") applyTo(side);
        if (fx.target === "opponent" || fx.target === "both") applyTo(otherSide);
      } else if (fx.type === "statusTransfer") {
        // ---- Status Transfer / Swap: passes, swaps, or steals an active status between the user and
        // the target. Respects the receiving side's normal status-type immunities — a leg that wouldn't
        // stick simply fails, and the source keeps whatever it had. ----
        const giver = side, receiver = otherSide;
        const mode = fx.transferMode || "swap";
        if (mode === "give") {
          if (status[giver] && !status[receiver] && !isStatusImmune(fighters[receiver].types, status[giver].kind, null, fighters[receiver].tags, fieldEffect)) {
            status[receiver] = status[giver]; status[giver] = null;
            log.push(`${fighters[giver].name} passes its status condition to ${fighters[receiver].name}!`);
          }
        } else if (mode === "steal") {
          if (status[receiver] && !status[giver] && !isStatusImmune(fighters[giver].types, status[receiver].kind, null, fighters[giver].tags, fieldEffect)) {
            status[giver] = status[receiver]; status[receiver] = null;
            log.push(`${fighters[giver].name} steals ${fighters[receiver].name}'s status condition!`);
          }
        } else {
          const gStatus = status[giver], rStatus = status[receiver];
          const giverOk = !rStatus || !isStatusImmune(fighters[giver].types, rStatus.kind, null, fighters[giver].tags, fieldEffect);
          const receiverOk = !gStatus || !isStatusImmune(fighters[receiver].types, gStatus.kind, null, fighters[receiver].tags, fieldEffect);
          if (giverOk && receiverOk) {
            status[giver] = rStatus; status[receiver] = gStatus;
            log.push(`${fighters[giver].name} and ${fighters[receiver].name} swap status conditions!`);
          }
        }
      } else if (fx.type === "omniBoost") {
        // ---- Multi-Stat Modifier Secondary Effect (Ominous Wind-style): raises/lowers EVERY stat in
        // fx.statKeys by fx.statStage stages at once, under the single Chance % roll already resolved in
        // runEffectsArray above (fx.chance × any Serene Grace-style multiplier) — this branch just applies
        // the change. fx.statKeys defaults to all 5 primary stats when the node was left unconfigured
        // (legacy "Omni-Boost" behavior); anything from 2 up to all 5 can be picked. Reuses
        // fx.target/fx.statModDuration exactly like a single-stat Stat Modifier node. ----
        const requestedSides = fx.target === "both" ? [side, otherSide] : [fx.target === "self" ? side : otherSide];
        const configuredKeys = (fx.statKeys && fx.statKeys.length) ? fx.statKeys : ["atk", "def", "spa", "spd", "spe"];
        requestedSides.forEach(t => {
          const keys = configuredKeys.filter(k => statModAllowed(t, fx.statStage));
          if (!keys.length) { log.push(`${fighters[t].name}'s ability blocks the stat change!`); return; }
          // ---- Contrary: flips the whole multi-stat change together (still one shared direction) ----
          const appliedStage = contraryAdjustedStage(t, fx.statStage);
          keys.forEach(k => {
            const baseline = stages[t][k] || 0;
            stages[t][k] = Math.max(-6, Math.min(6, baseline + appliedStage));
            if (fx.statModDuration > 0) {
              timedStatMods[t].push({ statKey: k, amount: appliedStage, turnsLeft: fx.statModDuration, expireMode: fx.statModExpireMode, baselineStage: baseline });
            }
          });
          log.push(keys.length >= 5 ? `${fighters[t].name}'s stats surge across the board!` : `${fighters[t].name}'s stats shift together!`);
          if (appliedStage < 0) notifyStatLowered(t, side);
        });
      } else if (fx.type === "weightmod") {
        // ---- Dynamic Weight Modifier: adjusts the target's temporary in-battle weight for the rest of
        // the fight, which then feeds weightMultiplier()'s crushHeavy / leverageLight damage calcs ----
        const targets = fx.target === "both" ? [side, otherSide] : [fx.target === "self" ? side : otherSide];
        targets.forEach(t => {
          const before = tempWeight[t];
          tempWeight[t] = Math.max(0.1, fx.weightModMode === "mult" ? tempWeight[t] * fx.weightModValue : tempWeight[t] + fx.weightModValue);
          log.push(`${fighters[t].name}'s weight ${tempWeight[t] >= before ? "increases" : "decreases"} to ${tempWeight[t].toFixed(1)}kg!`);
        });
      } else if (fx.type === "accuracyMod") {
        // ---- Accuracy Modifier (Sand Attack-style): adjusts the target's OWN accuracy multiplier for
        // the rest of the battle (clamped to a 10%-300% range so it can never hit 0 or blow up
        // unboundedly) — read by both accuracy-roll formulas in the turn loop via tempAccuracyMult. ----
        const targets = fx.target === "both" ? [side, otherSide] : [fx.target === "self" ? side : otherSide];
        targets.forEach(t => {
          tempAccuracyMult[t] = Math.max(0.1, Math.min(3, tempAccuracyMult[t] + (fx.accuracyModValue / 100)));
          log.push(`${fighters[t].name}'s accuracy ${fx.accuracyModValue >= 0 ? "rose" : "fell"}! (now ${Math.round(tempAccuracyMult[t] * 100)}%)`);
        });
      } else if (fx.type === "shield") {
        // ---- Customizable Hit-Count Attack Shields: erects a new shield stack on the target side.
        // Multiple shields can coexist; the damage pipeline (see findBlockingShield in the main hit loop)
        // picks the first active one whose category/type filters match the incoming hit. ----
        const targets = fx.target === "both" ? [side, otherSide] : [fx.target === "self" ? side : otherSide];
        targets.forEach(t => {
          shields[t].push({
            hitsLeft: fx.shieldHitCapacity,
            capacity: fx.shieldHitCapacity,
            triggerType: fx.shieldTriggerType,
            typeFilter: fx.shieldTypeFilter,
            unignorable: !!fx.shieldUnignorable,
            turnsLeft: fx.shieldDuration > 0 ? fx.shieldDuration : null,
            weaknessType: fx.shieldWeaknessType,
            // ---- Extended Shield Vulnerabilities: Tag-based reaction, independent of typeFilter above ----
            vulnerableToTags: fx.vulnerableToTags || [],
            vulnerableTagOutcome: fx.vulnerableTagOutcome || "bypass",
            vulnerableTagBonusHits: fx.vulnerableTagBonusHits || 1,
            vulnerableTagMultiplier: fx.vulnerableTagMultiplier != null ? fx.vulnerableTagMultiplier : 2,
            // ---- Reactive Shield Triggers ----
            reaction: fx.shieldReaction || "none",
            reactionValue: fx.shieldReactionValue != null ? fx.shieldReactionValue : 12.5,
            reactionStatus: fx.shieldReactionStatus || "burn",
            reactionChance: fx.shieldReactionChance != null ? fx.shieldReactionChance : 100,
            reactionContactOnly: fx.shieldReactionContactOnly != null ? !!fx.shieldReactionContactOnly : true
          });
          log.push(`${fighters[t].name} is protected by a shield! (absorbs ${fx.shieldHitCapacity} hit${fx.shieldHitCapacity === 1 ? "" : "s"}${fx.shieldDuration > 0 ? `, lasts ${fx.shieldDuration} turn${fx.shieldDuration === 1 ? "" : "s"}` : ""})`);
        });
      } else if (fx.type === "delayedQueue") {
        // ---- Delayed Effect Queue: queues a new node on the owner's queue. "Fixed Countdown" starts
        // ticking immediately at end-of-round; "On Charge-Release" instead rides along with the user's
        // active Charge-Up counter and is checked for release wherever that counter hits 0 (end-of-round
        // block below folds both cases into the same countdown field for a uniform tick-down). ----
        const targets = fx.target === "both" ? [side, otherSide] : [fx.target === "self" ? side : otherSide];
        targets.forEach(t => {
          const turnsLeft = fx.delayQueueTrigger === "chargeRelease" && charging[side]
            ? charging[side].turnsRemaining
            : fx.delayQueueTurns;
          delayedEffectQueue[side].push({
            side, targetSide: t, turnsLeft, payload: fx.delayQueuePayload,
            damagePct: fx.delayQueueDamagePct, statusEffect: fx.delayQueueStatusEffect,
            statKey: fx.delayQueueStatKey, statStage: fx.delayQueueStatStage,
            healPct: fx.delayQueueHealPct, ignoreSwitch: !!fx.delayQueueIgnoreSwitch
          });
        });
        log.push(`${who}'s move sets a delayed effect in motion!`);
      } else if (fx.type === "persistentDrain") {
        // ---- Multi-Turn Drain & Burnout: establishes a per-turn siphon tether between `side` and
        // `otherSide` (direction configurable), then — independently of the tether's own duration —
        // applies Type Burnout immediately if enabled, stripping a type off the USER (not the target)
        // right at execution time. ----
        const drainSide = fx.drainDirection === "userToTarget" ? side : otherSide;
        const gainSide = fx.drainDirection === "userToTarget" ? otherSide : side;
        persistentDrains[drainSide].push({
          drainSide, gainSide, resource: fx.drainResource, statKey: fx.drainStatKey,
          percent: fx.drainPercent, turnsLeft: fx.drainDuration > 0 ? fx.drainDuration : null
        });
        log.push(`${fighters[drainSide].name} is tethered — its ${fx.drainResource === "hp" ? "HP" : fx.drainResource === "energy" ? "energy" : fx.drainResource.toUpperCase()} will be siphoned each turn!`);
        if (fx.burnoutEnabled) {
          const userTypes = fighters[side].types;
          let stripType = fx.burnoutScope === "chosen" ? fx.burnoutType
            : fx.burnoutScope === "secondary" ? userTypes[1]
              : userTypes[0];
          if (stripType && userTypes.includes(stripType)) {
            const idx = userTypes.indexOf(stripType);
            if (fx.burnoutBecomeNormal) {
              userTypes[idx] = "normal";
              log.push(`${who} burns out its ${cap(stripType)} typing — it becomes Normal-type!`);
            } else if (userTypes.length > 1) {
              userTypes.splice(idx, 1);
              log.push(`${who} burns out and loses its ${cap(stripType)} typing!`);
            } else {
              userTypes[idx] = "normal";
              log.push(`${who} burns out its ${cap(stripType)} typing — with no other type left, it becomes Normal-type!`);
            }
          }
        }
      } else if (fx.type === "recycleItem") {
        const targets = fx.target === "both" ? [side, otherSide] : [fx.target === "self" ? side : otherSide];
        targets.forEach(t => applyItemRecycle(t, fx.recycleEfficiencyPct));
      } else if (fx.type === "customHazard") {
        // ---- Modular Custom Entry Hazard Builder: lays the configured hazard on the target field
        // side(s). Stackable hazards look up an existing entry with the same name and add a layer (up
        // to 3); non-stackable hazards simply (re)install a single fresh copy. The onSwitchIn-equivalent
        // entry effects fire immediately afterward via runHazardEntryEffects(); the optional turn-based
        // penalty is left on the entry for the onTurnEnd block further below to process every round. ----
        const targets = fx.target === "both" ? [side, otherSide] : [fx.target === "self" ? side : otherSide];
        targets.forEach(t => {
          let entry = fx.hzStacking ? customHazards[t].find(h => h.name === fx.hzName) : null;
          if (entry) {
            entry.stacks = Math.min(3, entry.stacks + 1);
            log.push(`${fighters[t].name}'s field gains another layer of ${fx.hzName}! (${entry.stacks}x)`);
          } else {
            entry = {
              name: fx.hzName, stacking: fx.hzStacking, stacks: 1,
              dmgMode: fx.hzDamageMode, dmgValue: fx.hzDamageValue, dmgType: fx.hzDamageType,
              statusEffect: fx.hzStatusEffect, statusChance: fx.hzStatusChance,
              statKey: fx.hzStatKey, statStage: fx.hzStatStage,
              turnBasedEnabled: fx.hzTurnBasedEnabled, turnDamagePct: fx.hzTurnDamagePct,
              turnStatKey: fx.hzTurnStatKey, turnStatStage: fx.hzTurnStatStage
            };
            if (!fx.hzStacking) customHazards[t] = customHazards[t].filter(h => h.name !== fx.hzName);
            customHazards[t].push(entry);
            log.push(`${fighters[t].name}'s field is now affected by ${fx.hzName}!`);
          }
          runHazardEntryEffects(t, entry);
        });
      } else if (fx.type === "addType") {
        const targets = fx.target === "both" ? [side, otherSide] : [fx.target === "self" ? side : otherSide];
        targets.forEach(t => {
          if (hp[t] <= 0) return;
          const f = fighters[t], cur = f.types || [], nt = fx.addTypeChoice;
          if (cur.includes(nt)) { log.push(`But ${f.name} is already ${cap(nt)}-type!`); return; }
          if (cur.length >= 3) { log.push(`But ${f.name} can't take on another type! (it already has 3)`); return; }
          f.types = [...cur, nt];
          typeAdds[t].push({ type: nt, mode: fx.addTypeDuration, turns: fx.addTypeTurns });
          const how = fx.addTypeDuration === "battle" ? "for the rest of the battle" : fx.addTypeDuration === "turns" ? `for ${fx.addTypeTurns} turn${fx.addTypeTurns === 1 ? "" : "s"}` : "until it switches out";
          log.push(`🧬 ${f.name} became ${f.types.map(cap).join("/")}-type ${how}!`);
        });
      } else if (fx.type === "evadeInaccurate") {
        dodgeShield[side] = { turns: fx.evadeTurns, below: fx.evadeBelowAcc / 100, name: currentSourceName || "The dodge stance" };
        log.push(`${who} is ready to dodge any attack under ${fx.evadeBelowAcc}% accuracy! (${fx.evadeTurns} turn${fx.evadeTurns === 1 ? "" : "s"})`);
      } else if (fx.type === "rootDown") {
        const targets = fx.target === "both" ? [side, otherSide] : [fx.target === "self" ? side : otherSide];
        targets.forEach(t => {
          if (hp[t] <= 0) return;
          rootState[t] = { turns: fx.rootTurns, ground: fx.rootGround, sureHit: fx.rootSureHit, name: currentSourceName || "Root Down" };
          if (fx.rootGround) { groundedFighters.add(fighters[t]); if (liftState[t]) { liftedFighters.delete(fighters[t]); liftState[t] = null; } }
          const parts = [fx.rootGround ? "forced to the ground" : "", fx.rootSureHit ? "can't dodge" : ""].filter(Boolean).join(", ");
          log.push(`🌱 ${fighters[t].name} is rooted in place! (${parts}; ${fx.rootTurns} turn${fx.rootTurns === 1 ? "" : "s"})`);
        });
      } else if (fx.type === "bond") {
        if (hp[otherSide] <= 0) { log.push(`But ${who} has no one to bond with!`); return; }
        bondState[side] = { turns: fx.bondTurns, partner: fighters[otherSide], onFaint: fx.bondOnFaint, onDamage: fx.bondOnDamage,
          damagePct: fx.bondDamagePct, onStatus: fx.bondOnStatus, lastStatus: status[side] ? status[side].kind : null, name: currentSourceName || "The bond" };
        const kinds = [fx.bondOnFaint ? "faint" : "", fx.bondOnDamage ? `${fx.bondDamagePct}% of damage` : "", fx.bondOnStatus ? "status" : ""].filter(Boolean);
        log.push(`🔗 ${who} formed a bond with ${otherWho}! (${kinds.join(" + ") || "no checks"}, ${fx.bondTurns} turn${fx.bondTurns === 1 ? "" : "s"})`);
      } else if (fx.type === "metronome") {
        // handled when the move is picked (see "Metronome" in the action loop); nothing to do as a stray effect
      } else if (fx.type === "substitute") {
        const cost = Math.max(1, Math.round(maxHp[side] * fx.subHpPct / 100));
        if (substitute[side] && substitute[side].hp > 0) log.push(`But ${who} already has a substitute!`);
        else if (hp[side] <= cost) log.push(`But ${who} doesn't have enough HP to make a substitute!`);
        else {
          hp[side] -= cost;
          substitute[side] = { hp: cost, max: cost };
          log.push(`${who} put in a substitute! (-${cost} HP)`);
        }
      } else if (fx.type === "lift") {
        const targets = fx.target === "both" ? [side, otherSide] : [fx.target === "self" ? side : otherSide];
        targets.forEach(t => {
          if (hp[t] <= 0) return;
          liftState[t] = { turns: fx.liftTurns, name: currentSourceName || "The lift", groundImmune: fx.liftGroundImmune };
          liftedFighters.add(fighters[t]);
          log.push(`${fighters[t].name} is airborne!`);
        });
      } else if (fx.type === "doom") {
        const targets = fx.target === "both" ? [side, otherSide] : [fx.target === "self" ? side : otherSide];
        targets.forEach(t => {
          if (hp[t] <= 0 || doomCount[t] > 0) return;
          doomCount[t] = fx.doomTurns;
          log.push(`☠️ ${fighters[t].name} will faint in ${fx.doomTurns} turn${fx.doomTurns === 1 ? "" : "s"} unless it switches out!`);
        });
      } else if (fx.type === "wish") {
        wishQueue[side].push({ turns: fx.wishTurns, pct: fx.wishPct });
        log.push(`🌠 ${who} made a wish! (${fx.wishPct}% heal in ${fx.wishTurns} turn${fx.wishTurns === 1 ? "" : "s"})`);
      } else if (fx.type === "reviveAlly") {
        const fallen = teamMode ? slots[side].map((s, i) => i).filter(i => i !== teamIdx[side] && slots[side][i].fainted) : [];
        if (!fallen.length) { log.push(`But ${who} has no fainted teammate to revive!`); return; }
        const bst = i => Object.values((slots[side][i].entry.stats) || {}).reduce((a, b) => a + (Number(b) || 0), 0);
        const pick = fallen.reduce((best, i) => bst(i) > bst(best) ? i : best, fallen[0]);
        const sl = slots[side][pick];
        sl.fainted = false;
        if (sl.saved) { sl.saved.hp = Math.max(1, Math.round(sl.saved.maxHp * fx.revivePct / 100)); sl.saved.status = null; }
        else sl.reviveHpPct = fx.revivePct;
        log.push(`✨ ${who} revived ${sl.entry.name}! (${fx.revivePct}% HP)`);
      } else if (fx.type === "snatch") {
        snatchReady[side] = true;
        log.push(`🪝 ${who} waits to snatch the opponent's move!`);
      } else if (fx.type === "switchIn") {
        // ---- Switch In: queues the benched OWNER (see applyAllyHitTriggers) to enter right after this action. ----
        if (benchSwitchCtx && benchSwitchCtx.side === side && !pendingSwitchIn[side]) {
          pendingSwitchIn[side] = { idx: benchSwitchCtx.idx };
        }
      } else if (fx.type === "triggerForm") {
        // ---- Trigger Alternate Form: always affects the USER. Switches it into one of its own alt forms. ----
        tryTriggerForm(side, fx.triggerFormLabel);
      } else if (fx.type === "changeForm") {
        // ---- In-Battle Form Change (Standalone Mega Mechanics): fires the swap directly off this
        // Move Effect node — no dependency on megaConfig.enabled, the "Allow Mega Evolution" Battle
        // Simulator toggle, or a Held Item requirement. Mirrors applyMegaEvolution()'s swap of
        // types/stats/ability/name/art, and reuses the same per-side transformState machinery so a
        // fighter already transformed (via Mega OR a prior Change Form effect) can't be transformed
        // again until it reverts — matching Rule 4 of the Mega Evolution lifecycle. Since this effect
        // carries no Duration/Reuse Cooldown config of its own, the swap is permanent for the rest of
        // the battle (turnsRemaining stays null, so the auto-revert timer never touches it). ----
        const targets = fx.target === "both" ? [side, otherSide] : [fx.target === "self" ? side : otherSide];
        targets.forEach(t => {
          const st = transformState[t];
          if (st.active) return; // already transformed — can't stack a second transformation on top
          const prevFighter = fighters[t];
          st.preForm = prevFighter;
          fighters[t] = {
            ...prevFighter,
            name: fx.changeFormName || prevFighter.name,
            types: fx.changeFormTypes || prevFighter.types,
            stats: fx.changeFormStats || prevFighter.stats,
            icon: fx.changeFormEmoji || prevFighter.icon,
            imageUrl: fx.changeFormImageUrl || prevFighter.imageUrl,
            abilities: fx.changeFormAbility ? [fx.changeFormAbility] : prevFighter.abilities
          };
          st.active = true;
          st.mega = null;
          st.turnsRemaining = null;
          log.push(`✨ ${prevFighter.name} ${fx.changeFormVerb} ${fighters[t].name}!`);
          if (fx.changeFormAbility) {
            ability[t] = pickBattleAbility(fighters[t]);
            log.push(`${fighters[t].name}'s Ability is now ${ability[t] ? ability[t].name : "None"}!`);
            activateEntryAbility(t);
          }
          (fighters[t].moves || []).forEach(m => { if (m.name && movePP[t][m.name] == null) movePP[t][m.name] = m.maxPP ?? m.pp ?? 15; });
        });
      }
    });
  }

  // ---- Debuff Trigger Tracker: fires whenever `side`'s stat is lowered. IF that side's ability is
  // Passive with trigger "statLowered" THEN its configured response action runs (e.g. Competitive/
  // Defiant-style "Boost another stat by +2 stages" via the existing modifyStat action) — but only if the
  // drop's actual source matches this ability's configured statLoweredSource filter (defaults to
  // "opponent", since Competitive/Defiant never trigger off your own self-inflicted drops). `sourceSide`
  // is whichever side's move/ability/hazard caused the drop; pass it whenever the caller knows it. When a
  // caller doesn't know (sourceSide left undefined), the source filter is skipped entirely rather than
  // guessed, so older call sites keep their previous (unfiltered) behavior. ----
  function notifyStatLowered(side, sourceSide) {
    const ab = ability[side];
    if (!ab || ab.abilityType !== "passive" || ab.passive.trigger !== "statLowered") return;
    if (hp[side] <= 0) return;
    if (sourceSide != null) {
      const src = ab.passive.statLoweredSource || "opponent";
      const causedBySelf = sourceSide === side;
      if (src === "opponent" && causedBySelf) return;
      if (src === "self" && !causedBySelf) return;
    }
    runAbilityAction(ab, side, { hasDamage: false }, log);
  }

  // ---- Ability "action" dispatcher shared by battleStart / attacking / defending / afterHit hooks ----
  function runAbilityAction(ab, side, ctx, log) {
    const who = fighters[side].name;
    if (!chanceHits(ab.passive.chance)) return ctx;
    if (ab.passive.action === "modifyStat") {
      stages[side][ab.passive.statKey] = Math.max(-6, Math.min(6, (stages[side][ab.passive.statKey] || 0) + ab.passive.statStage));
      log.push(`${who}'s ${ab.name} triggers!`);
    } else if (ab.passive.action === "heal") {
      applyHealTarget(hp, maxHp, side, otherOf(side), ab.passive.healTarget, ab.passive.healType, ab.passive.healValue, ab.name, who, fighters, log);
    } else if (ctx && ctx.hasDamage) {
      if (ab.passive.action === "negateDamage") { ctx.dmg = 0; log.push(`${who}'s ${ab.name} negates the damage!`); }
      else if (ab.passive.action === "multiplyDamage") { ctx.dmg = Math.round(ctx.dmg * (ab.passive.multiplier || 1)); }
      else if (ab.passive.action === "protect" && ctx.moveType === ab.passive.protectType) {
        ctx.dmg = Math.round(ctx.dmg * (1 - ab.passive.protectPercent / 100));
        log.push(`${who}'s ${ab.name} shields against ${ab.passive.protectType}-type damage!`);
      } else if (ab.passive.action === "resistanceMult") {
        const ratio = ab.passive.resistRatio ?? 0.5;
        ctx.dmg = Math.round(ctx.dmg * ratio);
        log.push(ratio <= 0 ? `${who}'s ${ab.name} grants total immunity!` : `${who}'s ${ab.name} resists the hit!`);
      } else if (ab.passive.action === "reduceSuperEffective") {
        // ---- Super Effective Reaction Triggers: Solid Rock / Filter-style flat % reduction, reusing
        // the shared Shield-vs-Type "protectPercent" field as the reduction amount ----
        ctx.dmg = Math.round(ctx.dmg * (1 - (ab.passive.protectPercent || 0) / 100));
        log.push(`${who}'s ${ab.name} weakens the super-effective hit!`);
      } else if (ab.passive.action === "categoryDamageMult" && ctx.moveCategory && ctx.moveCategory === ab.passive.damageCategory) {
        ctx.dmg = Math.round(ctx.dmg * (ab.passive.categoryMultiplier || 1));
        log.push(`${who}'s ${ab.name} changes the damage of ${ab.passive.damageCategory} moves!`);
      } else if (ab.passive.action === "tagDamageMult" && ctx.moveTags && ctx.moveTags.some(t => String(t).toLowerCase() === String(ab.passive.tagFilter || "").toLowerCase())) {
        ctx.dmg = Math.round(ctx.dmg * (ab.passive.tagMultiplier || 1));
        log.push(`${who}'s ${ab.name} empowers ${ab.passive.tagFilter}-tagged moves!`);
      } else if (ab.passive.action === "chipOnHit" && ab.passive.chipDamageTrigger === "onDealHit") {
        const chip = ab.passive.chipDamageType === "flat" ? Math.round(ab.passive.chipDamageValue) : Math.round(ctx.dmg * (ab.passive.chipDamageValue / 100));
        ctx.chipDmg = (ctx.chipDmg || 0) + Math.max(0, chip);
      }
    }
    return ctx;
  }

  // ---- Active ability action executor: shared by offensive (self-turn) and defensive (on-hit) gates ----
  function runActiveAbilityAction(ab, side, ctx, log) {
    const who = fighters[side].name;
    if (ab.active.action === "boostDamage150" && ctx && ctx.hasDamage) { ctx.dmg = Math.round(ctx.dmg * 1.5); log.push(`${who}'s ${ab.name} kicks in!`); }
    else if (ab.active.action === "boostDamageCustom" && ctx && ctx.hasDamage) { ctx.dmg = Math.round(ctx.dmg * (ab.active.multiplier || 2)); log.push(`${who}'s ${ab.name} unleashes a surge of power!`); }
    // ---- Boost Type Moves (Blaze-style): boosts damage only when the current move's Type is one of
    // the selected boostTypeTargets. Typically paired with an offensive condition like "If HP is Below
    // 33%" to replicate Blaze/Torrent/Overgrow exactly (only the matching-type moves get stronger, not
    // every move the user has, which the plain "Boost Damage by 1.5x" action would do). ----
    else if (ab.active.action === "boostType" && ctx && ctx.hasDamage && (ab.active.boostTypeTargets || []).includes(ctx.moveType)) {
      ctx.dmg = Math.round(ctx.dmg * (ab.active.multiplier || 1.5));
      log.push(`${who}'s ${ab.name} kicks in!`);
    }
    // ---- Boost Tag Moves (Iron Fist-style): boosts damage only when the current move carries one of
    // the listed tags — and a move's own Type counts as an implicit tag too (see moveTagPool()). ----
    else if (ab.active.action === "boostTagMove" && ctx && ctx.hasDamage && moveMatchesAnyTag({ type: ctx.moveType, tags: ctx.moveTags }, ab.active.boostTagFilter)) {
      ctx.dmg = Math.round(ctx.dmg * (ab.active.multiplier || 1.3));
      log.push(`${who}'s ${ab.name} empowers the attack!`);
    }
    else if (ab.active.action === "boostSpeed1") { stages[side].spe = Math.max(-6, Math.min(6, stages[side].spe + 1)); log.push(`${who}'s ${ab.name} boosts its Speed!`); }
    else if (ab.active.action === "heal") { applyHealTarget(hp, maxHp, side, otherOf(side), ab.active.healTarget, ab.active.healType, ab.active.healValue, ab.name, who, fighters, log); }
    else if (ab.active.action === "protect" && ctx && ctx.hasDamage && ctx.moveType === ab.active.protectType) { ctx.dmg = Math.round(ctx.dmg * (1 - ab.active.protectPercent / 100)); log.push(`${who}'s ${ab.name} shields against ${ab.active.protectType}-type damage!`); }
    else if (ab.active.action === "negateDamage" && ctx && ctx.hasDamage) { ctx.dmg = 0; log.push(`${who}'s ${ab.name} blocks the hit entirely!`); }
    else if (ab.active.action === "setWeather") {
      weather = ab.active.weatherSet; weatherTurns = ab.active.weatherSetDuration;
      weatherLocked = !ab.active.weatherOverridable;
      if (weather === "polluted") pollutedPoisonChance = ab.active.pollutedPoisonChance;
      log.push(`${who}'s ${ab.name} changes the weather to ${weatherLabel(weather)}!`);
    }
    else if (ab.active.action === "setField") {
      fieldEffect = ab.active.fieldSet; fieldTurns = ab.active.fieldSetDuration;
      fieldLocked = !ab.active.fieldOverridable;
      const label = FIELD_STATES.find(f => f[0] === fieldEffect);
      log.push(`${who}'s ${ab.name} changes the field to ${label ? label[1] : fieldEffect}!`);
    }
    if (ab.active.oncePerBattle) abilityTriggered[side] = true;
  }

  // ---- Entry/Transform Ability Activation: fires `side`'s CURRENT battle ability's "Battle Start"
  // passive action (Drizzle/Drought-style weather setters, Aura Field setup, etc.). Shared by the
  // once-per-battle initial activation below AND by Mega Evolution (see tryMegaEvolve), so a newly
  // assigned Mega ability triggers its instant on-transform effects the moment it takes hold instead
  // of only being usable reactively for the rest of the fight. ----
  function activateEntryAbility(side) {
    // Ability-Driven Transformation: checked first since it's its own Passive Action
    // ("transformOnEntry") rather than one of the branches below — performImposterTransform() re-derives
    // and validates the current ability/trigger itself, so this is safe to call unconditionally here.
    // Runs whenever this side's current ability enters play (initial battle start, a new Mega ability
    // taking hold, or a copied ability gained via Full Transform/Role Play/Trace/Skill Swap/Entrainment
    // all route through this same shared entry point).
    performImposterTransform(side);
    const ab = ability[side];
    if (!(ab && ab.abilityType === "passive" && triggerMatches(ab.passive.trigger, "battleStart"))) return;
    runAbilityAction(ab, side, { hasDamage: false }, log);
    runEffectsFrom(ab, ab.effects, side);
    if (ab.passive.action === "auraField") {
      auraField = { side, type: ab.passive.auraFieldType, percent: ab.passive.auraFieldPercent, target: ab.passive.auraFieldTarget };
      log.push(`${fighters[side].name}'s ${ab.name} fills the field with a ${cap(auraField.type)} Aura!`);
    } else if (ab.passive.action === "setWeather") {
      weather = ab.passive.weatherSet; weatherTurns = ab.passive.weatherSetDuration;
      weatherLocked = !ab.passive.weatherOverridable;
      if (weather === "polluted") pollutedPoisonChance = ab.passive.pollutedPoisonChance;
      log.push(`${fighters[side].name}'s ${ab.name} whips up ${weatherLabel(weather)}!`);
    } else if (ab.passive.action === "blockMoveType") {
      const bw = ab.passive.blockWeather;
      if (bw && bw !== "none") {
        weather = bw; weatherTurns = 999; weatherLocked = true;
        log.push(`${fighters[side].name}'s ${ab.name} whips up ${weatherLabel(weather)}!`);
      }
      log.push(`${fighters[side].name}'s ${ab.name}: ${cap(ab.passive.blockType)}-type attacks will fail!`);
    } else if (ab.passive.action === "setField") {
      fieldEffect = ab.passive.fieldSet; fieldTurns = ab.passive.fieldSetDuration;
      fieldLocked = !ab.passive.fieldOverridable;
      const label = FIELD_STATES.find(f => f[0] === fieldEffect);
      log.push(`${fighters[side].name}'s ${ab.name} transforms the field into ${label ? label[1] : fieldEffect}!`);
    }
  }

  // battle-start passives
  ["a", "b"].forEach(side => activateEntryAbility(side));
  // Item Dex: "battleStart" trigger (e.g. Choice Scarf's Speed boost), fires once right after abilities.
  ["a", "b"].forEach(side => applyItemBattleStart(side));
  // ---- "No Tera Required" items: the holder just LEARNS the Dynamic Move Injector move at battle
  // start instead of needing to actually Terastallize for it — no typing change, no once-per-battle
  // Tera activation consumed, and it's usable turn one like any other move. Skipped entirely for
  // items that don't have this box checked (the existing Terastallize-gated behavior in
  // activateTeraState() is untouched). ----
  ["a", "b"].forEach(side => {
    const teraItem = itemState[side].item;
    if (!teraItem || !teraItem.noTeraRequired || !teraItem.teraType || teraItem.teraType === "none") return;
    const learned = buildTeraBlastMove(teraItem.teraType, fighters[side], teraItem.teraMove);
    fighters[side].moves = injectTemporaryMove(fighters[side], learned);
    if (movePP[side][learned.name] == null) movePP[side][learned.name] = learned.maxPP ?? learned.pp ?? 10;
    log.push(`🪄 ${fighters[side].name} already knows ${learned.name} from ${teraItem.name}!`);
  });
  // Item Dex: "onUse" trigger — same "entrant meets the battle" moment as battleStart, for items whose
  // flavor is "consumed/activated right now" (a food item that heals and/or arms a timed type boost the
  // instant it's eaten). See applyItemImmediateEffects for why this is a separate, fully-supported
  // trigger rather than reusing battleStart's old boostStat-only behavior.
  ["a", "b"].forEach(side => applyItemOnUse(side));
  ["a", "b"].forEach(side => applyItemStatusEffect(side));
  // Extended Item Effect Hooks — all fire once, at the same "entrant meets the battle" moment:
  // Stat Copy (2), First-Turn Priority arm (7), Stat Shifts (8), Stat Modifier arm (3).
  ["a", "b"].forEach(side => {
    const otherSide = otherOf(side);
    applyItemStatCopy(side, otherSide);
    armItemFirstTurnPriority(side);
    applyItemStatShiftBattleStart(side);
    applyItemStatModifierArm(side);
  });

  // ================= TEAM MODE: sending in the next Fakemon =================
  const team = teamMode ? { a: teamOpts.a, b: teamOpts.b } : null;
  // One slot per team member. While a Fakemon is benched (switched out, not fainted) `saved` holds its battle
  // state, so it returns with the HP / status / PP it left with. teamIdx is the slot currently on the field.
  const slots = teamMode ? { a: team.a.map(en => ({ entry: en, fainted: false, saved: null })), b: team.b.map(en => ({ entry: en, fainted: false, saved: null })) } : null;
  // Abilities are decided up front (the lead keeps the one it already rolled) so the bot can read every teammate's ability.
  if (teamMode) ["a", "b"].forEach(sd => { slots[sd].forEach((s, i) => { s.rolledAbility = i === 0 ? ability[sd] : pickBattleAbility(s.entry); }); });
  const teamIdx = { a: 0, b: 0 };
  const switchCooldown = { a: 0, b: 0 };
  const switchedThisRound = { a: false, b: false };
  const roundsOnField = { a: 0, b: 0 };   // completed rounds since this side last entered the field (Fake Out / First Impression)
  const switchCount = { a: 0, b: 0 };
  // Bot switching tuning (all overridable through teamOpts.ai; teamOpts.switching === false turns it off).
  const AI = { enabled: true, trigger: -10, tax: 10, margin: 30, chance: 0.75, cooldown: 4, maxSwitches: 6, ...((teamOpts && teamOpts.ai) || {}) };
  if (teamOpts && teamOpts.switching === false) AI.enabled = false;
  const turnCap = teamMode ? 40 * Math.max(team.a.length, team.b.length) : 40;
  function benchSlots(side) { return teamMode ? slots[side].map((s, i) => i).filter(i => i !== teamIdx[side] && !slots[side][i].fainted) : []; }
  function benchLeft(side) { return benchSlots(side).length; }
  function sideHasMons(side) { return hp[side] > 0 || benchLeft(side) > 0; }
  function teamLeft(side) { return (hp[side] > 0 ? 1 : 0) + benchLeft(side); }
  // Remaining health (each living Fakemon counts as its HP fraction) — used by the turn-cap tiebreak.
  function teamHealth(side) {
    return slots[side].reduce((n, s, i) => {
      if (i === teamIdx[side]) return n + (hp[side] > 0 ? hp[side] / maxHp[side] : 0);
      if (s.fainted) return n;
      return n + (s.saved ? s.saved.hp / s.saved.maxHp : 1);
    }, 0);
  }
  // Everything that fires the moment a Fakemon enters the field (same sequence the lead goes through at battle start).
  function runEntryHooks(side) {
    const otherSide = otherOf(side);
    activateEntryAbility(side);
    applyItemBattleStart(side);
    const teraItem = itemState[side].item;
    if (teraItem && teraItem.noTeraRequired && teraItem.teraType && teraItem.teraType !== "none") {
      const learned = buildTeraBlastMove(teraItem.teraType, fighters[side], teraItem.teraMove);
      if (!(fighters[side].moves || []).some(m => m && m.name === learned.name)) { // a returning Fakemon already has it
        fighters[side].moves = injectTemporaryMove(fighters[side], learned);
        if (movePP[side][learned.name] == null) movePP[side][learned.name] = learned.maxPP ?? learned.pp ?? 10;
        log.push(`🪄 ${fighters[side].name} already knows ${learned.name} from ${teraItem.name}!`);
      }
    }
    applyItemOnUse(side);
    applyItemStatusEffect(side);
    applyItemStatCopy(side, otherSide);
    armItemFirstTurnPriority(side);
    applyItemStatShiftBattleStart(side);
    applyItemStatModifierArm(side);
  }
  // Hazards punish the ENTRANT (this is what makes Stealth Rock / Spikes matter once there is switching).
  function applyEntryHazards(side) {
    if (hp[side] <= 0) return;
    const hz = hazards[side];
    if ((hz.stealthrock || hz.spikesStacks > 0) && !itemBlocksHazard(side)) {
      if (hz.stealthrock) {
        const dot = Math.max(1, Math.round(maxHp[side] / 8));
        hp[side] = Math.max(0, hp[side] - dot);
        log.push(`${fighters[side].name} is hurt by the sharp stones! (${dot} dmg)`);
      }
      if (hz.spikesStacks > 0 && hp[side] > 0) {
        const dot = Math.max(1, Math.round((maxHp[side] / 8) * hz.spikesStacks));
        hp[side] = Math.max(0, hp[side] - dot);
        log.push(`${fighters[side].name} is hurt by spikes! (${dot} dmg)`);
      }
    }
    (customHazards[side] || []).forEach(h => { if (hp[side] > 0) runHazardEntryEffects(side, h); });
  }
  // ---- Saving / restoring a benched Fakemon ----
  // PERSISTENT state travels with the Fakemon (HP, status, PP, ability, item uses, Mega/Tera/Ditto state, once-per-battle flags).
  // VOLATILE state (stat stages, shields, charging, timers, drains, streaks…) is wiped every time one leaves the field.
  function saveActiveSlot(side) {
    doomCount[side] = 0; // leaving the field saves a doomed Fakemon
    substitute[side] = null; // ...and drops its substitute
    bondState[side] = null;  // ...and ends its bond
    removeAddedTypes(side, true); // ...and loses added types that only last until it switches out
    dodgeShield[side] = null; // ...and drops its dodge stance
    if (rootState[side]) { groundedFighters.delete(fighters[side]); rootState[side] = null; } // ...and is no longer rooted
    if (liftState[side]) { liftedFighters.delete(fighters[side]); liftState[side] = null; } // ...and lands it
    slots[side][teamIdx[side]].saved = {
      fighter: fighters[side], maxHp: maxHp[side], hp: hp[side], status: status[side], ability: ability[side],
      movePP: movePP[side], moveCooldowns: moveCooldowns[side], itemState: itemState[side], transformState: transformState[side],
      teraState: teraState[side], dittoState: dittoState[side], imposterState: imposterState[side], tempWeight: tempWeight[side],
      abilityTriggered: abilityTriggered[side], moveHitTotals: moveHitTotals[side], totalDamageTaken: totalDamageTaken[side]
    };
  }
  function resetVolatile(side) {
    stages[side] = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
    roundsOnField[side] = 0;
    turnState[side] = { lastDamageTaken: 0, lastDamageType: null, gotHitThisTurn: false };
    shields[side] = []; stateImmunity[side] = null; charging[side] = null;
    timedStatMods[side] = []; tradeoffDots[side] = [];
    ["a", "b"].forEach(sd => { persistentDrains[sd] = persistentDrains[sd].filter(pd => pd.drainSide !== side && pd.gainSide !== side); });
    tempAccuracyMult[side] = 1; lastMoveMissed[side] = false; moveStreak[side] = { name: null, count: 0 };
    lastUsedMove[side] = null; forcedRandomMove[side] = false;
    const its = itemState[side];
    if (its) { its.tempStatBuff = null; its.statShiftPct = null; its.firstMoveBonusArmed = false; its.abilityNullifyTurns = 0; }
    if (auraField && auraField.side === side) auraField = null; // the aura belonged to the Fakemon that just left
  }
  // Puts slot `idx` on the field: restores it if it has been out before, otherwise builds it fresh from its entry.
  function enterSlot(side, idx) {
    const slot = slots[side][idx], e = slot.entry;
    const returning = !!slot.saved;
    if (returning) {
      const sv = slot.saved;
      fighters[side] = sv.fighter; maxHp[side] = sv.maxHp; hp[side] = sv.hp; status[side] = sv.status; ability[side] = sv.ability;
      movePP[side] = sv.movePP; moveCooldowns[side] = sv.moveCooldowns; itemState[side] = sv.itemState; transformState[side] = sv.transformState;
      teraState[side] = sv.teraState; dittoState[side] = sv.dittoState; imposterState[side] = sv.imposterState; tempWeight[side] = sv.tempWeight;
      abilityTriggered[side] = sv.abilityTriggered; moveHitTotals[side] = sv.moveHitTotals; totalDamageTaken[side] = sv.totalDamageTaken;
    } else {
      fighters[side] = { ...e, types: [...(e.types || [])], moves: [...(e.moves || [])], tags: [...(e.tags || [])], gender: rollGender(e.genderPool) };
      maxHp[side] = ((e.stats && e.stats.hp) || 50) * 3;
      hp[side] = maxHp[side];
      if (slot.reviveHpPct) { hp[side] = Math.max(1, Math.round(maxHp[side] * slot.reviveHpPct / 100)); slot.reviveHpPct = 0; } // revived before it ever entered
      status[side] = null;
      itemState[side] = { item: itemById(itemIdOf(side, idx)), usesLeft: 0, efficiency: 1, abilityNullifyTurns: 0, firstMoveBonusArmed: false, tempStatBuff: null, statShiftPct: null };
      if (itemState[side].item) itemState[side].usesLeft = Math.max(0, Number(itemState[side].item.maxUses) || 0);
      transformState[side] = { active: false, mega: null, turnsRemaining: null, preForm: null, cooldownRemaining: 0, lockedOut: false };
      teraState[side] = { active: false, type: null, originalTypes: null, stellar: false, used: false };
      dittoState[side] = { active: false, revertMode: null, revertTurnsRemaining: null, preMoves: null, preAbility: null, preTypes: null };
      imposterState[side] = { active: false };
      ability[side] = slot.rolledAbility;
      const ab0 = ability[side];
      if (ab0 && ab0.manualCast && ab0.name) {
        fighters[side] = { ...fighters[side], moves: [...(fighters[side].moves || []), abilityToSyntheticMove(ab0)] };
      }
      movePP[side] = Object.fromEntries((fighters[side].moves || []).filter(m => m.name).map(m => [m.name, m.maxPP ?? m.pp ?? 15]));
      moveCooldowns[side] = {};
      tempWeight[side] = Number(e.weight) || 1;
      moveHitTotals[side] = {};
      totalDamageTaken[side] = 0;
      abilityTriggered[side] = false;
    }
    resetVolatile(side);
    teamIdx[side] = idx;
    const ab = ability[side];
    log.push(`➡️ Team ${side.toUpperCase()} sends out ${fighters[side].name}!` + (returning ? ` (back at ${hp[side]}/${maxHp[side]} HP)` : ``) + ` (${benchLeft(side)} left in reserve)`);
    if (ab) log.push(`${fighters[side].name} is using its ability: ${ab.name}.`);
    applyEntryHazards(side);
    if (hp[side] > 0) runEntryHooks(side);
  }

  // ================= MATCHUP POINTS =================
  // A Fakemon's score against a specific opponent, in points (positive = good matchup, negative = bad):
  //   + Offense  : its best move vs the opponent's typing (damage: type chart × STAB × power × accuracy; non-damaging: boosts/heals/status/hazards
  //                — all moves are considered, no 4-move limit), up to +60
  //   − Defense  : the opponent's best move vs ITS typing, up to −60
  //   ± Bulk     : overall stat total vs the opponent's, ±10
  //   ± Speed    : outspeeds the opponent (+6) or is outsped (−6)
  //   ± Health   : −15 at 0% HP … +15 at 100% HP
  //   − Status   : sleep/freeze −20, paralysis −10, burn/poison −8…   + 6 if the OPPONENT is afflicted
  //   ± Boosts   : current stat stages on the active Fakemon (staying keeps boosts, switching loses them), ±12
  const STATUS_PTS = { sleep: 20, freeze: 20, badlypoisoned: 12, paralysis: 10, burn: 8, poison: 8 };
  const bstOf = v => ["hp", "atk", "def", "spa", "spd", "spe"].reduce((n, k) => n + ((v.stats && v.stats[k]) || 50), 0);
  function viewActive(side) {
    const f = fighters[side];
    return {
      side, entry: f, types: f.types || ["normal"], moves: f.moves || [], stats: f.stats || {}, hpFrac: maxHp[side] > 0 ? hp[side] / maxHp[side] : 0, status: status[side], stages: stages[side],
      ability: ability[side], item: itemState[side].item, itemReady: itemHasCharge(itemState[side])
    };
  }
  function viewSlot(side, i) {
    const sl = slots[side][i];
    if (sl.saved) {
      const f = sl.saved.fighter; return {
        side, entry: f, types: f.types || ["normal"], moves: f.moves || [], stats: f.stats || {}, hpFrac: sl.saved.hp / sl.saved.maxHp, status: sl.saved.status, stages: null,
        ability: sl.saved.ability, item: sl.saved.itemState.item, itemReady: itemHasCharge(sl.saved.itemState)
      };
    }
    const en = sl.entry;
    const itm = itemById(itemIdOf(side, i));
    return {
      side, entry: en, types: en.types || ["normal"], moves: en.moves || [], stats: en.stats || {}, hpFrac: 1, status: null, stages: null,
      ability: sl.rolledAbility, item: itm, itemReady: !!itm
    };
  }
  // ================= READING ABILITIES & HELD ITEMS =================
  // The bot reads what each ability / item actually DOES (the same fields the battle core uses) and folds it into the score:
  //  · damage multipliers on its own attacks and on incoming ones (type boosts, resistances, immunities, Wonder Guard, Solid Rock…)
  //  · blockers: status immunity (ability or item), stat-drop blockers, hazard-immune items
  //  · steady value: regeneration, Leftovers-style healing, auras, reflected damage, Focus Sash
  //  · entry value (counted only for a teammate that is ABOUT to come in): weather/field setters, entry stat boosts, item boosts
  const lc = s => String(s == null ? "" : s).toLowerCase();
  const tagList = csv => String(csv || "").split(",").map(x => lc(x).trim()).filter(Boolean);
  const tagPoolOf = (mv, mtype) => [...(mv.tags || []).map(lc), lc(mtype)]; // a move's Type counts as an implicit tag
  const chanceW = pct => Math.max(0, Math.min(100, pct == null ? 100 : Number(pct))) / 100;
  const clampN = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const itemEffects = view => (view.item && view.itemReady) ? effectsByPriority(view.item) : [];
  const itemWeight = view => (view.item && Number(view.item.maxUses) > 0) ? 0.5 : 1; // single-use items only help once
  // Does this passive rule fire for the given event?
  function passiveFires(p, event, tmult, pool) {
    if (triggerMatches(p.trigger, event)) return true;
    if (event === "defending") {
      if (p.trigger === "hitBySuperEffective") return tmult > 1;
      if (p.trigger === "hitByTag") return pool.includes(lc(p.hitTagFilter));
    }
    return false;
  }
  // Ability: multiplier on THIS Fakemon's own attack
  function abilityOffenseMult(view, mv, mtype, tmult) {
    const ab = view.ability; if (!ab) return 1;
    const pool = tagPoolOf(mv, mtype); let m = 1;
    if (ab.abilityType === "passive") {
      const p = ab.passive, w = chanceW(p.chance);
      if (p.action === "multiplyDamage" && passiveFires(p, "attacking", tmult, pool) && passiveApplies(ab, mtype)) m *= 1 + ((Number(p.multiplier) || 1) - 1) * w;
      else if (p.action === "boostTagMove" && tagList(p.boostTagFilter).some(t => pool.includes(t))) m *= 1 + ((Number(p.boostTagMultiplier) || 1) - 1) * w;
      else if (p.action === "tagDamageMult" && passiveFires(p, "attacking", tmult, pool) && pool.includes(lc(p.tagFilter))) m *= 1 + ((Number(p.tagMultiplier) || 1) - 1) * w;
      else if (p.action === "loafAround") m *= 1 - 1 / Math.max(2, Number(p.loafInterval) || 2); // skips a turn every cycle
      else if (p.action === "slowStart" && turn < (p.slowStartTurns || 5) && (p.slowStartKeys || []).some(k => k === "atk" || k === "spa")) m *= clampN(Number(p.slowStartMultiplier) || 0.5, 0.1, 1);
    } else {
      const ac = ab.active, w = chanceW(ac.chance) * (ac.oncePerBattle ? 0.6 : 1);
      let boost = 1;
      if (ac.action === "boostDamage150") boost = 1.5;
      else if (ac.action === "boostDamageCustom") boost = Number(ac.multiplier) || 1;
      else if (ac.action === "boostType" && (ac.boostTypeTargets || []).includes(mtype)) boost = Number(ac.multiplier) > 1 ? Number(ac.multiplier) : 1.5;
      else if (ac.action === "boostTagMove" && tagList(ac.boostTagFilter).some(t => pool.includes(t))) boost = Number(ac.multiplier) > 1 ? Number(ac.multiplier) : 1.5;
      if (boost !== 1) {
        // how likely is the gating condition to hold when this move is used?
        let cond;
        switch (ac.condition) {
          case "stabMatch": cond = (view.types || []).includes(mtype) ? 1 : 0; break;
          case "hpBelow33": cond = view.hpFrac < 0.33 ? 1 : 0.2; break;
          case "weatherIs": cond = weather === ac.weatherCondition ? 1 : 0.15; break;
          case "lastMoveMissed": cond = 0.15; break;
          case "typeMatchOverride": cond = 0.5; break;
          default: cond = 0.4;
        }
        m *= 1 + (boost - 1) * w * cond;
      }
    }
    return m;
  }
  // Ability: multiplier on an incoming attack against THIS Fakemon (0 = immune)
  function abilityDefenseMult(view, mv, mtype, tmult) {
    const ab = view.ability; if (!ab) return 1;
    if (ab.immuneToType && ab.immuneToType !== "none" && ab.immuneToType === mtype) return 0;
    const pool = tagPoolOf(mv, mtype); let m = 1;
    if (ab.abilityType === "passive") {
      const p = ab.passive, w = chanceW(p.chance);
      if (p.action === "wonderGuard") { if (tmult <= 1) return 0; }
      else if (passiveFires(p, "defending", tmult, pool)) {
        if (p.action === "negateDamage" && passiveApplies(ab, mtype)) m *= 1 - w;
        else if (p.action === "resistanceMult" && passiveApplies(ab, mtype)) m *= 1 - w * (1 - (p.resistRatio ?? 0.5));
        else if (p.action === "multiplyDamage" && passiveApplies(ab, mtype)) m *= 1 + ((Number(p.multiplier) || 1) - 1) * w;
        else if (p.action === "protect" && p.protectType === mtype) m *= 1 - w * (p.protectPercent / 100);
        else if (p.action === "reduceSuperEffective" && tmult > 1) m *= 1 - w * (p.protectPercent / 100);
        else if (p.action === "tagDamageMult" && pool.includes(lc(p.tagFilter))) m *= 1 + ((Number(p.tagMultiplier) || 1) - 1) * w;
        else if (p.action === "negateTaggedMove" && pool.includes(lc(p.hitTagFilter))) m *= 1 - w;
        else if (p.action === "reflectDamage") { const frac = p.reflectType === "flat" ? 0.1 : (Number(p.reflectValue) || 0) / 100; m *= 1 - Math.min(0.3, 0.5 * frac * w); }
      }
    } else {
      const ac = ab.active, w = chanceW(ac.chance) * (ac.oncePerBattle ? 0.5 : 1);
      if (ac.condition === "hitByType" && ac.hitType === mtype) {
        if (ac.action === "negateDamage") m *= 1 - w;
        else if (ac.action === "protect") m *= 1 - w * (ac.protectPercent / 100);
      } else if (ac.condition === "hpFull" && ac.action === "negateDamage" && view.hpFrac >= 0.99) m *= 0.5; // soaks the first hit
    }
    if (ab.mirrorReflectPercent > 0) m *= 1 - Math.min(0.3, 0.5 * ab.mirrorReflectPercent / 100);
    return m;
  }
  // Held item: boostDamage effects on its own attacks / mitigation on incoming ones
  function itemOffenseMult(view, mv, mtype) {
    let m = 1; const w = itemWeight(view);
    itemEffects(view).forEach(fx => { if (fx.action === "boostDamage" && matchesMoveFilter(fx, { ...mv, type: mtype })) m *= 1 + (Number(fx.value) || 0) * w; });
    return m;
  }
  function itemDefenseMult(view, mv, mtype, tmult) {
    let m = 1; const w = itemWeight(view);
    itemEffects(view).forEach(fx => {
      if (fx.action !== "mitigation") return;
      const gate = fx.filterMode || "superEffective";
      if (gate === "superEffective" && tmult <= 1) return;
      if (gate === "typeFilter" && !matchesMoveFilter(fx, { ...mv, type: mtype })) return;
      m *= 1 - (Number(fx.value) || 0.25) * w;
    });
    return m;
  }
  // Can this Fakemon be given this status at all? (ability blanket-immunity or an immunity on its held item)
  function statusBlocked(view, kind) {
    kind = lc(kind);
    const ab = view.ability;
    if (ab && ab.abilityType === "passive" && ab.passive.action === "negateStatus" && triggerMatches(ab.passive.trigger, "defending")
      && chanceW(ab.passive.chance) >= 1 && ab.passive.filterType === "any" && !(ab.passive.affectedTypes || []).length) return true;
    const imm = view.item && view.itemReady && view.item.immunities;
    if (imm) { const map = { sleep: "sleep", paralysis: "paralysis", burn: "burn", poison: "poison", badlypoisoned: "poison", frostbite: "freeze", freeze: "freeze" }; if (imm[map[kind]]) return true; }
    return false;
  }
  const blocksStatDrops = view => !!(view.ability && (view.ability.negateStatMod === "blockDebuffs" || view.ability.negateStatMod === "blockAll"));

  // --- Damaging moves: type chart × STAB × power × accuracy (× multi-hit), then both sides' abilities and items ---
  function attackValue(mv, atkView, defView) {
    if (!mv || !mv.name || mv.category === "Status" || !(mv.basePower > 0)) return 0;
    let mtype = mv.type, bpBoost = 1;
    const aab = atkView.ability;
    if (aab && aab.abilityType === "passive" && aab.passive.action === "moveTypeOverride") { // Normalize / Galvanize-style rewrite
      const p = aab.passive;
      if (p.moveTypeFrom === "any" || p.moveTypeFrom === mtype) { mtype = p.moveTypeTo; bpBoost = Number(p.moveTypeBoost) || 1; }
    }
    const tmult = typeMultiplier(mtype, defView.types) * tagMatchupMultiplier(defView.entry, mv.tags || []);
    if (tmult <= 0) return 0;
    const stab = (atkView.types || []).includes(mtype) ? 1.5 : 1;
    const power = Math.min(2, Math.max(0.3, (mv.basePower || 60) * bpBoost / 60));
    const hitsBonus = 1 + 0.25 * (Math.max(1, Math.min(5, mv.hits || 1)) - 1);
    return tmult * stab * power * (mv.accuracy ?? 1) * hitsBonus
      * abilityOffenseMult(atkView, mv, mtype, tmult) * itemOffenseMult(atkView, mv, mtype)
      * abilityDefenseMult(defView, mv, mtype, tmult) * itemDefenseMult(defView, mv, mtype, tmult);
  }
  const bestAttackValue = (atkView, defView) => atkView.moves.reduce((m, mv) => Math.max(m, attackValue(mv, atkView, defView)), 0);

  // --- Non-damaging moves (boosts, drops, heals, status, hazards…): same scale as attacks (×20 = points), capped at 1.6 (32 pts) ---
  const STATUS_VALUE = { sleep: 1.5, freeze: 1.5, paralysis: 1.0, badlypoisoned: 1.0, frostbite: 0.9, burn: 0.9, poison: 0.7 };
  const STATUS_BLOCKED_BY = { burn: ["fire"], paralysis: ["electric"], frostbite: ["ice"], freeze: ["ice"], poison: ["poison", "steel"], badlypoisoned: ["poison", "steel"] };
  function statusInflictValue(kind, chancePct, acc, defView) {
    kind = lc(kind);
    if (!kind || kind === "none" || defView.status) return 0; // nothing to inflict, or the target is already afflicted
    if ((STATUS_BLOCKED_BY[kind] || []).some(t => (defView.types || []).includes(t))) return 0; // type-immune
    if (statusBlocked(defView, kind)) return 0; // ability / item immunity
    return (STATUS_VALUE[kind] ?? 0.7) * acc * (chancePct / 100);
  }
  function hazardValue(kind, targetSide) {
    if (!teamMode || !targetSide || benchLeft(targetSide) === 0) return 0; // hazards only pay off if the foe still has Fakemon to bring in
    const hz = hazards[targetSide];
    if (kind === "spikes") return hz.spikesStacks >= 3 ? 0 : (hz.spikesStacks === 0 ? 0.8 : 0.4);
    return hz.stealthrock ? 0 : 0.9;
  }
  function utilityValue(mv, atkView, defView) {
    const threat = bestAttackValue(defView, atkView);        // how hard the opponent can hit back
    const safe = Math.max(0.25, 1 - threat / 3);               // setting up only pays off if I'm not about to be knocked out
    const acc = mv.accuracy ?? 1;
    const healValue = (type, value, target) => {
      if (target && target !== "self") return 0;
      const maxHpV = ((atkView.stats && atkView.stats.hp) || 50) * 3;
      const frac = type === "flat" ? Math.min(1, (Number(value) || 0) / maxHpV) : Math.min(1, (Number(value) || 0) / 100);
      const restored = Math.min(frac, Math.max(0, 1 - atkView.hpFrac)); // healing at full health is worth nothing
      return 3 * restored * Math.max(0.4, 1 - threat / 5);
    };
    let v = 0;
    if (mv.action === "status") v += statusInflictValue(mv.statusEffect, mv.effectChance ?? 100, acc, defView);
    else if (mv.action === "heal") v += healValue(mv.healType, mv.healValue, mv.healTarget);
    else if (mv.action === "hazard") v += hazardValue(mv.hazardType, defView.side);
    else if (mv.action === "weather" || mv.action === "field") v += 0.4;
    else if (mv.action && mv.action !== "none") v += 0.3; // copy / steal / swap / transform… situational
    (mv.effects || []).forEach(fx => {
      const ch = (fx.chance ?? 100) / 100;
      if (fx.type === "statmod" || fx.type === "omniBoost") {
        const n = fx.type === "omniBoost" ? Math.max(1, (fx.statKeys || []).length) * 0.7 : 1; // several stats at once, with diminishing returns
        const stage = Math.max(-3, Math.min(3, Number(fx.statStage) || 0)) * n;
        if (fx.target === "self" || fx.target === "both") {
          if (stage > 0) v += 0.5 * stage * ch * safe;        // self boost
        } else if (stage < 0 && !blocksStatDrops(defView)) {
          v += 0.3 * (-stage) * ch * acc;                      // drop on the opponent
        }
      }
      else if (fx.type === "heal") v += healValue(fx.healType, fx.healValue, fx.target) * ch;
      else if (fx.type === "status") v += statusInflictValue(fx.statusEffect, 100, acc, defView) * ch;
      else if (fx.type === "hazard" && fx.target !== "self") v += hazardValue(fx.hazardType, defView.side) * ch;
      else if (fx.type === "shield") v += 0.6 * safe;
    });
    return Math.min(1.6, v);
  }
  const bestUtilityValue = (atkView, defView) => atkView.moves.reduce((m, mv) => Math.max(m, (mv && mv.name && mv.category === "Status") ? utilityValue(mv, atkView, defView) : 0), 0);
  // A kit with both a good attack and a good utility move is a bit better than either alone.
  function bestMoveValue(atkView, defView) {
    const att = bestAttackValue(atkView, defView), util = bestUtilityValue(atkView, defView);
    return Math.max(att, util) + 0.2 * Math.min(att, util);
  }

  // --- Steady / entry value of an ability or held item that isn't a damage multiplier, in points ---
  function abilityFlatPts(view, foe, entering) {
    const ab = view.ability; if (!ab) return 0;
    let pts = 0;
    const hpMax = ((view.stats && view.stats.hp) || 50) * 3;
    if (ab.abilityType === "passive") {
      const p = ab.passive;
      if (p.action === "heal" && (p.healTarget || "self") === "self") {
        const pct = (p.healType === "flat" ? 100 * (Number(p.healValue) || 0) / hpMax : (Number(p.healValue) || 0)) * chanceW(p.chance);
        const steady = p.trigger === "always" || p.trigger === "battleStart" || p.trigger === "weatherActive";
        pts += Math.min(8, pct * 0.8) * (steady ? 1 : 0.4);
      }
      else if (p.action === "auraField") pts += p.auraFieldTarget === "opponent" ? 6 : (p.auraFieldTarget === "self" ? -6 : 0);
      else if (p.action === "chipOnHit") pts += 3;
      else if (entering && p.action === "setWeather") pts += p.weatherSet !== weather ? 4 : 0;
      else if (entering && p.action === "setField") pts += p.fieldSet !== fieldEffect ? 4 : 0;
      else if (entering && p.action === "modifyStat" && triggerMatches(p.trigger, "battleStart")) pts += 3 * (Number(p.statStage) || 0) * chanceW(p.chance);
      else if (entering && p.action === "transformOnEntry") pts += 8;
    } else {
      const ac = ab.active;
      if (entering && ac.action === "setWeather") pts += ac.weatherSet !== weather ? 4 : 0;
      else if (entering && ac.action === "setField") pts += ac.fieldSet !== fieldEffect ? 4 : 0;
      else if (ac.action === "heal" && (ac.healTarget || "self") === "self") pts += 2;
    }
    if (blocksStatDrops(view)) pts += 3;
    return pts;
  }
  function itemFlatPts(view, foe, entering) {
    if (!view.item || !view.itemReady) return 0;
    let pts = 0;
    itemEffects(view).forEach(fx => {
      const v = Number(fx.value) || 0;
      switch (fx.action) {
        case "heal":
          if (!matchesHolderFilter(fx, view.entry)) break;
          if (fx.trigger === "turnEnd") pts += Math.min(8, v * 80);                              // Leftovers-style
          else if (view.hpFrac > 0.5 || fx.trigger === "onHpThreshold" || fx.trigger === "onUse") pts += 2 + Math.min(4, v * 16); // one-shot recovery (berries)
          break;
        case "preventFaint": if (view.hpFrac >= 0.99) pts += 5; break;                   // Focus Sash
        case "cureStatus": pts += 2; break;
        case "recoil": pts += 3; break;                                           // Rocky Helmet
        case "boostStat": if (entering && fx.trigger !== "onHpThreshold") pts += 3 * v; break;
        case "percentStatShift": if (entering) pts += 10 * v; break;
        case "firstTurnPriority": if (entering) pts += 3; break;
        case "terastallize": pts += 3; break;
        case "suppressAbility": if (foe.ability) pts += 4; break;
      }
    });
    const so = view.item.statusEffectOnUse;                                               // Flame/Toxic Orb-style, or one that hits the foe
    if (entering && so && so.effect && so.effect !== "none") {
      if (so.target === "self") pts -= (STATUS_PTS[lc(so.effect)] ?? 8) * chanceW(so.chance) * 0.5;
      else pts += 20 * statusInflictValue(so.effect, so.chance, 1, foe);
    }
    return pts;
  }
  const flatPts = (view, foe, entering) => clampN(abilityFlatPts(view, foe, entering) + itemFlatPts(view, foe, entering), -25, 25);

  // `entering` = this Fakemon is a teammate about to come in (so its entry effects count); false for the one already out.
  function matchupPoints(me, foe, entering) {
    const off = Math.min(60, 20 * bestMoveValue(me, foe));
    const def = Math.min(60, 20 * bestMoveValue(foe, me));
    const bst = Math.max(-10, Math.min(10, (bstOf(me) / Math.max(1, bstOf(foe)) - 1) * 20));
    const mySpe = (me.stats && me.stats.spe) || 50, foeSpe = (foe.stats && foe.stats.spe) || 50;
    const spe = mySpe > foeSpe ? 6 : (mySpe < foeSpe ? -6 : 0);
    const health = (me.hpFrac - 0.5) * 30;
    const sick = me.status ? -(STATUS_PTS[lc(me.status.kind)] ?? 8) : 0;
    const foeSick = foe.status ? 6 : 0;
    const boosts = me.stages ? Math.max(-12, Math.min(12, 3 * (me.stages.atk + me.stages.def + me.stages.spa + me.stages.spd + me.stages.spe))) : 0;
    const gear = flatPts(me, foe, !!entering) - 0.5 * flatPts(foe, me, false); // my ability/item value, minus half of what the foe's gives it
    return off - def + bst + spe + health + sick + foeSick + boosts + gear;
  }
  // Fraction of max HP the entry hazards on `side` would take off a given benched Fakemon the moment it arrives.
  function hazardFrac(side, view) {
    if (view.item && view.itemReady && view.item.immunities && view.item.immunities.hazard) return 0; // hazard-immune item
    const hz = hazards[side]; let frac = 0;
    if (hz.stealthrock) frac += 0.125;
    const flies = (view.types || []).includes("flying") || ((view.entry && view.entry.tags) || []).some(t => String(t).toLowerCase() === "levitating");
    if (hz.spikesStacks > 0 && !flies) frac += 0.125 * hz.spikesStacks;
    return frac;
  }
  const pts = n => (n >= 0 ? "+" : "") + Math.round(n);
  // Best teammate to bring in against the opponent's current Fakemon (null if nobody is eligible).
  function bestBenchPick(side) {
    const foe = viewActive(otherOf(side));
    let best = null;
    benchSlots(side).forEach(i => {
      const v = viewSlot(side, i), frac = hazardFrac(side, v);
      if (v.hpFrac - frac <= 0.02) return; // would be knocked out by the hazards on arrival
      const score = matchupPoints(v, foe, true) - frac * 60 + (Math.random() - 0.5); // tiny jitter so exact ties aren't always the same pick
      if (!best || score > best.score) best = { idx: i, score, view: v };
    });
    return best;
  }
  // Replacement after a faint: the best matchup if one is eligible, otherwise simply the first living teammate.
  function chooseReplacement(side) {
    const pick = bestBenchPick(side);
    return pick ? pick.idx : benchSlots(side)[0];
  }
  // Voluntary switch decision, made at the top of every round:
  //   1. How good is the CURRENT Fakemon against what is on the other side? (points above)
  //   2. Only if it is clearly in a bad spot (below AI.trigger)…
  //   3. …and a teammate scores at least AI.margin points better even after the switch cost (AI.tax) and entry hazards…
  //   4. …and the cooldown is over and it hasn't used up AI.maxSwitches, then it switches (with probability AI.chance, so the bot isn't perfectly predictable).
  // ---- Trap Opponent: returns the trapping ability if `side`'s active Fakemon is currently trapped, else null. ----
  const AIRBORNE_TAGS = ["flying", "floating", "levitating", "airborne"];
  function trappedBy(side) {
    const foe = otherOf(side), ab = ability[foe];
    if (!teamMode || hp[foe] <= 0 || !ab || ab.abilityType !== "passive" || ab.passive.action !== "trapSwitch" || isAbilityNullified(foe)) return null;
    const p = ab.passive, f = fighters[side];
    if (p.trapScope === "all") return ab;
    const fTypes = (f.types || []).map(t => String(t).toLowerCase());
    const fTags = (f.tags || []).map(t => String(t).toLowerCase());
    const wantTags = String(p.trapTags || "").split(",").map(t => t.trim().toLowerCase()).filter(Boolean);
    const typeHit = (p.trapTypes || []).some(t => fTypes.includes(t));
    const tagHit = wantTags.some(t => AIRBORNE_TAGS.includes(t) ? !isGrounded(f) : (fTags.includes(t) || fTypes.includes(t)));
    const hit = p.trapScope === "types" ? typeHit : p.trapScope === "tags" ? tagHit : (typeHit || tagHit);
    return hit ? ab : null;
  }
  function planSwitch(side) {
    // ---- Doom Countdown: a doomed Fakemon gets TOP switching priority (ignores cooldown, limits, odds and matchup) ----
    if (teamMode && AI.enabled && doomCount[side] > 0 && hp[side] > 0 && benchLeft(side)) {
      const dpick = bestBenchPick(side);
      if (dpick) {
        const dTrap = trappedBy(side);
        if (dTrap) { log.push(`🧲 ${fighters[side].name} can't switch out! ${fighters[otherOf(side)].name}'s ${dTrap.name} holds it in place!`); }
        else return { to: dpick.idx, cur: 0, cand: dpick.score };
      }
    }
    if (!teamMode || !AI.enabled || hp[side] <= 0 || switchCooldown[side] > 0 || switchCount[side] >= AI.maxSwitches || charging[side]) return null;
    if (status[side] && status[side].kind === "repeat") return null; // locked into repeating a move
    if (!benchLeft(side)) return null;
    const foe = viewActive(otherOf(side));
    const cur = matchupPoints(viewActive(side), foe, false);
    if (cur > AI.trigger) return null;
    const pick = bestBenchPick(side);
    if (!pick) return null;
    const cand = pick.score - AI.tax;
    if (cand - cur < AI.margin) return null;
    if (Math.random() > AI.chance) return null;
    const trapAb = trappedBy(side);
    if (trapAb) { log.push(`🧲 ${fighters[side].name} can't switch out! ${fighters[otherOf(side)].name}'s ${trapAb.name} holds it in place!`); return null; }
    return { to: pick.idx, cur, cand: pick.score };
  }
  function voluntarySwitch(side, plan) {
    const out = fighters[side], foeName = fighters[otherOf(side)].name;
    runSwitchOutHooks(side);
    saveActiveSlot(side);
    log.push(`🧮 Team ${side.toUpperCase()} reads the matchup: ${out.name} is at ${pts(plan.cur)} pts vs ${foeName}, ${slots[side][plan.to].entry.name} would be at ${pts(plan.cand)}.`);
    log.push(`➡️ Team ${side.toUpperCase()} withdraws ${out.name}! (${hp[side]}/${maxHp[side]} HP)`);
    enterSlot(side, plan.to);
    switchCooldown[side] = AI.cooldown;
    switchCount[side]++;
    switchedThisRound[side] = true;
  }

  // ---- Switch-Out Trigger: runs the leaving Fakemon's "When Switching Out" ability (passive action + Additional
  // Effects, e.g. Trigger Alternate Form) BEFORE its state is saved, so it is stored — and returns — changed. ----
  function runSwitchOutHooks(side) {
    const ab = ability[side];
    if (!teamMode || hp[side] <= 0 || !ab || ab.abilityType !== "passive" || ab.passive.trigger !== "onSwitchOut" || isAbilityNullified(side)) return;
    suppressFormEntryAbility = true;
    try {
      runAbilityAction(ab, side, { hasDamage: false }, log);
      runEffectsFrom(ab, ab.effects, side);
    } finally { suppressFormEntryAbility = false; }
  }
  // ---- Ally-Hit Trigger + Switch In effect: applyAllyHitTriggers() runs the moment a huge hit lands on the
  // active teammate; a "Switch In" effect only QUEUES the owner (pendingSwitchIn), and resolveSwitchIns() carries
  // it out at the next safe point (right after the attacker's action), so the swap never happens in the middle
  // of a move's own damage/effect resolution. ----
  function resolveSelfFaints() {
    ["a", "b"].forEach(sd => {
      if (!pendingSelfFaint[sd]) return;
      pendingSelfFaint[sd] = false;
      if (hp[sd] > 0) { hp[sd] = 0; log.push(`${fighters[sd].name} fainted from the blast!`); }
    });
  }
  // Add Type: takes added types back off. leaving=true drops every non-"battle" addition (it left the field);
  // otherwise only the entries in `only` are removed. ----
  function removeAddedType(side, entry) {
    const f = fighters[side], ts = (f && f.types) || [];
    const idx = ts.lastIndexOf(entry.type);
    if (idx >= 0) { f.types = ts.filter((_, i) => i !== idx); if (!f.types.length) f.types = ["normal"]; }
  }
  function removeAddedTypes(side, leaving) {
    typeAdds[side] = typeAdds[side].filter(entry => {
      if (leaving && entry.mode !== "battle") { removeAddedType(side, entry); log.push(`🧬 ${fighters[side].name} loses its added ${cap(entry.type)} typing.`); return false; }
      return true;
    });
  }
  function pickMetronomeMove(side, srcMove, pool) {
    if (pool === "own") { // only this Fakemon's own other moves (usable ones)
      const own = (fighters[side].moves || []).filter(m => m.name && m.name !== srcMove.name && (movePP[side][m.name] ?? 1) > 0
        && !(m.effects || []).some(f => f.type === "metronome" || f.type === "snatch"));
      return own.length ? own[Math.floor(Math.random() * own.length)] : null;
    }
    if (!metronomePool) {
      const seen = new Map();
      const roster = (typeof entries !== "undefined" && entries) || (typeof window !== "undefined" && window.entries) || [];
      roster.forEach(en => (en.moves || []).forEach(raw => {
        if (!raw || !raw.name) return;
        const m = normalizeMove(raw);
        if ((m.effects || []).some(f => f.type === "metronome" || f.type === "snatch")) return;
        if (!seen.has(m.name.toLowerCase())) seen.set(m.name.toLowerCase(), m);
      }));
      metronomePool = [...seen.values()];
    }
    return metronomePool.length ? metronomePool[Math.floor(Math.random() * metronomePool.length)] : null;
  }
  // Bond: damage / faint sharing, run from applyItemOnHit() after every hit that lands on the bonded user.
  function applyBondOnHit(defSide, atkSide, hpBeforeHit) {
    const b = bondState[defSide];
    if (!b || atkSide === defSide || fighters[atkSide] !== b.partner || hp[atkSide] <= 0) return;
    if (b.onDamage && hp[defSide] < hpBeforeHit) {
      const share = Math.max(1, Math.round((hpBeforeHit - hp[defSide]) * b.damagePct / 100));
      hp[atkSide] = Math.max(0, hp[atkSide] - share);
      log.push(`🔗 ${b.name}: ${fighters[atkSide].name} shares the pain and takes ${share} damage!`);
    }
    if (b.onFaint && hp[defSide] <= 0 && hp[atkSide] > 0) {
      hp[atkSide] = 0;
      log.push(`🔗 ${b.name}: ${fighters[defSide].name} took ${fighters[atkSide].name} down with it!`);
    }
  }
  // Bond: status sharing, checked between actions.
  function syncBondStatus() {
    ["a", "b"].forEach(sd => {
      const b = bondState[sd];
      if (!b || !b.onStatus || hp[sd] <= 0) return;
      const psd = otherOf(sd);
      if (fighters[psd] !== b.partner || hp[psd] <= 0) return;
      const cur = status[sd] ? status[sd].kind : null;
      if (cur && cur !== b.lastStatus && !status[psd]) {
        status[psd] = { ...status[sd] };
        log.push(`🔗 ${b.name}: ${fighters[psd].name} suffers ${cur} too!`);
      }
      b.lastStatus = cur;
    });
  }
  function runEffectsFrom(src, effects, side, chanceMult) {
    const prev = currentSourceName;
    currentSourceName = (src && src.name) || prev;
    try { return runEffectsArray(effects, side, chanceMult); } finally { currentSourceName = prev; }
  }
  function benchAbilityOf(side, i) {
    const sl = slots[side][i];
    return sl.saved ? sl.saved.ability : sl.rolledAbility;
  }
  function applyAllyHitTriggers(defSide, atkSide, hpBeforeHit) {
    if (!teamMode || atkSide === defSide || hpBeforeHit <= 0) return;
    const lethal = hp[defSide] <= 0;
    // Multi-hit moves: once a switch-in is queued, later hits can't finish the protected teammate off.
    if (pendingSwitchIn[defSide]) { if (lethal) hp[defSide] = 1; return; }
    const dmgPct = Math.max(0, hpBeforeHit - hp[defSide]) / Math.max(1, maxHp[defSide]) * 100;
    for (const i of benchSlots(defSide)) {
      const gab = benchAbilityOf(defSide, i);
      if (!gab || gab.abilityType !== "passive" || gab.passive.trigger !== "allyHugeHit") continue;
      if (allyTriggerUsed[defSide + i]) continue;
      if (!(lethal || dmgPct >= gab.passive.allyHitPct)) continue;
      allyTriggerUsed[defSide + i] = true;
      const allyName = fighters[defSide].name;
      if (lethal) hp[defSide] = 1;
      log.push(`🛡️ ${slots[defSide][i].entry.name}'s ${gab.name} reacts to the huge hit on ${allyName}!` + (lethal ? ` ${allyName} is left at 1 HP!` : ``));
      benchSwitchCtx = { side: defSide, idx: i };
      try {
        runAbilityAction(gab, defSide, { hasDamage: false }, log);
        runEffectsFrom(gab, gab.effects, defSide);
      } finally { benchSwitchCtx = null; }
      return;
    }
  }
  function resolveSwitchIns() {
    ["a", "b"].forEach(sd => {
      const pg = pendingSwitchIn[sd];
      if (!pg) return;
      pendingSwitchIn[sd] = null;
      if (!teamMode || hp[sd] <= 0 || !benchSlots(sd).includes(pg.idx)) return; // the teammate fell anyway, or the owner is gone
      const out = fighters[sd];
      const keepStages = pg.baton ? { ...stages[sd] } : null;   // Baton Pass hands its stat stages to the replacement
      runSwitchOutHooks(sd);
      saveActiveSlot(sd);
      log.push(`➡️ Team ${sd.toUpperCase()} withdraws ${out.name}! (${hp[sd]}/${maxHp[sd]} HP)`);
      enterSlot(sd, pg.idx);
      if (keepStages) { Object.assign(stages[sd], keepStages); log.push(`🎒 ${fighters[sd].name} inherits the passed stat changes!`); }
      switchedThisRound[sd] = true; // the new arrival uses this turn to come in
    });
  }

  let turn = 0;
  if (teamMode && teamOpts && typeof teamOpts.debug === "function") teamOpts.debug({ matchupPoints, viewActive, viewSlot, bestMoveValue, bestAttackValue, bestUtilityValue });
  while (sideHasMons("a") && sideHasMons("b") && turn < turnCap) {
    turn++;

    // ---- TEAM MODE: voluntary switching. Both sides decide on the same information at the top of the round,
    // then switch BEFORE any attack, so whoever comes in takes the hit meant for the Fakemon that left. A side
    // that switched uses its turn for it (it skips its move below). ----
    if (teamMode) {
      ["a", "b"].forEach(sd => { switchedThisRound[sd] = false; snatchReady[sd] = false; if (switchCooldown[sd] > 0) switchCooldown[sd]--; });
      const plans = { a: planSwitch("a"), b: planSwitch("b") };
      ["a", "b"].forEach(sd => { if (plans[sd]) voluntarySwitch(sd, plans[sd]); });
    }

    // ---- Multi-Mega Evolution: Held Mega Stone (per-round chance) and Turn Threshold requirements are
    // both re-checked here, once at the top of every round, for both sides ----
    tryMegaEvolve("a", null);
    tryMegaEvolve("b", null);
    // ---- Terastallization: manual (ON_USER_INTENT) activation, checked once at the top of every
    // round for both sides — see tryTerastallize()/activateTeraState() above. ----
    tryTerastallize("a");
    tryTerastallize("b");

    // ---- Aura / Field Abilities: passive chip damage applied to the field every turn ----
    if (auraField) {
      const targets = auraField.target === "both" ? ["a", "b"] : [auraField.target === "self" ? auraField.side : otherOf(auraField.side)];
      targets.forEach(t => {
        if (hp[t] <= 0) return;
        const dmg = Math.max(1, Math.round(maxHp[t] * (auraField.percent / 100)));
        hp[t] = Math.max(0, hp[t] - dmg);
        log.push(`${fighters[t].name} takes ${dmg} damage from the ${cap(auraField.type)} Aura!`);
      });
    }

    // ---- Contextual Status Interaction ("Wet"): auto-applies field-wide while Rain is active, EXCEPT to
    // Ground / Steel / Water types (immunity check) — OR stays true for a side a Move has directly
    // inflicted the "wet" status onto (handled by the normal Inflict Status Effect path + isStatusImmune). ----
    wetFlag.a = ((weather === "rain" || weather === "thunderstorm") && !isWetImmune(fighters.a.types)) || (status.a && status.a.kind === "wet");
    wetFlag.b = ((weather === "rain" || weather === "thunderstorm") && !isWetImmune(fighters.b.types)) || (status.b && status.b.kind === "wet");

    // ---- Expanded Weather: Snow gives non-immune combatants a per-round chance to freeze in place
    // (Ice/Fire/Rock/Steel types are immune, enforced by isStatusImmune's built-in elemental table) ----
    if (weather === "snow") {
      ["a", "b"].forEach(side => {
        if (hp[side] <= 0 || status[side]) return;
        const defender = fighters[side];
        if (itemBlocksStatus(side, "freeze")) return;
        if (isStatusImmune(defender.types, "freeze", null, defender.tags, fieldEffect)) return;
        if (chanceHits(15)) {
          status[side] = { kind: "freeze", counter: 1, turnsLeft: 1 + Math.floor(Math.random() * 3) };
          log.push(`${defender.name} is coated in snow and freezes solid!`);
        }
      });
    }

    // ---- Passive Rule: "While Weather Is Active" trigger — re-checked every round against the live
    // field weather. IF the ability's trigger is weatherActive AND the field weather matches the
    // ability's configured Weather Must Be, THEN its passive action runs — ELSE it stays dormant. ----
    ["a", "b"].forEach(side => {
      const ab = ability[side];
      if (ab && ab.abilityType === "passive" && ab.passive.trigger === "weatherActive"
        && evaluateEnvironmentalCondition("weatherIs", ab.passive, weather)) {
        runAbilityAction(ab, side, { hasDamage: false }, log);
        runEffectsFrom(ab, ab.effects, side);
      }
    });

    // ---- WHO/WHAT/WHEN/HOW matrix: HP-threshold / status-active conditions are re-checked every round ----
    ["a", "b"].forEach(side => {
      const ab = ability[side];
      if (ab) { runMatrixEffects(ab.effects, side, "onHpThreshold"); runMatrixEffects(ab.effects, side, "onStatusActive"); }
    });

    const paraSlowA = status.a && status.a.kind === "paralysis" ? 0.5 : 1;
    const paraSlowB = status.b && status.b.kind === "paralysis" ? 0.5 : 1;
    // ---- Nighttime: Grass types are slowed (unless their ability Ignores Weather Effects for Nighttime) ----
    const nightSlowA = (weather === "nighttime" && fighters.a.types.includes("grass") && !ignoresWeatherEffect(ability.a, "nighttime")) ? 0.67 : 1;
    const nightSlowB = (weather === "nighttime" && fighters.b.types.includes("grass") && !ignoresWeatherEffect(ability.b, "nighttime")) ? 0.67 : 1;
    // ---- Flood: Water types act faster, everyone else is slowed, Flying is immune — see
    // floodTypeSpeedFactor() for the shared logic (also used by the Dodge calculation) ----
    const floodSpeedA = floodTypeSpeedFactor(fighters.a.types);
    const floodSpeedB = floodTypeSpeedFactor(fighters.b.types);
    const speedA = ((fighters.a.stats && fighters.a.stats.spe) || 50) * stageMult(stages.a.spe) * paraSlowA * nightSlowA * floodSpeedA * abilitySpeedMult("a") * slowStartMult("a", "spe") * (0.9 + Math.random() * 0.2);
    const speedB = ((fighters.b.stats && fighters.b.stats.spe) || 50) * stageMult(stages.b.spe) * paraSlowB * nightSlowB * floodSpeedB * abilitySpeedMult("b") * slowStartMult("b", "spe") * (0.9 + Math.random() * 0.2);
    let order = speedA >= speedB ? ["a", "b"] : ["b", "a"];

    // ---- PP-aware move pre-selection for BOTH sides, needed up front so the Priority Hook below can inspect it ----
    // Smart AI: skip status-inflicting moves if the opponent is already afflicted, to avoid wasted turns.
    const chosenMove = {};
    ["a", "b"].forEach(side => {
      const otherSide = otherOf(side);
      const attacker = fighters[side];
      const ab = ability[side];
      if (ab) runMatrixEffects(ab.effects, side, "onMoveSelect");
      // ---- Multi-Turn Charge Execution (Solar Beam / Skull Bash Mechanics): while mid-charge, this side
      // may ONLY execute the move it's charging — bypasses normal AI move-pool selection entirely. ----
      if (charging[side]) {
        const forcedChargeMove = (attacker.moves || []).find(m => m.name === charging[side].moveName);
        if (forcedChargeMove) { chosenMove[side] = forcedChargeMove; return; }
        charging[side] = null; // movepool no longer has it (edge case) — fall through to normal selection
      }
      // ---- Forced Action Status ("Repeat"): while active, this side may ONLY execute its Last Used
      // Move for the remaining duration — bypasses normal AI move-pool selection entirely. IF the move
      // it last used still has PP left THEN it is forced again — ELSE selection falls through to normal
      // rules below (e.g. it ran out of PP and must Struggle). ----
      if (status[side] && status[side].kind === "repeat" && lastUsedMove[side]) {
        const forcedMove = (attacker.moves || []).find(m => m.name === lastUsedMove[side] && (movePP[side][m.name] ?? 1) > 0 && (moveCooldowns[side][m.name] || 0) <= 0);
        if (forcedMove) { chosenMove[side] = forcedMove; return; }
      }
      // ---- Random Move Transmutation (Metronome/Mirror Move-style): if flagged by a prior effect,
      // this side's move is picked fully at random from its own movepool this turn, bypassing the
      // normal PP/cooldown/taunt-aware AI selection below entirely — then the flag is consumed. ----
      if (forcedRandomMove[side]) {
        forcedRandomMove[side] = false;
        const namedMoves = (attacker.moves || []).filter(m => m.name);
        if (namedMoves.length) {
          chosenMove[side] = namedMoves[Math.floor(Math.random() * namedMoves.length)];
          log.push(`${attacker.name}'s move is randomly transmuted into ${chosenMove[side].name}!`);
          return;
        }
      }
      // ---- Move Cooldowns: a move whose cooldown timer hasn't reached 0 is excluded from the selectable pool ----
      const withPP = (attacker.moves || []).filter(m => m.name && (movePP[side][m.name] ?? 1) > 0 && (moveCooldowns[side][m.name] || 0) <= 0);
      // ---- Taunt: prevents the use of non-damaging (Status) moves while active ----
      const tauntActive = status[side] && status[side].kind === "taunt";
      const tauntFiltered = tauntActive ? withPP.filter(m => m.category !== "Status") : withPP;
      const pool = tauntFiltered.length ? tauntFiltered : withPP;
      // ---- Custom Status: Lost Control — Action Lock. Only attacking (Physical/Special) moves may be
      // selected while active; healing moves and defensive/protective moves (both Status-category, e.g.
      // Recover, Protect) are excluded from the pool entirely. Falls back to the untouched pool if the
      // lock would otherwise leave nothing selectable (e.g. an all-Status movepool). ----
      const lostControlActive = status[side] && status[side].kind === "lostcontrol";
      const lostControlFiltered = lostControlActive ? pool.filter(m => m.category !== "Status") : pool;
      const attackLockedPool = lostControlFiltered.length ? lostControlFiltered : pool;
      const nonRedundant = attackLockedPool.filter(m => !(m.category === "Status" && m.action === "status" && m.statusEffect && m.statusEffect !== "none" && status[otherSide]));
      const usable = nonRedundant.length ? nonRedundant : attackLockedPool;
      chosenMove[side] = usable.length
        ? usable[Math.floor(Math.random() * usable.length)]
        : { name: "Struggle", type: attacker.types[0], category: "Physical", desc: "", accuracy: 1, pp: 1, maxPP: 1, basePower: 50, hits: 1, action: "none", statusEffect: "none", statusDurationMode: "random", statusDurationMin: 1, statusDurationMax: 3, statusDurationFixed: 5, effectChance: 100, healType: "percent", healValue: 25, healTarget: "self", weather: "clear", weatherDuration: 5, field: "none", fieldDuration: 5, setsField: false, hazardType: "stealthrock", effects: [], tags: [], weightScaling: "none", damageBasis: "standard", historyScaling: "none", historyScalingStepPct: 100, pollutedPoisonChance: 15, ignoreDefense: false, ignoreShields: false, stateImmunity: { enabled: false, key: "hidden", exceptions: [], expireEvent: "onAttack", expireDurationTurns: 2 }, chargeUp: { enabled: false, duration: 1, condition: "none", shieldPercent: 50, healPercent: 25 }, delayedAttack: { enabled: false, delayTurns: 2, statSnapMode: "launch", ignoreTypeImmunity: false }, critRateMode: "normal", cooldownTurns: 0, dynamicTypeEnabled: false, dynamicTypeTarget: "normal", dynamicTypeMode: "superEffective", recoilPercent: 0, statusDamageMultiplier: 1, statusDamageMultFilter: "any", failCondition: "none", failWeather: "sun", failField: "grassy", rule: { enabled: false, ruleType: "passive", passive: normalizePassiveRule(), active: normalizeActiveRule() } };
    });

    // ---- Move Priority Brackets: a strictly higher move.priority acts first regardless of raw Speed;
    // equal priority on both sides leaves the existing Speed-based order untouched. Resolved here,
    // right after both sides' moves are chosen (so it can read chosenMove) and before the ability-
    // based First-Strike Priority Hook below, which can still override it further if triggered. ----
    {
      // Item Dex: First-Turn Priority hook folded in here — getEffectivePriority() adds the item's
      // one-shot bonus on top of the move's own priority the first time each side actually acts.
      const pa = getEffectivePriority("a", chosenMove.a);
      const pb = getEffectivePriority("b", chosenMove.b);
      if (pa !== pb) {
        order = pa > pb ? ["a", "b"] : ["b", "a"];
      }
    }

    // ---- Speed State Priority Brackets: First-Strike Priority Hook forces this side to act first if the ----
    // ---- opponent just chose an offensive (non-Status) move, regardless of raw Speed. ----
    ["a", "b"].forEach(side => {
      const otherSide = otherOf(side);
      const ab = ability[side];
      if (ab && ab.abilityType === "active" && ab.active.condition === "opponentOffensive" && ab.active.action === "firstStrikePriority"
        && !(ab.active.oncePerBattle && abilityTriggered[side]) && chosenMove[otherSide].category !== "Status" && chanceHits(ab.active.chance)) {
        if (order[0] !== side) {
          order = [side, otherSide];
          log.push(`${fighters[side].name}'s ${ab.name} seizes the initiative!`);
        }
        if (ab.active.oncePerBattle) abilityTriggered[side] = true;
      }
    });

    for (const side of order) {
      resolveSelfFaints();
      resolveSwitchIns(); // Switch In effect: carry out any forced switch-in queued by the previous action
      syncBondStatus();
      const otherSide = otherOf(side);
      if (hp[side] <= 0 || hp[otherSide] <= 0) continue;
      if (teamMode && switchedThisRound[side]) continue; // its turn was spent switching
      const attacker = fighters[side], defender = fighters[otherSide];
      const ab = ability[side]; // this side's active/passive ability, if any — used by the Dynamic PP Cost check below

      // ---- Loaf Around (Truant-style): skips this side's ENTIRE turn on its configured cycle, checked
      // directly against the round counter — ALWAYS applies regardless of this ability's own Trigger
      // dropdown, same as Boost Tag Move / Move Type Override / Wonder Guard elsewhere in this file. ----
      if (ab && !isAbilityNullified(side) && ab.abilityType === "passive" && ab.passive.action === "loafAround") {
        const n = ab.passive.loafInterval;
        const cyclePos = (turn - 1) % n;
        const isLoafTurn = ab.passive.loafStartsActive ? (cyclePos !== 0) : (cyclePos === 0);
        if (isLoafTurn) { log.push(`${attacker.name} is loafing around!`); continue; }
      }

      // ---- PP-aware move (already chosen above so the Priority Hook could inspect it this round),
      // resolved through the Tag-Based Move Transformations pipeline BEFORE the status-lockout phase
      // below, since Status-Bypass checks (and the status phase itself) need to read the move's final
      // tags/flags. applyMoveTagRules() returns a fresh working copy — chosenMove[side] itself, and the
      // creature's stored movepool entry, are left untouched. ----
      let move = applyMoveTagRules(chosenMove[side]);

      // ---- Metronome: this move is swapped for a random move from the whole roster, which then runs normally
      // with the user's own stats. The Metronome move itself pays the PP. ----
      if (move.effects && move.effects.some(f => f.type === "metronome")) {
        const metroFx = move.effects.find(f => f.type === "metronome");
        const picked = pickMetronomeMove(side, move, metroFx && metroFx.metronomePool);
        if (movePP[side][move.name] != null) movePP[side][move.name] = Math.max(0, movePP[side][move.name] - 1);
        if (!picked) { log.push(`${attacker.name} used ${move.name}! But there was no move to use!`); continue; }
        log.push(`${attacker.name} used ${move.name}! It waggled a finger and chose ${picked.name}!`);
        move = { ...applyMoveTagRules(picked), metronomed: true };
      }

      // ---- Ability-Driven Move Type Override (Normalize/Galvanize/Pixilate/Refrigerate-style): rewrites
      // this move's Type (and optionally scales its Base Power) BEFORE every later type-dependent check
      // reads move.type — type effectiveness, STAB, weather-synergy boosts, and the Unified Rule
      // Builder's own Filter (Move Type) gates all key off this SAME working-copy object, so applying the
      // override this early makes all of them cascade correctly. Like Boost Tag Move elsewhere in this
      // file, it ALWAYS fires on the ability owner's own attack and ignores its own Trigger dropdown
      // entirely, so it can never end up mis-wired to "When Defending" and rewrite the OPPONENT's
      // incoming move instead. ----
      const atkAbilityForTypeOverride = ability[side];
      if (atkAbilityForTypeOverride && !isAbilityNullified(side) && atkAbilityForTypeOverride.abilityType === "passive"
        && atkAbilityForTypeOverride.passive.action === "moveTypeOverride") {
        const ov = atkAbilityForTypeOverride.passive;
        const fromOk = ov.moveTypeFrom === "any" || move.type === ov.moveTypeFrom;
        if (fromOk && move.type !== ov.moveTypeTo) {
          const newPower = (ov.moveTypeBoost != null && ov.moveTypeBoost !== 1 && move.basePower)
            ? Math.round(move.basePower * ov.moveTypeBoost) : move.basePower;
          move = { ...move, type: ov.moveTypeTo, basePower: newPower };
          log.push(`${attacker.name}'s ${atkAbilityForTypeOverride.name} turns ${move.name} into a ${cap(ov.moveTypeTo)}-type move!`);
        }
      }

      const bypass = move.statusBypass || {};

      // ---- Custom Weather: accuracy multiplier on every move ----
      if (CUSTOM_WEATHERS[weather] && CUSTOM_WEATHERS[weather].accMult !== 1) {
        move = { ...move, accuracy: Math.max(0, Math.min(1, (move.accuracy ?? 1) * CUSTOM_WEATHERS[weather].accMult)) };
      }
      // ---- Weather Accuracy Rules: while the matching weather is active, swap in the rule's Accuracy and/or make
      // the move never miss (feeds the same "unavoidable" gate as other never-miss effects below). ----
      if (move.weatherAccuracy && move.weatherAccuracy.length) {
        const wr = move.weatherAccuracy.find(r => r.weather === weather);
        if (wr) move = { ...move, accuracy: wr.neverMiss ? 1 : (wr.accuracy != null ? wr.accuracy : move.accuracy), weatherNeverMiss: !!wr.neverMiss };
      }

      // ---- Sleep: Status-Bypass override lets a flagged move (Sleep Talk/Snore-style) execute anyway
      // WITHOUT waking the user up — sleep continues to tick down normally on subsequent turns. ----
      if (status[side] && status[side].kind === "sleep" && !bypass.sleep) { log.push(`${attacker.name} is fast asleep.`); continue; }
      if (status[side] && status[side].kind === "sleep" && bypass.sleep) { log.push(`${attacker.name} murmurs in its sleep and uses ${move.name} anyway!`); }
      // ---- Freeze: fully immobilized (Ice/Fire/Rock/Steel types are immune, enforced at application time).
      // Status-Bypass override auto-thaws the user (clears the freeze status entirely) and lets the move
      // execute this same turn, exactly like a Flame Wheel/Scald-style thaw move. ----
      if (status[side] && status[side].kind === "freeze") {
        if (!bypass.freeze) { log.push(`${attacker.name} is frozen solid and can't move!`); continue; }
        status[side] = null;
        log.push(`${attacker.name} thawed out and used ${move.name}!`);
      }

      // ---- Fails Against Fakemon Tags (e.g. "grounded": Whirlwind / Telekinesis / Sky Drop vs a buried Fakemon). ----
      if (move.failsAgainstTags && move.failsAgainstTags.length) {
        const tagSide = move.failsAgainstTagsOn === "self" ? side : otherSide;
        const hitTag = move.failsAgainstTags.find(t => fighterHasTag(fighters[tagSide], t));
        if (hitTag) {
          if (movePP[side][move.name] != null) movePP[side][move.name] = Math.max(0, movePP[side][move.name] - 1);
          log.push(`${attacker.name} tried to use ${move.name}... but ${fighters[tagSide].name} is ${canonTag(hitTag)}!`);
          continue;
        }
      }

      // ---- Lift: an airborne Fakemon (with Ground Immunity on) can't be hit by damaging Ground-type moves. ----
      if (move.category !== "Status" && move.type === "ground" && liftState[otherSide] && liftState[otherSide].groundImmune) {
        if (movePP[side][move.name] != null) movePP[side][move.name] = Math.max(0, movePP[side][move.name] - 1);
        log.push(`${attacker.name} used ${move.name}! But it doesn't affect ${fighters[otherSide].name}, who is airborne!`);
        continue;
      }

      // ---- Auto-Fail Moves of a Type: a damaging move of the blocked type fails outright. ----
      if (move.category !== "Status") {
        const blocker = [otherSide, side].find(sd => {
          const bab = ability[sd];
          return bab && bab.abilityType === "passive" && bab.passive.action === "blockMoveType" && hp[sd] > 0 && !isAbilityNullified(sd)
            && bab.passive.blockType === move.type && (bab.passive.blockScope === "all" || sd !== side);
        });
        if (blocker) {
          if (movePP[side][move.name] != null) movePP[side][move.name] = Math.max(0, movePP[side][move.name] - 1);
          log.push(`${attacker.name} used ${move.name}! But it failed! (${ability[blocker].name})`);
          continue;
        }
      }

      // ---- Snatch: a waiting snatcher steals this STATUS move — its Additional Effects apply to the snatcher
      // and the original user's turn is spent (PP is still used). ----
      if (move.category === "Status" && snatchReady[otherSide] && hp[otherSide] > 0 && move.effects && move.effects.length) {
        snatchReady[otherSide] = false;
        log.push(`🪝 ${fighters[otherSide].name} snatched ${attacker.name}'s ${move.name}!`);
        if (movePP[side][move.name] != null) movePP[side][move.name] = Math.max(0, movePP[side][move.name] - 1);
        runEffectsFrom(move, move.effects, otherSide, 1);
        continue;
      }
      // ---- Flinch: the shortest effect — blocks exactly this one action, then clears immediately ----
      if (status[side] && status[side].kind === "flinch") { log.push(`${attacker.name} flinched and couldn't move!`); status[side] = null; continue; }
      if (status[side] && status[side].kind === "paralysis" && Math.random() < 0.25) { log.push(`${attacker.name} is paralyzed! It can't move.`); continue; }
      // ---- Infatuated: 50% chance to lock up, but only while facing the specific fighter it's
      // smitten with (status[side].infatuatedWith) AND their genders are still compatible (see
      // isGenderCompatible() — covers the edge case where the crush got replaced mid-battle by
      // something Genderless/same-gender via Transform/Imposter). Persists until cured — it never
      // ticks down or clears itself on its own. ----
      if (status[side] && status[side].kind === "infatuated" && status[side].infatuatedWith === otherSide
        && isGenderCompatible(attacker.gender, defender.gender, attacker.tags, defender.tags) && Math.random() < 0.5) {
        log.push(`${attacker.name} is infatuated with ${defender.name}! It's ${defender.gender === "Genderless" ? "genderless" : `a ${defender.gender}`}! Can't move ❤️`);
        continue;
      }
      // ---- Confusion: 25% self-hit / 50% do nothing / 25% acts normally. Status-Bypass / Forced Action
      // override skips this roll entirely and lets the flagged move proceed straight through as if the
      // creature weren't confused at all — the confusion status itself is left active/ticking. ----
      if (status[side] && status[side].kind === "confusion" && !bypass.confusion) {
        const r = Math.random();
        if (r < 0.25) {
          // ---- BUGFIX: confusion self-hit used to be a flat 8%-of-max-HP number that ignored the
          // attacker's actual Attack/Defense (and anything boosting them) entirely. It now runs through
          // the SAME stat pipeline as a real attack — stat stages, Item Dex Stat Shifts, field stat
          // effects, and any active generic damage-boosting item effects — mirroring the real games'
          // "typeless 40 BP physical hit against your own Defense" self-hit, so a stat-boosting item or
          // a stat-stage buff now actually raises how hard a confused attacker hits itself.
          // Type/tag-specific item boosts are intentionally excluded (move passed as null below) since
          // a self-hit has no move type of its own for those filters to match against. ----
          let selfAtk = (attacker.stats && attacker.stats.atk) || 50;
          let selfDef = (attacker.stats && attacker.stats.def) || 50;
          selfAtk *= stageMult(stages[side].atk);
          selfDef *= stageMult(stages[side].def);
          selfAtk *= getStatShiftMultiplier(side, "atk");
          selfDef *= getStatShiftMultiplier(side, "def");
          selfAtk *= fieldStatMult(side);
          selfDef *= fieldStatMult(side);
          const selfMult = getActiveStatBuffDamageBonus(side) * getItemTimedDamageBoostMultiplier(side, null);
          const selfVariance = 0.85 + Math.random() * 0.3;
          const selfDmg = Math.max(1, Math.round((selfAtk / Math.max(20, selfDef)) * 26 * selfMult * selfVariance * (40 / 60)));
          const hpBeforeSelfHit = hp[side];
          hp[side] = Math.max(0, hp[side] - selfDmg);
          log.push(`${attacker.name} is confused and hurt itself in its confusion! (${selfDmg} dmg)`);
          // ---- BUGFIX: a self-inflicted hit is still a hit — it used to skip every "took damage" hook
          // entirely. Focus Sash/Sitrus-Berry-style item effects (preventFaint/heal/onHpThreshold, via
          // applyItemOnHit) and any passive "After Getting Hit" ability now fire off this damage too,
          // just like they would off a hit from the opponent. Rocky-Helmet-style "hurt the attacker"
          // item actions are skipped here (guarded inside applyItemOnHit) since attacker and defender
          // are the same fighter — that one would just be a confusing double-hit on yourself. ----
          applyItemOnHit(side, side, null, hpBeforeSelfHit);
          const selfHitAbility = ability[side];
          if (selfHitAbility && selfHitAbility.abilityType === "passive" && triggerMatches(selfHitAbility.passive.trigger, "afterHit") && passiveApplies(selfHitAbility, null)) {
            runAbilityAction(selfHitAbility, side, { hasDamage: false }, log);
            runEffectsFrom(selfHitAbility, selfHitAbility.effects, side);
          }
          continue;
        } else if (r < 0.75) {
          log.push(`${attacker.name} is confused and couldn't act.`);
          continue;
        }
        // else: falls through and the turn proceeds normally
      } else if (status[side] && status[side].kind === "confusion" && bypass.confusion) {
        log.push(`${attacker.name} fights through the confusion and forces ${move.name} out!`);
      }

      // ---- Psychic Terrain: any move with priority > 0 fails outright against a GROUNDED target (see
      // isGrounded()) while it's active — checked here, before PP cost/cooldown/charge tracking, so a
      // blocked move behaves like the other pre-empted actions above (no PP spent, no progress made). ----
      if (fieldEffect === "psychic" && (Number(move.priority) || 0) > 0 && isGrounded(defender)) {
        log.push(`${attacker.name} tried to use ${move.name}, but the Psychic Terrain blocks it!`);
        continue;
      }

      // ---- Custom Status: Lost Control — Self-Damage Chance. Rolled once per attack ATTEMPT, before the
      // accuracy roll: 60% (LOST_CONTROL_SELF_HIT_CHANCE) of the time the boosted attack goes wild and
      // lands on the user INSTEAD of the intended target. Mirrors the existing Confusion self-hit pattern
      // above (a self-contained damage calc that resolves the turn immediately) rather than threading a
      // target-redirect through the full multi-hit/shield/ability damage pipeline below — that pipeline
      // is keyed heavily off `otherSide` (shields, type-immunity abilities, hazards), so reusing it for a
      // self-target hit risks the user's own defensive tech intercepting its own out-of-control attack.
      // The self-hit still uses the move's own Base Power and the Lost Control Stat Buff, so a
      // higher-power move stings more even when it misfires onto its user. ----
      if (status[side] && status[side].kind === "lostcontrol" && move.category !== "Status") {
        if (Math.random() < LOST_CONTROL_SELF_HIT_CHANCE) {
          const atkKeySelf = move.category === "Special" ? "spa" : "atk";
          const defKeySelf = move.category === "Special" ? "spd" : "def";
          // ---- BUGFIX: this self-hit calc previously only applied the base stat + stat STAGE + the
          // flat Lost Control multiplier — it skipped every other damage-boosting source a real hit
          // would get: Item Dex Stat Shifts, field stat effects, and any active/timed item damage-boost
          // effects (a "sharply raises Atk" item, a Life-Orb-style boost, etc.). Those now apply here
          // too, so the misfired hit hurts exactly as much as the intended one would have. ----
          let selfAtkStat = ((attacker.stats && attacker.stats[atkKeySelf]) || 50) * stageMult(stages[side][atkKeySelf]) * LOST_CONTROL_ATK_MULTIPLIER;
          selfAtkStat *= getStatShiftMultiplier(side, atkKeySelf);
          selfAtkStat *= fieldStatMult(side);
          let selfDefStat = (attacker.stats && attacker.stats[defKeySelf]) || 50;
          selfDefStat *= getStatShiftMultiplier(side, defKeySelf);
          selfDefStat *= fieldStatMult(side);
          const bpScaleSelf = Math.max(0.2, (move.basePower || 60) / 60);
          const selfItemMult = getActiveStatBuffDamageBonus(side) * getItemTimedDamageBoostMultiplier(side, move);
          const selfDmg = Math.max(1, Math.round((selfAtkStat / Math.max(20, selfDefStat)) * 26 * bpScaleSelf * selfItemMult * (0.85 + Math.random() * 0.3)));
          const hpBeforeSelfHit = hp[side];
          hp[side] = Math.max(0, hp[side] - selfDmg);
          log.push(`${attacker.name} lost control and hit itself with ${move.name}! (${selfDmg} dmg)`);
          // ---- BUGFIX: same gap as Confusion's self-hit — Focus Sash/Sitrus-Berry-style item effects
          // (via applyItemOnHit) and any passive "After Getting Hit" ability now fire off this misfired
          // hit too. Unlike Confusion, this self-hit carries the move's real type/tags, so type-filtered
          // item and ability effects can actually match here. Rocky-Helmet-style "hurt the attacker"
          // item actions stay skipped (guarded inside applyItemOnHit) since attacker===defender here. ----
          applyItemOnHit(side, side, move, hpBeforeSelfHit);
          const selfHitAbility = ability[side];
          if (selfHitAbility && selfHitAbility.abilityType === "passive" && triggerMatches(selfHitAbility.passive.trigger, "afterHit") && passiveApplies(selfHitAbility, move.type)) {
            runAbilityAction(selfHitAbility, side, { hasDamage: false }, log);
            runEffectsFrom(selfHitAbility, selfHitAbility.effects, side);
          }
          continue;
        }
        log.push(`${attacker.name}, out of control, unleashes ${move.name} on ${defender.name}!`);
      }

      // ---- Multi-Turn Charge Execution (Solar Beam / Skull Bash Mechanics): if this move charges up,
      // every turn until the final one is consumed entirely by the charging stance (no accuracy roll, no
      // damage, no PP cost) — only the fully-charged final turn falls through to normal move resolution. ----
      if (move.chargeUp && move.chargeUp.enabled
        && !(!charging[side] && move.chargeUp.skipInWeather && move.chargeUp.skipInWeather !== "none" && weather === move.chargeUp.skipInWeather)) {
        if (!charging[side]) {
          charging[side] = { moveName: move.name, turnsRemaining: move.chargeUp.duration, condition: move.chargeUp.condition, shieldPercent: move.chargeUp.shieldPercent, healPercent: move.chargeUp.healPercent };
        }
        const chg = charging[side];
        if (chg.turnsRemaining > 0) {
          // Fly / Dig / Dive / Shadow Force: the user is untouchable (bar the listed exceptions) on the charging turn itself
          if (move.stateImmunity && move.stateImmunity.enabled && chg.turnsRemaining === move.chargeUp.duration) {
            stateImmunity[side] = { key: move.stateImmunity.key, exceptions: move.stateImmunity.exceptions, expireEvent: move.stateImmunity.expireEvent, turnsLeft: 1 };
            log.push(`${attacker.name} becomes ${move.stateImmunity.key}!`);
          }
          chg.turnsRemaining--;
          if (chg.condition === "healing") {
            const healAmt = Math.max(0, Math.round(maxHp[side] * ((chg.healPercent || 0) / 100)));
            if (healAmt > 0 && hp[side] > 0) {
              hp[side] = Math.min(maxHp[side], hp[side] + healAmt);
              log.push(`${attacker.name} absorbs energy while charging ${move.name}! (+${healAmt} HP)`);
            }
          } else {
            const condMsg = chg.condition === "shielded" ? " behind a shimmering barrier"
              : chg.condition === "statusImmune" ? ", steeling itself against status" : "";
            log.push(`${attacker.name} is charging up power for ${move.name}${condMsg}!`);
          }
          lastUsedMove[side] = move.name;
          continue;
        }
        // ---- Fully charged: clear the stance and let the move fire for real below ----
        charging[side] = null;
        log.push(`${attacker.name}'s charge is complete — ${move.name} fires!`);
      }

      // ---- Dynamic PP Cost System: base cost is 1; an Ability (or the Move's own unified rule) whose
      // action is "Modify PP Cost" adds/subtracts its configured amount IF (a) its own Trigger/Condition
      // Boolean gate passes, AND (b) the move being used matches its configured Target — "Highest Base
      // Power" (recomputed live off the user's current movepool) or "Last Used Move" (this side's
      // PREVIOUS successful move, i.e. lastUsedMove[side] before it's updated below). ----
      if (movePP[side][move.name] != null && !move.metronomed) {
        let ppCost = 1;
        const attackerMoveList = (attacker.moves || []).filter(m => m.name);
        const applyPPCostRule = (ruleOwner) => {
          if (!ruleOwner) return;
          if (ruleOwner.abilityType === "passive" && ruleOwner.passive.action === "modifyPPCost"
            && triggerMatches(ruleOwner.passive.trigger, "attacking") && chanceHits(ruleOwner.passive.chance)
            && ppCostTargetMatches(ruleOwner.passive.ppCostTarget, move, attackerMoveList, lastUsedMove[side])) {
            ppCost += ruleOwner.passive.ppCostDirection === "decrease" ? -ruleOwner.passive.ppCostAmount : ruleOwner.passive.ppCostAmount;
          }
          if (ruleOwner.abilityType === "active" && ruleOwner.active.action === "modifyPPCost" && chanceHits(ruleOwner.active.chance)) {
            const c = ruleOwner.active.condition;
            const meets = OFFENSIVE_ACTIVE_CONDITIONS.has(c) ? (c === "hpBelow33" ? (hp[side] / maxHp[side] <= 0.33) : c === "lastMoveMissed" ? !!lastMoveMissed[side] : c === "onHitting" ? false : attacker.types.includes(move.type))
              : ENVIRONMENTAL_ACTIVE_CONDITIONS.has(c) ? evaluateEnvironmentalCondition(c, ruleOwner.active, weather)
                : false;
            if (meets && ppCostTargetMatches(ruleOwner.active.ppCostTarget, move, attackerMoveList, lastUsedMove[side])) {
              ppCost += ruleOwner.active.ppCostDirection === "decrease" ? -ruleOwner.active.ppCostAmount : ruleOwner.active.ppCostAmount;
            }
          }
        };
        applyPPCostRule(ab);
        if (move.rule && move.rule.enabled) applyPPCostRule({ abilityType: move.rule.ruleType, passive: move.rule.passive, active: move.rule.active });
        ppCost = Math.max(0, Math.round(ppCost));
        movePP[side][move.name] = Math.max(0, movePP[side][move.name] - ppCost);
        if (ppCost !== 1) log.push(`${attacker.name}'s ${move.name} PP cost was ${ppCost > 1 ? "increased" : "decreased"} to ${ppCost}!`);
      }
      // ---- Forced Action Status ("Repeat") + Dynamic PP Cost "Last Used Move" targeting both read off
      // this side's PREVIOUS move above, so the tracker only advances to the current move AFTER that read. ----
      lastUsedMove[side] = move.name;
      if (move.selfFaint) pendingSelfFaint[side] = true; // faints once the move has finished resolving

      // ---- Move Cooldowns: once a move with cooldownTurns>0 is used, it locks out for that many turns
      // (counted down at end-of-round below) — set on use, regardless of whether it goes on to hit or miss. ----
      if (move.cooldownTurns > 0) { moveCooldowns[side][move.name] = move.cooldownTurns; }

      // ---- Movement Tag Triggers: "selfUsesTag" (user's own ability) and "opponentUsesTag" (opponent's
      // ability) fire on ATTEMPT — hit or miss — since both just react to the move being cast, not to it
      // landing. Checked here, before the accuracy roll, so a miss still fires them correctly. ----
      [[side, "selfUsesTag"], [otherSide, "opponentUsesTag"]].forEach(([who, trig]) => {
        const ab = ability[who];
        if (ab && ab.abilityType === "passive" && triggerMatches(ab.passive.trigger, trig)
          && (move.tags || []).some(t => String(t).toLowerCase() === String(ab.passive.hitTagFilter || "").toLowerCase())) {
          runAbilityAction(ab, who, { hasDamage: false }, log);
          runEffectsFrom(ab, ab.effects, who);
        }
      });

      // ---- Expanded Weather: Sandstorm cuts accuracy for everyone EXCEPT Ground/Rock types ----
      const evasionAb = ability[otherSide];
      const evasionFactor = (evasionAb && evasionAb.abilityType === "passive" && evasionAb.passive.action === "evasionMult" && !isAbilityNullified(otherSide)
        && (evasionAb.passive.evasionWeather === "none" || weather === evasionAb.passive.evasionWeather)) ? evasionAb.passive.evasionFactor : 1;
      const sandAccuracyMult = ((weather === "sand" && !attacker.types.some(t => t === "ground" || t === "rock")) ? 0.8 : 1) * evasionFactor;

      // ---- Tag-Based Mechanics — Powder-Style Immunity Check: Grass types are completely immune to any
      // move carrying a tag flagged via a "Powder-Style Immunity Check" Tag Rule (move.tagPowderImmune,
      // resolved above by applyMoveTagRules) OR the literal "powder" tag (kept for backward compatibility
      // with saves from before Tag Rules existed), regardless of the move's own Accuracy value — folded
      // into the accuracy step since it produces the exact same "move whiffs" outcome. ----
      const powderImmune = defender.types.includes("grass")
        && (move.tagPowderImmune || (move.tags || []).some(t => String(t).toLowerCase() === "powder"));

      // ---- Accuracy vs Dodge: the target's effective Speed (base stat × active stat stage) acts as
      // its Dodge stat for this attack. "Unavoidable"/"Undodgeable"-tagged moves skip this multiplier
      // (and the roll below) entirely — see computeDodgeHitMultiplier()/moveIsUnavoidable() up top. ----
      const unavoidable = moveIsUnavoidable(move) || !!move.weatherNeverMiss || !!(rootState[otherSide] && rootState[otherSide].sureHit); // Root Down: the target can't dodge
      const atkSpeedForAcc = ((attacker.stats && attacker.stats.spe) || 50) * stageMult(stages[side].spe) * fieldSpeedMult(side);
      const defSpeedForAcc = ((defender.stats && defender.stats.spe) || 50) * stageMult(stages[otherSide].spe) * fieldSpeedMult(otherSide);
      const dodgeMult = unavoidable ? 1 : computeDodgeHitMultiplier(atkSpeedForAcc, defSpeedForAcc);
      // ---- Move Dodge Chance: an explicit per-move evasion bonus (e.g. a Quick Attack-style move),
      // layered ON TOP OF the Speed-based dodgeMult above rather than replacing it. Read off whatever
      // move the DEFENDER itself chose to use this round (chosenMove[otherSide] — already picked for
      // both sides before either one acts, see the pre-selection block earlier this turn), so using an
      // evasive move grants its bonus for incoming hits during the same round it's used. ----
      const defenderMove = chosenMove[otherSide];
      const moveDodgeChance = unavoidable ? 0 : Math.max(0, Math.min(1, Number((defenderMove && defenderMove.dodgeChance) || 0) / 100));
      const totalDodgeMult = moveDodgeChance > 0 ? dodgeMult * (1 - moveDodgeChance) : dodgeMult;

      // ---- accuracy check ----
      // ---- Miss Message Variant (fixed): roll once and keep it, so we can tell WHY the hit failed.
      // A dodge factor below 1 alone isn't enough to call it a "dodge" — that only proves the defender
      // had an edge (Speed and/or an evasive move), not that it's the reason THIS roll failed. We only
      // credit a dodge when the exact same roll would have connected without that factor and only
      // whiffed once it pulled the odds down under it. Move Dodge Chance is checked first (its own log
      // line) so a Quick Attack-style dodge doesn't get miscredited to raw Speed when both are in play;
      // otherwise the attacker's own Accuracy roll failed on its own merits — that's a plain miss. ----
      const accuracyRoll = Math.random();
      const baseHitChance = (move.accuracy ?? 1) * sandAccuracyMult * (tempAccuracyMult[side] ?? 1);
      // Item Dex: Never-Miss Type/Tag — checked before the roll matters at all; if the held item covers
      // this move's type/tag, the accuracy/dodge gate below is skipped entirely (powderImmune still applies).
      const itemGuaranteesHit = !powderImmune && itemMoveNeverMisses(side, move);
      // ---- Electric Terrain: Electric-type moves automatically connect against a Steel-type defender —
      // the accuracy/dodge roll is skipped entirely for them, same treatment as an "unavoidable" move. ----
      const electricTerrainAutoHit = fieldEffect === "electric" && move.type === "electric" && defender.types.includes("steel");
      // ---- Evade Inaccurate Attacks: a move under the stance's accuracy threshold automatically misses. ----
      const evadeShieldHit = !powderImmune && !unavoidable && !itemGuaranteesHit && !electricTerrainAutoHit
        && !!dodgeShield[otherSide] && (move.accuracy ?? 1) < dodgeShield[otherSide].below;
      if (powderImmune || evadeShieldHit || (!unavoidable && !itemGuaranteesHit && !electricTerrainAutoHit && accuracyRoll > baseHitChance * totalDodgeMult)) {
        const wouldHaveHitWithoutAnyDodge = !unavoidable && accuracyRoll <= baseHitChance;
        const wouldHaveHitWithoutMoveDodge = !unavoidable && accuracyRoll <= baseHitChance * dodgeMult;
        const moveDodged = !powderImmune && moveDodgeChance > 0 && wouldHaveHitWithoutMoveDodge;
        const speedDodged = !powderImmune && !moveDodged && dodgeMult < 1 && wouldHaveHitWithoutAnyDodge;
        const dodged = evadeShieldHit || moveDodged || speedDodged;
        log.push(powderImmune ? `${attacker.name} used ${move.name}, but it doesn't affect ${defender.name}...`
          : evadeShieldHit ? `${attacker.name} used ${move.name}! ${defender.name} evaded the inaccurate attack!`
            : moveDodged ? `${defender.name} used ${defenderMove.name} and dodged the attack!`
            : speedDodged ? `${attacker.name} used ${move.name}! ${defender.name} dodged the attack!`
              : `${attacker.name} used ${move.name}, but it missed!`);
        // ---- Move Miss Tracker: flags for next turn's "lastMoveMissed" Active Condition check ----
        lastMoveMissed[side] = true;
        // ---- Battle History: a miss resets the consecutive-use streak (Fury Cutter-style) ----
        moveStreak[side] = { name: null, count: 0 };
        // Item Dex: Fail-Safe — a miss (not a dodge, not a powder-immunity no-op) can trigger a free
        // random damaging move from the holder's own movepool.
        if (!powderImmune && !dodged) applyItemFailSafe(side, otherSide);
        continue;
      }
      // ---- Move Miss Tracker: this move connected, so clear the flag for the NEXT turn's read ----
      lastMoveMissed[side] = false;
      // ---- Battle History: consecutive-use streak counter — same move name as last turn -> +1 stack,
      // any other move (or the very first move of the battle) -> streak restarts at 1 ----
      if (moveStreak[side].name === move.name) moveStreak[side].count++;
      else moveStreak[side] = { name: move.name, count: 1 };

      // ---- Movement Tag Triggers: "onHitTag" — user's own ability, only once the move has actually
      // landed (unlike selfUsesTag above, which fires on mere attempt) ----
      {
        const onHitAb = ability[side];
        if (onHitAb && onHitAb.abilityType === "passive" && triggerMatches(onHitAb.passive.trigger, "onHitTag")
          && (move.tags || []).some(t => String(t).toLowerCase() === String(onHitAb.passive.hitTagFilter || "").toLowerCase())) {
          runAbilityAction(onHitAb, side, { hasDamage: false }, log);
          runEffectsFrom(onHitAb, onHitAb.effects, side);
        }
      }

      // ---- Dynamic State-Binding Partial Immunity (Fly / Dig / Bury Mechanics): if the defender is
      // currently in a named stance (set by their own earlier move this round) and the incoming move
      // doesn't match any of that stance's exceptions, it whiffs entirely — no damage, no secondary
      // effects, exactly like a hard type immunity. ----
      if (isStateImmuneTo(otherSide, move)) {
        log.push(`${attacker.name}'s ${move.name} has no effect — ${defender.name} is ${stateImmunity[otherSide].key} and out of reach!`);
        lastMoveMissed[side] = true;
        moveStreak[side] = { name: null, count: 0 };
        continue;
      }

      // ---- Block Priority (Dazzling / Queenly Majesty / Armor Tail): the foe's ability stops any priority move aimed at this combatant ----
      {
        const dAb = ability[otherSide];
        if (dAb && dAb.abilityType === "passive" && dAb.passive.action === "blockPriority"
          && getEffectivePriorityPeek(side, move) > 0 && (move.category !== "Status" || move.action === "status")) {
          log.push(`${defender.name}'s ${dAb.name} blocks ${attacker.name}'s ${move.name}!`);
          lastMoveMissed[side] = true;
          moveStreak[side] = { name: null, count: 0 };
          continue;
        }
      }

      // ---- Move Fail Conditions (Sucker Punch-style if/else gate): checked once the move has connected
      // but before any damage/effects run — if the configured condition is met, the move simply fails. ----
      {
        const fc = move.failCondition || "none";
        let moveFails = false;
        if (fc === "opponentNotOffensive") moveFails = !chosenMove[otherSide] || chosenMove[otherSide].category === "Status";
        else if (fc === "opponentOffensive") moveFails = !!chosenMove[otherSide] && chosenMove[otherSide].category !== "Status";
        else if (fc === "userHpAbove50") moveFails = (hp[side] / maxHp[side]) > 0.5;
        else if (fc === "weatherIsNot") moveFails = weather !== move.failWeather;
        else if (fc === "fieldIsNot") moveFails = fieldEffect !== move.failField;
        else if (fc === "notFirstTurn") moveFails = roundsOnField[side] > 0;
        else if (fc === "userHasStatus" || fc === "targetHasStatus" || fc === "userNoStatus" || fc === "targetNoStatus") {
          const fst = fc.startsWith("user") ? status[side] : status[otherSide];
          const has = !!fst && (move.failStatus === "any" || fst.kind === move.failStatus);
          moveFails = fc.endsWith("NoStatus") ? !has : has;
        }
        // ---- Consecutive-use failure (Protect / Detect): moveStreak was already bumped for THIS use above, so the number of
        // earlier uses in a row is count - 1; each one cuts the success chance to a third. A failure resets the streak. ----
        if (!moveFails && move.consecutiveFail && moveStreak[side].name === move.name && moveStreak[side].count > 1) {
          if (Math.random() > Math.pow(1 / 3, moveStreak[side].count - 1)) { moveFails = true; moveStreak[side] = { name: null, count: 0 }; }
        }
        if (moveFails) {
          log.push(`${attacker.name} used ${move.name}, but it failed!`);
          continue;
        }
      }

      // ---- Multi-Mega Evolution: Specific Trigger Move requirement — fires only once the move is
      // confirmed to have actually gone through (past the miss/dodge roll above, past Fly/Dig-style state
      // immunity, and past any Move Fail Condition) — a whiffed or failed move no longer triggers it. It
      // still fires before the move's own damage/effects resolve below, so a Mega swap on this same turn
      // still applies to this very attack, same as before. ----
      // ---- Self-Switch (U-turn / Volt Switch / Baton Pass...): queue the user's own switch; resolveSwitchIns() carries it out
      // right after this action, so the damage / effects of the move still resolve first. 1v1 battles have no bench: no switch. ----
      if (move.selfSwitch && move.selfSwitch !== "none" && teamMode && hp[side] > 0) {
        const swPick = bestBenchPick(side);
        if (swPick) pendingSwitchIn[side] = { idx: swPick.idx, baton: move.selfSwitch === "baton" };
      }
      tryMegaEvolve(side, move.name);

      // ---- Dynamic State-Binding Partial Immunity (Fly / Dig / Bury Mechanics): using a move with this
      // enabled puts the USER into its named stance for the rest of the round — they take 0 damage and
      // are immune to incoming attacks (checked above for the opposing side) until end-of-round decay. ----
      if (move.stateImmunity && move.stateImmunity.enabled && !(move.chargeUp && move.chargeUp.enabled)) {   // charged moves already took the stance on their charge turn
        // ---- Adjustable State-Based Invulnerability Timing: "onAttack" keeps the original behavior
        // (decays at end of the round it's entered on — standard Fly/Dig). "fixedDuration" instead
        // starts the counter at the configured turn count and ignores attack resolution entirely,
        // so the stance persists across multiple rounds regardless of when/whether an attack lands. ----
        const usesFixedDuration = move.stateImmunity.expireEvent === "fixedDuration";
        stateImmunity[side] = {
          key: move.stateImmunity.key,
          exceptions: move.stateImmunity.exceptions,
          expireEvent: move.stateImmunity.expireEvent,
          turnsLeft: usesFixedDuration ? move.stateImmunity.expireDurationTurns : 1
        };
        log.push(`${attacker.name} becomes ${move.stateImmunity.key}!`);
      }

      // ---- "TRADEOFF" Move Matrix (Ghost-type Curse-style): checked once the move has connected and
      // survived Fail Conditions. IF a Conditional Type Override is set AND the user isn't that type,
      // the ENTIRE costing block is skipped and execution falls straight through to the move's normal
      // damage/stat-boosting calculation path below — no cost is paid, no consequence is forced. ----
      if (move.tradeoff && move.tradeoff.enabled) {
        const tr = move.tradeoff;
        const typeGateOk = tr.requireUserType === "any" || attacker.types.includes(tr.requireUserType);
        if (typeGateOk) {
          // ---- Cost: paid by the user, right away, regardless of whether the consequence lands ----
          if (tr.costType === "hpPercent") {
            const costAmt = Math.max(0, Math.round(maxHp[side] * (tr.costHpPercent / 100)));
            if (costAmt > 0 && hp[side] > 0) {
              hp[side] = Math.max(0, hp[side] - costAmt);
              log.push(`${attacker.name} pays the price of ${move.name}! (-${costAmt} HP)`);
            }
          } else {
            stages[side][tr.costStatKey] = Math.max(-6, Math.min(6, (stages[side][tr.costStatKey] || 0) - Math.abs(tr.costStatStage)));
            log.push(`${attacker.name}'s ${tr.costStatKey.toUpperCase()} fell as the cost of ${move.name}!`);
          }
          // ---- Target Consequence: only forced onto a target still standing ----
          if (hp[otherSide] > 0) {
            if (tr.consequenceType === "status") {
              if (!status[otherSide] && !itemBlocksStatus(otherSide, tr.consequenceStatus) && !isStatusImmune(defender.types, tr.consequenceStatus, null, defender.tags, fieldEffect) && !isChargeStatusImmune(otherSide)) {
                const finalConsequenceStatus = resolveItemStatusConversion(otherSide, side, tr.consequenceStatus);
                status[otherSide] = { kind: finalConsequenceStatus, counter: 1, turnsLeft: tr.durationTurns };
                log.push(`${defender.name} suffers from ${move.name}'s tradeoff!`);
              }
            } else if (tr.consequenceType === "drain") {
              const dotAmt = Math.max(1, Math.round(maxHp[otherSide] * (tr.consequenceDrainPercent / 100)));
              tradeoffDots[otherSide].push({ dot: dotAmt, turnsLeft: tr.durationTurns, healSide: side });
              log.push(`${defender.name} is caught in ${move.name}'s draining tradeoff!`);
            } else {
              stages[otherSide][tr.consequenceStatKey] = Math.max(-6, Math.min(6, (stages[otherSide][tr.consequenceStatKey] || 0) + tr.consequenceStatStage));
              log.push(`${defender.name}'s ${tr.consequenceStatKey.toUpperCase()} ${tr.consequenceStatStage > 0 ? "rose" : "fell"} from ${move.name}'s tradeoff!`);
            }
          }
        }
      }

      // ---- Defensive Ability Tag Triggers (Soundproof/Rough Skin-style): evaluated once per move use,
      // right after Move Fail Conditions and before Status/Damage branching, so it can react to ANY
      // incoming move (damaging or Status) that carries the ability's configured tag. Not routed through
      // the generic runAbilityAction ctx.hasDamage dispatcher because Negate Move must short-circuit the
      // move's secondary effects too (via `continue`), including on Status-category moves. ----
      {
        const tagAb = ability[otherSide];
        if (tagAb && tagAb.abilityType === "passive" && triggerMatches(tagAb.passive.trigger, "hitByTag")
          && (move.tags || []).some(t => String(t).toLowerCase() === String(tagAb.passive.hitTagFilter || "").toLowerCase())
          && chanceHits(tagAb.passive.chance)) {
          const defWho = fighters[otherSide].name;
          if (tagAb.passive.action === "negateTaggedMove") {
            // ---- Negate Move: entirely blocks the incoming move's damage AND secondary effects ----
            log.push(`${defWho}'s ${tagAb.name} completely blocks ${attacker.name}'s ${move.name}!`);
            continue;
          } else if (tagAb.passive.action === "reflectDamage") {
            // ---- Reflect Damage: flat value or % of the ATTACKER's Max HP, dealt back immediately ----
            const reflectAmt = tagAb.passive.reflectType === "flat"
              ? Math.max(0, Math.round(tagAb.passive.reflectValue || 0))
              : Math.max(0, Math.round(maxHp[side] * ((tagAb.passive.reflectValue || 0) / 100)));
            if (reflectAmt > 0 && hp[side] > 0) {
              hp[side] = Math.max(0, hp[side] - reflectAmt);
              log.push(`${defWho}'s ${tagAb.name} reflects ${reflectAmt} damage back at ${attacker.name}!`);
            }
            // move continues to resolve normally below (damage/effects still apply alongside the reflect)
          } else if (tagAb.passive.action === "tagStatMod") {
            // ---- Apply Stat Modification: alters the defender's own stat stage, then fires any Additional
            // Effects (matrix sequence) attached to the ability, exactly like every other ability trigger ----
            stages[otherSide][tagAb.passive.statKey] = Math.max(-6, Math.min(6, (stages[otherSide][tagAb.passive.statKey] || 0) + tagAb.passive.statStage));
            log.push(`${defWho}'s ${tagAb.name} triggers!`);
            runEffectsFrom(tagAb, tagAb.effects, otherSide);
            // move continues to resolve normally below
          }
        }
      }

      // ---- Weather picker on damaging moves: fires once per move use (same timing as a Status move's
      // own "Set Weather" effect), independently of whatever damage/effects follow. Skipped entirely if
      // the move was already negated above by a Defensive Ability Tag Trigger. ----
      if (move.setsWeather) {
        applyMoveWeatherSet(move, attacker, log);
      }
      // ---- Field Effect picker on damaging moves: same independent, always-fires-once-per-use pattern
      // as the Weather picker above, just targeting the separate Field Effect state. ----
      if (move.setsField) {
        applyMoveFieldSet(move, attacker, log);
      }

      if (move.category === "Status") {
        const action = move.action || "status";
        if (action === "weather") {
          applyMoveWeatherSet(move, attacker, log);
        } else if (action === "field") {
          applyMoveFieldSet(move, attacker, log);
        } else if (action === "hazard") {
          if (move.hazardType === "spikes") {
            hazards[otherSide].spikesStacks = Math.min(3, hazards[otherSide].spikesStacks + 1);
            log.push(`${attacker.name} used ${move.name}! Spikes scatter around ${defender.name}'s feet!`);
          } else {
            hazards[otherSide].stealthrock = true;
            log.push(`${attacker.name} used ${move.name}! Sharp stones float around ${defender.name}!`);
          }
        } else if (action === "heal") {
          if (chanceHits(move.effectChance * secondaryChanceMultiplierFor(side, move.tags))) applyHealTarget(hp, maxHp, side, otherSide, move.healTarget, move.healType, move.healValue, move.name, attacker.name, fighters, log);
          else log.push(`${attacker.name} used ${move.name}, but nothing happened.`);
        } else if (action === "status" && move.statusEffect && move.statusEffect !== "none") {
          const defAbility = ability[otherSide];
          const abilityBlocks = defAbility && defAbility.abilityType === "passive" && triggerMatches(defAbility.passive.trigger, "defending")
            && defAbility.passive.action === "negateStatus" && passiveApplies(defAbility, move.type) && chanceHits(defAbility.passive.chance);
          // ---- Serene Grace: multiplies the base Effect Chance % of THIS move's secondary status roll ----
          if (!chanceHits(move.effectChance * secondaryChanceMultiplierFor(side, move.tags))) {
            log.push(`${attacker.name} used ${move.name}, but it had no effect.`);
          } else if (fieldEffect === "misty" && MAJOR_STATUS_KINDS.has(move.statusEffect) && isGrounded(defender)) {
            log.push(`🌫️ Misty Terrain protected ${defender.name} from status!`);
          } else if (fieldEffect === "electric" && move.statusEffect === "sleep" && isGrounded(defender)) {
            log.push(`⚡ Electric Terrain keeps ${defender.name} wide awake!`);
          } else if (itemBlocksStatus(otherSide, move.statusEffect)) {
            // itemBlocksStatus already pushed the 🛡️ protection log line above.
          } else if (isStatusImmune(defender.types, move.statusEffect, move, defender.tags, fieldEffect) || abilityBlocks || isChargeStatusImmune(otherSide)) {
            log.push(`${attacker.name} used ${move.name}! ${defender.name} is immune to it!`);
          } else if (!status[otherSide]) {
            // Item Dex: Status Effect Change — either side's held item can rewrite the kind of status
            // that actually lands here (incoming conversion on the defender, outgoing on the attacker).
            const finalStatusKind = resolveItemStatusConversion(otherSide, side, move.statusEffect);
            status[otherSide] = { kind: finalStatusKind, counter: 1, turnsLeft: rollStatusDuration(move) + pollutedDurationBonus(finalStatusKind) };
            log.push(`${attacker.name} used ${move.name}! ${defender.name} is afflicted with ${finalStatusKind}!`);
          } else {
            log.push(`${attacker.name} used ${move.name}, but it had no effect.`);
          }
        } else if (action === "copyMove" || action === "stealMove" || action === "swapMove" || action === "forceMove") {
          // ================= MOVE EXCHANGE ENGINE: Copy / Steal / Swap / Force =================
          // RUNTIME-ONLY GUARANTEE: every write below touches ONLY fighters[side].moves /
          // fighters[otherSide].moves (this battle's cloned arrays — see the clone at fighters
          // construction, near the top of simulateOneBattle) and their matching movePP[side]/
          // movePP[otherSide] trackers. The permanent Dex registry (`entries` / entry.moves) is never
          // touched, so every change here is fully discarded the instant the battle object falls out of
          // scope — nothing survives to the next battle or the next call to runBattleOdds().
          //
          // SINGLE-SLOT GUARANTEE: every branch below replaces exactly ONE existing array index via
          // fighters[x].moves[idx] = {...move}. Nothing is ever pushed, spliced, or filtered out, so
          // the kit's length — and every OTHER slot in it — is always left untouched. That's what keeps
          // a hard cap on kit size for free: it can never grow, and copying/stealing/swapping one move
          // can never blow away the rest of the movepool down to a single entry. ----
          if (!chanceHits(move.effectChance * secondaryChanceMultiplierFor(side, move.tags))) {
            log.push(`${attacker.name} used ${move.name}, but it had no effect.`);
          } else {
            const userSlotIdx = (fighters[side].moves || []).findIndex(m => m.name === move.name);
            const targetIdx = pickExchangeTargetIdx(otherSide, move, fighters, lastUsedMove);
            if (userSlotIdx < 0 || targetIdx < 0) {
              log.push(`${attacker.name} used ${move.name}, but there was no move to swap/copy!`);
            } else if (action === "copyMove") {
              // ---- Copy (Mimic-style, one-sided): user's used-move slot becomes a full copy of the
              // targeted opponent move. Opponent's kit is completely untouched. ----
              const sourceMove = fighters[otherSide].moves[targetIdx];
              const copied = { ...sourceMove };
              fighters[side].moves[userSlotIdx] = copied;
              movePP[side][copied.name] = copied.maxPP ?? copied.pp ?? 15;
              log.push(`🎯 ${attacker.name} copied ${copied.name}!`);
            } else if (action === "stealMove") {
              // ---- Steal (one-sided theft): user gets a copy of the targeted opponent move into their
              // used-move slot, AND the opponent's slot is backfilled with a Struggle-style placeholder
              // so they genuinely lose access to it for the rest of the battle. ----
              const sourceMove = fighters[otherSide].moves[targetIdx];
              const stolen = { ...sourceMove };
              fighters[side].moves[userSlotIdx] = stolen;
              movePP[side][stolen.name] = stolen.maxPP ?? stolen.pp ?? 15;
              const fallback = makeStruggleFallback(defender.types && defender.types[0]);
              fighters[otherSide].moves[targetIdx] = fallback;
              movePP[otherSide][fallback.name] = fallback.maxPP ?? fallback.pp ?? 15;
              log.push(`🥷 ${attacker.name} stole ${stolen.name} from ${defender.name}!`);
            } else if (action === "swapMove") {
              // ---- Swap / Exchange (Skill Swap-style, two-sided): the user's used-move slot and the
              // targeted opponent slot trade places — user gets the opponent's move AND the opponent
              // gets the user's original move, both in a single atomic exchange. ----
              const userMove = fighters[side].moves[userSlotIdx];
              const oppMove = fighters[otherSide].moves[targetIdx];
              const userCopyForOpp = { ...userMove };
              const oppCopyForUser = { ...oppMove };
              fighters[side].moves[userSlotIdx] = oppCopyForUser;
              fighters[otherSide].moves[targetIdx] = userCopyForOpp;
              movePP[side][oppCopyForUser.name] = oppCopyForUser.maxPP ?? oppCopyForUser.pp ?? 15;
              movePP[otherSide][userCopyForOpp.name] = userCopyForOpp.maxPP ?? userCopyForOpp.pp ?? 15;
              log.push(`🔄 ${attacker.name} and ${defender.name} swapped moves! (${userMove.name} ↔ ${oppMove.name})`);
            } else if (action === "forceMove") {
              // ---- Force Replace (Entrainment-style, one-sided transfer): user forces a copy of its
              // own used move onto the opponent's targeted slot. The user's own kit is untouched. ----
              const userMove = fighters[side].moves[userSlotIdx];
              const forced = { ...userMove };
              const replacedName = fighters[otherSide].moves[targetIdx] && fighters[otherSide].moves[targetIdx].name;
              fighters[otherSide].moves[targetIdx] = forced;
              movePP[otherSide][forced.name] = forced.maxPP ?? forced.pp ?? 15;
              log.push(`😈 ${attacker.name} forced ${defender.name} to learn ${forced.name}${replacedName ? ` in place of ${replacedName}` : ""}!`);
            }
          }
        } else if (action === "copyAllMoves") {
          // ================= FULL MOVEPOOL COPY (Ditto-style, one-sided) =================
          // RUNTIME-ONLY, same guarantee as the single-move Exchange Engine above: only ever writes to
          // fighters[side].moves and movePP[side]/moveCooldowns[side] (this battle's own cloned state) —
          // the permanent Dex registry is never touched. Unlike the single-slot actions above, this
          // REPLACES the user's entire kit (array length included) with full copies of every active move
          // currently in the opponent's kit — PP pools are rebuilt from scratch to match 1:1. ----
          if (!chanceHits(move.effectChance * secondaryChanceMultiplierFor(side, move.tags))) {
            log.push(`${attacker.name} used ${move.name}, but it had no effect.`);
          } else {
            const oppMoves = (fighters[otherSide].moves || []).filter(m => m.name);
            if (!oppMoves.length) {
              log.push(`${attacker.name} used ${move.name}, but ${defender.name} had no moves to copy!`);
            } else {
              const copiedKit = oppMoves.map(m => ({ ...m }));
              fighters[side].moves = copiedKit;
              movePP[side] = {};
              moveCooldowns[side] = {};
              copiedKit.forEach(m => { movePP[side][m.name] = m.maxPP ?? m.pp ?? 15; });
              log.push(`🎯 ${attacker.name} copied all moves from ${defender.name}!`);
            }
          }
        } else if (action === "swapAllMoves") {
          // ================= FULL MOVEPOOL EXCHANGE (Whole Kit Swap, two-sided) =================
          // Same runtime-only guarantee — writes only to fighters[a/b].moves and their movePP/moveCooldowns
          // trackers. Completely exchanges both sides' entire active kits (and PP pools) in one atomic swap. ----
          if (!chanceHits(move.effectChance * secondaryChanceMultiplierFor(side, move.tags))) {
            log.push(`${attacker.name} used ${move.name}, but it had no effect.`);
          } else {
            const userMoves = (fighters[side].moves || []).filter(m => m.name);
            const oppMoves = (fighters[otherSide].moves || []).filter(m => m.name);
            if (!userMoves.length && !oppMoves.length) {
              log.push(`${attacker.name} used ${move.name}, but neither side had any moves to swap!`);
            } else {
              const userCopyForOpp = oppMoves.map(m => ({ ...m }));
              const oppCopyForUser = userMoves.map(m => ({ ...m }));
              fighters[side].moves = userCopyForOpp;
              fighters[otherSide].moves = oppCopyForUser;
              movePP[side] = {}; moveCooldowns[side] = {};
              movePP[otherSide] = {}; moveCooldowns[otherSide] = {};
              userCopyForOpp.forEach(m => { movePP[side][m.name] = m.maxPP ?? m.pp ?? 15; });
              oppCopyForUser.forEach(m => { movePP[otherSide][m.name] = m.maxPP ?? m.pp ?? 15; });
              log.push(`🔄 ${attacker.name} and ${defender.name} swapped move pools!`);
            }
          }
        } else if (action === "transform") {
          // ================= FULL TRANSFORM (Ditto-style: Moves + Ability + Type) =================
          // Snapshots the user's own moves/ability/types BEFORE overwriting them with full copies of the
          // opponent's, so revertDittoTransform() can restore them precisely later — mirrors the Mega
          // Evolution preForm-snapshot pattern above. Respects each ability's Lock flag (Wonder Guard /
          // Multitype-style): a locked target ability is never copied, though the moves/type portion of
          // the Transform still succeeds. BATTLE-ONLY: only fighters[side].moves/.types and ability[side]
          // are touched — nothing persists past this battle. ----
          if (!chanceHits(move.effectChance * secondaryChanceMultiplierFor(side, move.tags))) {
            log.push(`${attacker.name} used ${move.name}, but it had no effect.`);
          } else if (dittoState[side].active) {
            log.push(`${attacker.name} used ${move.name}, but it's already transformed!`);
          } else {
            const oppMoves = (fighters[otherSide].moves || []).filter(m => m.name);
            if (!oppMoves.length) {
              log.push(`${attacker.name} used ${move.name}, but there was nothing to transform into!`);
            } else {
              const st = dittoState[side];
              st.preMoves = (fighters[side].moves || []).map(m => ({ ...m }));
              st.preAbility = ability[side];
              st.preTypes = [...(fighters[side].types || [])];
              const copiedKit = oppMoves.map(m => ({ ...m }));
              fighters[side].moves = copiedKit;
              fighters[side].types = [...(fighters[otherSide].types || [])];
              movePP[side] = {}; moveCooldowns[side] = {};
              copiedKit.forEach(m => { movePP[side][m.name] = m.maxPP ?? m.pp ?? 15; });
              const oppAbility = ability[otherSide];
              const abilityCopied = oppAbility && oppAbility.name && !oppAbility.lockAbility;
              ability[side] = abilityCopied ? { ...oppAbility } : null;
              st.active = true;
              st.revertMode = move.transformRevertMode || "permanent";
              st.revertTurnsRemaining = st.revertMode === "turns" ? Math.max(1, move.transformRevertTurns || 3) : null;
              log.push(`🔮 ${attacker.name} transformed into a copy of ${defender.name}!`);
              if (abilityCopied) log.push(`${attacker.name}'s Ability is now ${ability[side].name}!`);
              else if (oppAbility && oppAbility.lockAbility) log.push(`${defender.name}'s ${oppAbility.name} can't be copied!`);
              activateEntryAbility(side);
            }
          }
        } else if (action === "copyAbility") {
          // ================= ABILITY COPY (Role Play / Trace-style, one-sided) =================
          // RUNTIME-ONLY: only ever writes to ability[side] (this battle's own ability tracker) — the
          // permanent Dex registry entry is never touched. Respects each ability's Lock flag. ----
          if (!chanceHits(move.effectChance * secondaryChanceMultiplierFor(side, move.tags))) {
            log.push(`${attacker.name} used ${move.name}, but it had no effect.`);
          } else {
            const targetAbility = ability[otherSide];
            if (!targetAbility || !targetAbility.name) {
              log.push(`${attacker.name} used ${move.name}, but ${defender.name} had no ability to copy!`);
            } else if (targetAbility.lockAbility) {
              log.push(`${attacker.name} tried to copy ${defender.name}'s ${targetAbility.name}, but it can't be copied!`);
            } else {
              ability[side] = { ...targetAbility };
              log.push(`🧬 ${attacker.name} copied ${defender.name}'s ${targetAbility.name}!`);
              // ---- Fires the newly-acquired ability's "On-Entry"/Battle Start passive immediately, if
              // it has one — same pipeline Mega Evolution uses for a freshly-assigned ability. ----
              activateEntryAbility(side);
            }
          }
        } else if (action === "swapAbility") {
          // ================= ABILITY SWAP (Skill Swap-style, two-sided) =================
          // RUNTIME-ONLY: only ever writes to ability[side]/ability[otherSide]. Fails gracefully (no
          // change to either side) if EITHER side's current ability is Locked. ----
          if (!chanceHits(move.effectChance * secondaryChanceMultiplierFor(side, move.tags))) {
            log.push(`${attacker.name} used ${move.name}, but it had no effect.`);
          } else {
            const userAbility = ability[side];
            const oppAbility = ability[otherSide];
            if ((!userAbility || !userAbility.name) && (!oppAbility || !oppAbility.name)) {
              log.push(`${attacker.name} used ${move.name}, but neither side had an ability to swap!`);
            } else if ((userAbility && userAbility.lockAbility) || (oppAbility && oppAbility.lockAbility)) {
              const lockedName = (userAbility && userAbility.lockAbility) ? userAbility.name : oppAbility.name;
              log.push(`${attacker.name} tried to swap abilities, but ${lockedName} can't be swapped!`);
            } else {
              ability[side] = oppAbility ? { ...oppAbility } : null;
              ability[otherSide] = userAbility ? { ...userAbility } : null;
              log.push(`🔄 ${attacker.name} and ${defender.name} swapped abilities! (${userAbility ? userAbility.name : "None"} ↔ ${oppAbility ? oppAbility.name : "None"})`);
              activateEntryAbility(side);
              activateEntryAbility(otherSide);
            }
          }
        } else if (action === "forceAbility") {
          // ================= FORCE ABILITY / ENTRAINMENT (one-sided transfer onto the target) =================
          // RUNTIME-ONLY: only ever writes to ability[otherSide]. Fails gracefully if the user has no
          // ability to give, or if the target's CURRENT ability is Locked (can't be overwritten). ----
          if (!chanceHits(move.effectChance * secondaryChanceMultiplierFor(side, move.tags))) {
            log.push(`${attacker.name} used ${move.name}, but it had no effect.`);
          } else {
            const userAbility = ability[side];
            const targetAbility = ability[otherSide];
            if (!userAbility || !userAbility.name) {
              log.push(`${attacker.name} used ${move.name}, but had no ability to give!`);
            } else if (targetAbility && targetAbility.lockAbility) {
              log.push(`${attacker.name} tried to change ${defender.name}'s ability, but ${targetAbility.name} can't be overwritten!`);
            } else {
              ability[otherSide] = { ...userAbility };
              log.push(`🧪 ${defender.name}'s ability changed to ${userAbility.name}!`);
              activateEntryAbility(otherSide);
            }
          }
        } else if (action === "swapItem") {
          // ================= ITEM SWAP ENGINE: Trick / Switcheroo-style =================
          // RUNTIME-ONLY, same guarantee as the Move Exchange Engine above: this only ever writes to
          // itemState[side]/itemState[otherSide] (this battle's own per-side item trackers, built fresh
          // in simulateOneBattle from itemConfig every trial) — never anything persisted to the registry.
          // Exchanges the User's and Target's held items in one atomic swap. If only ONE side has an
          // item, the swap naturally degenerates into a one-way transfer — the empty-handed side ends up
          // with it and the item-holding side is left with nothing, which reads as that item being taken
          // away. If NEITHER side has an item there's nothing to do, so it fails gracefully. Both items'
          // `used` one-shot flags are cleared on the way over — a freshly-acquired item hasn't fired in
          // its new holder's hands yet, regardless of whether its previous holder had already used it. ----
          if (!chanceHits(move.effectChance * secondaryChanceMultiplierFor(side, move.tags))) {
            log.push(`${attacker.name} used ${move.name}, but it had no effect.`);
          } else {
            const userItem = itemState[side].item;
            const oppItem = itemState[otherSide].item;
            if (!userItem && !oppItem) {
              log.push(`${attacker.name} used ${move.name}, but neither Pokémon had an item to swap!`);
            } else {
              itemState[side].item = oppItem;
              itemState[otherSide].item = userItem;
              itemState[side].usesLeft = oppItem ? Math.max(0, Number(oppItem.maxUses) || 0) : 0;
              itemState[otherSide].usesLeft = userItem ? Math.max(0, Number(userItem.maxUses) || 0) : 0;
              itemState[side].efficiency = 1;
              itemState[otherSide].efficiency = 1;
              if (userItem && oppItem) {
                log.push(`🔀 ${attacker.name} and ${defender.name} swapped items! (${userItem.name} ↔ ${oppItem.name})`);
              } else if (userItem && !oppItem) {
                log.push(`🔀 ${attacker.name} used ${move.name}! ${defender.name} took ${attacker.name}'s ${userItem.name}!`);
              } else {
                log.push(`🔀 ${attacker.name} used ${move.name} and took ${defender.name}'s ${oppItem.name}!`);
              }
            }
          }
        } else {
          log.push(`${attacker.name} used ${move.name}.`);
        }
        runEffectsFrom(move, move.effects, side, secondaryChanceMultiplierFor(side, move.tags));
        continue;
      }

      // ---- Delayed Attack Events (Future Sight / Doom Desire Mechanic): a flagged damaging move deals
      // NO damage this turn. Instead it registers a delayedAttacks queue entry (turn counter, the damage
      // formula payload via the `move` reference, the user's snapped offensive stat if "Snap Stats at
      // Launch Time" is selected, and the target's side ID) and skips the normal hit loop entirely. The
      // queue is ticked down / resolved in the end-of-round block further below. ----
      if (move.delayedAttack && move.delayedAttack.enabled) {
        const snapMode = move.delayedAttack.statSnapMode;
        const atkKeyD = move.atkStatBasis && move.atkStatBasis !== "auto" ? move.atkStatBasis
          : (move.category === "Special" ? "spa" : "atk");
        delayedAttacks.push({
          turnsLeft: move.delayedAttack.delayTurns,
          side, targetSide: otherSide,
          move,
          attackerName: attacker.name,
          ignoreTypeImmunity: move.delayedAttack.ignoreTypeImmunity,
          effectTiming: move.delayedAttack.effectTiming,
          // "launch" freezes (base stat × live stage multiplier) right now; "landing" leaves this null
          // so the resolver recalculates the attacker's offensive stat fresh when the hit actually lands.
          snappedAtkStat: snapMode === "launch" ? ((attacker.stats && attacker.stats[atkKeyD]) || 50) * stageMult(stages[side][atkKeyD]) * fieldStatMult(side) : null
        });
        log.push(`${attacker.name} used ${move.name}! It's charging up an attack for later!`);
        // ---- Secondary Effect Timing: "With Cast" fires this move's own Additional Effects list right
        // now, same as before. "With Resolve" instead holds it back — resolveDelayedAttack() below runs
        // it at the exact moment the delayed hit actually lands, alongside the damage. ----
        if (move.delayedAttack.effectTiming !== "resolve") {
          runEffectsFrom(move, move.effects, side, secondaryChanceMultiplierFor(side, move.tags));
        }
        continue;
      }

      // ---- Counter Mechanics (Counter / Mirror Coat / Metal Burst): entirely replaces the normal
      // Base-Power damage pipeline below. Reflects a multiple of whatever damage the user took THIS
      // turn straight back at the opponent, bypassing Def/SpD outright, then still runs the move's
      // own Additional Effects list exactly like any other move. Fails cleanly (own log line, no
      // damage, no effects) if the user wasn't hit this turn or was hit by a non-matching damage type. ----
      if (move.counterMove && move.counterMove.enabled) {
        const reflected = executeCounterMove(side, otherSide, move, attacker.name, defender.name);
        if (reflected > 0) {
          runEffectsFrom(move, move.effects, side, secondaryChanceMultiplierFor(side, move.tags));
        }
        lastMoveMissed[side] = reflected <= 0;
        moveStreak[side] = moveStreak[side].name === move.name ? { name: move.name, count: moveStreak[side].count + 1 } : { name: move.name, count: 1 };
        continue;
      }

      // ---- damaging move: runs the accuracy-already-passed roll sequence once per Hit Count ----
      // ---- Chronological Battle Log Order: the "used move" cause line is logged here, before any
      // per-hit effect/ability/shield lines or the final damage result, so the log always reads
      // cause -> effect modifiers -> result instead of result-first. ----
      log.push(`${attacker.name} used ${move.name}!`);
      const hitsToRun = Math.max(1, Math.min(5, move.hits || 1));
      let totalDmg = 0, lastMult = 1, hitsLanded = 0, shieldBlockedCount = 0;
      for (let h = 0; h < hitsToRun; h++) {
        if (hp[otherSide] <= 0) break;
        if (h > 0 && !unavoidable && !electricTerrainAutoHit && Math.random() > (move.accuracy ?? 1) * sandAccuracyMult * (tempAccuracyMult[side] ?? 1) * totalDodgeMult) continue; // first hit's accuracy already rolled above
        let shieldBlockedThisHit = false;

        // ---- Custom Damage Scaling: lets a move map Base Power against a chosen offensive stat AND a
        //      chosen (possibly different) defensive stat, e.g. Psyshock = user SpAtk vs target Def ----
        const atkKey = move.atkStatBasis && move.atkStatBasis !== "auto" ? move.atkStatBasis
          : (move.damageBasis === "defense" ? "def" : (move.category === "Special" ? "spa" : "atk")); // damageBasis kept for legacy saves
        const defKey = move.defStatBasis && move.defStatBasis !== "auto" ? move.defStatBasis
          : (move.category === "Special" ? "spd" : "def");
        let atkStat = (attacker.stats && attacker.stats[atkKey]) || 50;
        let defStat = (defender.stats && defender.stats[defKey]) || 50;
        atkStat *= stageMult(stages[side][atkKey]);
        // ---- Slow Start: temporarily weakens this stat for the battle's first N turns ----
        atkStat *= slowStartMult(side, atkKey);
        // Item Dex: Stat Shifts — a %-based multiplier on top of the integer stat stage above.
        atkStat *= getStatShiftMultiplier(side, atkKey);
        defStat *= getStatShiftMultiplier(otherSide, defKey);
        // ---- Field Effects: Grassy Field's stat boost applies to the fighter's actual stat, not their
        // stat stage — so it stacks alongside boosts/drops instead of being erased by "ignoreDefense". ----
        atkStat *= fieldStatMult(side);
        // ---- Custom Status: Lost Control — Stat Buff. Outgoing damage is boosted by a configurable
        // multiplier (LOST_CONTROL_ATK_MULTIPLIER, default 1.3x) for as long as the status is active —
        // this is the path taken on the 40% of attempts that actually land on the intended target,
        // mirroring the multiplier already applied to the 60% self-hit calc above. ----
        if (status[side] && status[side].kind === "lostcontrol") atkStat *= LOST_CONTROL_ATK_MULTIPLIER;
        // ---- Ignore Defense Trigger: treats the target's defensive stat stage as 0 (base value), bypassing
        // any Def/SpD boosts or drops — the base stat number itself still applies normally. ----
        if (!move.ignoreDefense) defStat *= stageMult(stages[otherSide][defKey]);
        // Frostbite cuts the afflicted user's Special Attack output in half
        if (move.category === "Special" && status[side] && status[side].kind === "frostbite") atkStat *= 0.5;
        // ---- Expanded Weather: Snow boosts Ice-type Pokémon's effective Defense/Sp.Def by 1.5x ----
        if (weather === "snow" && defender.types.includes("ice")) defStat *= 1.5;
        // ---- Field Effects: Grassy Field's Defense/Sp.Def boost still applies even when the move
        // Ignores Defense — same treatment as Snow's Ice boost above, since it's a stat-level effect,
        // not a stage modifier. ----
        defStat *= fieldStatMult(otherSide);
        // ---- Poisonous Terrain: halves Defense/Sp. Def for every non-Poison GROUNDED defender (see
        // isGrounded()) — applies to whichever of the two stats this hit is actually using. ----
        if (fieldEffect === "poisonous" && !defender.types.includes("poison") && isGrounded(defender)) {
          defStat *= POISONOUS_TERRAIN_DEFENSE_WEAKEN_MULT;
        }
        let mult = typeMultiplier(move.type, defender.types);
        // ---- Root Down (forces grounded): Ground-type moves can hit a Flying type that is rooted ----
        if (mult === 0 && move.type === "ground" && rootState[otherSide] && rootState[otherSide].ground && (defender.types || []).includes("flying")) {
          mult = typeMultiplier("ground", defender.types.filter(t => t !== "flying"));
        }
        // ---- Tag Matchups: applies no matter what ability (or lack of one) the defender has ----
        mult *= tagMatchupMultiplier(defender, move.tags);
        // ---- Effectiveness vs Pokémon Tags: mirror-image direction — checks the DEFENDER's own
        // Pokémon Tags against this move's vsTags rules, independent of move.tags/Type Chart above ----
        mult *= moveVsCreatureTagMultiplier(move, defender);
        // ---- Strong Winds: Electric-, Ice-, and Rock-type moves deal normal damage to any Flying-type
        // Pokémon instead of being super-effective — divides out just the Flying-typing's contribution. ----
        if (weather === "strongwinds" && ["electric", "ice", "rock"].includes(move.type) && defender.types.includes("flying")) {
          const flyingMult = (TYPE_CHART[move.type] || {}).flying ?? 1;
          if (flyingMult > 1) mult = mult / flyingMult;
        }
        // ---- Dynamic Type Matching (Freedom Selection): if the target has the move's configured override
        // type, its chosen multiplier REPLACES the standard type-chart result entirely. ----
        if (move.dynamicTypeEnabled && defender.types.includes(move.dynamicTypeTarget)) {
          mult = move.dynamicTypeMode === "superEffective" ? 2 : move.dynamicTypeMode === "notVeryEffective" ? 0.5 : 0;
        }
        // ---- Wonder Guard: forces full immunity (0x) on anything that isn't already Super-Effective,
        // checked on the pure type-effectiveness multiplier above (type chart + tag matchups + Dynamic
        // Type Matching + Strong Winds) — BEFORE the non-type multipliers below (weight, history scaling,
        // weather, status) layer on, since those aren't "type effectiveness" in the sense Wonder Guard
        // cares about. ----
        const defWonderGuardAbility = ability[otherSide];
        if (defWonderGuardAbility && defWonderGuardAbility.abilityType === "passive" && defWonderGuardAbility.passive.action === "wonderGuard" && mult > 0 && mult < 2) {
          mult = 0;
          log.push(`${defender.name}'s ${defWonderGuardAbility.name} makes it immune to anything but a Super-Effective hit!`);
        }
        // ---- Advanced Status Matrix: Electric-type attacks deal 1.5x damage against Wet targets ----
        if (move.type === "electric" && wetFlag[otherSide]) mult *= 1.5;
        // ---- Pokémon Weight Impact ----
        mult *= weightMultiplier(move, side, otherSide);
        // ---- Battle History & Damage Scaling: Fury Cutter / Echoed Voice / Revenge-style scaling ----
        mult *= historyScalingMultiplier(move, side);
        // ---- Recoil-Interaction Abilities: Reckless-style boost for any move that carries recoil ----
        const recklessAbility = ability[side];
        if (recklessAbility && recklessAbility.boostsRecoilMoves && (move.recoilPercent || 0) > 0) {
          mult *= 1.2;
        }
        // Item Dex: Stat Modifier (timed) — optional "boostDamage" while-active bonus.
        mult *= getActiveStatBuffDamageBonus(side);
        // Item Dex: Timed Type/Tag Damage Boost — boostDamage effects armed from battleStart/onUse
        // (e.g. a Fire-boosting food item eaten at the start of the fight), scoped by Move Filter.
        mult *= getItemTimedDamageBoostMultiplier(side, move);
        // ---- Speed-Scaling Offense: "relativeFaster"/"relativeSlower" read the live Speed gap between
        // the two combatants this turn (stat stages included); "absolute" reads only the user's own raw
        // Speed. See speedScalingMultiplier() up top for the exact formula per mode. ----
        if (move.speedScaling && move.speedScaling !== "none") {
          const atkSpeedForScaling = ((attacker.stats && attacker.stats.spe) || 50) * stageMult(stages[side].spe);
          const defSpeedForScaling = ((defender.stats && defender.stats.spe) || 50) * stageMult(stages[otherSide].spe);
          mult *= speedScalingMultiplier(move, atkSpeedForScaling, defSpeedForScaling);
        }
        // ---- Critical Rate Selector: Normal uses the default roll, High raises the roll chance (+1 stage
        // equivalent), Always Crit guarantees a critical hit every time this move connects. ----
        // critMod abilities: Super Luck (+crit stages), Sniper (bigger crit damage), Battle Armor / Shell Armor (crit immunity)
        const critAtkAb = ability[side], critDefAb = ability[otherSide];
        const critMine = (critAtkAb && critAtkAb.abilityType === "passive" && critAtkAb.passive.action === "critMod" && !isAbilityNullified(side)) ? critAtkAb.passive : null;
        const critTheirs = (critDefAb && critDefAb.abilityType === "passive" && critDefAb.passive.action === "critMod" && !isAbilityNullified(otherSide)) ? critDefAb.passive : null;
        const critStageNow = Math.min(3, (move.critRateMode === "high" ? 1 : 0) + (critMine ? critMine.critStage : 0));
        const critChance = move.critRateMode === "always" ? 1 : [0.08, 0.25, 0.5, 1][critStageNow];
        let crit = Math.random() < critChance ? 1.5 * (critMine ? critMine.critDamageMult : 1) : 1;
        if (crit > 1 && critTheirs && critTheirs.critImmune) { crit = 1; log.push(`${fighters[otherSide].name}'s ${critDefAb.name} blocks the critical hit!`); }
        // ---- Type-Specific Overriding Critical Hits: bypasses standard type effectiveness and forces a crit ----
        const overrideAbility = ability[side];
        if (overrideAbility && overrideAbility.abilityType === "active" && overrideAbility.active.condition === "typeMatchOverride"
          && overrideAbility.active.action === "typeOverrideCrit" && move.type === overrideAbility.active.overrideType
          && !(overrideAbility.active.oncePerBattle && abilityTriggered[side]) && chanceHits(overrideAbility.active.chance)) {
          mult = Math.max(mult, 2); crit = 2;
          log.push(`${attacker.name}'s ${overrideAbility.name} tears through type resistance for a critical hit!`);
          if (overrideAbility.active.oncePerBattle) abilityTriggered[side] = true;
        }
        const variance = 0.85 + Math.random() * 0.3;
        // ---- Expanded Stat/Weight Damage Scaling: if this move carries a Dynamic Base Power formula
        // (Electro Ball/Gyro Ball/Heavy Hitter/Heavy Slam-style), compute the replacement Base Power
        // fresh off THIS hit's live Speed/Weight matchup and use it below instead of move.basePower.
        // "none" (the default) returns null and changes nothing. ----
        let effectiveBasePower = move.basePower;
        if (move.dynamicPower && move.dynamicPower !== "none") {
          const atkSpeedForDyn = ((attacker.stats && attacker.stats.spe) || 50) * stageMult(stages[side].spe);
          const defSpeedForDyn = ((defender.stats && defender.stats.spe) || 50) * stageMult(stages[otherSide].spe);
          const atkWeightForDyn = tempWeight[side] || 1, defWeightForDyn = tempWeight[otherSide] || 1;
          const dynBP = dynamicBasePower(move, atkSpeedForDyn, defSpeedForDyn, atkWeightForDyn, defWeightForDyn, hp[side] / Math.max(1, maxHp[side]), hp[otherSide] / Math.max(1, maxHp[otherSide]));
          if (dynBP != null) effectiveBasePower = dynBP;
        }
        // Item Dex: Multi-Hit Break — +X% power for matching type/tag moves, item breaks after N uses.
        effectiveBasePower = applyItemTypePowerBoost(side, move, effectiveBasePower);
        // ---- Base Power scales damage relative to a 60-BP baseline, so existing saves (which default
        // to basePower:60) produce identical numbers to before this field existed. ----
        const bpScale = Math.max(0.2, (effectiveBasePower || 60) / 60);
        // ---- BUGFIX: the "at least 1 damage" floor below must never apply to a genuinely immune hit
        // (mult===0 — full type immunity, an Immunity Ability, Dynamic Type Matching set to "no
        // effect", etc.). Previously Math.max(1, ...) floored EVERY hit to a minimum of 1 damage
        // regardless of mult, so an immune target still lost 1 HP per hit while the log simultaneously
        // (and correctly) printed "It had no effect!" — contradicting itself. Only a hit with SOME
        // effectiveness (mult>0) gets floored up to a minimum of 1; a fully immune hit now stays 0. ----
        let dmg = mult <= 0 ? 0 : Math.max(1, Math.round((atkStat / Math.max(20, defStat)) * 26 * mult * crit * variance * bpScale));
        // ---- STAB (Same-Type Attack Bonus), Terastallization-aware: kept as its own multiplier on
        // `dmg` rather than folded into `mult` above, because `mult` is also read afterward as a pure
        // type-effectiveness signal (e.g. the Solid Rock/Filter "hitBySuperEffective" check and the
        // Type-Specific Overriding Critical Hit's own effectiveness gate) — STAB inflating `mult` would
        // make a same-type neutral hit misread as "super effective" to those checks. See
        // computeStabMultiplier() for the full Tera-aware rule (base STAB retained, boosted Tera STAB
        // layered on top per the spec's requirement #4). ----
        dmg = Math.round(dmg * computeStabMultiplier(attacker, move, teraState[side]));
        // ---- Multi-Hit Scaling: only the 2nd+ hit of a multi-hit move is ever touched (hit index h
        // is 0-based, so h===0 always stays at 1.0x) — compounds per subsequent hit via Math.pow so a
        // 5-hit move ramps smoothly rather than jumping by a flat step each time. Floored at 0.05x so
        // a high rampDown percent on a long hit-count can never fully zero out or invert damage. ----
        if (move.multiHitScaling && move.multiHitScaling !== "none" && h > 0 && dmg > 0) {
          const step = (move.multiHitScalingPct != null ? move.multiHitScalingPct : 20) / 100;
          const hitScaleMult = move.multiHitScaling === "rampUp"
            ? Math.pow(1 + step, h)
            : Math.max(0.05, Math.pow(1 - step, h));
          dmg = Math.max(1, Math.round(dmg * hitScaleMult));
        }
        if (status[side] && status[side].kind === "burn" && move.category === "Physical") dmg = Math.round(dmg * 0.5);
        // ---- Conditional Status Damage Boosters (Hex/Facade-style): multiplies damage if the target
        // currently carries the configured status condition (or any status at all) ----
        const boostStatus = move.statusDamageMultOn === "user" ? status[side] : status[otherSide];
        if (move.statusDamageMultiplier && move.statusDamageMultiplier !== 1 && boostStatus
          && (move.statusDamageMultFilter === "any" || boostStatus.kind === move.statusDamageMultFilter)) {
          dmg = Math.round(dmg * move.statusDamageMultiplier);
        }

        // ---- Weather field effects: Sun boosts Fire+Grass 1.5x/cuts Water 0.5x; Rain boosts Water 1.5x /
        // cuts Fire 0.5x; Sandstorm boosts Ground-type moves 1.5x (accuracy penalty handled pre-hit; the
        // chip-damage-per-round + Rock/Ground/Steel immunity to it are handled in the end-of-round block) ----
        if (weather === "sun") {
          if (move.type === "fire" || move.type === "grass") dmg = Math.round(dmg * 1.5);
          else if (move.type === "water") dmg = Math.round(dmg * 0.5);
        } else if (weather === "rain") {
          if (move.type === "water") dmg = Math.round(dmg * 1.5);
          else if (move.type === "fire") dmg = Math.round(dmg * 0.5);
        } else if (weather === "sand") {
          if (move.type === "ground") dmg = Math.round(dmg * 1.5);
        } else if (weather === "polluted") {
          // ---- Polluted Weather: Poison-type attacks hit 1.5x harder while the toxic air is active ----
          if (move.type === "poison") dmg = Math.round(dmg * 1.5);
        } else if (weather === "thunderstorm") {
          // ---- Thunderstorm: Rain's Water boost applies too, PLUS Electric-type moves get the same
          // 1.5x boost; Fire is weakened exactly like it is in plain Rain ----
          if (move.type === "electric" || move.type === "water") dmg = Math.round(dmg * 1.5);
          else if (move.type === "fire") dmg = Math.round(dmg * 0.5);
        } else if (weather === "nighttime") {
          // ---- Nighttime: Grass-type moves are weakened, unless the ATTACKER's ability Ignores Weather
          // Effects for Nighttime (Night Blooming-style). Ghost/Dark/Fairy-type moves are boosted. ----
          if (move.type === "grass" && !ignoresWeatherEffect(ability[side], "nighttime")) dmg = Math.round(dmg * 0.5);
          else if (["ghost", "dark", "fairy"].includes(move.type)) dmg = Math.round(dmg * 1.5);
        }
        // ---- Custom Weather: damage multipliers for the move's type ----
        if (CUSTOM_WEATHERS[weather]) {
          const cwm = CUSTOM_WEATHERS[weather].typeMods.find(m => m.type === move.type);
          if (cwm) dmg = Math.round(dmg * cwm.mult);
        }
        // ---- Field Effects: Flood weakens Fire-type MOVES (by move type, same as Sun/Rain do for their
        // own type interactions) — independent of Weather, so it stacks with whatever's active there. ----
        if (fieldEffect === "flood" && move.type === "fire") {
          dmg = Math.round(dmg * FLOOD_FIRE_MOVE_WEAKEN_MULT);
        }
        // ---- Misty Terrain: halves incoming Dragon-type move damage, but ONLY for a GROUNDED defender
        // (see isGrounded()) — Flying-types and "levitating"-tagged Pokémon get no benefit from it. ----
        if (fieldEffect === "misty" && move.type === "dragon" && isGrounded(defender)) {
          dmg = Math.round(dmg * MISTY_DRAGON_MOVE_WEAKEN_MULT);
        }
        // ---- Electric Terrain / Psychic Terrain: boost their matching move Type's power by 1.3x ----
        if (fieldEffect === "electric" && move.type === "electric") {
          dmg = Math.round(dmg * ELECTRIC_TERRAIN_MOVE_BOOST_MULT);
        } else if (fieldEffect === "psychic" && move.type === "psychic") {
          dmg = Math.round(dmg * PSYCHIC_TERRAIN_MOVE_BOOST_MULT);
        }

        const ctx = { dmg, hasDamage: true, moveType: move.type, moveTags: move.tags || [], moveCategory: move.category };

        // ---- Multi-Turn Charge Execution: while the defender is mid-charge under the "Shielded"
        // condition, incoming damage is reduced by its configured percentage ----
        if (charging[otherSide] && charging[otherSide].condition === "shielded") {
          const reduced = Math.round(ctx.dmg * (1 - (charging[otherSide].shieldPercent || 0) / 100));
          if (reduced < ctx.dmg) log.push(`${defender.name}'s barrier absorbs some of the impact!`);
          ctx.dmg = Math.max(0, reduced);
        }

        // ---- Type Damage Immunity Abilities: any damage matching the ability's configured type drops
        // immediately to 0, before any other ability/rule interactions get a chance to modify it ----
        const immunityAbility = ability[otherSide];
        if (immunityAbility && immunityAbility.immuneToType && immunityAbility.immuneToType !== "none" && immunityAbility.immuneToType === move.type) {
          ctx.dmg = 0;
          log.push(`${defender.name}'s ${immunityAbility.name} grants full immunity to ${cap(move.type)}-type moves!`);
        }

        // ---- Super Effective Reaction Triggers (Solid Rock / Filter): fires only when this hit is
        // Super Effective (mult>1) and the defender's passive ability is gated on that trigger ----
        const superEffAbility = ability[otherSide];
        if (mult > 1 && superEffAbility && superEffAbility.abilityType === "passive"
          && triggerMatches(superEffAbility.passive.trigger, "hitBySuperEffective") && passiveApplies(superEffAbility, move.type)) {
          runAbilityAction(superEffAbility, otherSide, ctx, log);
        }

        // ---- Active ability: strict Boolean gate check on the attacker (offensive conditions only) ----
        const atkAbility = ability[side];
        if (atkAbility && !isAbilityNullified(side) && atkAbility.abilityType === "active" && OFFENSIVE_ACTIVE_CONDITIONS.has(atkAbility.active.condition)
          && !(atkAbility.active.oncePerBattle && abilityTriggered[side]) && chanceHits(atkAbility.active.chance)) {
          const c = atkAbility.active.condition;
          const meets = c === "hpBelow33" ? (hp[side] / maxHp[side] <= 0.33) : c === "lastMoveMissed" ? !!lastMoveMissed[side] : c === "stabMatch" ? attacker.types.includes(move.type) : c === "onHitting" ? effectivenessMatches(mult, atkAbility.active.hitEffectiveness) : false;
          if (meets) runActiveAbilityAction(atkAbility, side, ctx, log);
        }
        // ---- Active ability: defensive Boolean gate on the defender (Disguise-style interception, checked before damage lands) ----
        // Item Dex: Ability Nullifier applies here too — a nullified defender's active ability is skipped.
        const defAbilityActive = !isAbilityNullified(otherSide) ? ability[otherSide] : null;
        if (defAbilityActive && defAbilityActive.abilityType === "active" && DEFENSIVE_ACTIVE_CONDITIONS.has(defAbilityActive.active.condition)
          && !(defAbilityActive.active.oncePerBattle && abilityTriggered[otherSide]) && chanceHits(defAbilityActive.active.chance)) {
          const c = defAbilityActive.active.condition;
          const preHpRatio = hp[otherSide] / maxHp[otherSide];
          const meets = c === "hpFull" ? preHpRatio >= 1 : c === "hpBelow50" ? preHpRatio <= 0.5 : c === "hitByType" ? move.type === defAbilityActive.active.hitType : false;
          if (meets) runActiveAbilityAction(defAbilityActive, otherSide, ctx, log);
        }
        // ---- Active ability: Environmental Boolean gate ("IF Weather Is Active") — role-agnostic, so it's
        // checked once per side rather than split into offensive/defensive buckets. ----
        ["a", "b"].forEach(envSide => {
          const envAbility = ability[envSide];
          if (envAbility && envAbility.abilityType === "active" && ENVIRONMENTAL_ACTIVE_CONDITIONS.has(envAbility.active.condition)
            && !(envAbility.active.oncePerBattle && abilityTriggered[envSide]) && chanceHits(envAbility.active.chance)
            && evaluateEnvironmentalCondition(envAbility.active.condition, envAbility.active, weather)) {
            // Offensive actions (boosts) only make sense for the ATTACKER's ability; defensive ones for the DEFENDER's.
            const envIsOffensive = ["boostDamage150", "boostDamageCustom", "boostType", "boostTagMove"].includes(envAbility.active.action);
            const envUsesCtx = envSide === side ? envIsOffensive : (envSide === otherSide && !envIsOffensive);
            runActiveAbilityAction(envAbility, envSide, envUsesCtx ? ctx : { hasDamage: false }, log);
          }
        });
        // ---- Boost Tag Move (Passive, self-only): fires on the ability owner's own attack whenever the
        // move matches one of the configured tags/types (Type counts as an implicit tag — see
        // moveTagPool()) — ALWAYS, regardless of what this ability's Passive Trigger dropdown says. This
        // is intentional: it's the one passive action that ignores the Trigger selector entirely, so it
        // can never end up mis-wired to a defensive trigger and boost the OPPONENT's incoming hit instead
        // of the owner's own move (a common mix-up with the generic tag-filter actions above). ----
        if (atkAbility && atkAbility.abilityType === "passive" && atkAbility.passive.action === "boostTagMove"
          && moveMatchesAnyTag(move, atkAbility.passive.boostTagFilter)) {
          ctx.dmg = Math.round(ctx.dmg * (atkAbility.passive.boostTagMultiplier || 1.3));
          log.push(`${attacker.name}'s ${atkAbility.name} empowers its attack!`);
        }
        // ---- Passive: "When Attacking" (attacker) / "When Defending" (defender) / "Passively (Always Active)" ----
        // Item Dex: Ability Nullifier — a nullified side's passive abilities simply don't fire here.
        if (atkAbility && !isAbilityNullified(side) && atkAbility.abilityType === "passive" && triggerMatches(atkAbility.passive.trigger, "attacking") && passiveApplies(atkAbility, move.type)) {
          runAbilityAction(atkAbility, side, ctx, log);
          runEffectsFrom(atkAbility, atkAbility.effects, side);
        }
        const defAbility = ability[otherSide];
        if (defAbility && !isAbilityNullified(otherSide) && defAbility.abilityType === "passive" && triggerMatches(defAbility.passive.trigger, "defending") && passiveApplies(defAbility, move.type)) {
          runAbilityAction(defAbility, otherSide, ctx, log);
          runEffectsFrom(defAbility, defAbility.effects, otherSide);
        }
        // ---- Unified Rule Builder: a Move's OWN Conditional Rule runs through the exact same gate
        // functions as an Ability's — it's just "attacker" here instead of "ability owner". ----
        if (move.rule && move.rule.enabled) {
          const moveAsRuleOwner = { name: move.name, abilityType: move.rule.ruleType, passive: move.rule.passive, active: move.rule.active };
          if (moveAsRuleOwner.abilityType === "active") {
            const c = moveAsRuleOwner.active.condition;
            if (chanceHits(moveAsRuleOwner.active.chance)) {
              const meets = OFFENSIVE_ACTIVE_CONDITIONS.has(c) ? (c === "hpBelow33" ? hp[side] / maxHp[side] <= 0.33 : c === "lastMoveMissed" ? !!lastMoveMissed[side] : c === "onHitting" ? effectivenessMatches(mult, moveAsRuleOwner.active.hitEffectiveness) : attacker.types.includes(move.type))
                : DEFENSIVE_ACTIVE_CONDITIONS.has(c) ? (c === "hpFull" ? hp[otherSide] / maxHp[otherSide] >= 1 : c === "hpBelow50" ? hp[otherSide] / maxHp[otherSide] <= 0.5 : move.type === moveAsRuleOwner.active.hitType)
                  : ENVIRONMENTAL_ACTIVE_CONDITIONS.has(c) ? evaluateEnvironmentalCondition(c, moveAsRuleOwner.active, weather)
                    : false;
              if (meets) runActiveAbilityAction(moveAsRuleOwner, side, ctx, log);
            }
          } else if (triggerMatches(moveAsRuleOwner.passive.trigger, "attacking")
            || (moveAsRuleOwner.passive.trigger === "weatherActive" && evaluateEnvironmentalCondition("weatherIs", moveAsRuleOwner.passive, weather))) {
            runAbilityAction(moveAsRuleOwner, side, ctx, log);
          }
        }
        // ---- Customizable Hit-Count Attack Shields: checked last, right before damage lands, so it
        // overrides every prior ability/rule modifier on ctx.dmg. A qualifying shield blocks the hit
        // entirely (dmg -> 0) UNLESS the move Ignores Defenses/Shields AND the shield isn't flagged
        // Unignorable — an Unignorable Shield always wins regardless of the move's override. ----
        // ---- OHKO moves (Fissure / Guillotine-style): a connecting hit deals the target's whole remaining HP (type
        // immunities still apply), unless the target's ability resists OHKO moves at its current HP%. Ability damage
        // modifiers are skipped for OHKO moves. ----
        // ---- Fixed Damage (Seismic Toss / Dragon Rage / Super Fang): replaces the computed number. Only when damage would have
        // landed at all (type immunities and ability negations already zeroed ctx.dmg), so it can still be blocked below. ----
        if ((move.fixedDamage > 0 || move.fixedDamagePct > 0) && ctx.dmg > 0) {
          ctx.dmg = move.fixedDamage > 0 ? move.fixedDamage : Math.max(1, Math.floor(hp[otherSide] * move.fixedDamagePct / 100));
        }
        let ohkoHit = false;
        if (move.ohko && mult > 0) {
          const oab = ability[otherSide];
          const guarded = oab && oab.abilityType === "passive" && oab.passive.action === "ohkoGuard" && !isAbilityNullified(otherSide)
            && (hp[otherSide] / maxHp[otherSide]) * 100 >= oab.passive.ohkoGuardHpPct;
          if (guarded) { ctx.dmg = 0; shieldBlockedThisHit = true; log.push(`${defender.name}'s ${oab.name} makes it immune to the one-hit KO!`); }
          else { ohkoHit = true; ctx.dmg = Math.max(ctx.dmg, hp[otherSide]); }
        }
        const blockingShield = findBlockingShield(otherSide, move);
        if (blockingShield && (blockingShield.unignorable || !move.ignoreShields)) {
          ctx.dmg = 0;
          shieldBlockedThisHit = true;
          applyShieldHit(blockingShield, side, move, log, defender.name);
          // ---- Shield Interruption Log Override: a fully-absorbed hit gets ONLY this clean block
          // line — the standard type-effectiveness / "0 dmg" output for this hit is suppressed below
          // (lastMult is left untouched and this hit isn't counted toward the final damage summary). ----
          log.push(`${defender.name}'s shield blocked the hit! (${Math.max(0, blockingShield.hitsLeft)}/${blockingShield.capacity} hits left)`);
          if (blockingShield.hitsLeft <= 0) {
            shields[otherSide] = shields[otherSide].filter(s => s !== blockingShield);
            log.push(`${defender.name}'s shield shatters!`);
          }
          // ---- Reactive Shield Triggers: fires after the block/shatter log lines above, so the log
          // reads block -> reaction. "Direct Damage" reflects a % of the shield-owner's max HP back onto
          // the attacker; "Status Infliction" attempts to inflict a status on the attacker instead (only
          // if the attacker isn't already statused, same as any other status-inflicting effect). ----
          if (hp[side] > 0 && (!blockingShield.reactionContactOnly || (move.tags || []).some(t => String(t).toLowerCase() === "contact"))) {
            if (blockingShield.reaction === "damage" && chanceHits(blockingShield.reactionChance)) {
              const reactDmg = Math.max(1, Math.round(maxHp[side] * ((blockingShield.reactionValue || 0) / 100)));
              hp[side] = Math.max(0, hp[side] - reactDmg);
              log.push(`${attacker.name} is struck back for ${reactDmg} damage by ${defender.name}'s shield!`);
            } else if (blockingShield.reaction === "status" && !status[side] && chanceHits(blockingShield.reactionChance)) {
              status[side] = { kind: blockingShield.reactionStatus, counter: 1, turnsLeft: 3 + Math.floor(Math.random() * 3) };
              log.push(`${defender.name}'s shield afflicts ${attacker.name} with ${blockingShield.reactionStatus}!`);
            }
          }
        } else if (blockingShield && move.ignoreShields) {
          log.push(`${attacker.name}'s ${move.name} tears straight through ${defender.name}'s shield!`);
        }
        // ---- Substitute: the decoy takes the whole hit (no overflow). Moves that Ignore Defenses/Shields go through. ----
        if (!shieldBlockedThisHit && ctx.dmg > 0 && substitute[otherSide] && substitute[otherSide].hp > 0 && !move.ignoreShields) {
          const sb = substitute[otherSide];
          sb.hp -= ctx.dmg;
          ctx.dmg = 0;
          shieldBlockedThisHit = true;
          log.push(`The substitute took the damage for ${defender.name}! (${Math.max(0, sb.hp)}/${sb.max} left)`);
          if (sb.hp <= 0) { substitute[otherSide] = null; log.push(`${defender.name}'s substitute faded!`); }
        }
        // Item Dex: Weakness (drawback, +X% incoming) and Mitigation (-X% incoming) — both read the
        // defender's own held item and multiply the same final number, in opposite directions.
        ctx.dmg = Math.round(ctx.dmg * itemIncomingDamageMultiplier(otherSide, move) * itemDamageMitigation(otherSide, move, mult));
        dmg = Math.max(0, ctx.dmg);
        if (ohkoHit && dmg > 0) { dmg = Math.max(dmg, hp[otherSide]); log.push("It's a one-hit KO!"); }
        const hpBeforeThisHit = hp[otherSide];
        hp[otherSide] = Math.max(0, hp[otherSide] - dmg);
        totalDmg += dmg; hitsLanded++;
        // ---- Counter Mechanics: track this hit against the DEFENDER's turnState so a Counter/Mirror
        // Coat/Metal Burst-style move it uses later THIS SAME ROUND can reflect off of it. ----
        recordTurnDamage(otherSide, dmg, move.category);
        // ---- Full Transform (Ditto-style) "Reverts On Damage" mode (Zoroark/Illusion-style): the
        // instant the transformed side takes damage from a landed hit, it snaps back to its own
        // moves/ability/type. Checked here rather than only at end-of-round so a transform can never
        // survive the very hit that broke it. ----
        if (dmg > 0 && dittoState[otherSide].active && dittoState[otherSide].revertMode === "onDamage") {
          revertDittoTransform(otherSide);
        }
        // ---- Item Dex: "onTakeDamage" / "onHpThreshold" triggers on the defender (Focus Sash, Rocky
        // Helmet, Sitrus/Lum Berry), and "onDealDamage" on the attacker (e.g. Fire Gem), both gated by
        // each item's optional Move Filter (type/tag). ----
        if (dmg > 0) {
          applyItemOnHit(otherSide, side, move, hpBeforeThisHit);
          applyItemOnDeal(side, otherSide, move, dmg);
          // Item Dex Extended: Contact Counter (defender's item, contact-tagged moves only),
          // Ability Nullifier (attacker's item suppresses the defender's Ability), and Move Repeat
          // (Echo) — a chance to land a second, weaker copy of the exact same hit right now.
          applyItemContactCounter(otherSide, side, move);
          applyItemAbilityNullifier(side, otherSide);
          const echo = checkItemEcho(side, otherSide, move, dmg);
          if (echo.shouldEcho && hp[otherSide] > 0) {
            const echoDmg = Math.max(1, Math.round(dmg * echo.powerMult));
            const hpBeforeEcho = hp[otherSide];
            hp[otherSide] = Math.max(0, hp[otherSide] - echoDmg);
            totalDmg += echoDmg;
            log.push(`${attacker.name}'s ${move.name} strikes again for ${echoDmg} damage!`);
            applyItemOnHit(otherSide, side, move, hpBeforeEcho);
            applyItemOnDeal(side, otherSide, move, echoDmg);
          }
        }
        if (shieldBlockedThisHit) { shieldBlockedCount++; } else { lastMult = mult; }
        // ---- Battle History: cumulative damage received this match (Revenge-style scaling reads this) ----
        if (dmg > 0) totalDamageTaken[otherSide] += dmg;

        // ---- Mirror Damage Reflection: a % of the damage just taken is reflected straight back onto the
        // attacker, sourced from the defender's Ability (always-on) and/or an active "Mirror Stance"
        // status effect — the two sources stack if both are present. ----
        if (dmg > 0 && hp[side] > 0) {
          const mirrorAbilityPct = (ability[otherSide] && ability[otherSide].mirrorReflectPercent) || 0;
          const mirrorStatusPct = (status[otherSide] && status[otherSide].kind === "mirrorstance") ? (status[otherSide].mirrorReflectPercent || 0) : 0;
          const mirrorPct = mirrorAbilityPct + mirrorStatusPct;
          if (mirrorPct > 0) {
            const reflectAmt = Math.max(0, Math.round(dmg * (mirrorPct / 100)));
            if (reflectAmt > 0) {
              hp[side] = Math.max(0, hp[side] - reflectAmt);
              log.push(`${defender.name} mirrors the damage! ${attacker.name} takes ${reflectAmt} reflected damage!`);
            }
          }
        }

        // ---- Contact / On-Hit Chip Damage: attacker's own chip (e.g. poison touch) + defender's recoil-style ability ----
        if (ctx.chipDmg && hp[otherSide] > 0) {
          const chip = Math.min(hp[otherSide], ctx.chipDmg);
          hp[otherSide] = Math.max(0, hp[otherSide] - chip);
          totalDmg += chip;
          log.push(`${attacker.name}'s ${atkAbility ? atkAbility.name : "attack"} inflicts ${chip} chip damage!`);
        }
        if (defAbility && defAbility.abilityType === "passive" && defAbility.passive.action === "chipOnHit"
          && defAbility.passive.chipDamageTrigger === "onGetHit" && chanceHits(defAbility.passive.chance)) {
          const selfChip = defAbility.passive.chipDamageType === "flat" ? Math.round(defAbility.passive.chipDamageValue) : Math.round(dmg * (defAbility.passive.chipDamageValue / 100));
          if (selfChip > 0 && hp[side] > 0) {
            hp[side] = Math.max(0, hp[side] - selfChip);
            log.push(`${attacker.name} is hurt by ${defender.name}'s ${defAbility.name}!`);
          }
        }

        // ---- WHO/WHAT/WHEN/HOW matrix: dispatched by type-effectiveness category on the hit that just landed ----
        const dealWhen = mult > 1 ? "onDealSuperEffective" : (mult > 0 && mult < 1 ? "onDealNotVeryEffective" : (mult === 0 ? "onDealImmune" : null));
        if (dealWhen) {
          runMatrixEffects(atkAbility ? atkAbility.effects : null, side, dealWhen, {
            moveType: move.type, dmgDealt: dmg,
            bonusDmg: (magnitude) => {
              const add = Math.max(0, Math.round(dmg * (magnitude - 1)));
              if (add > 0 && hp[otherSide] > 0) { hp[otherSide] = Math.max(0, hp[otherSide] - add); totalDmg += add; log.push(`A matrix rule adds bonus ${move.type}-type damage! (+${add})`); }
            }
          });
          if (dealWhen === "onDealSuperEffective" && defAbility) {
            runMatrixEffects(defAbility.effects, otherSide, "onHitSuperEffective", { moveType: move.type });
          }
        }
        // ---- WHEN: When Hit By a Specific Type — fires on every landed hit (any effectiveness), filtered
        // by the defender's own matrixTypeFilter selection inside runMatrixEffects ----
        if (defAbility) {
          runMatrixEffects(defAbility.effects, otherSide, "onHitByType", { moveType: move.type });
        }
        // ---- WHEN: When Hitting With a Specific Type — the attacker-side mirror, fires on the attacker's
        // own ability effects for every landed hit, filtered by its own matrixTypeFilter selection ----
        if (atkAbility) {
          runMatrixEffects(atkAbility.effects, side, "onDealByType", { moveType: move.type });
        }

        // ---- Passive: "After Getting Hit" ----
        if (dmg > 0 && defAbility && defAbility.abilityType === "passive" && triggerMatches(defAbility.passive.trigger, "afterHit") && passiveApplies(defAbility, move.type)) {
          runAbilityAction(defAbility, otherSide, { hasDamage: false }, log);
          runEffectsFrom(defAbility, defAbility.effects, otherSide);
        }
      }

      // ---- Recoil Mechanics: applied once per move use, off the total damage dealt across all hits.
      // Rock Head-style abilities (ignoresRecoil) negate it entirely; otherwise a Passive Trigger
      // ability can still respond to the recoil via the "takingRecoil" hook. ----
      if ((move.recoilPercent || 0) > 0 && totalDmg > 0 && hp[side] > 0) {
        const recoilAbility = ability[side];
        if (recoilAbility && recoilAbility.ignoresRecoil) {
          log.push(`${attacker.name}'s ${recoilAbility.name} shrugs off the recoil!`);
        } else {
          const recoilDmg = Math.max(1, Math.round(totalDmg * (move.recoilPercent / 100)));
          hp[side] = Math.max(0, hp[side] - recoilDmg);
          log.push(`${attacker.name} is damaged by recoil! (${recoilDmg} dmg)`);
          if (recoilAbility && recoilAbility.abilityType === "passive" && triggerMatches(recoilAbility.passive.trigger, "takingRecoil")) {
            runAbilityAction(recoilAbility, side, { hasDamage: false }, log);
            runEffectsFrom(recoilAbility, recoilAbility.effects, side);
          }
        }
      }

      // ---- Drain: heal the user for X% of the total damage it just dealt (mirror image of Recoil above) ----
      if ((move.drainPercent || 0) > 0 && totalDmg > 0 && hp[side] > 0) {
        const drained = Math.max(1, Math.round(totalDmg * (move.drainPercent / 100)));
        const before = hp[side];
        hp[side] = Math.min(maxHp[side], hp[side] + drained);
        if (hp[side] > before) log.push(`${attacker.name} drained ${hp[side] - before} HP!`);
      }

      // ---- Shield Interruption Log Override: if every hit that landed this turn was fully absorbed by
      // a shield, the per-hit "shield blocked the hit!" line(s) already logged above tell the whole
      // story — skip the standard effectiveness / "0 dmg" line entirely rather than showing a
      // misleading "It's super effective! (0 dmg)" after a block. Computed here (ahead of the Effect
      // Sequence Array below) so it can also gate the move's own secondary effects. ----
      const allLandedHitsBlocked = hitsLanded > 0 && shieldBlockedCount >= hitsLanded;

      // ---- Move-level Dynamic Multi-Effect Sequence Array: runs once per move use, after damage resolves.
      // Skipped entirely when a shield fully absorbed every hit this move landed — a hit that never
      // actually got through shouldn't still poison/burn/flinch/etc. its target. Serene Grace-style
      // abilities scale every node's Effect Chance % via secondaryChanceMultiplierFor(). ----
      if (!allLandedHitsBlocked) {
        runEffectsFrom(move, move.effects, side, secondaryChanceMultiplierFor(side, move.tags));
      }

      // ---- Battle History: total-times-landed-a-hit counter (Echoed Voice-style scaling reads this) ----
      if (hitsLanded > 0) moveHitTotals[side][move.name] = (moveHitTotals[side][move.name] || 0) + 1;

      // ---- Chronological Battle Log Order: "used move!" was already logged before the hit loop above
      // (cause). What remains here is the effect-modifier tag and the final result, logged in that
      // order: effectiveness/hit-count first, then the damage total. ----
      if (!allLandedHitsBlocked) {
        const hitsTag = hitsToRun > 1 ? `Hit ${hitsLanded} time${hitsLanded === 1 ? "" : "s"}!` : "";
        const effTag = lastMult > 1 ? "It's super effective!" : lastMult < 1 && lastMult > 0 ? "It's not very effective..." : lastMult === 0 ? "It had no effect!" : "";
        if (hitsTag) log.push(hitsTag);
        if (effTag) log.push(effTag);
        log.push(`${defender.name} took ${totalDmg} damage!`);
      }

      if (hp[otherSide] <= 0 && hp[side] > 0 && ability[side]) runMatrixEffects(ability[side].effects, side, "onKnockOut");   // Moxie / Beast Boost
      if (hp[otherSide] <= 0) { log.push(`${defender.name} can't battle anymore!`); break; }
    }

    resolveSelfFaints();
    resolveSwitchIns(); // Switch In effect: a switch-in queued by the last action of the round
    syncBondStatus();

    // ---- Wish heals + Doom Countdown ticks (end of round) ----
    ["a", "b"].forEach(sd => {
      wishQueue[sd] = wishQueue[sd].filter(w => {
        if (--w.turns > 0) return true;
        if (hp[sd] > 0 && hp[sd] < maxHp[sd]) {
          const heal = Math.min(maxHp[sd] - hp[sd], Math.max(1, Math.round(maxHp[sd] * w.pct / 100)));
          hp[sd] += heal;
          log.push(`🌠 The wish came true! ${fighters[sd].name} recovered ${heal} HP!`);
        } else if (hp[sd] > 0) log.push(`🌠 The wish came true, but ${fighters[sd].name} is already at full HP.`);
        return false;
      });
      if (bondState[sd]) {
        const b = bondState[sd];
        if (hp[sd] <= 0 || fighters[otherOf(sd)] !== b.partner || hp[otherOf(sd)] <= 0) bondState[sd] = null;
        else if (--b.turns <= 0) { log.push(`🔗 The bond between ${fighters[sd].name} and ${b.partner.name} fades.`); bondState[sd] = null; }
      }
      typeAdds[sd] = typeAdds[sd].filter(entry => {
        if (entry.mode !== "turns" || hp[sd] <= 0) return true;
        if (--entry.turns > 0) return true;
        removeAddedType(sd, entry);
        log.push(`🧬 ${fighters[sd].name} is no longer ${cap(entry.type)}-type${(fighters[sd].types || []).includes(entry.type) ? " (its natural type remains)" : ""}.`);
        return false;
      });
      if (rootState[sd] && hp[sd] > 0 && --rootState[sd].turns <= 0) {
        log.push(`${rootState[sd].name} wears off, ${fighters[sd].name} is free to move again.`);
        groundedFighters.delete(fighters[sd]); rootState[sd] = null;
      }
      if (dodgeShield[sd] && hp[sd] > 0 && --dodgeShield[sd].turns <= 0) {
        log.push(`${dodgeShield[sd].name} wears off, ${fighters[sd].name} can be hit by inaccurate attacks again.`);
        dodgeShield[sd] = null;
      }
      if (liftState[sd] && hp[sd] > 0 && --liftState[sd].turns <= 0) {
        log.push(`${liftState[sd].name} wears off, ${fighters[sd].name} is back on the ground!`);
        liftedFighters.delete(fighters[sd]); liftState[sd] = null;
      }
      if (doomCount[sd] > 0 && hp[sd] > 0) {
        doomCount[sd]--;
        if (doomCount[sd] > 0) log.push(`☠️ ${fighters[sd].name}'s doom count fell to ${doomCount[sd]}!`);
        else { hp[sd] = 0; log.push(`☠️ ${fighters[sd].name}'s doom count hit zero — it faints!`); }
      }
    });

    // end-of-round residual status damage + custom duration countdown / wake-up
    ["a", "b"].forEach(side => {
      if (hp[side] <= 0) return;
      const st = status[side];
      if (!st) return;
      if (st.kind === "burn" || st.kind === "poison" || st.kind === "frostbite") {
        const dot = Math.max(1, Math.round(maxHp[side] * 0.0625));
        hp[side] = Math.max(0, hp[side] - dot);
        log.push(`${fighters[side].name} is hurt by its ${st.kind}! (${dot} dmg)`);
      } else if (st.kind === "badlyPoisoned") {
        const dot = Math.max(1, Math.round(maxHp[side] * 0.0625 * st.counter));
        hp[side] = Math.max(0, hp[side] - dot);
        st.counter++;
        log.push(`${fighters[side].name} is badly poisoned! (${dot} dmg)`);
      }
      // ---- Custom Status Duration: decrement the turn counter at the end of each round, then recover ----
      if (hp[side] > 0 && st.turnsLeft != null) {
        st.turnsLeft--;
        if (st.turnsLeft <= 0) {
          // ---- Multi-Turn Lock-In Attacks: a "repeat" status running out doesn't just clear quietly —
          // it pays off its configured end consequence first (Outrage/Thrash-style self-confusion by
          // default, or a cooldown lock on the just-repeated move, or nothing if set to "none"). ----
          if (st.kind === "repeat" && (st.lockInEndEffect || "confusion") !== "none") {
            if (st.lockInEndEffect === "cooldown") {
              if (lastUsedMove[side]) moveCooldowns[side][lastUsedMove[side]] = Math.max(moveCooldowns[side][lastUsedMove[side]] || 0, st.lockInCooldownTurns || 2);
              log.push(`${fighters[side].name} is worn out from its lock-in and must rest!`);
              status[side] = null;
            } else {
              log.push(`${fighters[side].name} snaps out of its lock-in... and becomes confused!`);
              status[side] = { kind: "confusion", counter: 1, turnsLeft: 2 + Math.floor(Math.random() * 2) };
            }
          } else {
            log.push(`${fighters[side].name} recovered from its ${st.kind}!`);
            status[side] = null;
          }
        }
      }
    });

    // ---- Field Effects: Grassy Field heals any Grass-type fighter still standing for 5% of its Max HP
    // at the end of every round — independent of Weather, so it stacks with whatever's active there. ----
    if (fieldEffect === "grassy") {
      ["a", "b"].forEach(side => {
        if (hp[side] <= 0 || hp[side] >= maxHp[side]) return;
        if (!fighters[side].types.includes("grass")) return;
        const heal = Math.max(1, Math.round(maxHp[side] * GRASSY_FIELD_HEAL_PERCENT));
        hp[side] = Math.min(maxHp[side], hp[side] + heal);
        log.push(`${fighters[side].name} soaks up the grassy field! (+${heal} HP)`);
      });
    }

    // ---- Custom Weather: per-round chip damage / healing ----
    if (CUSTOM_WEATHERS[weather] && (CUSTOM_WEATHERS[weather].chipPct > 0 || CUSTOM_WEATHERS[weather].healPct > 0)) {
      const cw = CUSTOM_WEATHERS[weather];
      ["a", "b"].forEach(sd => {
        if (hp[sd] <= 0) return;
        const types = fighters[sd].types || [];
        if (cw.chipPct > 0 && !types.some(t => cw.chipImmune.includes(t))) {
          const dot = Math.max(1, Math.round(maxHp[sd] * cw.chipPct / 100));
          hp[sd] = Math.max(0, hp[sd] - dot);
          log.push(`${fighters[sd].name} is hurt by the ${cw.name}! (${dot} dmg)`);
        }
        if (cw.healPct > 0 && hp[sd] > 0 && hp[sd] < maxHp[sd] && types.some(t => cw.healTypes.includes(t))) {
          const heal = Math.min(maxHp[sd] - hp[sd], Math.max(1, Math.round(maxHp[sd] * cw.healPct / 100)));
          hp[sd] += heal;
          log.push(`${fighters[sd].name} is refreshed by the ${cw.name}! (+${heal} HP)`);
        }
      });
    }

    // ---- Sandstorm: chips non-Rock/Ground/Steel creatures for Max HP / 16 at the end of each round ----
    if (weather === "sand") {
      ["a", "b"].forEach(side => {
        if (hp[side] <= 0) return;
        const immune = fighters[side].types.some(t => t === "rock" || t === "ground" || t === "steel");
        if (immune) return;
        const dot = Math.max(1, Math.round(maxHp[side] / 16));
        hp[side] = Math.max(0, hp[side] - dot);
        log.push(`${fighters[side].name} is buffeted by the sandstorm! (${dot} dmg)`);
      });
    }

    // ---- Polluted Weather: passive chip damage each round. Poison/Steel/Ghost types are fully immune;
    // Grass/Rock types take half damage; all other types take the full standard hit. ----
    if (weather === "polluted") {
      ["a", "b"].forEach(side => {
        if (hp[side] <= 0) return;
        const types = fighters[side].types;
        if (types.some(t => t === "poison" || t === "steel" || t === "ghost")) return; // fully immune
        const resistant = types.some(t => t === "grass" || t === "rock");
        const dot = Math.max(1, Math.round((maxHp[side] / 16) * (resistant ? 0.5 : 1)));
        hp[side] = Math.max(0, hp[side] - dot);
        log.push(`${fighters[side].name} is sickened by the polluted air! (${dot} dmg)`);
      });
      // ---- Turn-End Status Infliction: customizable % chance for non-immune targets to become Poisoned ----
      ["a", "b"].forEach(side => {
        if (hp[side] <= 0 || status[side]) return;
        const defender = fighters[side];
        if (itemBlocksStatus(side, "poison")) return;
        if (isStatusImmune(defender.types, "poison", null, defender.tags, fieldEffect)) return;
        if (chanceHits(pollutedPoisonChance)) {
          // ---- Duration Extender: +1 extra turn since this is being inflicted while Polluted is active ----
          status[side] = { kind: "poison", counter: 1, turnsLeft: 3 + Math.floor(Math.random() * 3) + pollutedDurationBonus("poison") };
          log.push(`${defender.name} is poisoned by the toxic, polluted air!`);
        }
      });
    }

    // ---- Persistent field hazards: chip damage each round in lieu of a switch-in mechanic ----
    ["a", "b"].forEach(side => {
      if (hp[side] <= 0) return;
      if (teamMode) return; // team battles apply hazards when a Fakemon is sent in instead (see enterSlot)
      const hz = hazards[side];
      if (hz.stealthrock) {
        const dot = Math.max(1, Math.round(maxHp[side] / 8));
        hp[side] = Math.max(0, hp[side] - dot);
        log.push(`${fighters[side].name} is hurt by the sharp stones! (${dot} dmg)`);
      }
      if (hz.spikesStacks > 0 && hp[side] > 0) {
        const dot = Math.max(1, Math.round((maxHp[side] / 8) * hz.spikesStacks));
        hp[side] = Math.max(0, hp[side] - dot);
        log.push(`${fighters[side].name} is hurt by spikes! (${dot} dmg)`);
      }
    });

    // ---- Modular Custom Entry Hazard Builder: onTurnEnd hook. Every active custom hazard flagged
    // Turn-Based applies its lingering per-turn damage and/or stat penalty to whichever side's field
    // it's sitting on, for as long as the occupant remains there (this simulator has no switch-out, so
    // "for as long as the occupant remains" is simply "every round for the rest of the battle"). ----
    ["a", "b"].forEach(side => {
      if (hp[side] <= 0 || !customHazards[side].length) return;
      customHazards[side].forEach(hz => {
        if (!hz.turnBasedEnabled || hp[side] <= 0) return;
        if (hz.turnDamagePct > 0) {
          const dot = Math.max(1, Math.round(maxHp[side] * (hz.turnDamagePct / 100) * (hz.stacking ? hz.stacks : 1)));
          hp[side] = Math.max(0, hp[side] - dot);
          log.push(`${fighters[side].name} is worn down by the lingering ${hz.name}! (${dot} dmg)`);
        }
        if (hz.turnStatStage !== 0 && hp[side] > 0 && statModAllowed(side, hz.turnStatStage)) {
          applyStatModTarget(stages, side, otherOf(side), "self", hz.turnStatKey, contraryAdjustedStage(side, hz.turnStatStage), fighters[side].name, "", log);
        }
      });
    });

    // ---- Counter Mechanics: clear both sides' turn-scoped damage tracking now that the round is
    // fully resolved, so a Counter/Mirror Coat/Metal Burst-style move next round can only ever
    // reflect off damage taken during THAT round, never a stale hit from a previous one. ----
    resetTurnState();

    // ---- Move Cooldowns: count down every locked-out move's remaining turns at the end of each round ----
    ["a", "b"].forEach(side => {
      Object.keys(moveCooldowns[side]).forEach(name => {
        if (moveCooldowns[side][name] > 0) moveCooldowns[side][name]--;
      });
    });

    // ---- Dynamic State-Binding Partial Immunity (Fly / Dig / Bury Mechanics): counts down every round.
    // "onAttack" mode lasts only through the rest of the round it was entered on (original behavior).
    // "fixedDuration" mode instead persists across multiple rounds, counting down regardless of
    // whether/when an attack actually resolved out of the stance. ----
    ["a", "b"].forEach(side => {
      if (!stateImmunity[side]) return;
      stateImmunity[side].turnsLeft--;
      if (stateImmunity[side].turnsLeft <= 0) {
        log.push(stateImmunity[side].expireEvent === "fixedDuration"
          ? `${fighters[side].name}'s ${stateImmunity[side].key} state wears off!`
          : `${fighters[side].name} returns to the fray!`);
        stateImmunity[side] = null;
      }
    });

    // ---- Breakable Stat-Specific & Weakness-Specific Attack Shields: count down each shield stack's
    // optional Shield Duration (turnsLeft===null means no turn limit — it only expires via hit capacity) ----
    ["a", "b"].forEach(side => {
      if (!shields[side].length) return;
      shields[side] = shields[side].filter(sh => {
        if (sh.turnsLeft == null) return true;
        sh.turnsLeft--;
        if (sh.turnsLeft <= 0) {
          log.push(`${fighters[side].name}'s shield fades away!`);
          return false;
        }
        return true;
      });
    });

    // ---- Delayed Attack Events (Future Sight / Doom Desire Mechanic): tick every in-flight delayed
    // hit's turn counter down at end-of-round. Once an entry's counter reaches 0 it's resolved (see
    // resolveDelayedAttack above) and removed from the queue; everything else stays queued. ----
    if (delayedAttacks.length) {
      for (let i = delayedAttacks.length - 1; i >= 0; i--) {
        const entry = delayedAttacks[i];
        entry.turnsLeft--;
        if (entry.turnsLeft <= 0) {
          resolveDelayedAttack(entry);
          delayedAttacks.splice(i, 1);
        }
      }
    }

    // ---- Delayed Effect Queue: end-of-turn execution queue. Ticks every active countdown timer down
    // (both "Fixed Countdown" and "On Charge-Release" nodes share the same turnsLeft field by the time
    // they're queued), resolves any node whose counter hits 0 via resolveDelayedEffect(), and drops the
    // resolved (or otherwise expired/no-target) marker from the queue. ----
    ["a", "b"].forEach(side => {
      if (!delayedEffectQueue[side].length) return;
      for (let i = delayedEffectQueue[side].length - 1; i >= 0; i--) {
        const entry = delayedEffectQueue[side][i];
        entry.turnsLeft--;
        if (entry.turnsLeft <= 0) {
          resolveDelayedEffect(entry);
          delayedEffectQueue[side].splice(i, 1);
        }
      }
    });

    // ---- Multi-Turn Drain & Burnout: end-of-turn persistent drain loop. Every active tether removes
    // `percent`% of the drained side's resource (HP directly; Energy from whatever move it last used;
    // a Stat Stage nudged down by one) each round and, if a gainSide is set and still standing, hands
    // that same amount back to it (HP/PP only — stat-stage siphons don't have a meaningful "gain" side
    // beyond simply lowering the drained side's stage). Tethers expire on a finite duration, or the
    // moment either side faints — whichever comes first. ----
    ["a", "b"].forEach(side => {
      if (!persistentDrains[side].length) return;
      const stillActive = [];
      persistentDrains[side].forEach(pd => {
        if (hp[side] > 0) {
          if (pd.resource === "hp") {
            const amt = Math.max(1, Math.round(maxHp[side] * (pd.percent / 100)));
            hp[side] = Math.max(0, hp[side] - amt);
            log.push(`${fighters[side].name} is siphoned by the lingering drain! (${amt} HP)`);
            if (pd.gainSide != null && hp[pd.gainSide] > 0) {
              hp[pd.gainSide] = Math.min(maxHp[pd.gainSide], hp[pd.gainSide] + amt);
            }
          } else if (pd.resource === "energy") {
            const moveName = lastUsedMove[side];
            if (moveName != null && movePP[side][moveName] != null) {
              const amt = Math.max(1, Math.round((movePP[side][moveName]) * (pd.percent / 100)));
              movePP[side][moveName] = Math.max(0, movePP[side][moveName] - amt);
              log.push(`${fighters[side].name}'s ${moveName} loses ${amt} PP to the lingering drain!`);
            }
          } else if (pd.resource === "stat") {
            stages[side][pd.statKey] = Math.max(-6, (stages[side][pd.statKey] || 0) - 1);
            log.push(`${fighters[side].name}'s ${pd.statKey.toUpperCase()} is siphoned down by the lingering drain!`);
            if (pd.gainSide != null && hp[pd.gainSide] > 0) {
              stages[pd.gainSide][pd.statKey] = Math.min(6, (stages[pd.gainSide][pd.statKey] || 0) + 1);
            }
          }
        }
        if (pd.turnsLeft != null) pd.turnsLeft--;
        const expired = (pd.turnsLeft != null && pd.turnsLeft <= 0) || hp[side] <= 0 || (pd.gainSide != null && hp[pd.gainSide] <= 0);
        if (!expired) stillActive.push(pd);
      });
      persistentDrains[side] = stillActive;
    });

    // ---- Turn-Based Duration & Decay: count down each active timed stat modifier; once it expires, either
    // "Decay/Disappear" (the applied stage delta is simply removed) or "Revert to Original" (the stat snaps
    // back exactly to the stage it held right before this modifier was applied) — whichever the effect chose. ----
    ["a", "b"].forEach(side => {
      if (!timedStatMods[side].length) return;
      const stillActive = [];
      timedStatMods[side].forEach(mod => {
        mod.turnsLeft--;
        if (mod.turnsLeft > 0) { stillActive.push(mod); return; }
        if (hp[side] > 0) {
          if (mod.expireMode === "revert") {
            stages[side][mod.statKey] = Math.max(-6, Math.min(6, mod.baselineStage));
            log.push(`${fighters[side].name}'s ${mod.statKey.toUpperCase()} reverts back to normal!`);
          } else {
            stages[side][mod.statKey] = Math.max(-6, Math.min(6, (stages[side][mod.statKey] || 0) - mod.amount));
            log.push(`${fighters[side].name}'s ${mod.statKey.toUpperCase()} boost fades away!`);
          }
        }
      });
      timedStatMods[side] = stillActive;
    });

    // ---- "TRADEOFF" Move Matrix: tick every active "Drain % HP" consequence at end-of-round — the
    // afflicted side loses the flat dot amount each round, and (if still standing) whoever originally
    // inflicted it gets that same amount back as HP, exactly like the timed stat mod tracker above. ----
    ["a", "b"].forEach(side => {
      if (!tradeoffDots[side].length) return;
      const stillActive = [];
      tradeoffDots[side].forEach(td => {
        if (hp[side] > 0) {
          hp[side] = Math.max(0, hp[side] - td.dot);
          log.push(`${fighters[side].name} is drained by the lingering tradeoff effect! (${td.dot} dmg)`);
          if (hp[td.healSide] > 0) {
            hp[td.healSide] = Math.min(maxHp[td.healSide], hp[td.healSide] + td.dot);
          }
        }
        td.turnsLeft--;
        if (td.turnsLeft > 0 && hp[side] > 0) stillActive.push(td);
      });
      tradeoffDots[side] = stillActive;
    });

    // ---- Item Dex: "turnEnd" trigger — e.g. Leftovers restoring 1/16th Max HP every round.
    // Runs once per side, per round, after all other end-of-round chip/drain effects above. ----
    applyItemTurnEnd("a");
    applyItemTurnEnd("b");
    // Extended Item Effect Hooks: Stat Modifier (timed) duration tick + Ability Nullifier countdown +
    // Timed Type/Tag Damage Boost countdown (boostDamage effects armed via battleStart/onUse).
    ["a", "b"].forEach(side => { tickItemStatModifier(side); tickAbilityNullifier(side); tickItemTimedBoosts(side); });

    // ---- Weather duration countdown: field condition reverts to Clear once its timer runs out ----
    if (weather !== "clear") {
      weatherTurns--;
      if (weatherTurns <= 0) {
        weather = "clear";
        weatherLocked = false;
        log.push(`The weather returns to normal.`);
      }
    }
    // ---- Field Effect duration countdown: independent of Weather's timer above ----
    if (fieldEffect !== "none") {
      fieldTurns--;
      if (fieldTurns <= 0) {
        fieldEffect = "none";
        fieldLocked = false;
        log.push(`The field effect fades away.`);
      }
    }

    // ---- Transformation Duration (Turn Limit) + Reuse Cooldown countdown (Rules 1 & 3): mirrors the
    // Weather/Field timers above. A side with a finite (non-permanent) active transformation ticks its
    // turnsRemaining down and fully reverts — via revertTransformation(), which also starts the reuse
    // cooldown/lockout — the instant it hits 0. A side that's back in base form and waiting out a reuse
    // cooldown ticks that down separately so it becomes eligible to transform again once it reaches 0. ----
    ["a", "b"].forEach(side => {
      const st = transformState[side];
      if (st.active && st.turnsRemaining != null) {
        st.turnsRemaining--;
        if (st.turnsRemaining <= 0) revertTransformation(side);
      } else if (!st.active && st.cooldownRemaining > 0) {
        st.cooldownRemaining--;
      }
    });

    // ---- Full Transform (Ditto-style) Revert Timing: only the "turns" revert mode ticks down here —
    // "permanent" never reverts on its own, and "onDamage" is instead handled the instant a hit lands
    // (see the main damage-application block in the turn loop above). ----
    ["a", "b"].forEach(side => {
      const dst = dittoState[side];
      if (dst.active && dst.revertMode === "turns" && dst.revertTurnsRemaining != null) {
        dst.revertTurnsRemaining--;
        if (dst.revertTurnsRemaining <= 0) revertDittoTransform(side);
      }
    });

    // ---- TEAM MODE: replace any fainted Fakemon (both sides, simultaneously). A hazard can KO the
    // replacement on arrival, so keep sending in until someone stands or the bench is empty. ----
    if (teamMode) {
      ["a", "b"].forEach(side => {
        if (hp[side] > 0) return;
        const nm = fighters[side].name;
        if (!log.slice(-12).some(l => l.includes(`${nm} can't battle anymore`))) log.push(`${nm} fainted!`);
        let guard = 0;
        while (hp[side] <= 0 && benchLeft(side) > 0 && guard++ < 24) {
          slots[side][teamIdx[side]].fainted = true;
          enterSlot(side, chooseReplacement(side));
          if (hp[side] <= 0) log.push(`${fighters[side].name} fainted on arrival!`);
        }
        if (hp[side] <= 0) slots[side][teamIdx[side]].fainted = true;
      });
    }
  }
  let winner, winnerSide;
  if (teamMode) {
    // Normal finish: whoever still has Fakemon. Turn-cap finish: more remaining team health wins.
    const sa = teamHealth("a"), sb = teamHealth("b");
    winnerSide = sa === sb ? (Math.random() < 0.5 ? "a" : "b") : (sa > sb ? "a" : "b");
    winner = team[winnerSide][0]; // lead entry, kept for callers that expect an entry object
    log.push(`🏆 Team ${winnerSide.toUpperCase()} wins the battle! (${teamLeft(winnerSide)} Fakemon still standing)`);
  } else {
    if (hp.a <= 0 && hp.b <= 0) winner = Math.random() < 0.5 ? a : b;
    else if (hp.a <= 0) winner = b;
    else if (hp.b <= 0) winner = a;
    else winner = hp.a >= hp.b ? a : b;
    winnerSide = winner === a ? "a" : "b";
    log.push(`🏆 ${winner.name} wins the battle!`);
  }
  return { winner, winnerSide, log, remaining: { a: teamMode ? teamLeft("a") : (hp.a > 0 ? 1 : 0), b: teamMode ? teamLeft("b") : (hp.b > 0 ? 1 : 0) }, turns: turn };
}

function runBattleOdds(a, b, trials, megaConfig, fieldConfig, itemConfig) {
  let aWins = 0;
  let narratedLog = null;
  for (let i = 0; i < trials; i++) {
    const result = simulateOneBattle(a, b, megaConfig, fieldConfig, itemConfig);
    if (result.winner.id === a.id) aWins++;
    if (i === trials - 1) narratedLog = result.log;
  }
  const pctA = Math.round((aWins / trials) * 100);
  const pctB = 100 - pctA;
  return { pctA, pctB, narratedLog };
}

const fighterASelect = document.getElementById("fighterASelect");
const fighterBSelect = document.getElementById("fighterBSelect");
const fighterAPreview = document.getElementById("fighterAPreview");
const fighterBPreview = document.getElementById("fighterBPreview");
const fighterAItemSelect = document.getElementById("fighterAItemSelect");
const fighterBItemSelect = document.getElementById("fighterBItemSelect");
const battleFavOnly = document.getElementById("battleFavOnly");
const allowMegaToggle = document.getElementById("allowMegaToggle");
const megaChancePct = document.getElementById("megaChancePct");
const fieldEffectSelect = document.getElementById("fieldEffectSelect");
const simulateBattleBtn = document.getElementById("simulateBattleBtn");
const battleResultsEl = document.getElementById("battleResults");
const itemGrid = document.getElementById("itemGrid");

// ================= BATTLE SEARCH BAR =================
// Narrows Fighter A / Fighter B AND both Held Item pickers at once, by Name (battler name, a
// move on their kit, or an item name) and/or Type (battler's types). Solves "scrolling hell"
// on rosters/item lists that have grown large.
const battleSearchInput = document.getElementById("battleSearchInput");
const battleTypeChipBtn = document.getElementById("battleTypeChipBtn");
const battleTypeChipPanel = document.getElementById("battleTypeChipPanel");
const battleSearchClearBtn = document.getElementById("battleSearchClearBtn");
const battleSearchSummary = document.getElementById("battleSearchSummary");
let battleFilters = { text: "", type: "" };

// ================= RANDOM BATTLE (team mode) =================
// Picks `size` Fakemon WITH replacement from the whole roster, so mirrors (even a whole team of the same
// species) are possible — which is what you want while the roster is small. Entries without any named move
// are skipped because they couldn't do anything on the field.
function buildRandomTeam(pool, size) {
  size = Math.max(1, Math.round(Number(size) || 6));
  // migrateEntry() normalizes abilities/moves/megas. Entries streamed in from Firestore (main.js) are RAW, and the
  // team-mode bot reads ab.passive.chance / ab.active.chance on every teammate's ability — on a raw ability those
  // blocks don't exist, which caused "Cannot read properties of undefined (reading 'chance')" in Random Battle.
  const valid = (pool || []).filter(e => e && !e.isVirtualMega && (e.moves || []).some(m => m && m.name));
  if (!valid.length) return [];
  return Array.from({ length: size }, () => ({ ...migrateEntry(valid[Math.floor(Math.random() * valid.length)]), __migrated: true }));
}

// ================= ITEM RANDOMIZER (Random Battle + 2v2) =================
// Gives every rolled Fakemon a held item:
//  · If the Fakemon has an item-gated transformation (a Mega / Alternate Form whose Activation Requirement names a
//    "Required Held Item"), it holds ONE of those items with probability ITEM_RANDOMIZER.formItemChance — so Blastoise
//    usually gets Blastoisinite and a custom "Wishing Star" owner usually gets its Wishing Star.
//  · Otherwise (or the other 20%) it rolls from the GENERAL pool. The general pool EXCLUDES every item that is the
//    required item of ANY Fakemon's transformation, so Blastoise can never roll Charizardite. New Megas/stones need no
//    code changes: just set the form's Required Held Item in the editor and the randomizer picks it up.
//  · noItemChance of general rolls leave the Fakemon empty-handed.
const ITEM_RANDOMIZER = { enabled: true, formItemChance: 0.8, noItemChance: 0.15 };
function transformItemIdsOf(entry) {
  const megas = (entry && (entry.megas || entry.mega)) || [];
  const list = Array.isArray(megas) ? megas : [megas];
  const ids = [];
  list.forEach(mg => {
    if (!mg || mg.enabled === false) return;
    const id = String((mg.activation && mg.activation.requiredItem) || "").trim();
    if (id && !ids.includes(id)) ids.push(id);
  });
  return ids;
}
function allTransformGateItemIds(pool) {
  const gate = new Set();
  (pool || []).forEach(e => transformItemIdsOf(e).forEach(id => gate.add(id)));
  return gate;
}
function pickRandomHeldItemId(entry, gate, cfg) {
  cfg = { ...ITEM_RANDOMIZER, ...(cfg || {}) };
  if (!cfg.enabled || typeof items === "undefined" || !Array.isArray(items) || !items.length) return null;
  const own = transformItemIdsOf(entry).filter(id => items.some(i => i.id === id)); // ignore ids of deleted items
  if (own.length && Math.random() < cfg.formItemChance) return own[Math.floor(Math.random() * own.length)];
  const general = items.filter(i => i && i.id && !gate.has(i.id));
  if (!general.length || Math.random() < cfg.noItemChance) return null;
  return general[Math.floor(Math.random() * general.length)].id;
}
// One item id (or null) per team member, in team order — this is the array shape itemConfig expects.
function rollTeamItems(team, cfg) {
  const gate = allTransformGateItemIds(typeof entries !== "undefined" ? entries : team);
  return (team || []).map(en => pickRandomHeldItemId(en, gate, cfg));
}
// One full bot-vs-bot team battle. Returns the engine result plus both rolled teams.
function runRandomBattle(megaConfig, fieldConfig, size) {
  const teamA = buildRandomTeam(entries, size), teamB = buildRandomTeam(entries, size);
  if (!teamA.length || !teamB.length) return null;
  const itemsA = rollTeamItems(teamA), itemsB = rollTeamItems(teamB);
  const r = simulateOneBattle(teamA[0], teamB[0], megaConfig, fieldConfig, { a: itemsA, b: itemsB }, { a: teamA, b: teamB });
  return { ...r, teamA, teamB, itemsA, itemsB };
}

// ================= BATTLE MODE TOGGLE: 1v1 / Random Battle =================
// Binds to the #battleModeToggle markup in index.html. While Random Battle is selected it (a) hides every
// .battle-1v1-only block (search bar, favorites filter, fighter pickers), (b) keeps the Simulate button
// clickable even though the 1v1 code leaves it disabled until two fighters are chosen, and (c) intercepts the
// Simulate click in the capture phase so the existing 1v1 handler never runs. Back in 1v1 it restores
// everything exactly as it was, so the 1v1 flow is untouched.
function installBattleModeToggle() {
  if (typeof document === "undefined" || !simulateBattleBtn || !battleResultsEl) return;
  const wrap = document.getElementById("battleModeToggle");
  if (!wrap || wrap.dataset.wired === "1") return;
  wrap.dataset.wired = "1";
  const btn1v1 = document.getElementById("battleMode1v1Btn"), btnRand = document.getElementById("battleModeRandomBtn"), btnDbl = document.getElementById("battleModeDoublesBtn");
  const hint = document.getElementById("battleModeHint");
  if (!btn1v1 || !btnRand) return;
  let battleMode = "1v1", wasDisabled = simulateBattleBtn.disabled, simLabel = simulateBattleBtn.textContent;

  // Keep the button enabled in Random mode even if the 1v1 code re-disables it (no fighters picked).
  new MutationObserver(() => { if ((battleMode === "random" || battleMode === "doubles") && simulateBattleBtn.disabled) simulateBattleBtn.disabled = false; })
    .observe(simulateBattleBtn, { attributes: true, attributeFilter: ["disabled"] });

  function setMode(mode) {
    const rand = mode === "random" || mode === "doubles";
    if (rand && battleMode !== "random" && battleMode !== "doubles") { wasDisabled = simulateBattleBtn.disabled; simLabel = simulateBattleBtn.textContent; }
    battleMode = mode;
    btn1v1.classList.toggle("active", mode === "1v1"); btnRand.classList.toggle("active", mode === "random"); if (btnDbl) btnDbl.classList.toggle("active", mode === "doubles");
    btn1v1.setAttribute("aria-pressed", String(mode === "1v1")); btnRand.setAttribute("aria-pressed", String(mode === "random")); if (btnDbl) btnDbl.setAttribute("aria-pressed", String(mode === "doubles"));
    document.querySelectorAll(".battle-1v1-only").forEach(el => { el.style.display = rand ? "none" : ""; });
    if (hint) hint.textContent = mode === "doubles" ? "2v2: each side (🔵 Blue vs 🔴 Red) rolls 4 random Fakemon — 2 fight, 2 wait on the bench. Moves use their Target setting. Click Roll to start." : rand ? "Both sides get 6 random Fakemon from the whole roster (mirrors allowed). Click Simulate to roll a new match." : "";
    if (rand) {
      simulateBattleBtn.disabled = false;
      simulateBattleBtn.textContent = mode === "doubles" ? "🎲 Roll 2v2 Battle" : "🎲 Roll Random Battle";
    } else {
      simulateBattleBtn.textContent = simLabel;
      simulateBattleBtn.disabled = wasDisabled;
      // let the 1v1 UI recompute whether the button should be enabled for the currently picked fighters
      if (fighterASelect) fighterASelect.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
  btn1v1.addEventListener("click", () => setMode("1v1"));
  btnRand.addEventListener("click", () => setMode("random"));
  if (btnDbl) btnDbl.addEventListener("click", () => setMode("doubles"));

  function renderRandomBattle(res) {
    const itemName = id => { const it = id ? itemById(id) : null; return it ? ` 🎒${it.name}` : ""; };
    const chip = (en, i, arr, ids) => `<span class="type-pill" style="background:var(--t-${(en.types && en.types[0]) || "normal"});margin:2px 4px 2px 0;">${esc(en.name)}${esc(itemName(ids && ids[i]))}</span>`;
    const winTeam = res.winnerSide === "a" ? "Team A" : "Team B";
    const cls = line => line.includes("🏆") ? "winner-line" : line.includes("🪄") ? "move-learn-line" : line.includes("🎒") ? "item-line"
      : (line.includes("🎯") || line.includes("🔄") || line.includes("🔮") || line.includes("🧬") || line.includes("🧪") || line.includes("🔁")) ? "move-swap-line" : "";
    battleResultsEl.innerHTML = `
        <div class="battle-results">
          <div class="odds-verdict">${winTeam} wins — ${res.remaining[res.winnerSide]} Fakemon left standing (${res.turns} turns)</div>
          <div style="margin:8px 0 4px;"><b>Team A</b> ${res.teamA.map((en, i, arr) => chip(en, i, arr, res.itemsA)).join("")}</div>
          <div style="margin:4px 0 12px;"><b>Team B</b> ${res.teamB.map((en, i, arr) => chip(en, i, arr, res.itemsB)).join("")}</div>
          <div class="battle-log-title">Battle replay</div>
          <div class="battle-log">${res.log.map(line => `<div class="${cls(line)}">${esc(line)}</div>`).join("")}</div>
          <button class="btn-secondary replay-btn" id="rerunRandomBattleBtn">🎲 Roll Again</button>
        </div>`;
    const again = document.getElementById("rerunRandomBattleBtn");
    if (again) again.addEventListener("click", startRandomBattle);
  }
  function startRandomBattle() {
    const megaConfig = { enabled: !!(allowMegaToggle && allowMegaToggle.checked), chance: clampPct(megaChancePct && megaChancePct.value, 50) };
    const fieldConfig = { field: (fieldEffectSelect && fieldEffectSelect.value) || "none" };
    let res = null;
    try { res = runRandomBattle(megaConfig, fieldConfig, 6); }
    catch (err) { battleResultsEl.textContent = "Random Battle failed: " + (err && err.message ? err.message : err); console.error(err); return; }
    if (!res) { battleResultsEl.textContent = "Random Battle needs at least one Fakemon with a move in the roster."; return; }
    renderRandomBattle(res);
  }
  function startDoublesBattle() {
    let res = null;
    try { res = typeof runDoublesBattle === "function" ? runDoublesBattle(4, { megaEnabled: !!(allowMegaToggle && allowMegaToggle.checked), megaChance: clampPct(megaChancePct && megaChancePct.value, 50) }) : null; }
    catch (err) { battleResultsEl.textContent = "2v2 Battle failed: " + (err && err.message ? err.message : err); console.error(err); return; }
    if (!res) { battleResultsEl.textContent = "2v2 Battle needs at least one Fakemon with a move in the roster (and js/doubles.js loaded)."; return; }
    renderDoublesResult(res, startDoublesBattle);
  }
  document.addEventListener("click", ev => {
    if (battleMode !== "random" && battleMode !== "doubles") return;
    const hit = ev.target && ev.target.closest && ev.target.closest("#simulateBattleBtn");
    if (!hit) return;
    ev.stopImmediatePropagation(); ev.preventDefault();
    if (battleMode === "doubles") startDoublesBattle(); else startRandomBattle();
  }, true);
  setMode("1v1");
}
if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", installBattleModeToggle);
  else installBattleModeToggle();
}