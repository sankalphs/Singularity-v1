/*
 * SINGULARITY — SpacetimeDB server module
 *
 * Replaces the original Next.js in-memory room service + SSE relay:
 * rooms, teams, roles, ready-up, round lifecycle (countdown -> playing -> results),
 * input relay (teammates -> team host), physics snapshot relay (team host -> everyone),
 * and the all-time leaderboard all live in the database now.
 */
import { schema, table, t } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';

/* ---------------------------------- constants ---------------------------------- */

const CHALLENGE_IDS = new Set(['wobble-run', 'ferry-job', 'summit-sync', 'egg-express', 'slam-dunk']);
// Squad roles players actually pick. 3-player: arms+torso+legs. 5-player: split hands + split legs.
const SQUAD_3 = ['arms', 'torso', 'legs'];
const SQUAD_5 = ['lhand', 'rhand', 'torso', 'lleg', 'rleg'];
// Every assignable role (legacy head/arms kept for old rooms).
const ROLES = new Set(['arms', 'torso', 'legs', 'lhand', 'rhand', 'lleg', 'rleg', 'head']);
const TEAM_COLORS = ['#ff5d5d', '#4fa8ff', '#ffd23f', '#6ef29a', '#c58bff', '#ff9a3c'];

const COUNTDOWN_MICROS = 4_200_000n; // 4.2s
const GRACE_MICROS = 45_000_000n; // 45s for remaining teams after a finish
const CLEANUP_INTERVAL_MICROS = 60_000_000n; // 60s
const STALE_MICROS = 600_000_000n; // 10min without heartbeat -> gone

/* ---------------------------------- types ---------------------------------- */

const RoleInput = t.object('RoleInput', {
  f: t.f32(), // forward/back axis -1..1
  s: t.f32(), // side axis -1..1
  a: t.bool(), // space
  b: t.bool(), // shift
  q: t.bool(),
  e: t.bool(),
  lx: t.f32(), // head yaw (radians, absolute)
  ly: t.f32(), // head pitch (radians, absolute)
});

/* ---------------------------------- tables ---------------------------------- */

const room = table(
  { name: 'room', public: true },
  {
    code: t.string().primaryKey(),
    phase: t.string(), // 'lobby' | 'countdown' | 'playing' | 'results'
    challenge_id: t.string(),
    round: t.u32(),
    start_at_micros: t.u64(),
    now_micros: t.u64(),
    next_team_id: t.u32(),
    next_player_seq: t.u64(),
  }
);

const player = table(
  { name: 'player', public: true },
  {
    identity: t.identity().primaryKey(),
    code: t.string().index('btree'),
    name: t.string(),
    team_id: t.u64(),
    roles: t.array(t.string()),
    ready: t.bool(),
    solo: t.bool(),
    joined_seq: t.u64(),
    last_seen_micros: t.u64(),
  }
);

const team = table(
  { name: 'team', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    code: t.string().index('btree'),
    name: t.string(),
    color: t.string(),
    host_id: t.option(t.identity()),
    finish_ms: t.option(t.u64()),
  }
);

/** Published by each team's host at ~15Hz; subscribed by everyone else in the room. */
const snapshot = table(
  { name: 'snapshot', public: true },
  {
    team_id: t.u64().primaryKey(),
    code: t.string().index('btree'),
    recv_micros: t.u64(),
    p: t.array(t.f32()), // 11 parts * 7 floats (pos xyz + quat)
    props: t.array(t.f32()), // propId, pos xyz, quat xyzw per prop
    yaw: t.f32(),
    pitch: t.f32(),
    timer: t.f32(),
    fallen: t.bool(),
    score: t.u32(),
    ev: t.string(), // JSON array of sound/FX events since last snapshot
    msg: t.option(t.string()), // "tone|text" toast from the host
  }
);

