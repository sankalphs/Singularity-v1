/*
 * End-to-end test for the SINGULARITY SpacetimeDB module.
 * Simulates a complete three-player squad joining, readying up, starting a round,
 * relaying inputs/snapshots, recording a server-timed bounded leaderboard run,
 * and cleaning up on disconnect.
 *
 * Usage:
 *   npx esbuild scripts/e2e.ts --bundle --platform=node --format=esm --outfile=scripts/e2e.mjs --external:ws
 *   node scripts/e2e.mjs
 */
import { DbConnection, type EventContext } from "../src/module_bindings/index.js";

const URI = process.env.STDB_URI ?? "ws://127.0.0.1:3007";
const DB = process.env.STDB_DB ?? "singularity2-sankalphs";
const RUN_MARKER = `${Date.now().toString(36).slice(-6)}${process.pid.toString(36).slice(-3)}${Math.random()
  .toString(36)
  .slice(2, 5)}`.toUpperCase();
const CODE = (process.env.STDB_CODE ?? `T${RUN_MARKER}`).toUpperCase().slice(-8);
const ALICE_NAME = `A-${RUN_MARKER}`;
const BOB_NAME = `B-${RUN_MARKER}`;
const CAROL_NAME = `C-${RUN_MARKER}`;
const PRACTICE_NAME = `P-${RUN_MARKER}`;
const LATE_HOST_NAME = `L1-${RUN_MARKER}`;
const LATE_TWO_NAME = `L2-${RUN_MARKER}`;
const LATE_THREE_NAME = `L3-${RUN_MARKER}`;

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Client {
  conn: DbConnection;
  hex: string;
  token: string;
  snapshots: number;
  inputRows: number;
}

function connect(name: string, token?: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const c: Partial<Client> = {};
    const timeout = setTimeout(() => reject(new Error(`connect timeout: ${name}`)), 15_000);
    DbConnection.builder()
      .withUri(URI)
      .withDatabaseName(DB)
      .withToken(token)
      .onConnect((conn, identity, issuedToken) => {
        c.conn = conn;
        c.hex = identity.toHexString();
        c.token = issuedToken;
        c.snapshots = 0;
        c.inputRows = 0;
        conn.db.snapshot.onInsert(() => c.snapshots!++);
        conn.db.snapshot.onUpdate(() => c.snapshots!++);
        conn.db.input.onInsert(() => c.inputRows!++);
        conn.db.input.onUpdate(() => c.inputRows!++);
        conn.subscriptionBuilder()
          .onApplied(() => {
            clearTimeout(timeout);
            resolve(c as Client);
          })
          .subscribe([
            `SELECT * FROM room WHERE code = '${CODE}'`,
            `SELECT * FROM player WHERE code = '${CODE}'`,
            `SELECT * FROM team WHERE code = '${CODE}'`,
            `SELECT * FROM snapshot WHERE code = '${CODE}'`,
            `SELECT * FROM input WHERE code = '${CODE}'`,
            `SELECT * FROM leaderboard`,
            `SELECT * FROM score`,
          ]);
      })
      .onConnectError((_ctx: unknown, err: Error) => {
        clearTimeout(timeout);
        reject(err);
      })
      .build();
  });
}

const rows = <T,>(it: Iterable<T>): T[] => [...it];
const roomOf = (c: Client) => rows(c.conn.db.room.iter()).find((r) => r.code === CODE);
const playersOf = (c: Client) => rows(c.conn.db.player.iter()).filter((p) => p.code === CODE);
const teamsOf = (c: Client) => rows(c.conn.db.team.iter()).filter((t) => t.code === CODE);
const leaderboardOf = (c: Client) => rows(c.conn.db.leaderboard.iter());
const scoresOf = (c: Client) => rows(c.conn.db.score.iter());

