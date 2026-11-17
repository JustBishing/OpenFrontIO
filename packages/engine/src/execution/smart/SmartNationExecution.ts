import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  Difficulty,
  Nation,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { GameID } from "@openfront/engine-api/Schemas";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import {
  VersionedSchema,
  zInt,
  zPlayerRef,
  zRandom,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { simpleHash } from "@openfront/engine-lib/Util";
import { z } from "zod";
import { Execution, Game, Player, Unit } from "../../game/Game";
import {
  NationSchema,
  nationData,
  newCell,
  readPlayerInfo,
} from "../../snapshot/CommonSchemas";
import { execSnapshotType } from "../../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../../snapshot/SnapshotContext";
import { AllianceExtensionExecution } from "../alliance/AllianceExtensionExecution";
import { AllianceRequestExecution } from "../alliance/AllianceRequestExecution";
import { ConstructionExecution } from "../ConstructionExecution";
import { MoveWarshipExecution } from "../MoveWarshipExecution";
import { NationEmojiBehavior } from "../nation/NationEmojiBehavior";
import { NationMIRVBehavior } from "../nation/NationMIRVBehavior";
import { NationNukeBehavior } from "../nation/NationNukeBehavior";
import { NationStructurePlacement } from "../nation/NationStructurePlacement";
import { NationWarshipBehavior } from "../nation/NationWarshipBehavior";
import { SpawnExecution } from "../SpawnExecution";
import { UpgradeStructureExecution } from "../UpgradeStructureExecution";
import { SmartAttackBehavior } from "./SmartAttackBehavior";
import {
  ACT_INTERVAL,
  ATTACK_TROOP_FRACTION,
  BOAT_TROOP_FRACTION,
  ECONOMY_CHECKS_PER_INTERVAL,
  EXPAND_TROOP_FRACTION,
  SPAWN_MOVE_IMPROVEMENT,
  SPAWN_REEVALUATE_TICKS,
  PIRACY_MAX_WARSHIPS,
  PIRACY_MIN_CITIES,
  PIRACY_MOVE_FACTOR,
  ALLY_TRADE_PARTNERS,
  SPARE_PORT_LEVEL_RATIO,
  SPEND_SPARE_GOLD_ON_CITIES,
  UPGRADE_WHEN_NO_ROOM,
  USE_NUKES,
  USE_PIRACY,
  USE_WARSHIPS,
} from "./SmartNationConfig";
import { capturableTradeShips, piracyLane, shipsNear } from "./SmartPiracy";
import { otherPlayerSpots, pickSpawnTile, scoreSpawnTile } from "./SmartSpawn";
import {
  allianceRequestTarget,
  bordersFreeLand,
  canAfford,
  choosePhase,
  chooseWarTarget,
  currentWars,
  defensePostTile,
  expansionTroops,
  frontTiles,
  hasFreeLandNearby,
  hostileNeighbors,
  isThreat,
  landNeighbors,
  nextEconomyBuild,
  overseasTarget,
  retaliationTarget,
  shouldAcceptAlliance,
  strongestHostileNeighbor,
  troopReserve,
  wantsDefensePost,
  warTroops,
  weakTribeTarget,
} from "./SmartStrategy";

/**
 * A rule-based AI opponent that plays one of the game's nations (it is a
 * PlayerType.Nation to everything else). Only created for singleplayer and
 * private games (see ExecutionManager.nationExecutions).
 *
 * Each decision round (every ACT_INTERVAL ticks) it, in order:
 *   1. answers alliance requests and asks its strongest non-enemy
 *      neighbour for one (shouldAcceptAlliance, allianceRequestTarget)
 *   2. fortifies the most dangerous front (defend)
 *   3. builds the next economy structure (buildEconomy)
 *   4. attacks: early game expands, mid/late game wages one war at a time.
 * Between rounds it only re-checks the economy, so gold doesn't pile up.
 */
export class SmartNationExecution implements Execution {
  private active = true;
  private random: PseudoRandom;
  private mg: Game;
  private player: Player | null = null;
  private attack: SmartAttackBehavior | null = null;
  // Stateless between ticks: rebuilt on restore.
  private placement: NationStructurePlacement | null = null;
  // The regular nations' nuke, MIRV and warship logic, reused as is
  // (created with `attack`, null when USE_WARSHIPS and USE_NUKES are off).
  private military: Military | null = null;

  private actInterval = 0;
  private actTick = 0;
  private spawnExecAdded = false;
  private lastSpawnEval: number | null = null;
  // Set when a defense post is wanted but unaffordable: economy then waits.
  private savingForDefense = false;

  constructor(
    private gameID: GameID,
    private nation: Nation,
  ) {
    // +1: a different stream from a NationExecution of the same id.
    this.random = new PseudoRandom(
      simpleHash(nation.playerInfo.id) + simpleHash(gameID) + 1,
    );
  }

  playerID(): string {
    return this.nation.playerInfo.id;
  }

  isInitialized(): boolean {
    return this.mg !== undefined;
  }

  /** Re-reads the difficulty (singleplayer can change it mid-game). */
  refreshDifficulty(): void {
    if (!this.mg) return;
    this.actInterval = ACT_INTERVAL[this.mg.config().gameConfig().difficulty];
    this.actTick = this.random.nextInt(0, this.actInterval);
  }

  init(mg: Game) {
    this.mg = mg;
    this.refreshDifficulty();
    this.player = mg.hasPlayer(this.nation.playerInfo.id)
      ? mg.player(this.nation.playerInfo.id)
      : mg.addPlayer(this.nation.playerInfo);
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return true;
  }

  tick(ticks: number) {
    const player = this.player;
    if (player === null) return;

    if (this.mg.inSpawnPhase()) {
      this.handleSpawnPhase(player, ticks);
      return;
    }
    // Spawn phase ended before our SpawnExecution ran: wait for it.
    if (this.spawnExecAdded && !player.hasSpawned()) return;
    if (!player.isAlive()) {
      // removeOnDeath is called from the nation's PlayerExecution
      this.active = false;
      return;
    }

    if (this.attack === null) {
      this.attack = new SmartAttackBehavior(this.random, this.mg, player);
      this.placement = new NationStructurePlacement(
        this.random,
        this.mg,
        player,
      );
      if (USE_WARSHIPS || USE_NUKES) {
        this.military = createMilitary(
          this.random,
          this.mg,
          player,
          this.attack,
        );
      }
      // Grab free land straight away, like nations do.
      this.attack.expandByLand(
        Math.floor(this.attack.available() * EXPAND_TROOP_FRACTION),
      );
      return;
    }

    this.everyTickMilitary(player);

    const offset =
      (((ticks - this.actTick) % this.actInterval) + this.actInterval) %
      this.actInterval;
    if (offset !== 0) {
      if (this.isEconomyTick(offset)) this.buildEconomy(player);
      return;
    }
    this.decisionRound(player);
  }

  private isEconomyTick(offset: number): boolean {
    const step = Math.floor(
      this.actInterval / (ECONOMY_CHECKS_PER_INTERVAL + 1),
    );
    return step > 0 && offset % step === 0;
  }

  private decisionRound(player: Player): void {
    const hostile = hostileNeighbors(player, landNeighbors(this.mg, player));
    const strongest = strongestHostileNeighbor(hostile);

    this.handleAlliances(player, hostile);
    this.defend(player, strongest);
    if (USE_NUKES) this.military?.mirv.considerMIRV();
    if (USE_PIRACY) this.pirate(player);
    this.buildEconomy(player);
    if (USE_WARSHIPS) this.military?.warship.maybeSpawnWarship();
    if (choosePhase(this.mg, player) === "early") {
      this.earlyGame(player, hostile);
    } else {
      this.midLateGame(player, hostile, strongest);
    }
    if (USE_WARSHIPS) this.military?.warship.counterWarshipInfestation();
    if (USE_NUKES) this.military?.nuke.maybeSendNuke();
  }

  /**
   * Every tick, as the nations do: warships hunt ships that attacked us
   * (not on Easy), and nukes that landed get their follow-up land strike.
   */
  private everyTickMilitary(player: Player): void {
    const military = this.military;
    if (military === null) return;
    const config = this.mg.config();
    if (
      USE_WARSHIPS &&
      config.gameConfig().difficulty !== Difficulty.Easy &&
      player.unitsConstructed(UnitType.Port) &&
      !config.isUnitDisabled(UnitType.Warship)
    ) {
      military.warship.trackShipsAndRetaliate();
    }
    if (USE_NUKES) military.nuke.followUpStrikes();
  }

  // ── Spawn ─────────────────────────────────────────────────────────────────

  /**
   * Picks the best-scoring spot (SmartSpawn), then re-checks it every
   * SPAWN_REEVALUATE_TICKS as other players arrive, moving only for a clearly
   * better one.
   */
  private handleSpawnPhase(player: Player, ticks: number): void {
    if (this.spawnExecAdded && !player.hasSpawned()) return;
    if (
      this.lastSpawnEval !== null &&
      ticks - this.lastSpawnEval < SPAWN_REEVALUATE_TICKS
    ) {
      return;
    }
    this.lastSpawnEval = ticks;

    const team = player.team();
    const area = team === null ? undefined : this.mg.teamSpawnArea(team);
    const pick = pickSpawnTile(this.mg, this.random, player, area);
    if (pick === null) {
      // Nothing scored (crowded map): let SpawnExecution place us at random.
      if (!this.spawnExecAdded) this.spawnAt(undefined);
      return;
    }
    const current = player.hasSpawned() ? player.spawnTile() : undefined;
    if (current !== undefined) {
      const others = otherPlayerSpots(this.mg, player);
      const now = scoreSpawnTile(this.mg, current, others)?.total ?? 0;
      if (pick.score.total < now * (1 + SPAWN_MOVE_IMPROVEMENT)) return;
    }
    this.spawnAt(pick.tile);
  }

  private spawnAt(tile: TileRef | undefined): void {
    this.mg.addExecution(
      new SpawnExecution(this.gameID, this.nation.playerInfo, tile),
    );
    this.spawnExecAdded = true;
  }

  // ── Diplomacy ─────────────────────────────────────────────────────────────

  /**
   * Accept alliances (and renewals) only from much stronger players, and
   * ask the strongest neighbour we're not fighting for one.
   */
  private handleAlliances(player: Player, hostile: Player[]): void {
    if (this.mg.config().disableAlliances()) return;
    const spawnEnd = this.mg.config().numSpawnPhaseTurns() + 1;
    for (const req of player.incomingAllianceRequests()) {
      // Requests sent during the spawn phase: rejected, as nations do.
      if (req.createdAt() <= spawnEnd) {
        req.reject();
      } else if (shouldAcceptAlliance(player, req.requestor())) {
        req.accept();
      } else {
        req.reject();
      }
    }
    for (const alliance of player.alliances()) {
      if (!alliance.onlyOneAgreedToExtend()) continue;
      const other = alliance.other(player);
      if (!shouldAcceptAlliance(player, other)) continue;
      this.mg.addExecution(new AllianceExtensionExecution(player, other.id()));
    }
    const ask = allianceRequestTarget(player, hostile, currentWars(player));
    if (ask !== null) {
      this.mg.addExecution(new AllianceRequestExecution(player, ask.id()));
    }
    if (ALLY_TRADE_PARTNERS) this.askTradePartner(player, hostile);
  }

  /**
   * One non-neighbouring nation or human with ports, picked at random, for an
   * alliance: allied ports trade with us more often (the friendly trade
   * bonus) and an ally overseas won't land boats on us.
   */
  private askTradePartner(player: Player, hostile: Player[]): void {
    const wars = currentWars(player);
    const partners = this.mg
      .players()
      .filter(
        (p) =>
          p !== player &&
          p.isAlive() &&
          p.type() !== PlayerType.Bot &&
          !hostile.includes(p) &&
          !player.isFriendly(p) &&
          !wars.includes(p) &&
          p.unitCount(UnitType.Port) > 0 &&
          player.canSendAllianceRequest(p),
      );
    if (partners.length === 0) return;
    const pick = this.random.randElement(partners);
    this.mg.addExecution(new AllianceRequestExecution(player, pick.id()));
  }

  // ── Defense ───────────────────────────────────────────────────────────────

  /** Defense posts behind the border with the strongest hostile neighbour. */
  private defend(player: Player, strongest: Player | null): void {
    this.savingForDefense = false;
    if (strongest === null || !isThreat(player, strongest)) return;
    const front = frontTiles(this.mg, player, strongest);
    if (!wantsDefensePost(this.mg, player, front)) return;
    if (!canAfford(this.mg, player, UnitType.DefensePost)) {
      this.savingForDefense = true;
      return;
    }
    const tile = defensePostTile(this.mg, this.random, player, front);
    if (tile === null) return;
    this.mg.addExecution(
      new ConstructionExecution(player, UnitType.DefensePost, tile),
    );
  }

  // ── Economy ───────────────────────────────────────────────────────────────

  /** Builds (or upgrades) the next structure nextEconomyBuild asks for. */
  private buildEconomy(player: Player): void {
    const placement = this.placement;
    if (placement === null || this.savingForDefense) return;
    placement.startRound();
    const planned = nextEconomyBuild(
      this.mg,
      player,
      placement.hasCoastalTiles(),
    );
    if (planned === null) {
      this.spendSpareGold(player);
      return;
    }
    const type = planned;
    if (!canAfford(this.mg, player, type)) return;
    const tile = placement.spawnTile(type);
    if (tile !== null) {
      this.mg.addExecution(new ConstructionExecution(player, type, tile));
      return;
    }
    if (UPGRADE_WHEN_NO_ROOM) this.upgradeOne(player, type);
  }

  /**
   * Nothing planned: spare gold still grows us. Port levels (more trade
   * ships, most of our income) until they reach SPARE_PORT_LEVEL_RATIO of
   * our city levels, otherwise cities or city levels (+max troops).
   */
  private spendSpareGold(player: Player): void {
    if (!SPEND_SPARE_GOLD_ON_CITIES) return;
    const levels = (type: UnitType) =>
      player.units(type).reduce((sum, u) => sum + u.level(), 0);
    const portLevels = levels(UnitType.Port);
    if (
      portLevels > 0 &&
      portLevels < levels(UnitType.City) * SPARE_PORT_LEVEL_RATIO &&
      canAfford(this.mg, player, UnitType.Port)
    ) {
      this.upgradeOne(player, UnitType.Port);
      return;
    }
    if (!canAfford(this.mg, player, UnitType.City)) return;
    const tile = this.placement!.spawnTile(UnitType.City);
    if (tile !== null) {
      this.mg.addExecution(
        new ConstructionExecution(player, UnitType.City, tile),
      );
    } else {
      this.upgradeOne(player, UnitType.City);
    }
  }

  /** Upgrades our lowest-level finished structure of `type`, if any. */
  private upgradeOne(player: Player, type: UnitType): void {
    if (this.mg.config().unitInfo(type).upgradable !== true) return;
    let best = null;
    for (const u of player.units(type)) {
      if (!player.canUpgradeUnit(u)) continue;
      if (best === null || u.level() < best.level()) best = u;
    }
    if (best !== null) {
      this.mg.addExecution(new UpgradeStructureExecution(player, best.id()));
    }
  }

  // ── Piracy ────────────────────────────────────────────────────────────────

  /**
   * Keeps warships on the busiest enemy trade lane (SmartPiracy): builds one
   * when no warship covers it, or moves the one on the quietest lane there.
   */
  private pirate(player: Player): void {
    const game = this.mg;
    if (game.config().isUnitDisabled(UnitType.Warship)) return;
    if (player.unitCount(UnitType.City) < PIRACY_MIN_CITIES) return;
    const ships = capturableTradeShips(game, player);
    const lane = piracyLane(game, ships);
    if (lane === null) return;
    const range2 = game.config().warshipPatrolRange() ** 2;
    const warships = player.units(UnitType.Warship);
    const covered = warships.some((w) => {
      const patrol = w.warshipState().patrolTile;
      return (
        patrol !== undefined &&
        game.euclideanDistSquared(patrol, lane.tile) <= range2
      );
    });
    if (covered) return;

    if (warships.length < PIRACY_MAX_WARSHIPS) {
      if (!canAfford(game, player, UnitType.Warship)) return;
      if (player.canBuild(UnitType.Warship, lane.tile) === false) return;
      game.addExecution(
        new ConstructionExecution(player, UnitType.Warship, lane.tile),
      );
      return;
    }
    let quietest: Unit | null = null;
    let quietestShips = Infinity;
    for (const w of warships) {
      const state = w.warshipState();
      if (state.state !== "patrolling" || state.isInCombat === true) continue;
      const n =
        state.patrolTile === undefined
          ? 0
          : shipsNear(game, ships, state.patrolTile);
      if (n < quietestShips) {
        quietest = w;
        quietestShips = n;
      }
    }
    if (quietest !== null && lane.ships >= quietestShips * PIRACY_MOVE_FACTOR) {
      game.addExecution(
        new MoveWarshipExecution(player, [quietest.id()], lane.tile),
      );
    }
  }

  // ── Attacks ───────────────────────────────────────────────────────────────

  /** Early game: free land and weak tribes, ~half our troops at a time. */
  private earlyGame(player: Player, hostile: Player[]): void {
    const attack = this.attack!;
    const troops = expansionTroops(this.mg, player, attack.available());
    if (troops <= 0) return;
    if (bordersFreeLand(this.mg, player)) {
      attack.expandByLand(troops);
      return;
    }
    const tribe = weakTribeTarget(hostile, troops);
    if (tribe !== null) {
      attack.attackWith(tribe, troops);
      return;
    }
    // Free land only across water (nearby() looks across rivers too).
    if (hasFreeLandNearby(player)) attack.expandByBoat();
  }

  /**
   * Mid/late game: hit back at attackers, keep taking free land, then fight
   * the weakest neighbour — one war at a time, always keeping the reserve.
   */
  private midLateGame(
    player: Player,
    hostile: Player[],
    strongest: Player | null,
  ): void {
    const attack = this.attack!;
    const available = attack.available();
    const reserve = troopReserve(this.mg, player, strongest);
    const spare = Math.max(0, available - reserve);

    const attacker = retaliationTarget(player, spare);
    if (attacker !== null) {
      const troops = Math.floor(spare * ATTACK_TROOP_FRACTION);
      if (attack.attackWith(attacker, troops)) return;
    }

    if (bordersFreeLand(this.mg, player)) {
      const troops = Math.min(
        expansionTroops(this.mg, player, available),
        Math.floor(spare),
      );
      if (troops > 0 && attack.expandByLand(troops)) return;
    }

    const troops = warTroops(this.mg, player, available, reserve);
    if (troops <= 0) return;
    const target = chooseWarTarget(player, hostile, currentWars(player));
    if (target !== null) {
      attack.attackWith(target, troops);
      return;
    }

    // Nobody weak enough by land: try a boat to free land or a weak overseas player.
    if (hostile.length === 0 && hasFreeLandNearby(player)) {
      if (attack.expandByBoat()) return;
    }
    const overseas = overseasTarget(this.mg, player, hostile);
    if (overseas !== null) {
      attack.attackWith(overseas, Math.floor(troops * BOAT_TROOP_FRACTION));
    }
  }

  // ── Snapshots ─────────────────────────────────────────────────────────────

  snapshot(w: SnapshotWriter): ExecRecord {
    // Stored by index into the game's nations so identity survives.
    const nationIndex = w.game.nations().indexOf(this.nation);
    return SmartNationExecutionSnapshot.write({
      active: this.active,
      gameID: this.gameID,
      nationIndex: nationIndex === -1 ? null : nationIndex,
      nation: nationIndex === -1 ? nationData(this.nation) : null,
      random: w.random(this.random),
      initialized: this.mg !== undefined,
      player: w.playerOrNull(this.player),
      actInterval: this.actInterval,
      actTick: this.actTick,
      spawnExecAdded: this.spawnExecAdded,
      lastSpawnEval: this.lastSpawnEval,
      savingForDefense: this.savingForDefense,
      attack: this.attack === null ? null : this.attack.snapshot(w),
      military:
        this.military === null
          ? null
          : {
              emoji: this.military.emoji.snapshot(w),
              mirv: this.military.mirv.snapshot(w),
              warship: this.military.warship.snapshot(w),
              nuke: this.military.nuke.snapshot(w),
            },
    });
  }

  restoreSnapshot(s: SmartNationState, r: SnapshotReader): void {
    this.active = s.active;
    this.gameID = s.gameID;
    if (s.nationIndex !== null) {
      this.nation = r.game.nations()[s.nationIndex];
    } else if (s.nation !== null) {
      const cell = s.nation.spawnCell;
      this.nation = new Nation(
        cell === null ? undefined : newCell(cell),
        readPlayerInfo(s.nation.playerInfo, r),
      );
    }
    const random = r.random(s.random);
    this.random = random;
    if (s.initialized) this.mg = r.game;
    this.player = r.playerOrNull(s.player);
    this.actInterval = s.actInterval;
    this.actTick = s.actTick;
    this.spawnExecAdded = s.spawnExecAdded;
    this.lastSpawnEval = s.lastSpawnEval;
    this.savingForDefense = s.savingForDefense;
    this.attack = null;
    this.placement = null;
    this.military = null;
    const player = this.player;
    if (s.attack !== null && player !== null) {
      const attack = Object.create(
        SmartAttackBehavior.prototype,
      ) as SmartAttackBehavior;
      attack.restoreSnapshot(s.attack, r, random, player);
      this.attack = attack;
      this.placement = new NationStructurePlacement(random, r.game, player);
      this.military =
        s.military === null
          ? null
          : restoreMilitary(s.military, r, random, player, attack);
    }
  }
}

const SmartNationStateSchema = z.object({
  active: z.boolean(),
  gameID: z.string(),
  nationIndex: z.number().int().nonnegative().nullable(),
  nation: NationSchema.nullable(),
  random: zRandom(),
  initialized: z.boolean(),
  player: zPlayerRef().nullable(),
  actInterval: zInt(),
  actTick: zInt(),
  spawnExecAdded: z.boolean(),
  lastSpawnEval: zInt().nullable(),
  savingForDefense: z.boolean(),
  attack: VersionedSchema.nullable(),
  military: z
    .object({
      emoji: VersionedSchema,
      mirv: VersionedSchema,
      warship: VersionedSchema,
      nuke: VersionedSchema,
    })
    .nullable(),
});
type SmartNationState = z.infer<typeof SmartNationStateSchema>;

export const SmartNationExecutionSnapshot = execSnapshotType({
  name: "SmartNation",
  version: 1,
  schema: SmartNationStateSchema,
  cls: () => SmartNationExecution,
});

/** The nation behaviors SmartNation borrows, sharing one PRNG and emoji state. */
interface Military {
  emoji: NationEmojiBehavior;
  mirv: NationMIRVBehavior;
  warship: NationWarshipBehavior;
  nuke: NationNukeBehavior;
}

function createMilitary(
  random: PseudoRandom,
  game: Game,
  player: Player,
  attack: SmartAttackBehavior,
): Military {
  const emoji = new NationEmojiBehavior(random, game, player);
  return {
    emoji,
    mirv: new NationMIRVBehavior(random, game, player, emoji),
    warship: new NationWarshipBehavior(random, game, player, emoji),
    nuke: new NationNukeBehavior(random, game, player, attack, emoji),
  };
}

/** Fills prototype-only shells, as NationExecution does (see snapshot README). */
function restoreMilitary(
  s: NonNullable<SmartNationState["military"]>,
  r: SnapshotReader,
  random: PseudoRandom,
  player: Player,
  attack: SmartAttackBehavior,
): Military {
  const shell = <T extends object>(cls: { prototype: T }): T =>
    Object.create(cls.prototype) as T;
  const emoji = shell(NationEmojiBehavior);
  const mirv = shell(NationMIRVBehavior);
  const warship = shell(NationWarshipBehavior);
  const nuke = shell(NationNukeBehavior);
  emoji.restoreSnapshot(s.emoji, r, random, player);
  mirv.restoreSnapshot(s.mirv, r, random, player, emoji);
  warship.restoreSnapshot(s.warship, r, random, player, emoji);
  nuke.restoreSnapshot(s.nuke, r, random, player, attack, emoji);
  return { emoji, mirv, warship, nuke };
}