/** Per-role control inputs, written by non-host players, consumed by their team host. */
const input = table(
  { name: 'input', public: true },
  {
    identity: t.identity().primaryKey(),
    code: t.string().index('btree'),
    team_id: t.u64(),
    roles: t.array(t.string()),
    inputs: t.array(RoleInput),
  }
);

const score = table(
  { name: 'score', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    challenge_id: t.string().index('btree'),
    team_name: t.string(),
    players: t.array(t.string()),
    time_ms: t.u64(),
    created_at: t.timestamp(),
  }
);

/** Per-room squad size (3 or 5). Separate table so existing rooms/scores need no migration. */
const squad = table(
  { name: 'squad', public: true },
  {
    code: t.string().primaryKey(),
    size: t.u8(),
  }
);

/** One-shot scheduled timers: kind = 'start' (countdown over) or 'grace' (round grace over). */
const round_timer = table(
  { name: 'round_timer', scheduled: (): any => onRoundTimer },
  {
    scheduled_id: t.u64().primaryKey().autoInc(),
    scheduled_at: t.scheduleAt(),
    code: t.string(),
    round: t.u32(),
    kind: t.string(),
  }
);

/** Recurring maintenance tick (stale player/room cleanup). */
const cleanup_timer = table(
  { name: 'cleanup_timer', scheduled: (): any => onCleanup },
  {
    scheduled_id: t.u64().primaryKey().autoInc(),
    scheduled_at: t.scheduleAt(),
  }
);

/** Live WebSocket connections; a player row survives while any of its connections is open. */
const conn = table(
  { name: 'conn', public: true },
  {
    connection_id: t.connectionId().primaryKey(),
    identity: t.identity().index('btree'),
  }
);

const spacetimedb = schema({
  room,
  player,
  team,
  snapshot,
  input,
  score,
  squad,
  round_timer,
  cleanup_timer,
  conn,
});
export default spacetimedb;

/* ---------------------------------- helpers (unexported) ---------------------------------- */

function normCode(code: string): string {
  return code.trim().toUpperCase().slice(0, 8);
}

function nowMicros(ctx: { timestamp: { microsSinceUnixEpoch: bigint } }): bigint {
  return ctx.timestamp.microsSinceUnixEpoch;
}

function touchRoom(ctx: any, r: { code: string; now_micros: bigint } | null | undefined, micros: bigint) {
  if (!r) return;
  r.now_micros = micros;
  ctx.db.room.code.update(r);
}

function getOrCreateRoom(ctx: any, code: string, micros: bigint) {
  let r = ctx.db.room.code.find(code);
  if (!r) {
    r = ctx.db.room.insert({
      code,
      phase: 'lobby',
      challenge_id: 'wobble-run',
      round: 0,
      start_at_micros: 0n,
      now_micros: micros,
      next_team_id: 1,
      next_player_seq: 0n,
    });
  }
  return r;
}

function playersIn(ctx: any, code: string) {
  return [...ctx.db.player.code.filter(code)];
}

function teamsIn(ctx: any, code: string) {
  return [...ctx.db.team.code.filter(code)];
}

function earliest(members: any[]): any | null {
  let best: any | null = null;
  for (const m of members) if (!best || m.joined_seq < best.joined_seq) best = m;
  return best;
}

function leaderOf(ctx: any, code: string): any | null {
  return earliest(playersIn(ctx, code));
}

/** Reassign team hosts after membership changes; delete teams with no members. */
function fixHosts(ctx: any, code: string) {
  for (const tm of teamsIn(ctx, code)) {
    const members = playersIn(ctx, code).filter((p: any) => p.team_id === tm.id);
    if (members.length === 0) {
      ctx.db.team.id.delete(tm.id);
      continue;
    }
    const hostOk = tm.host_id != null && members.some((m: any) => m.identity.equals(tm.host_id!));
    if (!hostOk) {
      const host = earliest(members);
      tm.host_id = host ? host.identity : undefined;
      ctx.db.team.id.update(tm);
    }
  }
}