async function main() {
  console.log(`E2E against ${URI} / ${DB}`);
  let alice = await connect(ALICE_NAME);
  const bob = await connect(BOB_NAME);
  const carol = await connect(CAROL_NAME);

  alice.conn.reducers.joinRoom({ code: CODE, name: ALICE_NAME, solo: false });
  await sleep(700);
  alice.conn.reducers.setSquad({ size: 3 });
  await sleep(300);
  bob.conn.reducers.joinRoom({ code: CODE, name: BOB_NAME, solo: false });
  await sleep(300);
  carol.conn.reducers.joinRoom({ code: CODE, name: CAROL_NAME, solo: false });
  await sleep(1000);

  const room = roomOf(alice);
  check("room created with lobby phase", !!room && room.phase === "lobby", room?.phase);
  check("complete three-player squad joined", playersOf(alice).length === 3);
  check("one team created", teamsOf(alice).length === 1);
  const team = teamsOf(alice)[0];
  check("team host assigned", !!team && !!team.hostId, team?.hostId?.toHexString().slice(0, 8));
  const roles = playersOf(alice).flatMap((p) => p.roles).sort();
  check("3P roles auto-assigned", roles.join(",") === "arms,legs,torso", roles.join(","));
  check("alice is earliest -> host & leader", !!team && team.hostId?.toHexString() === alice.hex && roomOf(alice)?.nextPlayerSeq === 3n);

  alice.conn.reducers.setReady({ ready: true });
  bob.conn.reducers.setReady({ ready: true });
  carol.conn.reducers.setReady({ ready: true });
  await sleep(400);
  alice.conn.reducers.startRound({ force: false });
  await sleep(500);
  const cd = roomOf(alice);
  check("phase countdown after start", cd?.phase === "countdown", cd?.phase);
  check("startAt scheduled", (cd?.startAtMicros ?? 0n) > 0n);

  // Bob (non-host) relays inputs; Alice (host) publishes a snapshot
  const bobRole = playersOf(alice).find((p) => p.identity.toHexString() === bob.hex)?.roles[0];
  check("bob owns a 3P input role", bobRole === "arms" || bobRole === "torso" || bobRole === "legs", bobRole);
  bob.conn.reducers.sendInput({
    roles: [bobRole!],
    inputs: [{ f: 1, s: 0, a: true, b: false, q: false, e: false, lx: 0.5, ly: 0.1 }],
  });
  alice.conn.reducers.publishSnapshot({
    p: new Array(77).fill(0.5),
    props: [0, 1, 2, 3, 4, 5, 6, 7],
    yaw: 0.1,
    pitch: 0.2,
    timer: 1.5,
    fallen: false,
    score: 0,
    ev: JSON.stringify([{ type: "shout", pos: [0, 1, 2] }]),
    msg: "good|CHECKPOINT!",
  });
  await sleep(900);
  const inputsSeenByAlice = rows(alice.conn.db.input.iter()).filter((i) => i.code === CODE);
  check("host received teammate input row", inputsSeenByAlice.length === 1 && inputsSeenByAlice[0].roles[0] === bobRole);
  const unauthorizedRole = (["arms", "torso", "legs"] as const).find((role) => role !== bobRole)!;
  bob.conn.reducers.sendInput({
    roles: [unauthorizedRole],
    inputs: [{ f: -1, s: 0, a: false, b: false, q: false, e: false, lx: 0, ly: 0 }],
  });
  await sleep(300);
  const afterUnauthorized = rows(alice.conn.db.input.iter()).find((i) => i.code === CODE && i.identity.toHexString() === bob.hex);
  check("unassigned role input rejected", afterUnauthorized?.roles[0] === bobRole, afterUnauthorized?.roles.join(","));
  check("bob received snapshot (row + callback)", bob.snapshots >= 1, `count=${bob.snapshots}`);
  // Note: the module broadcasts rows to all subscribers; the game's Net layer is
  // responsible for ignoring the host's own snapshot (which this raw client doesn't do).
  check("snapshot row visible to subscribers", alice.snapshots >= 1, `count=${alice.snapshots}`);

  // wait for the scheduled countdown transition (4.2s)
  await sleep(4500);
  check("phase playing after countdown", roomOf(alice)?.phase === "playing", roomOf(alice)?.phase);

  const originalAliceIdentity = alice.hex;
  const originalTeamId = team.id;
  const aliceToken = alice.token;
  alice.conn.disconnect();
  await sleep(700);
  alice = await connect(ALICE_NAME, aliceToken);
  alice.conn.reducers.joinRoom({ code: CODE, name: ALICE_NAME, solo: false });
  await sleep(900);
  const recoveredAlice = playersOf(alice).find((player) => player.identity.toHexString() === alice.hex);
  check("active-round reconnect preserves identity", alice.hex === originalAliceIdentity);
  check("active-round reconnect restores the original team", recoveredAlice?.teamId === originalTeamId);

  const forgedClientTime = 999_999_999n;
  const finishPose = new Array(77).fill(0.5);
  finishPose[0] = 0;
  finishPose[1] = 1.5;
  finishPose[2] = -64;
  alice.conn.reducers.publishSnapshot({
    p: finishPose,
    props: [],
    yaw: 0,
    pitch: 0,
    timer: 2,
    fallen: false,
    score: 0,
    ev: "[]",
    msg: undefined,
  });
  await sleep(100);
  alice.conn.reducers.finishRun({ timeMs: forgedClientTime });
  await sleep(800);
  const teamAfter = teamsOf(alice)[0];
  check(
    "server-authoritative finish time recorded",
    teamAfter?.finishMs != null && teamAfter.finishMs > 0n && teamAfter.finishMs !== forgedClientTime,
    String(teamAfter?.finishMs)
  );
  const boardAfter = leaderboardOf(alice).filter((row) => row.challengeId === "wobble-run" && row.squadSize === 3);
  const rankedRun = boardAfter.find((row) => row.players.includes(ALICE_NAME));
  const displacedByTenFaster =
    boardAfter.length === 10 && boardAfter.every((row) => row.timeMs <= teamAfter!.finishMs!);
  check(
    "qualifying 3P run is ranked unless ten faster times displace it",
    rankedRun?.timeMs === teamAfter?.finishMs || displacedByTenFaster,
    `rows=${boardAfter.length}`
  );
  check("leaderboard rows carry explicit squad size", boardAfter.every((row) => row.squadSize === 3));
  check(
    "ranked finish leaves the legacy score table read-only",
    !scoresOf(alice).some((row) => row.players.includes(ALICE_NAME))
  );
  const boardCounts = new Map<string, number>();
  for (const row of leaderboardOf(alice)) {
    const key = `${row.challengeId}/${row.squadSize}`;
    boardCounts.set(key, (boardCounts.get(key) ?? 0) + 1);
  }
  check("every challenge/squad leaderboard is capped at ten", [...boardCounts.values()].every((count) => count <= 10));
  check("single team finish -> results", roomOf(alice)?.phase === "results", roomOf(alice)?.phase);

  const rankedMarkerCount = leaderboardOf(alice).filter((row) => row.players.includes(ALICE_NAME)).length;
  // Bob became room leader/current host while Alice reconnected.
  bob.conn.reducers.backToLobby({});
  await sleep(500);
  check("back to lobby", roomOf(alice)?.phase === "lobby", roomOf(alice)?.phase);
  bob.conn.reducers.startRound({ force: true });
  await sleep(5_500);
  check("unverified round reached playing phase", roomOf(alice)?.phase === "playing", roomOf(alice)?.phase);
  bob.conn.reducers.finishRun({ timeMs: 1n });
  await sleep(600);
  check("unverified objective still records round finish", teamsOf(alice)[0]?.finishMs != null);
  check(
    "finish call without fresh objective proof is not ranked",
    leaderboardOf(alice).filter((row) => row.players.includes(ALICE_NAME)).length === rankedMarkerCount
  );
  bob.conn.reducers.backToLobby({});
  await sleep(500);

  // disconnect cleanup: players + room should disappear when the last connection drops
  alice.conn.disconnect();
  bob.conn.disconnect();
  carol.conn.disconnect();
  await sleep(1500);
  const observer = await connect("Observer");
  await sleep(500);
  check("room cleaned up after everyone left", roomOf(observer) === undefined);
  check("players cleaned up after everyone left", playersOf(observer).length === 0);
  check("global leaderboard survives room cleanup", leaderboardOf(observer).some((row) => row.challengeId === "wobble-run"));

  const practice = await connect(PRACTICE_NAME);
  practice.conn.reducers.joinRoom({ code: CODE, name: PRACTICE_NAME, solo: true });
  await sleep(600);
  practice.conn.reducers.startRound({ force: true });
  await sleep(5_500);
  check("solo practice reached playing phase", roomOf(practice)?.phase === "playing", roomOf(practice)?.phase);
  practice.conn.reducers.finishRun({ timeMs: 1n });
  await sleep(600);
  check("solo practice still records round finish", teamsOf(practice)[0]?.finishMs != null);
  check(
    "solo practice is excluded from global rankings",
    !leaderboardOf(observer).some((row) => row.players.includes(PRACTICE_NAME))
  );
  check(
    "solo practice leaves the legacy score table read-only",
    !scoresOf(observer).some((row) => row.players.includes(PRACTICE_NAME))
  );
  practice.conn.disconnect();

  await sleep(500);
  const lateHost = await connect(LATE_HOST_NAME);
  const lateTwo = await connect(LATE_TWO_NAME);
  const lateThree = await connect(LATE_THREE_NAME);
  lateHost.conn.reducers.joinRoom({ code: CODE, name: LATE_HOST_NAME, solo: false });
  await sleep(500);
  lateHost.conn.reducers.setSquad({ size: 3 });
  await sleep(300);
  lateHost.conn.reducers.startRound({ force: true });
  await sleep(300);
  lateTwo.conn.reducers.joinRoom({ code: CODE, name: LATE_TWO_NAME, solo: false });
  lateThree.conn.reducers.joinRoom({ code: CODE, name: LATE_THREE_NAME, solo: false });
  await sleep(5_000);
  check("late joiners can participate in the active round", playersOf(lateHost).length === 3);
  check("late-join round reached playing phase", roomOf(lateHost)?.phase === "playing", roomOf(lateHost)?.phase);
  lateHost.conn.reducers.finishRun({ timeMs: 1n });
  await sleep(600);
  check("late-join round still records its finish", teamsOf(lateHost)[0]?.finishMs != null);
  check(
    "late joiners cannot convert an incomplete start into a ranked run",
    !leaderboardOf(observer).some((row) => row.players.includes(LATE_HOST_NAME))
  );
  lateHost.conn.disconnect();
  lateTwo.conn.disconnect();
  lateThree.conn.disconnect();
  observer.conn.disconnect();

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
