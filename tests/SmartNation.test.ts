import {
  GameType,
  Nation,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { GameConfig } from "@openfront/engine-api/Schemas";
import { NationExecution } from "@openfront/engine/execution/NationExecution";
import { SmartNationExecution } from "@openfront/engine/execution/smart/SmartNationExecution";
import { pickSmartNations } from "@openfront/engine/execution/smart/SmartNationSelection";
import {
  piracyLane,
  shipsNear,
} from "@openfront/engine/execution/smart/SmartPiracy";
import {
  edgeScore,
  naturalBorderScore,
  otherPlayerSpots,
  separationScore,
} from "@openfront/engine/execution/smart/SmartSpawn";
import {
  allianceRequestTarget,
  chooseWarTarget,
  expansionTroops,
  isThreat,
  nextEconomyBuild,
  shouldAcceptAlliance,
  shouldRenewAlliance,
  troopReserve,
} from "@openfront/engine/execution/smart/SmartStrategy";
import { SpawnExecution } from "@openfront/engine/execution/SpawnExecution";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
import { GameImpl } from "@openfront/engine/game/GameImpl";
import { createGame, L, W } from "./core/pathfinding/_fixtures";

const SIZE = 100;

function landMap(config: Partial<GameConfig> = {}): Game {
  return createGame(
    { width: SIZE, height: SIZE, grid: Array(SIZE * SIZE).fill(L) },
    config,
  );
}

function nation(name: string): Nation {
  return new Nation(
    undefined,
    new PlayerInfo(name, PlayerType.Nation, null, name),
  );
}

function addPlayer(game: Game, name: string, type: PlayerType): Player {
  return (game as GameImpl).addPlayer(new PlayerInfo(name, type, null, name));
}

function tickUntil(game: Game, done: () => boolean, max: number): void {
  for (let i = 0; i < max && !done(); i++) game.executeNextTick();
}

describe("pickSmartNations", () => {
  const nations = ["a", "b", "c", "d"].map(nation);
  const base = { smartNations: 2 } as GameConfig;

  it("picks the requested number, deterministically per game", () => {
    const cfg = { ...base, gameType: GameType.Private };
    const first = pickSmartNations(cfg, nations, "game1");
    expect(first.size).toBe(2);
    expect(pickSmartNations(cfg, nations, "game1")).toEqual(first);
  });

  it("caps at the number of nations", () => {
    const cfg = {
      ...base,
      smartNations: 10,
      gameType: GameType.Singleplayer,
    };
    expect(pickSmartNations(cfg, nations, "g").size).toBe(4);
  });

  it("never plays in public games", () => {
    const cfg = { ...base, gameType: GameType.Public };
    expect(pickSmartNations(cfg, nations, "g").size).toBe(0);
  });
});

describe("SmartSpawn scoring", () => {
  it("scores corners above edges above the middle", () => {
    const game = landMap();
    const corner = edgeScore(game, game.ref(0, 0));
    const edge = edgeScore(game, game.ref(0, 50));
    const middle = edgeScore(game, game.ref(50, 50));
    expect(corner).toBe(1);
    expect(edge).toBeCloseTo(0.5);
    expect(middle).toBe(0);
  });

  it("scores separation from 0 (on top of someone) to 1 (no one around)", () => {
    const game = landMap();
    const t = game.ref(10, 10);
    expect(separationScore(game, t, [])).toBe(1);
    expect(separationScore(game, t, [t])).toBe(0);
  });

  it("sees coasts as natural borders", () => {
    // Land on the left half, water on the right half; big enough that the
    // inland tile's rays don't reach the map edge.
    const size = 240;
    const grid = Array.from({ length: size * size }, (_, i) =>
      i % size < 120 ? L : W,
    );
    const game = createGame({ width: size, height: size, grid });
    const coast = naturalBorderScore(game, game.ref(116, 120));
    const inland = naturalBorderScore(game, game.ref(60, 120));
    expect(inland).toBe(0);
    expect(coast).toBeGreaterThan(inland);
  });
});

describe("SmartStrategy", () => {
  it("only accepts alliances from much stronger players", () => {
    const game = landMap();
    const me = addPlayer(game, "me", PlayerType.Nation);
    const other = addPlayer(game, "other", PlayerType.Nation);
    me.setTroops(1000);
    other.setTroops(1200);
    expect(shouldAcceptAlliance(me, other)).toBe(false);
    other.setTroops(2000);
    expect(shouldAcceptAlliance(me, other)).toBe(true);
  });

  it("expands with everything above 15% of its max troops", () => {
    const game = landMap();
    const me = addPlayer(game, "me", PlayerType.Nation);
    const max = game.config().maxTroops(me);
    expect(expansionTroops(game, me, max * 0.1)).toBe(0);
    expect(expansionTroops(game, me, max * 0.6)).toBe(
      Math.floor(max * 0.6 - max * 0.15),
    );
  });

  it("asks the strongest neighbour it isn't fighting for an alliance", () => {
    const game = landMap();
    const me = addPlayer(game, "me", PlayerType.Nation);
    const big = addPlayer(game, "big", PlayerType.Nation);
    const small = addPlayer(game, "small", PlayerType.Nation);
    const tribe = addPlayer(game, "tribe", PlayerType.Bot);
    // Only living players (owning land) can ask or be asked.
    [me, big, small, tribe].forEach((p, i) => p.conquer(game.ref(i * 10, 0)));
    me.setTroops(1_500);
    big.setTroops(9_000);
    small.setTroops(1_000);
    tribe.setTroops(50_000);
    expect(allianceRequestTarget(me, [small, big, tribe], [])).toBe(big);
    // Never the enemy we're at war with.
    expect(allianceRequestTarget(me, [small, big, tribe], [big])).toBe(small);
    // Much weaker neighbours are future conquests, not allies.
    small.setTroops(500);
    expect(allianceRequestTarget(me, [small, big, tribe], [big])).toBeNull();
  });

  it("only fortifies once it has its first cities", () => {
    const game = landMap();
    const me = addPlayer(game, "me", PlayerType.Nation);
    const enemy = addPlayer(game, "enemy", PlayerType.Nation);
    me.setTroops(1_000);
    enemy.setTroops(10_000);
    expect(isThreat(me, enemy)).toBe(false);
  });

  it("adds a SAM launcher per four cities, but never a missile silo", () => {
    const game = landMap();
    const me = addPlayer(game, "me", PlayerType.Nation);
    // Inland (no port wanted), no factory gold: only cities and SAMs count.
    for (let i = 0; i < 4; i++) {
      const tile = game.ref(20 + i * 10, 20);
      me.conquer(tile);
      me.buildUnit(UnitType.City, tile, {});
    }
    expect(nextEconomyBuild(game, me, false)).toBe(UnitType.SAMLauncher);
    const samTile = game.ref(20, 40);
    me.conquer(samTile);
    me.buildUnit(UnitType.SAMLauncher, samTile, {});
    // SAM quota met, silos are off (USE_NUKES) and 4 cities is plenty for
    // 5 tiles: nothing left to build.
    expect(nextEconomyBuild(game, me, false)).toBeNull();
  });

  it("builds a port first on the coast, a city first inland", () => {
    const game = landMap();
    const me = addPlayer(game, "me", PlayerType.Nation);
    // Trade is most of the income, so a coastal nation opens with a port.
    expect(nextEconomyBuild(game, me, true)).toBe(UnitType.Port);
    expect(nextEconomyBuild(game, me, false)).toBe(UnitType.City);
  });

  it("keeps a reserve between its base and max share of max troops", () => {
    const game = landMap();
    const me = addPlayer(game, "me", PlayerType.Nation);
    const enemy = addPlayer(game, "enemy", PlayerType.Nation);
    const max = game.config().maxTroops(me);
    expect(troopReserve(game, me, null)).toBeCloseTo(max * 0.25);
    enemy.setTroops(max * 100);
    expect(troopReserve(game, me, enemy)).toBeCloseTo(max * 0.6);
  });

  it("renews alliances except with weak neighbours it may attack", () => {
    const game = landMap();
    const me = addPlayer(game, "me", PlayerType.Nation);
    const strong = addPlayer(game, "strong", PlayerType.Nation);
    const weak = addPlayer(game, "weak", PlayerType.Nation);
    const distant = addPlayer(game, "distant", PlayerType.Nation);
    me.setTroops(10_000);
    strong.setTroops(20_000);
    weak.setTroops(1_000);
    distant.setTroops(1_000);
    const neighbors = [strong, weak];
    expect(shouldRenewAlliance(me, strong, neighbors)).toBe(true);
    expect(shouldRenewAlliance(me, weak, neighbors)).toBe(false);
    // Overseas trade partners are never war targets by land.
    expect(shouldRenewAlliance(me, distant, neighbors)).toBe(true);
  });

  it("only fights its current war while one is going on", () => {
    const game = landMap();
    const me = addPlayer(game, "me", PlayerType.Nation);
    const weak = addPlayer(game, "weak", PlayerType.Nation);
    const atWar = addPlayer(game, "atWar", PlayerType.Nation);
    me.setTroops(10_000);
    weak.setTroops(1_000);
    atWar.setTroops(5_000);
    expect(chooseWarTarget(me, [weak, atWar], [])).toBe(weak);
    expect(chooseWarTarget(me, [weak, atWar], [atWar])).toBe(atWar);
    // A war with someone who doesn't border us doesn't freeze the land front.
    const raider = addPlayer(game, "raider", PlayerType.Nation);
    expect(chooseWarTarget(me, [weak, atWar], [raider])).toBe(weak);
    // Nobody weak enough: no war at all.
    atWar.setTroops(9_000);
    expect(chooseWarTarget(me, [atWar], [atWar])).toBeNull();
  });
});

describe("SmartPiracy", () => {
  it("patrols where the most trade ships pass, if enough do", () => {
    const size = 400;
    const game = createGame({
      width: size,
      height: size,
      grid: Array(size * size).fill(W),
    });
    // Only position matters to the lane choice.
    const ship = (x: number, y: number) =>
      ({ tile: () => game.ref(x, y) }) as unknown as Unit;
    const lane = [ship(300, 300), ship(310, 305), ship(305, 310)];
    const stray = [ship(20, 20), ship(30, 380)];
    const best = piracyLane(game, [...stray, ...lane]);
    expect(best?.ships).toBe(3);
    expect(shipsNear(game, lane, best!.tile)).toBe(3);
    // Two ships in one spot aren't worth a warship.
    expect(piracyLane(game, stray)).toBeNull();
  });
});

describe("SmartNationExecution in a game", () => {
  function smartGame(config: Partial<GameConfig> = {}) {
    const game = landMap({ gameType: GameType.Singleplayer, ...config });
    // Someone in the middle of the map, spawned first.
    const rival = new PlayerInfo("rival", PlayerType.Nation, null, "rival");
    const rivalPlayer = (game as GameImpl).addPlayer(rival);
    game.addExecution(new SpawnExecution("game", rival, game.ref(50, 50)));
    const smart = nation("smart");
    game.addExecution(new SmartNationExecution("game", smart));
    tickUntil(game, () => game.hasPlayer("smart"), 5);
    const player = game.player("smart");
    tickUntil(game, () => player.hasSpawned(), 20);
    return { game, player, rivalPlayer };
  }

  it("keeps away from nations, not tribes, when spawning", () => {
    const game = landMap();
    const me = addPlayer(game, "me", PlayerType.Nation);
    const tribe = addPlayer(game, "tribe", PlayerType.Bot);
    const rival = addPlayer(game, "rival", PlayerType.Nation);
    tribe.conquer(game.ref(10, 10));
    tribe.setSpawnTile(game.ref(10, 10));
    rival.conquer(game.ref(80, 80));
    rival.setSpawnTile(game.ref(80, 80));
    expect(otherPlayerSpots(game, me)).toEqual([game.ref(80, 80)]);
  });

  it("spawns away from other players, towards the map edge", () => {
    const { game, player, rivalPlayer } = smartGame();
    expect(player.hasSpawned()).toBe(true);
    const spawn = player.spawnTile()!;
    const rival = rivalPlayer.spawnTile()!;
    expect(Math.sqrt(game.euclideanDistSquared(spawn, rival))).toBeGreaterThan(
      30,
    );
    expect(edgeScore(game, spawn)).toBeGreaterThan(0.3);
  });

  it("expands and builds a city after the spawn phase", () => {
    const { game, player } = smartGame();
    game.endSpawnPhase();
    // infiniteGold only applies to humans.
    player.addGold(10_000_000n);
    const start = player.numTilesOwned();
    for (let i = 0; i < 600; i++) game.executeNextTick();
    expect(player.numTilesOwned()).toBeGreaterThan(start);
    expect(player.unitCount(UnitType.City)).toBeGreaterThan(0);
  });

  it("plays the same game twice (deterministic)", () => {
    const run = () => {
      const { game, player } = smartGame();
      game.endSpawnPhase();
      for (let i = 0; i < 300; i++) game.executeNextTick();
      return [player.spawnTile(), player.numTilesOwned(), player.troops()];
    };
    expect(run()).toEqual(run());
  });

  it("replaces NationExecution only for the picked nations", () => {
    // ExecutionManager wiring is covered by the full-game snapshot test
    // (FullGameSnapshot.test.ts runs with smartNations: 2); here just check
    // the two executions control their own players.
    const game = landMap();
    game.addExecution(new NationExecution("g", nation("plain")));
    game.addExecution(new SmartNationExecution("g", nation("smart")));
    game.executeNextTick();
    expect(game.player("plain").type()).toBe(PlayerType.Nation);
    expect(game.player("smart").type()).toBe(PlayerType.Nation);
  });
});