/** Remove a player; clean up their input row, host pointers, and empty rooms. */
function removePlayer(ctx: any, identity: any, micros: bigint) {
  const p = ctx.db.player.identity.find(identity);
  if (!p) return;
  const code = p.code;
  ctx.db.player.identity.delete(identity);
  ctx.db.input.identity.delete(identity);
  fixHosts(ctx, code);
  if (playersIn(ctx, code).length === 0) deleteRoom(ctx, code);
  else touchRoom(ctx, ctx.db.room.code.find(code), micros);
}

function deleteRoom(ctx: any, code: string) {
  for (const tm of teamsIn(ctx, code)) ctx.db.team.id.delete(tm.id);
  for (const s of [...ctx.db.snapshot.code.filter(code)]) ctx.db.snapshot.team_id.delete(s.team_id);
  for (const i of [...ctx.db.input.code.filter(code)]) ctx.db.input.identity.delete(i.identity);
  for (const rt of [...ctx.db.round_timer.iter()]) if (rt.code === code) ctx.db.round_timer.scheduled_id.delete(rt.scheduled_id);
  const sq = ctx.db.squad.code.find(code);
  if (sq) ctx.db.squad.code.delete(code);
  ctx.db.room.code.delete(code);
}

/** Room's squad size (3 or 5). Defaults to 5 for rooms created before squads existed. */
function squadSizeOf(ctx: any, code: string): number {
  const sq = ctx.db.squad.code.find(code);
  return sq && sq.size === 3 ? 3 : 5;
}

function squadRolesOf(ctx: any, code: string): string[] {
  return squadSizeOf(ctx, code) === 3 ? SQUAD_3 : SQUAD_5;
}

/** Auto-assign the first free role on a team; returns the assigned roles array. */
function pickFreeRole(ctx: any, code: string, teamId: bigint): string[] {
  const taken = new Set(
    playersIn(ctx, code)
      .filter((p: any) => p.team_id === teamId)
      .flatMap((p: any) => p.roles)
  );
  for (const r of squadRolesOf(ctx, code)) if (!taken.has(r)) return [r];
  return [];
}

function newTeam(ctx: any, code: string): any {
  const r = ctx.db.room.code.find(code);
  const id = BigInt(r.next_team_id);
  r.next_team_id += 1;
  ctx.db.room.code.update(r);
  const colorIdx = teamsIn(ctx, code).length;
  return ctx.db.team.insert({
    id: 0n,
    code,
    name: `Team ${id}`,
    color: TEAM_COLORS[colorIdx % TEAM_COLORS.length],
    host_id: undefined,
    finish_ms: undefined,
  });
}

/* ---------------------------------- lifecycle ---------------------------------- */

export const init = spacetimedb.init((ctx) => {
  ctx.db.cleanup_timer.insert({ scheduled_id: 0n, scheduled_at: ScheduleAt.interval(CLEANUP_INTERVAL_MICROS) });
});

export const clientConnected = spacetimedb.clientConnected((ctx) => {
  if (ctx.connectionId) {
    ctx.db.conn.insert({ connection_id: ctx.connectionId, identity: ctx.sender });
  }
});

export const clientDisconnected = spacetimedb.clientDisconnected((ctx) => {
  const micros = nowMicros(ctx);
  if (ctx.connectionId) ctx.db.conn.connection_id.delete(ctx.connectionId);
  // only drop the player when its last connection is gone
  if ([...ctx.db.conn.identity.filter(ctx.sender)].length === 0) {
    removePlayer(ctx, ctx.sender, micros);
  }
});

/* ---------------------------------- room lifecycle reducers ---------------------------------- */

