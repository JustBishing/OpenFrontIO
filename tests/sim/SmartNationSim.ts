/**
 * Headless SmartNation vs nations simulation.
 *
 * Plays full games (no humans) on a real map with some nations played by
 * SmartNation and the rest by the regular nation AI, and prints territory
 * share over time, gold, structures and the winner (or leader at the end).
 *
 * Usage:
 *   npm run sim:smart -- [--map world] [--runs 3] [--minutes 30] [--smart 1]
 *                        [--bots 400] [--difficulty Hard] [--seed sim]
 *                        [--control] [--trace]
 *
 * --control plays the same games with the same nation slots driven by the
 * regular nation AI, as a baseline for SmartNation's numbers.
 *
 * Each run uses seed `<seed>-<i>`, so a run is reproducible on its own.
 */
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { GameConfig, GameStartInfo } from "@openfront/engine-api/Schemas";
import { loadTerrainMap } from "@openfront/engine-lib/game/TerrainMapLoader";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { simpleHash } from "@openfront/engine-lib/Util";
import { EngineConfig } from "@openfront/engine/configuration/EngineConfig";
import { Executor } from "@openfront/engine/execution/ExecutionManager";
import { SmartNationExecution } from "@openfront/engine/execution/smart/SmartNationExecution";
import { pickSmartNations } from "@openfront/engine/execution/smart/SmartNationSelection";
import {
  bordersFreeLand,
  landNeighbors,
} from "@openfront/engine/execution/smart/SmartStrategy";
import { Game, Player } from "@openfront/engine/game/Game";
import { createGame } from "@openfront/engine/game/GameImpl";
import { createNationsForGame } from "@openfront/engine/game/NationCreation";
import { GameRunner } from "@openfront/engine/GameRunner";
import { loadMapFiles } from "@openfront/shared/GameMapLoader";
import path from "path";
import { fileURLToPath } from "url";
import { NodeGameMapLoader } from "../perf/fullgame/NodeGameMapLoader";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const TICKS_PER_MINUTE = 600;

interface Options {
  map: GameMapType;
  runs: number;
  minutes: number;
  smart: number;
  bots: number;
  difficulty: Difficulty;
  seed: string;
  /** Control run: the same nation slots, played by the regular nation AI. */
  control: boolean;
  /** Print SmartNation's internals every minute. */
  trace: boolean;
}

function parseArgs(argv: string[]): Options {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const mapName = get("map") ?? "world";
  const mapKey = Object.keys(GameMapType).find(
    (k) => k.toLowerCase() === mapName.toLowerCase(),
  );
  if (mapKey === undefined) throw new Error(`unknown map ${mapName}`);
  const difficulty = (get("difficulty") ?? "Hard") as Difficulty;
  if (!Object.values(Difficulty).includes(difficulty)) {
    throw new Error(`unknown difficulty ${difficulty}`);
  }
  return {
    map: GameMapType[mapKey as keyof typeof GameMapType],
    runs: Number(get("runs") ?? 3),
    minutes: Number(get("minutes") ?? 30),
    smart: Number(get("smart") ?? 1),
    bots: Number(get("bots") ?? 400),
    difficulty,
    seed: get("seed") ?? "sim",
    control: argv.includes("--control"),
    trace: argv.includes("--trace"),
  };
}

interface RunResult {
  seed: string;
  /** Per sampled minute: territory % of the smart nations (summed) and of the best other nation. */
  timeline: {
    minute: number;
    smart: number;
    bestOther: number;
    rank: number;
  }[];
  winner: string | null;
  leader: string;
  smartAlive: boolean;
  smartGold: bigint;
  /** Where SmartNation's gold came from over the game. */
  smartIncome: string;
  avgNationGold: bigint;
  smartStructures: string;
  minutesPlayed: number;
}

// The engine logs through console.log ("Failed to spawn warship..."); the
// report uses stdout directly so that chatter can be muted.
const out = (line: string) => process.stdout.write(`${line}\n`);

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

function share(game: Game, p: Player): number {
  return p.numTilesOwned() / game.numLandTiles();
}

function structures(p: Player): string {
  const c = (t: UnitType) => p.unitCount(t);
  return (
    `city ${c(UnitType.City)}, port ${c(UnitType.Port)}, ` +
    `factory ${c(UnitType.Factory)}, defense ${c(UnitType.DefensePost)}, ` +
    `sam ${c(UnitType.SAMLauncher)}, silo ${c(UnitType.MissileSilo)}, ` +
    `warship ${c(UnitType.Warship)}`
  );
}

