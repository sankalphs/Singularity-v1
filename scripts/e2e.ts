/*
 * End-to-end test for the SINGULARITY SpacetimeDB module.
 * Simulates two players joining a room, readying up, starting a round,
 * relaying inputs/snapshots, finishing, and cleaning up on disconnect.
 *
 * Usage:
 *   npx esbuild scripts/e2e.ts --bundle --platform=node --format=esm --outfile=scripts/e2e.mjs --external:ws
 *   node scripts/e2e.mjs
 */
import { DbConnection, type EventContext } from "../src/module_bindings/index.js";

const URI = process.env.STDB_URI ?? "ws://127.0.0.1:3007";
const DB = process.env.STDB_DB ?? "singularity2";
const CODE = "TEST";

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Client {
  conn: DbConnection;
  hex: string;
  snapshots: number;
  inputRows: number;
}

function connect(name: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const c: Partial<Client> = {};
    const timeout = setTimeout(() => reject(new Error(`connect timeout: ${name}`)), 15_000);
    DbConnection.builder()
      .withUri(URI)
      .withDatabaseName(DB)
      .onConnect((conn, identity) => {
        c.conn = conn;
        c.hex = identity.toHexString();
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
const scoresOf = (c: Client) => rows(c.conn.db.score.iter());

async function main() {
  console.log(`E2E against ${URI} / ${DB}`);
  const alice = await connect("Alice");
  const bob = await connect("Bob");

  alice.conn.reducers.joinRoom({ code: CODE, name: "Alice", solo: false });
  await sleep(700);
  bob.conn.reducers.joinRoom({ code: CODE, name: "Bob", solo: false });
  await sleep(1000);

  const room = roomOf(alice);
  check("room created with lobby phase", !!room && room.phase === "lobby", room?.phase);
  check("two players joined", playersOf(alice).length === 2);
  check("one team created", teamsOf(alice).length === 1);
  const team = teamsOf(alice)[0];
  check("team host assigned", !!team && !!team.hostId, team?.hostId?.toHexString().slice(0, 8));
  const roles = playersOf(alice).flatMap((p) => p.roles).sort();
  check("roles auto-assigned", roles.join(",") === "lhand,rhand", roles.join(","));
  check("alice is earliest -> host & leader", !!team && team.hostId?.toHexString() === alice.hex && roomOf(alice)?.nextPlayerSeq === 2n);

  alice.conn.reducers.setReady({ ready: true });
  bob.conn.reducers.setReady({ ready: true });
  await sleep(400);
  alice.conn.reducers.startRound({ force: false });
  await sleep(500);
  const cd = roomOf(alice);
  check("phase countdown after start", cd?.phase === "countdown", cd?.phase);
  check("startAt scheduled", (cd?.startAtMicros ?? 0n) > 0n);

  // Bob (non-host) relays inputs; Alice (host) publishes a snapshot
  const bobRole = playersOf(alice).find((p) => p.identity.toHexString() === bob.hex)?.roles[0];
  check("bob owns an input role", bobRole === "lhand" || bobRole === "rhand", bobRole);
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
  bob.conn.reducers.sendInput({
    roles: ["torso"],
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

  alice.conn.reducers.finishRun({ timeMs: 65432n });
  await sleep(800);
  const teamAfter = teamsOf(alice)[0];
  check("team finish time recorded", teamAfter?.finishMs === 65432n, String(teamAfter?.finishMs));
  check("leaderboard score inserted", scoresOf(alice).some((s) => s.teamName === "Team 1" && s.timeMs === 65432n && s.challengeId === "wobble-run"));
  check("single team finish -> results", roomOf(alice)?.phase === "results", roomOf(alice)?.phase);

  alice.conn.reducers.backToLobby({});
  await sleep(500);
  check("back to lobby", roomOf(alice)?.phase === "lobby", roomOf(alice)?.phase);

  // disconnect cleanup: players + room should disappear when the last connection drops
  alice.conn.disconnect();
  bob.conn.disconnect();
  await sleep(1500);
  const charlie = await connect("Charlie");
  await sleep(500);
  check("room cleaned up after everyone left", roomOf(charlie) === undefined);
  check("players cleaned up after everyone left", playersOf(charlie).length === 0);
  charlie.conn.disconnect();

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