export const joinRoom = spacetimedb.reducer(
  { code: t.string(), name: t.string(), solo: t.bool() },
  (ctx, { code: rawCode, name, solo }) => {
    const micros = nowMicros(ctx);
    const code = normCode(rawCode);
    if (code.length < 3) return;
    const r = getOrCreateRoom(ctx, code, micros);

    const existing = ctx.db.player.identity.find(ctx.sender);
    const displayName = name.trim().slice(0, 16) || 'Player';
    if (existing) {
      existing.name = displayName;
      existing.last_seen_micros = micros;
      if (solo && !existing.solo) {
        existing.solo = true;
        existing.ready = true;
        existing.roles = [...squadRolesOf(ctx, code)];
      }
      ctx.db.player.identity.update(existing);
      return;
    }

    let tm: any;
    let roles: string[] = [];
    let ready = false;
    if (solo) {
      tm = newTeam(ctx, code);
      roles = [...squadRolesOf(ctx, code)];
      ready = true;
    } else {
      // join the team with the most free slots but at least one person, else new team
      const cap = squadSizeOf(ctx, code);
      const counts = new Map<bigint, number>();
      for (const p of playersIn(ctx, code)) counts.set(p.team_id, (counts.get(p.team_id) ?? 0) + 1);
      const candidates = teamsIn(ctx, code)
        .filter((tm: any) => (counts.get(tm.id) ?? 0) < cap)
        .sort((a: any, b: any) => (counts.get(a.id) ?? 0) - (counts.get(b.id) ?? 0));
      tm = candidates.length > 0 ? candidates[candidates.length - 1] : newTeam(ctx, code);
      roles = pickFreeRole(ctx, code, tm.id);
    }
    const seq = r.next_player_seq;
    r.next_player_seq += 1n;
    ctx.db.room.code.update(r);
    ctx.db.player.insert({
      identity: ctx.sender,
      code,
      name: displayName,
      team_id: tm.id,
      roles,
      ready,
      solo,
      joined_seq: seq,
      last_seen_micros: micros,
    });
    fixHosts(ctx, code);
    touchRoom(ctx, r, micros);
  }
);

/** Periodic presence ping (also recovers the player row after an unclean reconnect). */
export const heartbeat = spacetimedb.reducer((ctx) => {
  const micros = nowMicros(ctx);
  const p = ctx.db.player.identity.find(ctx.sender);
  if (p) {
    p.last_seen_micros = micros;
    ctx.db.player.identity.update(p);
    const r = ctx.db.room.code.find(p.code);
    if (r) touchRoom(ctx, r, micros);
  }
});

export const leaveRoom = spacetimedb.reducer((ctx) => {
  removePlayer(ctx, ctx.sender, nowMicros(ctx));
});

export const setRole = spacetimedb.reducer({ role: t.string() }, (ctx, { role }) => {
  if (!ROLES.has(role)) return;
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return;
  const room = ctx.db.room.code.find(p.code);
  if (!room || room.phase !== 'lobby') return;
  // only the current squad's roles (plus legacy head/arms which map onto torso-cam/shared hands)
  if (!squadRolesOf(ctx, p.code).includes(role) && role !== 'head' && role !== 'arms') return;
  const micros = nowMicros(ctx);
  if (p.roles.includes(role)) {
    p.roles = p.roles.filter((x: string) => x !== role);
  } else {
    // steal the role from a teammate if taken
    for (const other of playersIn(ctx, p.code)) {
      if (other.team_id === p.team_id && !other.identity.equals(ctx.sender)) {
        other.roles = other.roles.filter((x: string) => x !== role);
        ctx.db.player.identity.update(other);
      }
    }
    p.roles = [...p.roles, role];
  }
  ctx.db.player.identity.update(p);
  touchRoom(ctx, ctx.db.room.code.find(p.code), micros);
});