async function playOne(opts: Options, seed: string): Promise<RunResult> {
  const gameConfig: GameConfig = {
    gameMap: opts.map,
    gameMapSize: GameMapSize.Normal,
    gameMode: GameMode.FFA,
    // Private: SmartNation never plays in public games.
    gameType: GameType.Private,
    difficulty: opts.difficulty,
    nations: "default",
    smartNations: opts.control ? 0 : opts.smart,
    donateGold: false,
    donateTroops: false,
    bots: opts.bots,
    infiniteGold: false,
    infiniteTroops: false,
    instantBuild: false,
    randomSpawn: false,
  };
  const gameStart: GameStartInfo = {
    gameID: seed,
    lobbyCreatedAt: 0,
    config: gameConfig,
    players: [],
  };
  // Same assembly as tests/perf/fullgame/FullGamePerf.ts.
  const terrain = await loadTerrainMap(
    await loadMapFiles(
      new NodeGameMapLoader(path.join(PROJECT_ROOT, "resources/maps")),
      gameConfig.gameMap,
      gameConfig.gameMapSize,
    ),
  );
  const nations = createNationsForGame(
    gameStart,
    terrain.nations,
    terrain.additionalNations,
    0,
    new PseudoRandom(simpleHash(seed)),
  );
  const game = createGame(
    [],
    nations,
    terrain.gameMap,
    terrain.miniGameMap,
    new EngineConfig(gameConfig, false),
    terrain.teamGameSpawnAreas,
  );
  let fatal: string | undefined;
  const runner = new GameRunner(
    game,
    new Executor(game, seed, undefined),
    (gu) => {
      if ("errMsg" in gu) fatal = `${gu.errMsg}\n${gu.stack ?? ""}`;
    },
  );
  runner.init();

  // In a control run, track the nations SmartNation would have played.
  const smartIds = opts.control
    ? pickSmartNations(
        { ...gameConfig, smartNations: opts.smart },
        game.nations(),
        seed,
      )
    : new Set(
        (game as unknown as { executions(): object[] })
          .executions()
          .filter(
            (e): e is SmartNationExecution => e instanceof SmartNationExecution,
          )
          .map((e) => e.playerID()),
      );
  const isSmart = (p: Player) => smartIds.has(p.id());
  const nationPlayers = () =>
    game.players().filter((p) => p.type() === PlayerType.Nation);

  const timeline: RunResult["timeline"] = [];
  const maxTicks =
    game.config().numSpawnPhaseTurns() + opts.minutes * TICKS_PER_MINUTE;
  let turn = 0;
  while (game.ticks() < maxTicks && game.getWinner() === null) {
    runner.addTurn({ turnNumber: turn++, intents: [] });
    runner.executeNextTick();
    if (fatal !== undefined) throw new Error(fatal);
    const played = game.ticks() - game.config().numSpawnPhaseTurns();
    if (played > 0 && played % TICKS_PER_MINUTE === 0) {
      const ranked = nationPlayers().sort(
        (a, b) => b.numTilesOwned() - a.numTilesOwned(),
      );
      const smartShare = ranked
        .filter(isSmart)
        .reduce((s, p) => s + share(game, p), 0);
      const bestOther = ranked.find((p) => !isSmart(p));
      timeline.push({
        minute: played / TICKS_PER_MINUTE,
        smart: smartShare,
        bestOther: bestOther ? share(game, bestOther) : 0,
        rank: ranked.findIndex(isSmart) + 1,
      });
      if (opts.trace) {
        for (const p of game.players().filter(isSmart)) traceLine(game, p);
      }
    }
  }

  const smart = game.players().filter(isSmart);
  const others = nationPlayers().filter((p) => !isSmart(p) && p.isAlive());
  const avgGold =
    others.length === 0
      ? 0n
      : others.reduce((s, p) => s + p.gold(), 0n) / BigInt(others.length);
  const leader = [...game.players()].sort(
    (a, b) => b.numTilesOwned() - a.numTilesOwned(),
  )[0];
  const winner = game.getWinner();
  return {
    seed,
    timeline,
    winner:
      winner === null
        ? null
        : typeof winner === "string"
          ? winner
          : `${winner.name()}${isSmart(winner) ? " (SmartNation)" : ""}`,
    leader: `${leader.name()}${isSmart(leader) ? " (SmartNation)" : ""} ${pct(share(game, leader))}`,
    smartAlive: smart.some((p) => p.isAlive()),
    smartGold: smart.reduce((s, p) => s + p.gold(), 0n),
    smartIncome: smart.map(income).join("; "),
    avgNationGold: avgGold,
    smartStructures: smart.map(structures).join(" | "),
    minutesPlayed:
      (game.ticks() - game.config().numSpawnPhaseTurns()) / TICKS_PER_MINUTE,
  };
}

/** Lifetime gold by source, in thousands. */
function income(p: Player): string {
  const k = (g: bigint) => `${(g / 1000n).toLocaleString()}k`;
  return (
    `total ${k(p.goldEarned())} trade ${k(p.tradeGold())} ` +
    `train ${k(p.trainGold())} piracy ${k(p.piracyGold())}`
  );
}

/** Where the player spawned, as x,y. */
function spawnAt(game: Game, p: Player): string {
  const t = p.spawnTile();
  return t === undefined ? "-" : `${game.x(t)},${game.y(t)}`;
}

