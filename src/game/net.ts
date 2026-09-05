/*
 * SpacetimeDB-backed networking for SINGULARITY.
 *
 * Replaces the old SSE + POST relay: rooms, teams, inputs, physics snapshots and
 * the leaderboard all flow through a single WebSocket into the SpacetimeDB module
 * (see server/src/index.ts). The rest of the game talks to this class exactly like
 * it talked to the old Net.
 */
import { DbConnection, type EventContext } from "@/module_bindings";
import type { Room, Player, Team, Snapshot, Input, Squad } from "@/module_bindings/types";
import { MAX_TEAM_SIZE, type Phase, type PlayerInfo, type Role, type RoleInput, type RoomSnapshot, type SquadSize, type TeamInfo } from "./types";
import type { Snap } from "./game";

export const SPACETIMEDB_URI = process.env.NEXT_PUBLIC_SPACETIMEDB_URI ?? "wss://maincloud.spacetimedb.com";
export const SPACETIMEDB_MODULE = process.env.NEXT_PUBLIC_SPACETIMEDB_MODULE ?? "singularity2";

const ALL_ROLES: Role[] = ["arms", "torso", "legs", "lhand", "rhand", "lleg", "rleg", "head"];
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 5000;

export interface ScoreRow {
  id: string;
  challengeId: string;
  teamName: string;
  players: string[];
  timeMs: number;
}

export interface NetHandlers {
  onRoom?: (room: RoomSnapshot) => void;
  onRemoteInputs?: (inputs: Partial<Record<Role, RoleInput>>) => void;
  onSnapshot?: (teamId: number, snap: Snap) => void;
  onTeamFinished?: (teamId: number, timeMs: number, teamName: string) => void;
  onConnectionChange?: (connected: boolean) => void;
  onScores?: (rows: ScoreRow[]) => void;
}

function hexOf(id: { toHexString(): string } | undefined | null): string {
  return id ? id.toHexString() : "";
}

function msOf(micros: bigint): number {
  return Number(micros / 1000n);
}

export class Net {
  private conn: DbConnection | null = null;
  private handlers: NetHandlers = {};
  private code = "";
  private name = "";
  private solo = false;
  private me = "";
  private destroyed = false;
  private disposed = false;
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private roomRow: Room | null = null;
  private squadSize: SquadSize = 5;
  private players = new Map<string, Player>();
  private teams = new Map<string, Team>();
  private inputRows = new Map<string, Input>();
  private scoreRows = new Map<string, { challengeId: string; teamName: string; players: string[]; timeMs: number }>();
  private finishSeen = new Set<string>();
  serverOffset = 0; // serverMs - clientMs
  connected = false;

  constructor(code: string, name: string, solo: boolean) {
    this.code = code.toUpperCase();
    this.name = name;
    this.solo = solo;
  }

  setHandlers(h: NetHandlers) {
    this.handlers = h;
  }

  /** This client's SpacetimeDB identity hex (empty until connected). */
  get myId(): string {
    return this.me;
  }

  connect() {
    this.destroyed = false;
    DbConnection.builder()
      .withUri(SPACETIMEDB_URI)
      .withDatabaseName(SPACETIMEDB_MODULE)
      .onConnect((conn, identity) => {
        if (this.disposed) return;
        this.conn = conn;
        this.me = identity.toHexString();
        this.reconnectAttempt = 0;
        this.wire(conn);
        conn.subscriptionBuilder()
          .onApplied(() => {
            this.connected = true;
            this.handlers.onConnectionChange?.(true);
            this.callJoinRoom(conn);
            this.emitRoom();
          })
          .subscribe([
            `SELECT * FROM room WHERE code = '${this.code}'`,
            `SELECT * FROM player WHERE code = '${this.code}'`,
            `SELECT * FROM team WHERE code = '${this.code}'`,
            `SELECT * FROM snapshot WHERE code = '${this.code}'`,
            `SELECT * FROM input WHERE code = '${this.code}'`,
            `SELECT * FROM squad WHERE code = '${this.code}'`,
            `SELECT * FROM score`,
          ]);
      })
      .onConnectError(() => this.scheduleReconnect())
      .onDisconnect(() => {
        this.conn = null;
        this.connected = false;
        this.handlers.onConnectionChange?.(false);
        if (!this.disposed && !this.destroyed) this.scheduleReconnect();
      })
      .build();
  }

