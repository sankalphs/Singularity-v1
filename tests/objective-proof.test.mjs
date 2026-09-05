import assert from "node:assert/strict";
import test from "node:test";
import { snapshotMatchesObjective } from "../server/src/objective-proof.ts";

const body = (x, y, z) => [x, y, z, 0, 0, 0, 1];
const prop = (id, x, y, z) => [id, x, y, z, 0, 0, 0, 1];
const proof = (overrides = {}) => ({ p: body(0, 1, 0), props: [], fallen: false, score: 0, ...overrides });

test("each challenge accepts a snapshot at its real completion target", () => {
  assert.equal(snapshotMatchesObjective("wobble-run", proof({ p: body(0, 1.5, -64) })), true);
  assert.equal(snapshotMatchesObjective("ferry-job", proof({ props: prop(0, 0, 1.2, -37.5) })), true);
  assert.equal(
    snapshotMatchesObjective("summit-sync", proof({ p: body(0, 1.5, -60), props: prop(0, 0, 1.2, -46.5) })),
    true
  );
  assert.equal(snapshotMatchesObjective("egg-express", proof({ props: prop(0, 0, 1.2, -40) })), true);
  assert.equal(snapshotMatchesObjective("slam-dunk", proof({ score: 3 })), true);
});

test("incomplete, fallen, malformed, and unknown objective proofs are rejected", () => {
  assert.equal(snapshotMatchesObjective("wobble-run", proof({ p: body(0, 1.5, -64), fallen: true })), false);
  assert.equal(snapshotMatchesObjective("summit-sync", proof({ p: body(0, 1.5, -60) })), false);
  assert.equal(snapshotMatchesObjective("egg-express", proof({ props: [0, Number.NaN, 1.2, -40, 0, 0, 0, 1] })), false);
  assert.equal(snapshotMatchesObjective("slam-dunk", proof({ score: 2 })), false);
  assert.equal(snapshotMatchesObjective("not-a-challenge", proof()), false);
});