export const joinTeam = spacetimedb.reducer({ teamId: t.u64() }, (ctx, { teamId }) => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return;
  const room = ctx.db.room.code.find(p.code);
  if (!room || room.phase !== 'lobby') return;
  const micros = nowMicros(ctx);
  const tm = ctx.db.team.id.find(teamId);
  if (!tm || tm.code !== p.code) return;
  if (tm.id !== p.team_id) {
    const members = playersIn(ctx, p.code).filter((x: any) => x.team_id === tm.id);
    if (members.length >= squadSizeOf(ctx, p.code)) return;
    p.team_id = tm.id;
    const taken = new Set(members.filter((x: any) => !x.identity.equals(ctx.sender)).flatMap((x: any) => x.roles));
    p.roles = p.roles.filter((r: string) => !taken.has(r));
    if (p.roles.length === 0) p.roles = pickFreeRole(ctx, p.code, tm.id);
    p.ready = false;
    ctx.db.player.identity.update(p);
    fixHosts(ctx, p.code);
  }
  touchRoom(ctx, ctx.db.room.code.find(p.code), micros);
});

export const createTeam = spacetimedb.reducer((ctx) => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return;
  const room = ctx.db.room.code.find(p.code);
  if (!room || room.phase !== 'lobby') return;
  const micros = nowMicros(ctx);
  const tm = newTeam(ctx, p.code);
  p.team_id = tm.id;
  p.roles = p.solo ? [...squadRolesOf(ctx, p.code)] : pickFreeRole(ctx, p.code, tm.id);
  p.ready = p.solo;
  ctx.db.player.identity.update(p);
  fixHosts(ctx, p.code);
  touchRoom(ctx, ctx.db.room.code.find(p.code), micros);
});

export const setReady = spacetimedb.reducer({ ready: t.bool() }, (ctx, { ready }) => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return;
  const room = ctx.db.room.code.find(p.code);
  if (!room || room.phase !== 'lobby') return;
  p.ready = ready;
  ctx.db.player.identity.update(p);
  touchRoom(ctx, ctx.db.room.code.find(p.code), nowMicros(ctx));
});

export const setChallenge = spacetimedb.reducer({ challengeId: t.string() }, (ctx, { challengeId }) => {
  if (!CHALLENGE_IDS.has(challengeId)) return;
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return;
  const r = ctx.db.room.code.find(p.code);
  const leader = leaderOf(ctx, p.code);
  if (!r || r.phase !== 'lobby' || !leader || !leader.identity.equals(ctx.sender)) return;
  r.challenge_id = challengeId;
  for (const other of playersIn(ctx, p.code)) {
    other.ready = false;
    ctx.db.player.identity.update(other);
  }
  ctx.db.room.code.update(r);
  touchRoom(ctx, r, nowMicros(ctx));
});

/** Leader-only squad switch (3 or 5 players). Clears role picks; everyone re-picks. */
export const setSquad = spacetimedb.reducer({ size: t.u8() }, (ctx, { size }) => {
  if (size !== 3 && size !== 5) return;
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return;
  const r = ctx.db.room.code.find(p.code);
  const leader = leaderOf(ctx, p.code);
  if (!r || r.phase !== 'lobby' || !leader || !leader.identity.equals(ctx.sender)) return;
  const cur = ctx.db.squad.code.find(p.code);
  if (cur && cur.size === size) return;
  if (cur) {
    cur.size = size;
    ctx.db.squad.code.update(cur);
  } else {
    ctx.db.squad.insert({ code: p.code, size });
  }
  const roles = size === 3 ? SQUAD_3 : SQUAD_5;
  for (const tm of teamsIn(ctx, p.code)) {
    const members = playersIn(ctx, p.code).filter((m: any) => m.team_id === tm.id);
    let first = true;
    for (const m of members) {
      m.roles = first ? [roles[0]] : [];
      m.ready = false;
      ctx.db.player.identity.update(m);
      first = false;
    }
  }
  touchRoom(ctx, r, nowMicros(ctx));
});