  private scheduleReconnect() {
    if (this.disposed || this.destroyed || this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** this.reconnectAttempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.disposed && !this.destroyed) this.connect();
    }, delay);
  }

  private callJoinRoom(conn: DbConnection) {
    conn.reducers.joinRoom({ code: this.code, name: this.name, solo: this.solo });
    if (!this.hbTimer) {
      this.hbTimer = setInterval(() => {
        try {
          this.conn?.reducers.heartbeat({});
        } catch {}
      }, 20_000);
    }
  }

  private wire(conn: DbConnection) {
    const inRoom = (code: string) => code === this.code;

    conn.db.room.onInsert((_ctx: EventContext, row: Room) => {
      if (!inRoom(row.code)) return;
      this.roomRow = row;
      this.syncOffset(row);
      this.emitRoom();
    });
    conn.db.room.onUpdate((_ctx: EventContext, _prev: Room, next: Room) => {
      if (!inRoom(next.code)) return;
      this.roomRow = next;
      this.syncOffset(next);
      this.emitRoom();
    });
    conn.db.room.onDelete((_ctx: EventContext, row: Room) => {
      if (!inRoom(row.code)) return;
      this.roomRow = null;
      this.emitRoom();
    });

    const cachePlayer = (row: Player) => {
      if (!inRoom(row.code)) return;
      this.players.set(hexOf(row.identity), row);
      this.emitRoom();
    };
    conn.db.player.onInsert((_ctx: EventContext, row: Player) => cachePlayer(row));
    conn.db.player.onUpdate((_ctx: EventContext, _prev: Player, next: Player) => cachePlayer(next));
    conn.db.player.onDelete((_ctx: EventContext, row: Player) => {
      const hex = hexOf(row.identity);
      if (hex === this.me) {
        // cleanup beat us to it (or we were kicked) — rejoin
        this.players.delete(hex);
        this.emitRoom();
        if (!this.disposed && !this.destroyed && this.conn) {
          setTimeout(() => this.conn && this.callJoinRoom(this.conn), 800);
        }
        return;
      }
      if (this.players.delete(hex)) this.emitRoom();
    });

    const cacheTeam = (row: Team) => {
      if (!inRoom(row.code)) return;
      this.teams.set(row.id.toString(), row);
      if (row.finishMs != null && !this.finishSeen.has(row.id.toString())) {
        this.finishSeen.add(row.id.toString());
        this.handlers.onTeamFinished?.(Number(row.id), msOf(row.finishMs), row.name);
      }
      this.emitRoom();
    };
    conn.db.team.onInsert((_ctx: EventContext, row: Team) => cacheTeam(row));
    conn.db.team.onUpdate((_ctx: EventContext, _prev: Team, next: Team) => cacheTeam(next));
    conn.db.team.onDelete((_ctx: EventContext, row: Team) => {
      if (this.teams.delete(row.id.toString())) {
        this.finishSeen.delete(row.id.toString());
        this.emitRoom();
      }
    });

    const applySnapshot = (row: Snapshot) => {
      if (!inRoom(row.code)) return;
      // the host does not need to hear its own broadcast
      if (row.teamId === this.myTeamId() && this.amHost()) return;
      this.handlers.onSnapshot?.(Number(row.teamId), this.toSnap(row));
    };
    conn.db.snapshot.onInsert((_ctx: EventContext, row: Snapshot) => applySnapshot(row));
    conn.db.snapshot.onUpdate((_ctx: EventContext, _prev: Snapshot, next: Snapshot) => applySnapshot(next));

    const applyInputs = () => {
      const myTeam = this.myTeamId();
      if (myTeam == null) return;
      const merged: Partial<Record<Role, RoleInput>> = {};
      for (const row of this.inputRows.values()) {
        if (row.teamId !== myTeam || hexOf(row.identity) === this.me) continue;
        row.roles.forEach((role, i) => {
          const inp = row.inputs[i];
          if (!inp || !ALL_ROLES.includes(role as Role)) return;
          merged[role as Role] = {
            f: inp.f, s: inp.s, a: inp.a, b: inp.b, q: inp.q, e: inp.e, lx: inp.lx, ly: inp.ly,
          };
        });
      }
      this.handlers.onRemoteInputs?.(merged);
    };
    conn.db.input.onInsert((_ctx: EventContext, row: Input) => {
      if (!inRoom(row.code)) return;
      this.inputRows.set(hexOf(row.identity), row);
      applyInputs();
    });
    conn.db.input.onUpdate((_ctx: EventContext, _prev: Input, next: Input) => {
      if (!inRoom(next.code)) return;
      this.inputRows.set(hexOf(next.identity), next);
      applyInputs();
    });
    conn.db.input.onDelete((_ctx: EventContext, row: Input) => {
      if (this.inputRows.delete(hexOf(row.identity))) applyInputs();
    });

    conn.db.score.onInsert((_ctx: EventContext, row) => {
      this.scoreRows.set(row.id.toString(), { challengeId: row.challengeId, teamName: row.teamName, players: row.players, timeMs: msOf(row.timeMs) });
      this.emitScores();
    });
    conn.db.score.onDelete((_ctx: EventContext, row) => {
      if (this.scoreRows.delete(row.id.toString())) this.emitScores();
    });

    const applySquad = (row: Squad) => {
      if (!inRoom(row.code)) return;
      this.squadSize = row.size === 3 ? 3 : 5;
      this.emitRoom();
    };
    conn.db.squad.onInsert((_ctx: EventContext, row: Squad) => applySquad(row));
    conn.db.squad.onUpdate((_ctx: EventContext, _prev: Squad, next: Squad) => applySquad(next));
    conn.db.squad.onDelete((_ctx: EventContext, row: Squad) => {
      if (!inRoom(row.code)) return;
      this.squadSize = 5;
      this.emitRoom();
    });
  }

  private emitScores() {
    const rows: ScoreRow[] = [...this.scoreRows.entries()]
      .map(([id, r]) => ({ id, ...r }))
      .sort((a, b) => a.timeMs - b.timeMs)
      .slice(0, 50);
    this.handlers.onScores?.(rows);
  }

  private syncOffset(row: Room) {
    this.serverOffset = msOf(row.nowMicros) - Date.now();
  }

  private myTeamId(): bigint | null {
    const me = this.players.get(this.me);
    return me ? me.teamId : null;
  }

  private amHost(): boolean {
    const teamId = this.myTeamId();
    if (teamId == null) return false;
    const tm = this.teams.get(teamId.toString());
    return !!tm && hexOf(tm.hostId) === this.me;
  }

  private toSnap(row: Snapshot): Snap {
    let ev: Snap["ev"] = [];
    try {
      ev = JSON.parse(row.ev) as Snap["ev"];
    } catch {}
    return {
      t: msOf(row.recvMicros),
      p: row.p,
      props: row.props,
      yaw: row.yaw,
      pitch: row.pitch,
      timer: row.timer,
      fallen: row.fallen ? 1 : 0,
      score: row.score,
      ev,
      msg: row.msg,
    };
  }

  private emitRoom() {
    if (!this.handlers.onRoom) return;
    const players = [...this.players.values()].sort((a, b) => (a.joinedSeq < b.joinedSeq ? -1 : a.joinedSeq > b.joinedSeq ? 1 : 0));
    const teams = [...this.teams.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    const infos: PlayerInfo[] = players.map((p) => ({
      id: hexOf(p.identity),
      name: p.name,
      teamId: Number(p.teamId),
      roles: p.roles.filter((r): r is Role => ALL_ROLES.includes(r as Role)),
      ready: p.ready,
    }));
    const teamInfos: TeamInfo[] = teams.map((t) => ({
      id: Number(t.id),
      name: t.name,
      color: t.color,
      hostId: hexOf(t.hostId) || null,
      finishMs: t.finishMs != null ? msOf(t.finishMs) : null,
    }));
    this.handlers.onRoom({
      code: this.code,
      phase: (this.roomRow?.phase ?? "lobby") as Phase,
      challengeId: this.roomRow?.challengeId ?? "wobble-run",
      squadSize: this.squadSize,
      players: infos,
      teams: teamInfos,
      startAt: this.roomRow && this.roomRow.startAtMicros > 0n ? msOf(this.roomRow.startAtMicros) + this.serverOffset : null,
      round: this.roomRow?.round ?? 0,
      now: Date.now() + this.serverOffset,
      leaderId: infos[0]?.id ?? null,
    });
  }

  /* ---------------------------------- outbound ---------------------------------- */

  setRole(role: Role) {
    this.conn?.reducers.setRole({ role });
  }
  joinTeam(teamId: number) {
    this.conn?.reducers.joinTeam({ teamId: BigInt(teamId) });
  }
  createTeam() {
    this.conn?.reducers.createTeam({});
  }
  setReady(ready: boolean) {
    this.conn?.reducers.setReady({ ready });
  }
  setChallenge(challengeId: string) {
    this.conn?.reducers.setChallenge({ challengeId });
  }
  setSquad(squadSize: SquadSize) {
    this.conn?.reducers.setSquad({ size: squadSize });
  }
  startRound(force: boolean) {
    this.conn?.reducers.startRound({ force });
  }
  backToLobby() {
    this.conn?.reducers.backToLobby({});
  }
  finishRun(timeMs: number) {
    this.conn?.reducers.finishRun({ timeMs: BigInt(Math.max(0, Math.round(timeMs))) });
  }

  sendInputs(payload: Partial<Record<Role, RoleInput>>) {
    const roles = Object.keys(payload) as Role[];
    if (roles.length === 0) return;
    this.conn?.reducers.sendInput({
      roles,
      inputs: roles.map((r) => {
        const i = payload[r]!;
        return { f: i.f, s: i.s, a: i.a, b: i.b, q: i.q, e: i.e, lx: i.lx, ly: i.ly };
      }),
    });
  }

  publishSnapshot(s: Snap) {
    this.conn?.reducers.publishSnapshot({
      p: s.p as number[],
      props: s.props as number[],
      yaw: s.yaw,
      pitch: s.pitch,
      timer: s.timer,
      fallen: s.fallen === 1,
      score: s.score,
      ev: JSON.stringify(s.ev),
      msg: s.msg,
    });
  }

  serverNow() {
    return Date.now() + this.serverOffset;
  }

  leave() {
    try {
      this.conn?.reducers.leaveRoom({});
    } catch {}
  }

  close() {
    this.disposed = true;
    this.destroyed = true;
    if (this.hbTimer) clearInterval(this.hbTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.leave();
    this.conn?.disconnect();
    this.conn = null;
  }
}

export { MAX_TEAM_SIZE };
