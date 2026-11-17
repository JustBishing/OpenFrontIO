import { TileRef } from "@openfront/engine-api/game/GameMap";
import { SpawnArea, TerrainType } from "@openfront/engine-api/game/GameTypes";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { Game, Player } from "../../game/Game";
import {
  SPAWN_CANDIDATES,
  SPAWN_EDGE_RANGE,
  SPAWN_MIN_LAND_FRACTION,
  SPAWN_NATURAL_BORDER_RANGE,
  SPAWN_SCAN_RADIUS,
  SPAWN_SCAN_STEP,
  SPAWN_SEPARATION_TARGET,
  SPAWN_W_EDGE,
  SPAWN_W_NATURAL_BORDER,
  SPAWN_W_PLAINS,
  SPAWN_W_SEPARATION,
} from "./SmartNationConfig";

/**
 * SmartNation's spawn choice: sample random free land tiles and keep the one
 * with the best weighted score of
 *   - plains:     share of plains (highland counts half) around the tile
 *   - separation: distance to the nearest other player, against a fair share
 *   - edge:       closeness to the map edges (corners score highest)
 *   - natural:    share of directions that run into coast, mountains or the
 *                 map edge, i.e. borders nobody attacks across easily.
 * All pure functions of the game state plus the seeded PRNG (deterministic).
 */

/** The 16 directions natural-border rays are cast in (no trig in the engine). */
const RAY_DIRECTIONS: readonly [number, number][] = [
  [1, 0],
  [2, 1],
  [1, 1],
  [1, 2],
  [0, 1],
  [-1, 2],
  [-1, 1],
  [-2, 1],
  [-1, 0],
  [-2, -1],
  [-1, -1],
  [-1, -2],
  [0, -1],
  [1, -2],
  [1, -1],
  [2, -1],
].map(([x, y]) => {
  const len = Math.sqrt(x * x + y * y);
  return [x / len, y / len] as [number, number];
});

export interface SpawnScore {
  total: number;
  plains: number;
  separation: number;
  edge: number;
  natural: number;
}

/** Where everyone else is (or will be): spawned players and unspawned nations' map spots. */
export function otherPlayerSpots(game: Game, self: Player): TileRef[] {
  const spots: TileRef[] = [];
  const placed = new Set<string>();
  for (const p of game.players()) {
    if (p === self || !p.hasSpawned()) continue;
    const tile = p.spawnTile();
    if (tile === undefined) continue;
    spots.push(tile);
    placed.add(p.id());
  }
  for (const n of game.nations()) {
    if (n.playerInfo.id === self.id() || placed.has(n.playerInfo.id)) continue;
    if (n.spawnCell === undefined) continue;
    if (!game.isValidCoord(n.spawnCell.x, n.spawnCell.y)) continue;
    spots.push(game.ref(n.spawnCell.x, n.spawnCell.y));
  }
  return spots;
}

/** Can a player spawn on this tile right now? */
export function isSpawnable(game: Game, tile: TileRef): boolean {
  return game.isLand(tile) && !game.isImpassable(tile) && !game.hasOwner(tile);
}

/** Plains share (highland = half) and land share of the area around the tile. */
export function terrainAround(
  game: Game,
  tile: TileRef,
): { plains: number; land: number } {
  const cx = game.x(tile);
  const cy = game.y(tile);
  const r = SPAWN_SCAN_RADIUS;
  let samples = 0;
  let land = 0;
  let plains = 0;
  for (let dy = -r; dy <= r; dy += SPAWN_SCAN_STEP) {
    for (let dx = -r; dx <= r; dx += SPAWN_SCAN_STEP) {
      if (dx * dx + dy * dy > r * r) continue;
      samples++;
      const x = cx + dx;
      const y = cy + dy;
      if (!game.isValidCoord(x, y)) continue;
      const t = game.ref(x, y);
      if (!game.isLand(t) || game.isImpassable(t)) continue;
      land++;
      const terrain = game.terrainType(t);
      if (terrain === TerrainType.Plains) plains += 1;
      else if (terrain === TerrainType.Highland) plains += 0.5;
    }
  }
  return {
    plains: land === 0 ? 0 : plains / land,
    land: samples === 0 ? 0 : land / samples,
  };
}