export const startRound = spacetimedb.reducer({ force: t.bool() }, (ctx, { force }) => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return;
  const r = ctx.db.room.code.find(p.code);
  const leader = leaderOf(ctx, p.code);
  if (!r || !leader || !leader.identity.equals(ctx.sender)) return;
  if (r.phase === 'countdown' || r.phase === 'playing') return;
  const members = playersIn(ctx, p.code);
  if (!force && members.some((m: any) => !m.ready)) return;

  // auto-assign uncovered roles per team round-robin
  for (const tm of teamsIn(ctx, p.code)) {
    const teamMembers = members
      .filter((m: any) => m.team_id === tm.id)
      .sort((a: any, b: any) => (a.joined_seq < b.joined_seq ? -1 : a.joined_seq > b.joined_seq ? 1 : 0));
    if (teamMembers.length === 0) continue;
    const taken = new Set(teamMembers.flatMap((m: any) => m.roles));
    for (const role of squadRolesOf(ctx, p.code)) {
      if (taken.has(role)) continue;
      const target = [...teamMembers].sort((a: any, b: any) => a.roles.length - b.roles.length)[0];
      target.roles = [...target.roles, role];
      ctx.db.player.identity.update(target);
    }
    tm.finish_ms = undefined;
    ctx.db.team.id.update(tm);
  }

  const micros = nowMicros(ctx);
  const startAt = micros + COUNTDOWN_MICROS;
  // cancel stale timers from previous rounds
  for (const rt of [...ctx.db.round_timer.iter()]) {
    if (rt.code === p.code) ctx.db.round_timer.scheduled_id.delete(rt.scheduled_id);
  }
  r.round += 1;
  r.phase = 'countdown';
  r.start_at_micros = startAt;
  ctx.db.room.code.update(r);
  ctx.db.round_timer.insert({ scheduled_id: 0n, scheduled_at: ScheduleAt.time(startAt), code: p.code, round: r.round, kind: 'start' });
  touchRoom(ctx, r, micros);
});

/** Called by a team's host when its body reaches the objective. */
export const finishRun = spacetimedb.reducer({ timeMs: t.u64() }, (ctx, { timeMs }) => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return;
  const r = ctx.db.room.code.find(p.code);
  if (!r || r.phase !== 'playing') return;
  const tm = ctx.db.team.id.find(p.team_id);
  if (!tm || tm.host_id == null || !tm.host_id.equals(ctx.sender) || tm.finish_ms != null) return;
  const micros = nowMicros(ctx);
  tm.finish_ms = timeMs;
  ctx.db.team.id.update(tm);

  // leaderboard entry (server-side, replaces the old /api/leaderboard POST)
  ctx.db.score.insert({
    id: 0n,
    challenge_id: r.challenge_id,
    team_name: tm.name,
    players: playersIn(ctx, p.code)
      .filter((m: any) => m.team_id === tm.id)
      .map((m: any) => m.name),
    time_ms: timeMs,
    created_at: ctx.timestamp,
  });

  const active = teamsIn(ctx, p.code);
  if (active.every((x: any) => x.finish_ms != null)) {
    r.phase = 'results';
    ctx.db.room.code.update(r);
  } else {
    const hasGrace = [...ctx.db.round_timer.iter()].some((rt: any) => rt.code === p.code && rt.kind === 'grace');
    if (!hasGrace) {
      ctx.db.round_timer.insert({
        scheduled_id: 0n,
        scheduled_at: ScheduleAt.time(micros + GRACE_MICROS),
        code: p.code,
        round: r.round,
        kind: 'grace',
      });
    }
  }
  touchRoom(ctx, r, micros);
});

export const backToLobby = spacetimedb.reducer((ctx) => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return;
  const r = ctx.db.room.code.find(p.code);
  const leader = leaderOf(ctx, p.code);
  if (!r || !leader || !leader.identity.equals(ctx.sender)) return;
  for (const rt of [...ctx.db.round_timer.iter()]) {
    if (rt.code === p.code) ctx.db.round_timer.scheduled_id.delete(rt.scheduled_id);
  }
  r.phase = 'lobby';
  r.start_at_micros = 0n;
  ctx.db.room.code.update(r);
  for (const other of playersIn(ctx, p.code)) {
    other.ready = false;
    ctx.db.player.identity.update(other);
  }
  for (const tm of teamsIn(ctx, p.code)) {
    tm.finish_ms = undefined;
    ctx.db.team.id.update(tm);
  }
  touchRoom(ctx, r, nowMicros(ctx));
});

