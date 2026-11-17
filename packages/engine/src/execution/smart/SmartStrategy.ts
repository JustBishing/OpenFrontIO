import { TileRef } from "@openfront/engine-api/game/GameMap";
import { PlayerType, UnitType } from "@openfront/engine-api/game/GameTypes";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { Game, Player } from "../../game/Game";
import {
  ALLY_ACCEPT_STRENGTH_RATIO,
  ALLY_REQUEST_MIN_STRENGTH_RATIO,
  BUILD_SAMS,
  ATTACK_MAX_RELATIVE_STRENGTH,
  ATTACK_TRIGGER_RATIO,
  ATTACK_TROOP_FRACTION,
  BASE_RESERVE_RATIO,
  CITIES_PER_FACTORY,
  CITIES_PER_SAM,
  CITIES_PER_SILO,
  CITIES_PER_PORT,
  DEFENSE_POST_DEPTH,
  DEFENSE_MIN_CITIES,
  DEFENSE_THREAT_RATIO,
  EARLY_MAX_TERRITORY_SHARE,
  EXPAND_KEEP_RATIO,
  EXPAND_TRIGGER_RATIO,
  FACTORY_GOLD_BUFFER,
  MAX_DEFENSE_POSTS_PER_FRONT,
  MAX_RESERVE_RATIO,
  MIN_CITIES,
  MIN_CITIES_BEFORE_FACTORY,
  MIN_CITIES_BEFORE_SILO,
  OVERSEAS_CANDIDATES,
  RETALIATE_ADVANTAGE,
  THREAT_RESERVE_FACTOR,
  TILES_PER_CITY,
  TRIBE_ATTACK_ADVANTAGE,
  USE_NUKES,
} from "./SmartNationConfig";

/**
 * SmartNation's rules, one small function per decision. They only read the
 * game; SmartNationExecution acts on what they return. Tune the numbers in
 * SmartNationConfig.ts, or swap a function out to change one behaviour.
 */

export type SmartPhase = "early" | "midlate";

// ── Reading the situation ───────────────────────────────────────────────────

/** Share of the map's land we own. */
export function territoryShare(game: Game, player: Player): number {
  return player.numTilesOwned() / Math.max(1, game.numLandTiles());
}