/** Land neighbours as name:troops/share, `*` marking allies, plus free-land contact. */
function neighborSummary(game: Game, p: Player): string {
  const list = landNeighbors(game, p)
    .map(
      (n) =>
        `${p.isFriendly(n) ? "*" : ""}${n.type() === PlayerType.Bot ? "tribe" : n.name()}:` +
        `${Math.round(n.troops() / 1000)}k/${pct(share(game, n))}`,
    )
    .join(",");
  return `free=${bordersFreeLand(game, p) ? "y" : "n"} nb=[${list}]`;
}

function traceLine(game: Game, p: Player): void {
  const max = game.config().maxTroops(p);
  const attackers = p
    .incomingAttacks()
    .map((a) => `${a.attacker().name()}:${Math.round(a.troops())}`)
    .join(",");
  const targets = p
    .outgoingAttacks()
    .map((a) => {
      const t = a.target();
      return t.isPlayer() ? t.name() : "free";
    })
    .join(",");
  out(
    `  [trace m${Math.round((game.ticks() - game.config().numSpawnPhaseTurns()) / TICKS_PER_MINUTE)}] ` +
      `${p.name()} alive=${p.isAlive()} tiles=${pct(share(game, p))} ` +
      `spawn=${spawnAt(game, p)} ` +
      `troops=${Math.round(p.troops())}/${Math.round(max)} gold=${p.gold()} ` +
      `${structures(p)} allies=${p.alliances().length} ` +
      `${neighborSummary(game, p)} ` +
      `in=[${attackers}] out=[${targets}]`,
  );
}

function printRun(r: RunResult): void {
  out(`\n=== ${r.seed} (${r.minutesPlayed.toFixed(1)} min) ===`);
  out("minute  smart   best-other-nation  smart-rank-among-nations");
  for (const t of r.timeline) {
    if (t.minute % 2 !== 0 && t.minute !== r.timeline.length) continue;
    out(
      `${String(t.minute).padStart(6)}  ${pct(t.smart).padStart(6)}  ` +
        `${pct(t.bestOther).padStart(17)}  ${String(t.rank).padStart(5)}`,
    );
  }
  out(`winner:  ${r.winner ?? "none yet"}`);
  out(`leader:  ${r.leader}`);
  out(`smart alive: ${r.smartAlive}`);
  out(
    `gold:    smart ${r.smartGold.toLocaleString()} vs avg nation ${r.avgNationGold.toLocaleString()}`,
  );
  out(`smart structures: ${r.smartStructures}`);
  out(`smart income: ${r.smartIncome}`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  console.debug = () => {};
  console.log = () => {};
  console.warn = () => {};
  out(
    `SmartNation sim: map=${opts.map} runs=${opts.runs} minutes=${opts.minutes} ` +
      `smart=${opts.smart} bots=${opts.bots} difficulty=${opts.difficulty}` +
      (opts.control ? " (CONTROL: same slots, regular nation AI)" : ""),
  );
  const results: RunResult[] = [];
  for (let i = 0; i < opts.runs; i++) {
    const started = performance.now();
    const r = await playOne(opts, `${opts.seed}-${i}`);
    results.push(r);
    printRun(r);
    out(`(simulated in ${((performance.now() - started) / 1000).toFixed(0)}s)`);
  }
  out("\n=== Summary ===");
  for (const r of results) {
    const last = r.timeline[r.timeline.length - 1];
    out(
      `${r.seed}: smart ${last ? pct(last.smart) : "-"} (rank ${last?.rank ?? "-"}), ` +
        `best other ${last ? pct(last.bestOther) : "-"}, alive ${r.smartAlive}, ` +
        `winner ${r.winner ?? "none"}`,
    );
  }
  printAggregate(results);
}

/**
 * One line to compare tuning changes by: averages over all runs of how long
 * SmartNation stayed alive, its peak share, and its share at minutes 10/20/30
 * (0 once dead).
 */
function printAggregate(results: RunResult[]): void {
  const mean = (xs: number[]) =>
    xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
  const at = (r: RunResult, m: number) =>
    r.timeline.find((t) => t.minute === m)?.smart ?? 0;
  const survived = results.map((r) => {
    const lastAlive = [...r.timeline].reverse().find((t) => t.smart > 0);
    return lastAlive?.minute ?? 0;
  });
  out(
    `AGGREGATE runs=${results.length} ` +
      `survival=${mean(survived).toFixed(1)}min ` +
      `alive@end=${results.filter((r) => r.smartAlive).length}/${results.length} ` +
      `peak=${pct(mean(results.map((r) => Math.max(0, ...r.timeline.map((t) => t.smart)))))} ` +
      `@10=${pct(mean(results.map((r) => at(r, 10))))} ` +
      `@20=${pct(mean(results.map((r) => at(r, 20))))} ` +
      `@30=${pct(mean(results.map((r) => at(r, 30))))}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
