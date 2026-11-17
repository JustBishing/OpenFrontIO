import { Difficulty } from "@openfront/engine-api/game/GameTypes";

/**
 * Every tunable number SmartNation uses, in one place. Each constant belongs
 * to one decision in SmartStrategy.ts / SmartSpawn.ts; the comment says
 * which way to turn it. Ratios are fractions (0.5 = 50%). Times are ticks
 * (10 ticks = 1 second).
 */

// ── Cadence ─────────────────────────────────────────────────────────────────

/** Ticks between decision rounds (attack / diplomacy / defense). Lower = faster reactions. */
export const ACT_INTERVAL: Record<Difficulty, number> = {
  [Difficulty.Easy]: 70,
  [Difficulty.Medium]: 40,
  [Difficulty.Hard]: 30,
  [Difficulty.Impossible]: 25,
};
/** Extra economy checks spread evenly between decision rounds, so gold doesn't pile up. */
export const ECONOMY_CHECKS_PER_INTERVAL = 2;

// ── Spawn ───────────────────────────────────────────────────────────────────

/** Random land tiles scored per spawn evaluation. More = better spot, slower spawn phase. */
export const SPAWN_CANDIDATES = 300;
/** Radius (tiles) of the area whose terrain is scored around a candidate. */
export const SPAWN_SCAN_RADIUS = 18;
/** Only every Nth tile in the scan area is looked at (cost control). */
export const SPAWN_SCAN_STEP = 3;
/** How far (tiles) rays travel looking for coast/mountains/map edge. */
export const SPAWN_NATURAL_BORDER_RANGE = 45;
/** Candidates with less land than this around them (tiny islands, thin coasts) are skipped. */
export const SPAWN_MIN_LAND_FRACTION = 0.35;
/** Distance from the map edge (as a fraction of the shorter side) that still counts as "near the edge". */
export const SPAWN_EDGE_RANGE = 0.15;
/** Score weights. Raise one to make that property matter more. */
export const SPAWN_W_PLAINS = 1.0;
export const SPAWN_W_SEPARATION = 2.0;
export const SPAWN_W_EDGE = 0.6;
export const SPAWN_W_NATURAL_BORDER = 1.0;
/**
 * Separation is measured against the radius a player would own if land were
 * split evenly (sqrt(land / players)). 1.0 = full score at that distance.
 */
export const SPAWN_SEPARATION_TARGET = 1.0;
/** Re-check the spawn spot this often during the spawn phase (others keep arriving). */
export const SPAWN_REEVALUATE_TICKS = 25;
/** Only move if the new spot scores this much better (fraction) — avoids hopping around. */
export const SPAWN_MOVE_IMPROVEMENT = 0.2;

// ── Early game: expansion ───────────────────────────────────────────────────

/** Early game ends once we own this share of the map's land, or free land runs out. */
export const EARLY_MAX_TERRITORY_SHARE = 0.05;
/**
 * Free land is a race: tribes and nations claim it within the first minute.
 * So, like the regular nations, push into it every decision round with
 * everything above EXPAND_KEEP_RATIO of max troops. (Waiting for the growth
 * peak at ~42% of max lost too much land in the World/Hard evaluation.)
 * EXPAND_TRIGGER_RATIO is the troop level below which we don't bother.
 */
export const EXPAND_TRIGGER_RATIO = 0.15;
export const EXPAND_KEEP_RATIO = 0.15;
/** The very first expansion (right after spawning) sends this fraction of troops. */
export const EXPAND_TROOP_FRACTION = 0.5;
/** Attack a neighbouring tribe only if the troops we'd send exceed its troops by this factor. */
export const TRIBE_ATTACK_ADVANTAGE = 1.3;

// ── Economy ─────────────────────────────────────────────────────────────────

/** Cities come first: build this many before anything else. */
export const MIN_CITIES = 3;
/** After that, aim for one city per this many owned tiles. */
export const TILES_PER_CITY = 800;
/** Coastal nations build their first port after this many cities (trade is most of the income). */
export const CITIES_BEFORE_FIRST_PORT = 0;
/** Coastal nations want ports: one per this many cities (at least one). */
export const CITIES_PER_PORT = 2;
/** Factories once we have this many cities and ports... */
export const MIN_CITIES_BEFORE_FACTORY = 3;
/** ...one per this many cities... */
export const CITIES_PER_FACTORY = 3;
/**
 * ...and only once gold covers this many factories' cost. Passive income is
 * flat, so a surplus is the "income allows it" signal (trade adds the rest).
 */