/** Do we border unowned, passable, un-nuked land directly? */
export function bordersFreeLand(game: Game, player: Player): boolean {
  for (const border of player.borderTiles()) {
    for (const n of game.neighbors(border)) {
      if (
        game.isLand(n) &&
        !game.isImpassable(n) &&
        !game.hasOwner(n) &&
        !game.hasFallout(n)
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Is there free land anywhere next to us (directly or across a river)? */
export function hasFreeLandNearby(player: Player): boolean {
  return player.nearby().some((n) => !n.isPlayer());
}

/** Early game while there's free land to grab and we're still small. */
export function choosePhase(game: Game, player: Player): SmartPhase {
  if (
    hasFreeLandNearby(player) &&
    territoryShare(game, player) < EARLY_MAX_TERRITORY_SHARE
  ) {
    return "early";
  }
  return "midlate";
}

/** Players owning land that touches our border, in border order. */
export function landNeighbors(game: Game, player: Player): Player[] {
  const found = new Set<Player>();
  const self = player.smallID();
  player.borderTiles().forEach((t) => {
    game.forEachNeighbor(t, (n) => {
      if (!game.isLand(n) || game.ownerID(n) === self) return;
      const owner = game.owner(n);
      if (owner.isPlayer()) found.add(owner);
    });
  });
  return [...found];
}

/** Neighbours we're not allied / teamed with. */
export function hostileNeighbors(
  player: Player,
  neighbors: Player[],
): Player[] {
  return neighbors.filter((n) => !player.isFriendly(n));
}

/** The hostile non-tribe neighbour with the most troops (tribes never threaten). */
export function strongestHostileNeighbor(hostile: Player[]): Player | null {
  let best: Player | null = null;
  for (const n of hostile) {
    if (n.type() === PlayerType.Bot) continue;
    if (best === null || n.troops() > best.troops()) best = n;
  }
  return best;
}

/** Players we're at war with right now: attacking us or being attacked by us. */
export function currentWars(player: Player): Player[] {
  const wars = new Set<Player>();
  for (const a of player.outgoingAttacks()) {
    const t = a.target();
    if (t.isPlayer() && t.type() !== PlayerType.Bot) wars.add(t);
  }
  for (const a of player.incomingAttacks()) {
    const attacker = a.attacker();
    if (!player.isFriendly(attacker) && attacker.type() !== PlayerType.Bot) {
      wars.add(attacker);
    }
  }
  return [...wars];
}

// ── Troops ──────────────────────────────────────────────────────────────────

/** Troops to keep home: a base share plus a slice of the biggest threat, capped. */
export function troopReserve(
  game: Game,
  player: Player,
  strongest: Player | null,
): number {
  const max = game.config().maxTroops(player);
  const threat = strongest === null ? 0 : strongest.troops();
  return Math.min(
    max * MAX_RESERVE_RATIO,
    max * BASE_RESERVE_RATIO + threat * THREAT_RESERVE_FACTOR,
  );
}

/** Expansion size: everything above the keep level, once troops reach the trigger. */
export function expansionTroops(
  game: Game,
  player: Player,
  available: number,
): number {
  const max = game.config().maxTroops(player);
  if (available < max * EXPAND_TRIGGER_RATIO) return 0;
  return Math.floor(available - max * EXPAND_KEEP_RATIO);
}

/** Mid/late attack size: most of what's above the reserve, once we're near full. */
export function warTroops(
  game: Game,
  player: Player,
  available: number,
  reserve: number,
): number {
  const max = game.config().maxTroops(player);
  if (available < max * ATTACK_TRIGGER_RATIO) return 0;
  return Math.max(0, Math.floor((available - reserve) * ATTACK_TROOP_FRACTION));
}

// ── Targets ─────────────────────────────────────────────────────────────────

/** The weakest neighbouring tribe we'd beat clearly with `troops`. */
export function weakTribeTarget(
  hostile: Player[],
  troops: number,
): Player | null {
  let best: Player | null = null;
  for (const n of hostile) {
    if (n.type() !== PlayerType.Bot) continue;
    if (troops < n.troops() * TRIBE_ATTACK_ADVANTAGE) continue;
    if (best === null || n.troops() < best.troops()) best = n;
  }
  return best;
}

/**
 * The incoming attacker worth hitting back: the biggest attack we can answer
 * with RETALIATE_ADVANTAGE more troops than it carries.
 */
export function retaliationTarget(
  player: Player,
  available: number,
): Player | null {
  let best: Player | null = null;
  let bestTroops = 0;
  for (const a of player.incomingAttacks()) {
    const attacker = a.attacker();
    if (player.isFriendly(attacker)) continue;
    if (a.troops() <= bestTroops) continue;
    if (available < a.troops() * RETALIATE_ADVANTAGE) continue;
    best = attacker;
    bestTroops = a.troops();
  }
  return best;
}

/**
 * The weakest hostile neighbour relative to us. One front at a time: while
 * at war, only the current enemies are candidates.
 */
export function chooseWarTarget(
  player: Player,
  hostile: Player[],
  wars: Player[],
): Player | null {
  // An enemy we can't reach by land (a boat raid) doesn't block other targets.
  const atWar = hostile.filter((h) => wars.includes(h));
  const candidates = atWar.length > 0 ? atWar : hostile;
  const ours = Math.max(1, player.troops());
  let best: Player | null = null;
  let bestRatio = Infinity;
  for (const c of candidates) {
    const ratio = c.troops() / ours;
    if (ratio < bestRatio) {
      best = c;
      bestRatio = ratio;
    }
  }
  return bestRatio <= ATTACK_MAX_RELATIVE_STRENGTH ? best : null;
}

/**
 * When nobody borders us by land: the weakest of the OVERSEAS_CANDIDATES
 * nearest hostile players (by spawn spot) we clearly outnumber, for a boat.
 */
export function overseasTarget(
  game: Game,
  player: Player,
  landHostile: Player[],
): Player | null {
  const home = player.spawnTile();
  if (home === undefined) return null;
  const ours = Math.max(1, player.troops());
  const candidates = game
    .players()
    .filter(
      (p) =>
        p !== player &&
        p.isAlive() &&
        !player.isFriendly(p) &&
        !landHostile.includes(p) &&
        p.spawnTile() !== undefined,
    )
    .map((p) => ({ p, d2: game.euclideanDistSquared(home, p.spawnTile()!) }))
    .sort((a, b) => a.d2 - b.d2)
    .slice(0, OVERSEAS_CANDIDATES);
  let best: Player | null = null;
  for (const { p } of candidates) {
    if (p.troops() / ours > ATTACK_MAX_RELATIVE_STRENGTH) continue;
    if (best === null || p.troops() < best.troops()) best = p;
  }
  return best;
}

// ── Diplomacy ───────────────────────────────────────────────────────────────

/**
 * Who to ask for an alliance: the strongest hostile nation/human bordering
 * us that we're not fighting, so our one war stays our only front.
 */
export function allianceRequestTarget(
  player: Player,
  hostile: Player[],
  wars: Player[],
): Player | null {
  let best: Player | null = null;
  for (const h of hostile) {
    if (h.type() === PlayerType.Bot || wars.includes(h)) continue;
    // Weaker neighbours are future conquests, not allies.
    if (h.troops() < player.troops() * ALLY_REQUEST_MIN_STRENGTH_RATIO)
      continue;
    if (!player.canSendAllianceRequest(h)) continue;
    if (best === null || h.troops() > best.troops()) best = h;
  }
  return best;
}

/** Accept alliances only from players much stronger than us. */
export function shouldAcceptAlliance(
  player: Player,
  requestor: Player,
): boolean {
  return requestor.troops() >= player.troops() * ALLY_ACCEPT_STRENGTH_RATIO;
}

// ── Economy ─────────────────────────────────────────────────────────────────

/** Can anyone fire a nuke in this game? */
export function nukesEnabled(game: Game): boolean {
  const config = game.config();
  return (
    !config.isUnitDisabled(UnitType.AtomBomb) ||
    !config.isUnitDisabled(UnitType.HydrogenBomb) ||
    !config.isUnitDisabled(UnitType.MIRV)
  );
}

function cost(game: Game, player: Player, type: UnitType): bigint {
  return game.unitInfo(type).cost(game, player);
}

/**
 * What to build next: cities first (population cap), then ports when
 * coastal, then factories once gold allows, then more cities as we grow.
 * Returns the wanted type even if we can't afford it yet — we save up.
 */
export function nextEconomyBuild(
  game: Game,
  player: Player,
  coastal: boolean,
): UnitType | null {
  const config = game.config();
  const allowed = (t: UnitType) => !config.isUnitDisabled(t);
  const cities = player.unitCount(UnitType.City);
  const ports = player.unitCount(UnitType.Port);
  const factories = player.unitCount(UnitType.Factory);

  if (allowed(UnitType.City) && cities < MIN_CITIES) return UnitType.City;

  const portTarget = Math.max(1, Math.floor(cities / CITIES_PER_PORT));
  const needsPort = coastal && allowed(UnitType.Port) && ports < portTarget;
  if (needsPort) return UnitType.Port;

  if (
    allowed(UnitType.Factory) &&
    cities >= MIN_CITIES_BEFORE_FACTORY &&
    factories < Math.floor(cities / CITIES_PER_FACTORY)
  ) {
    const factoryCost = cost(game, player, UnitType.Factory);
    const buffer = BigInt(Math.round(FACTORY_GOLD_BUFFER * 100));
    if (player.gold() * 100n >= factoryCost * buffer) return UnitType.Factory;
  }

  // Nukes: SAMs to stop them, silos to fire them (both scale with cities).
  if (nukesEnabled(game)) {
    const sams = player.unitCount(UnitType.SAMLauncher);
    if (
      BUILD_SAMS &&
      allowed(UnitType.SAMLauncher) &&
      allowed(UnitType.MissileSilo) &&
      sams < Math.floor(cities / CITIES_PER_SAM)
    ) {
      return UnitType.SAMLauncher;
    }
    const silos = player.unitCount(UnitType.MissileSilo);
    if (
      USE_NUKES &&
      allowed(UnitType.MissileSilo) &&
      cities >= MIN_CITIES_BEFORE_SILO &&
      silos < Math.floor(cities / CITIES_PER_SILO)
    ) {
      return UnitType.MissileSilo;
    }
  }

  const cityTarget =
    MIN_CITIES + Math.floor(player.numTilesOwned() / TILES_PER_CITY);
  if (allowed(UnitType.City) && cities < cityTarget) return UnitType.City;
  return null;
}

/** Can we pay for one of these now? */
export function canAfford(game: Game, player: Player, type: UnitType): boolean {
  return player.gold() >= cost(game, player, type);
}

// ── Defense ─────────────────────────────────────────────────────────────────

/** Is this neighbour strong enough relative to us to fortify against (once the economy started)? */
export function isThreat(player: Player, enemy: Player): boolean {
  if (player.unitCount(UnitType.City) < DEFENSE_MIN_CITIES) return false;
  return enemy.troops() >= player.troops() * DEFENSE_THREAT_RATIO;
}

/** Our border tiles that touch `enemy`'s land. */
export function frontTiles(
  game: Game,
  player: Player,
  enemy: Player,
): TileRef[] {
  const out: TileRef[] = [];
  const enemyID = enemy.smallID();
  player.borderTiles().forEach((t) => {
    for (const n of game.neighbors(t)) {
      if (game.ownerID(n) === enemyID) {
        out.push(t);
        return;
      }
    }
  });
  return out;
}

/** Our defense posts within reach of this front. */
export function defensePostsNear(
  game: Game,
  player: Player,
  front: TileRef[],
): number {
  const reach2 = (DEFENSE_POST_DEPTH * 3) ** 2;
  let count = 0;
  for (const post of player.units(UnitType.DefensePost)) {
    // Every 4th front tile is plenty to tell which front a post covers.
    for (let i = 0; i < front.length; i += 4) {
      if (game.euclideanDistSquared(post.tile(), front[i]) <= reach2) {
        count++;
        break;
      }
    }
  }
  return count;
}

/** Room for another defense post on this front? */
export function wantsDefensePost(
  game: Game,
  player: Player,
  front: TileRef[],
): boolean {
  if (front.length === 0) return false;
  if (game.config().isUnitDisabled(UnitType.DefensePost)) return false;
  return defensePostsNear(game, player, front) < MAX_DEFENSE_POSTS_PER_FRONT;
}

/**
 * A buildable tile DEFENSE_POST_DEPTH behind a random spot on the front:
 * of our tiles around it, the one farthest away within that depth.
 */
export function defensePostTile(
  game: Game,
  random: PseudoRandom,
  player: Player,
  front: TileRef[],
): TileRef | null {
  if (front.length === 0) return null;
  const self = player.smallID();
  for (let attempt = 0; attempt < 3; attempt++) {
    const anchor = front[random.nextInt(0, front.length)];
    let best: TileRef | null = null;
    let bestD2 = -1;
    for (const t of game.circleSearch(anchor, DEFENSE_POST_DEPTH)) {
      if (game.ownerID(t) !== self) continue;
      const d2 = game.euclideanDistSquared(t, anchor);
      if (d2 <= bestD2) continue;
      if (player.canBuild(UnitType.DefensePost, t) === false) continue;
      best = t;
      bestD2 = d2;
    }
    if (best !== null) return best;
  }
  return null;
}