/* ---------------------------------- gameplay relay reducers ---------------------------------- */

export const sendInput = spacetimedb.reducer(
  { roles: t.array(t.string()), inputs: t.array(RoleInput) },
  (ctx, { roles, inputs }) => {
    if (roles.length !== inputs.length || roles.length === 0) return;
    if (!roles.every((x) => ROLES.has(x))) return;
    const p = ctx.db.player.identity.find(ctx.sender);
    if (!p) return;
    const assigned = new Set(p.roles);
    if (!roles.every((role) => assigned.has(role))) return;
    const tm = ctx.db.team.id.find(p.team_id);
    if (!tm) return;
    // the host applies its own inputs locally
    if (tm.host_id != null && tm.host_id.equals(ctx.sender)) return;
    const existing = ctx.db.input.identity.find(ctx.sender);
    if (existing) {
      existing.roles = roles;
      existing.inputs = inputs;
      ctx.db.input.identity.update(existing);
    } else {
      ctx.db.input.insert({ identity: ctx.sender, code: p.code, team_id: tm.id, roles, inputs });
    }
  }
);

export const publishSnapshot = spacetimedb.reducer(
  {
    p: t.array(t.f32()),
    props: t.array(t.f32()),
    yaw: t.f32(),
    pitch: t.f32(),
    timer: t.f32(),
    fallen: t.bool(),
    score: t.u32(),
    ev: t.string(),
    msg: t.option(t.string()),
  },
  (ctx, args) => {
    const p = ctx.db.player.identity.find(ctx.sender);
    if (!p) return;
    const tm = ctx.db.team.id.find(p.team_id);
    if (!tm || tm.host_id == null || !tm.host_id.equals(ctx.sender)) return;
    const existing = ctx.db.snapshot.team_id.find(tm.id);
    if (existing) {
      existing.recv_micros = nowMicros(ctx);
      existing.p = args.p;
      existing.props = args.props;
      existing.yaw = args.yaw;
      existing.pitch = args.pitch;
      existing.timer = args.timer;
      existing.fallen = args.fallen;
      existing.score = args.score;
      existing.ev = args.ev;
      existing.msg = args.msg;
      ctx.db.snapshot.team_id.update(existing);
    } else {
      ctx.db.snapshot.insert({
        team_id: tm.id,
        code: p.code,
        recv_micros: nowMicros(ctx),
        p: args.p,
        props: args.props,
        yaw: args.yaw,
        pitch: args.pitch,
        timer: args.timer,
        fallen: args.fallen,
        score: args.score,
        ev: args.ev,
        msg: args.msg,
      });
    }
  }
);

/* ---------------------------------- scheduled reducers ---------------------------------- */

export const onRoundTimer = spacetimedb.reducer({ timer: round_timer.rowType }, (ctx, { timer }) => {
  const r = ctx.db.room.code.find(timer.code);
  if (!r || r.round !== timer.round) return;
  if (timer.kind === 'start' && r.phase === 'countdown') {
    r.phase = 'playing';
    ctx.db.room.code.update(r);
  } else if (timer.kind === 'grace' && r.phase === 'playing') {
    r.phase = 'results';
    ctx.db.room.code.update(r);
  }
  touchRoom(ctx, r, nowMicros(ctx));
});

export const onCleanup = spacetimedb.reducer({ _timer: cleanup_timer.rowType }, (ctx) => {
  const micros = nowMicros(ctx);
  for (const p of [...ctx.db.player.iter()]) {
    if (micros - p.last_seen_micros > STALE_MICROS) removePlayer(ctx, p.identity, micros);
  }
});
