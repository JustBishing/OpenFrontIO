import { GameType, Nation } from "@openfront/engine-api/game/GameTypes";
import { GameConfig } from "@openfront/engine-api/Schemas";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { simpleHash } from "@openfront/engine-lib/Util";

/**
 * How many nations SmartNation plays. Never in public games: SmartNation is
 * an opponent for singleplayer and private lobbies only.
 */
export function smartNationCount(config: GameConfig, nations: number): number {
  if (config.gameType === GameType.Public) return 0;
  return Math.max(0, Math.min(config.smartNations ?? 0, nations));
}

/**
 * The ids of the nations SmartNation plays: a seeded, deterministic pick of
 * smartNationCount of them, so every client agrees.
 */
export function pickSmartNations(
  config: GameConfig,
  nations: readonly Nation[],
  gameID: string,
): Set<string> {
  const count = smartNationCount(config, nations.length);
  if (count === 0) return new Set();
  const random = new PseudoRandom(simpleHash(gameID) + simpleHash("smart"));
  const ids = random.shuffleArray(nations.map((n) => n.playerInfo.id));
  return new Set(ids.slice(0, count));
}
