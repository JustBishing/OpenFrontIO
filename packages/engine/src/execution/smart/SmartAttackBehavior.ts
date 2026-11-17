import { TerraNullius } from "@openfront/engine-api/game/GameTypes";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { Versioned } from "@openfront/engine-lib/snapshot/SnapshotType";
import { Game, Player } from "../../game/Game";
import type {
  SnapshotReader,
  SnapshotWriter,
} from "../../snapshot/SnapshotContext";
import type { NukeStrikePartner } from "../nation/NationNukeBehavior";
import { TransportShipExecution } from "../TransportShipExecution";
import { AiAttackBehavior } from "../utils/AiAttackBehavior";
import { BASE_RESERVE_RATIO } from "./SmartNationConfig";

/**
 * SmartNation's hands: it decides elsewhere (SmartStrategy) whom to attack
 * and with how many troops, and sends the attack here through the same
 * AttackExecution / TransportShipExecution plumbing tribes and nations use.
 * The base class's own ratios are unused (SmartNation sizes every attack
 * itself), so they are stored as zero.
 */
export class SmartAttackBehavior
  extends AiAttackBehavior
  implements NukeStrikePartner
{
  constructor(random: PseudoRandom, game: Game, player: Player) {
    super(random, game, player, 0, 0, 0);
  }

  snapshot(w: SnapshotWriter): Versioned {
    return this.writeRecord(w, 0, []);
  }

  /** Fills a prototype-only shell; only assigns (see snapshot README). */
  restoreSnapshot(
    raw: unknown,
    r: SnapshotReader,
    random: PseudoRandom,
    player: Player,
  ): void {
    this.restoreRecord(raw, r, random, player);
  }

  /** Troops at home, net of what we already sent this tick. */
  available(): number {
    return this.homeTroops();
  }

  /** Troops a strike right after our nuke may send: everything above the base reserve. */
  strikeTroops(_target: Player): number {
    const max = this.game.config().maxTroops(this.player);
    return Math.max(0, this.homeTroops() - max * BASE_RESERVE_RATIO);
  }

  /** Land attack on a player our nuke just hit, while its troops are down. */
  strike(target: Player): boolean {
    if (this.player.isFriendly(target)) return false;
    if (!this.player.sharesBorderWith(target)) return false;
    return this.sendLandAttack(target, () => this.strikeTroops(target));
  }

  /** Land attack on free land with exactly `troops`. */
  expandByLand(troops: number): boolean {
    return this.sendLandAttack(this.game.terraNullius(), () => troops);
  }

  /** A boat to nearby free land (the base class picks the spot and size). */
  expandByBoat(): boolean {
    return this.sendAttack(this.game.terraNullius(), true);
  }

  /**
   * Attack `target` with `troops`: by land if we border it, otherwise by
   * boat (when a safe route exists).
   */
  attackWith(target: Player | TerraNullius, troops: number): boolean {
    if (!target.isPlayer()) return this.expandByLand(troops);
    if (this.player.sharesBorderWith(target)) {
      return this.sendLandAttack(target, () => troops);
    }
    const route = this.boatRoute(target);
    if (route === null || route.blocker !== null) return false;
    if (troops < 1) return false;
    this.send(
      new TransportShipExecution(this.player, route.landing, troops),
      troops,
    );
    return true;
  }
}
