/**
 * Plays an AI-only game with SmartNations and writes its replay record, so
 * you can watch it in the client's replay viewer (docs/Replays.md):
 *
 *   npx tsx scripts/replay/record-smart.mts [minutes] [smartNations] [gameID] [map] [difficulty]
 *   npm run dev:all
 *   open http://localhost:9000/#replay-viewer=<gameID>
 *
 * Defaults: 20 minutes, 1 SmartNation, a random game id (8-10 letters or
 * digits), World, Hard. The
 * names of the SmartNations are printed: on the map they look like any
 * other nation. The same gameID always plays the same game, so a game seen
 * in `npm run sim:smart -- --seed X` (run i is gameID `X-i`) can be
 * recorded and watched by passing that gameID here.
 */
import {
  Difficulty,
  GameMapType,
  GameType,
} from "@openfront/engine-api/game/GameTypes";
import { pickSmartNations } from "@openfront/engine/execution/smart/SmartNationSelection";
import { generateID } from "@openfront/shared/SharedUtil";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import {
  config,
  playAndArchive,
} from "../../tests/client/replay/util/ArchiveGame";

const [
  minutesArg = "20",
  smartArg = "1",
  gameIDArg,
  mapArg = "World",
  difficultyArg = "Hard",
] = process.argv.slice(2);
const minutes = Number(minutesArg);
const smartNations = Number(smartArg);
if (!(minutes > 0) || !Number.isInteger(smartNations) || smartNations < 1) {
  console.error(
    "usage: record-smart.mts [minutes] [smartNations] [gameID] [map] [difficulty]",
  );
  process.exit(1);
}
const gameMap = Object.values(GameMapType).find(
  (m) => m.toLowerCase() === mapArg.toLowerCase(),
);
const difficulty = Object.values(Difficulty).find(
  (d) => d.toLowerCase() === difficultyArg.toLowerCase(),
);
if (gameMap === undefined || difficulty === undefined) {
  console.error(`unknown map "${mapArg}" or difficulty "${difficultyArg}"`);
  process.exit(1);
}

const gameID = gameIDArg ?? generateID();
if (!/^[A-Za-z0-9]{8,10}$/.test(gameID)) {
  console.error(`gameID must be 8-10 letters/digits, got "${gameID}"`);
  process.exit(1);
}
const gameConfig = config({
  gameMap,
  difficulty,
  // Private: SmartNation never plays in public games.
  gameType: GameType.Private,
  bots: 400,
  smartNations,
});
// Spawn phase (private games: 200 turns) plus the requested minutes.
const ticks = 200 + minutes * 600;

// The engine logs routine chatter through console.log; keep stdout clean.
const log = console.error;
console.log = () => {};
console.debug = () => {};
console.info = () => {};
console.warn = () => {};

log(`playing ${minutes} min of ${gameMap} (${difficulty}), game ${gameID}…`);
let smartNames: string[] = [];
const outcome: string[] = [];
const { record } = await playAndArchive({
  gameID,
  config: gameConfig,
  players: [],
  ticks,
  intents: (game, t) => {
    if (t === 1) {
      const ids = pickSmartNations(gameConfig, game.nations(), gameID);
      smartNames = game
        .nations()
        .filter((n) => ids.has(n.playerInfo.id))
        .map((n) => n.playerInfo.name);
    }
    if (t === ticks - 1) {
      // Final standings, to know what the replay ends with.
      const land = game.numLandTiles();
      const ranked = game
        .players()
        .sort((a, b) => b.numTilesOwned() - a.numTilesOwned());
      for (const name of smartNames) {
        const p = ranked.find((r) => r.name() === name);
        if (p === undefined) continue;
        outcome.push(
          `${name}: ${((p.numTilesOwned() / land) * 100).toFixed(1)}% of the land, ` +
            `rank ${ranked.indexOf(p) + 1}, ${p.isAlive() ? "alive" : "eliminated"}`,
        );
      }
      const top = ranked[0];
      outcome.push(
        `leader: ${top.name()} ${((top.numTilesOwned() / land) * 100).toFixed(1)}%`,
      );
    }
    return [];
  },
});
record.gitCommit =
  process.env.GIT_COMMIT ??
  execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();

const out = path.join("records", `${gameID}.json`);
fs.mkdirSync("records", { recursive: true });
fs.writeFileSync(
  out,
  JSON.stringify(record, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
);
log(`wrote ${out} (${record.turns.length} turns)`);
log(`SmartNation(s): ${smartNames.join(", ")}`);
for (const line of outcome) log(`  at the end: ${line}`);
log(
  `watch: npm run dev:all, then http://localhost:9000/#replay-viewer=${gameID}`,
);