export const FACTORY_GOLD_BUFFER = 1.5;
/** Nuke defence and offence (the regular nations' logic decides when to fire). */
/** One SAM launcher per this many cities... */
export const CITIES_PER_SAM = 4;
/** ...and one missile silo per this many cities, once we have this many cities. */
export const CITIES_PER_SILO = 5;
export const MIN_CITIES_BEFORE_SILO = 4;
/**
 * Each part of the military can be switched on separately. In the World/Hard
 * evaluation (tests/sim/SmartNationSim.ts) silos+nukes and warships both made
 * SmartNation weaker: they cost gold that cities turn into troops, and
 * provoke retaliation.
 */
export const BUILD_SAMS = true;
export const USE_WARSHIPS = false;
export const USE_NUKES = false;
/** With nothing else to build, keep turning gold into cities (or city levels): +250k max troops each. */
export const SPEND_SPARE_GOLD_ON_CITIES = true;
/** With spare gold, upgrade ports until their levels reach this share of our city levels (0 = cities only). */
export const SPARE_PORT_LEVEL_RATIO = 0;
/**
 * Piracy: warships patrol the busiest enemy trade lane and capture ships
 * there (the captor keeps the whole payout). Up to this many warships...
 */
export const PIRACY_MAX_WARSHIPS = 1;
/** ...once we have this many cities... */
export const PIRACY_MIN_CITIES = 8;
/** ...for a lane with at least this many capturable ships in patrol range. */
export const PIRACY_MIN_SHIPS = 3;
/** Ship positions tried as patrol spots per decision (cost control). */
export const PIRACY_LANE_CANDIDATES = 40;
/** Move a warship only to a lane with this many times the ships of its current one. */
export const PIRACY_MOVE_FACTOR = 2;
export const USE_PIRACY = true;
/** When no tile is free for a new structure, upgrade an existing one instead. */
export const UPGRADE_WHEN_NO_ROOM = true;

// ── Defense ─────────────────────────────────────────────────────────────────

/** Always keep this fraction of max troops home. */
export const BASE_RESERVE_RATIO = 0.25;
/** Plus this fraction of the strongest hostile neighbour's troops. */
export const THREAT_RESERVE_FACTOR = 0.3;
/** But never keep more than this fraction of max troops home. */
export const MAX_RESERVE_RATIO = 0.6;
/** Build defense posts once the strongest neighbour has this many troops relative to ours... */
export const DEFENSE_THREAT_RATIO = 1.2;
/** ...and only once this many cities stand (early gold is worth more as cities). */
export const DEFENSE_MIN_CITIES = 2;
/** Max defense posts facing a single neighbour. */
export const MAX_DEFENSE_POSTS_PER_FRONT = 3;
/** Defense posts go this many tiles behind the border so they finish before it moves. */
export const DEFENSE_POST_DEPTH = 6;

// ── Mid / late game: war and diplomacy ─────────────────────────────────────

/** Only start attacking players once troops reach this fraction of max. */
export const ATTACK_TRIGGER_RATIO = 0.55;
/** Fraction of troops above the reserve that each attack sends. */
export const ATTACK_TROOP_FRACTION = 0.8;
/** Only attack a player whose troops are at most this fraction of ours. */
export const ATTACK_MAX_RELATIVE_STRENGTH = 0.7;
/** Counter-attack an attacker if our available troops exceed their attack by this factor. */
export const RETALIATE_ADVANTAGE = 1.2;
/** Accept an alliance from players at least this many times stronger (troops) than us. */
export const ALLY_ACCEPT_STRENGTH_RATIO = 1.5;
/** Only ask neighbours with at least this many times our troops for an alliance. */
export const ALLY_REQUEST_MIN_STRENGTH_RATIO = 0.5;
/** Also ask distant nations with ports for alliances (friendly trade bonus, no boat raids). */
export const ALLY_TRADE_PARTNERS = true;
/**
 * Renew alliances in their last 30 s (the extension window) with every ally
 * except bordering ones weak enough to attack: a big neighbour whose
 * alliance runs out tends to attack at once. (Nations never ask to renew
 * themselves; they only answer.)
 */
export const RENEW_ALLIANCES = true;
/** Boat attacks send this fraction of available troops (boats are risky). */
export const BOAT_TROOP_FRACTION = 0.3;
/** Overseas players (nearest first) considered for a boat attack when nobody borders us. */
export const OVERSEAS_CANDIDATES = 3;