/** 1 next to two edges (a corner), 0.5 next to one edge, 0 away from all of them. */
export function edgeScore(game: Game, tile: TileRef): number {
  const w = game.width();
  const h = game.height();
  const range = Math.max(1, Math.min(w, h) * SPAWN_EDGE_RANGE);
  const x = game.x(tile);
  const y = game.y(tile);
  const ex = 1 - Math.min(Math.min(x, w - 1 - x), range) / range;
  const ey = 1 - Math.min(Math.min(y, h - 1 - y), range) / range;
  return (ex + ey) / 2;
}

/** Share of directions that hit water, mountains or the map edge within range. */
export function naturalBorderScore(game: Game, tile: TileRef): number {
  const cx = game.x(tile);
  const cy = game.y(tile);
  let blocked = 0;
  for (const [dx, dy] of RAY_DIRECTIONS) {
    for (let d = 4; d <= SPAWN_NATURAL_BORDER_RANGE; d += 2) {
      const x = Math.round(cx + dx * d);
      const y = Math.round(cy + dy * d);
      if (!game.isValidCoord(x, y)) {
        blocked++;
        break;
      }
      const t = game.ref(x, y);
      if (
        !game.isLand(t) ||
        game.isImpassable(t) ||
        game.terrainType(t) === TerrainType.Mountain
      ) {
        blocked++;
        break;
      }
    }
  }
  return blocked / RAY_DIRECTIONS.length;
}

/** 0 on top of someone, 1 at (or beyond) a fair-share distance from everyone. */
export function separationScore(
  game: Game,
  tile: TileRef,
  others: readonly TileRef[],
): number {
  if (others.length === 0) return 1;
  let minD2 = Infinity;
  for (const o of others) {
    const d2 = game.euclideanDistSquared(tile, o);
    if (d2 < minD2) minD2 = d2;
  }
  const fairRadius = Math.sqrt(game.numLandTiles() / (others.length + 1));
  const target = Math.max(1, fairRadius * SPAWN_SEPARATION_TARGET);
  return Math.min(1, Math.sqrt(minD2) / target);
}

/** The weighted spawn score of one tile, or null if it is unusable. */
export function scoreSpawnTile(
  game: Game,
  tile: TileRef,
  others: readonly TileRef[],
): SpawnScore | null {
  const { plains, land } = terrainAround(game, tile);
  if (land < SPAWN_MIN_LAND_FRACTION) return null;
  const separation = separationScore(game, tile, others);
  const edge = edgeScore(game, tile);
  const natural = naturalBorderScore(game, tile);
  const total =
    SPAWN_W_PLAINS * plains +
    SPAWN_W_SEPARATION * separation +
    SPAWN_W_EDGE * edge +
    SPAWN_W_NATURAL_BORDER * natural;
  return { total, plains, separation, edge, natural };
}

/** A random tile inside the area (the whole map when undefined). */
function randomTile(
  game: Game,
  random: PseudoRandom,
  area: SpawnArea | undefined,
): TileRef | null {
  const x0 = area?.x ?? 0;
  const y0 = area?.y ?? 0;
  const x1 = area !== undefined ? area.x + area.width : game.width();
  const y1 = area !== undefined ? area.y + area.height : game.height();
  const x = random.nextInt(x0, x1);
  const y = random.nextInt(y0, y1);
  return game.isValidCoord(x, y) ? game.ref(x, y) : null;
}

/**
 * The best of SPAWN_CANDIDATES random spawnable tiles, or null if none
 * scored (e.g. the map is full). `area` restricts the search (team games).
 */
export function pickSpawnTile(
  game: Game,
  random: PseudoRandom,
  self: Player,
  area?: SpawnArea,
): { tile: TileRef; score: SpawnScore } | null {
  const others = otherPlayerSpots(game, self);
  let best: { tile: TileRef; score: SpawnScore } | null = null;
  // Water tiles are rejected, so allow a few draws per candidate.
  for (let draws = 0, kept = 0; kept < SPAWN_CANDIDATES; draws++) {
    if (draws >= SPAWN_CANDIDATES * 4) break;
    const tile = randomTile(game, random, area);
    if (tile === null || !isSpawnable(game, tile)) continue;
    kept++;
    const score = scoreSpawnTile(game, tile, others);
    if (score === null) continue;
    if (best === null || score.total > best.score.total) {
      best = { tile, score };
    }
  }
  return best;
}
