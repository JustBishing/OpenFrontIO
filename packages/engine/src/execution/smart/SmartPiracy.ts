import { TileRef } from "@openfront/engine-api/game/GameMap";
import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { Game, Player, Unit } from "../../game/Game";
import { PIRACY_LANE_CANDIDATES, PIRACY_MIN_SHIPS } from "./SmartNationConfig";

/**
 * Where to pirate trade. A warship captures enemy trade ships near its
 * patrol tile and keeps their whole payout (TradeShipExecution); the two
 * traders get nothing. So the best patrol tile is the one with the most
 * capturable trade ships around it right now.
 */

/** Water bodies our finished ports touch: a warship only captures where it can bring the ship home. */
function portWaters(game: Game, player: Player): Set<number> {
  const waters = new Set<number>();
  for (const port of player.units(UnitType.Port)) {
    if (!port.isActive() || port.isUnderConstruction()) continue;
    for (const n of game.neighbors(port.tile())) {
      if (!game.isWater(n)) continue;
      const c = game.getWaterComponent(n);
      if (c !== null) waters.add(c);
    }
  }
  return waters;
}

/** Trade ships our warships may capture (the same rules WarshipExecution applies). */
export function capturableTradeShips(game: Game, player: Player): Unit[] {
  const waters = portWaters(game, player);
  if (waters.size === 0) return [];
  const out: Unit[] = [];
  for (const ship of game.units(UnitType.TradeShip)) {
    if (ship.owner() === player || ship.isSafeFromPirates()) continue;
    const dest = ship.targetUnit()?.owner();
    if (dest === player || dest?.isFriendly(player) === true) continue;
    const c = game.getWaterComponent(ship.tile());
    if (c === null || !waters.has(c)) continue;
    out.push(ship);
  }
  return out;
}

/** Ships within a warship's patrol range of `tile`. */
export function shipsNear(game: Game, ships: Unit[], tile: TileRef): number {
  const range2 = game.config().warshipPatrolRange() ** 2;
  let n = 0;
  for (const s of ships) {
    if (game.euclideanDistSquared(s.tile(), tile) <= range2) n++;
  }
  return n;
}

/**
 * The busiest lane: of up to PIRACY_LANE_CANDIDATES ship positions (evenly
 * spread over the list), the one with the most capturable ships in range.
 * Null if no spot has PIRACY_MIN_SHIPS.
 */
export function piracyLane(
  game: Game,
  ships: Unit[],
): { tile: TileRef; ships: number } | null {
  if (ships.length === 0) return null;
  const step = Math.max(1, Math.floor(ships.length / PIRACY_LANE_CANDIDATES));
  let best: { tile: TileRef; ships: number } | null = null;
  for (let i = 0; i < ships.length; i += step) {
    const tile = ships[i].tile();
    const count = shipsNear(game, ships, tile);
    if (best === null || count > best.ships) best = { tile, ships: count };
  }
  return best !== null && best.ships >= PIRACY_MIN_SHIPS ? best : null;
}
