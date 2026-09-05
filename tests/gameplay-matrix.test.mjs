import assert from "node:assert/strict";
import test from "node:test";

import { LEVELS } from "../src/game/levels.ts";
import {
  CHALLENGES,
  ROLES_3,
  ROLES_5,
  emptyInput,
  squadRoles,
} from "../src/game/types.ts";
import { makeSquadMixState, resolvePhysInputs } from "../src/game/squad.ts";

const input = (overrides = {}) => ({ ...emptyInput(), ...overrides });

test("all five challenges expose their original objective and completion path", () => {
  assert.deepEqual(
    CHALLENGES.map(({ id }) => id),
    ["wobble-run", "ferry-job", "summit-sync", "egg-express", "slam-dunk"],
  );

  for (const challenge of CHALLENGES) {
    const level = LEVELS[challenge.id];
    assert.ok(level, `${challenge.id} level exists`);
    assert.ok(level.objective.length > 0, `${challenge.id} keeps an objective`);
    assert.ok(
      level.finish || level.deliver || (level.hoop && level.targetScore),
      `${challenge.id} keeps a completion predicate`,
    );
  }

  assert.ok(LEVELS["wobble-run"].finish);
  assert.ok(LEVELS["ferry-job"].deliver);
  assert.equal(LEVELS["summit-sync"].requireDeliverThenFinish, true);
  assert.equal(LEVELS["egg-express"].props[0].fragile, true);
  assert.equal(LEVELS["slam-dunk"].targetScore, 3);
});

test("every challenge is a complete, distinct playable course", () => {
  for (const challenge of CHALLENGES) {
    const level = LEVELS[challenge.id];
    assert.ok(level.statics.length >= 6, `${challenge.id} has a real obstacle layout`);
    assert.ok(level.sky, `${challenge.id} has its own sky treatment`);
    assert.ok(level.water, `${challenge.id} has its own water treatment`);
    assert.ok(Number.isFinite(level.killY), `${challenge.id} defines a reset plane`);
  }

  for (const id of ["wobble-run", "ferry-job", "summit-sync", "egg-express", "slam-dunk"]) {
    assert.ok(LEVELS[id].statics.some((part) => part.slide), `${id} includes a moving co-op obstacle`);
  }

  assert.ok(LEVELS["wobble-run"].checkpoints.length >= 4, "race course saves progress between sections");
  assert.ok(LEVELS["egg-express"].statics.some((part) => part.kind === "ferry"), "egg route has a ferry transfer");
  assert.equal(LEVELS["slam-dunk"].props.filter((prop) => prop.scoring).length, 5, "basketball course has spare balls");
});

test("normal lobby roles remain strict for 3P and 5P", () => {
  assert.deepEqual(squadRoles(3), ROLES_3);
  assert.deepEqual(squadRoles(5), ROLES_5);
  assert.deepEqual([...ROLES_3], ["arms", "torso", "legs"]);
  assert.deepEqual([...ROLES_5], ["lhand", "rhand", "torso", "lleg", "rleg"]);
  assert.ok(!ROLES_3.includes("head"));
  assert.ok(!ROLES_5.includes("head"));
});

test("every 3P role controls only its intended physics channel", () => {
  const state = makeSquadMixState();
  const result = resolvePhysInputs(
    {
      arms: input({ f: 0.7, s: -0.4, a: true, q: true }),
      torso: input({ f: -0.6, s: 0.5, a: true, b: true, lx: 1.2, ly: -0.3 }),
      legs: input({ f: 1, s: 0.25, a: true }),
    },
    3,
    0.31,
    state,
  );

  assert.deepEqual(
    { f: result.arms.f, s: result.arms.s, a: result.arms.a, q: result.arms.q },
    { f: 0.7, s: -0.4, a: true, q: true },
  );
  assert.deepEqual(
    { f: result.torso.f, s: result.torso.s, a: result.torso.a, b: result.torso.b },
    { f: -0.6, s: 0.5, a: true, b: true },
  );
  assert.equal(result.head.lx, 1.2, "torso owns heading");
  assert.equal(result.head.ly, -0.3, "torso owns camera pitch");
  assert.equal(result.lleg.a, true);
  assert.equal(result.rleg.a, true);
  assert.notEqual(Math.abs(result.lleg.f) > 0, Math.abs(result.rleg.f) > 0, "3P legs auto-alternate");
});

test("every 5P role remains independent and paired actions require agreement", () => {
  const base = {
    lhand: input({ f: 1, s: -1, a: true, b: true, q: true }),
    rhand: input({ f: 0, s: 1, a: false, b: false, e: true }),
    torso: input({ f: 0.4, s: -0.2, lx: 0.8, ly: 0.1 }),
    lleg: input({ f: 1, s: -0.3, a: true }),
    rleg: input({ f: -1, s: 0.4, a: false }),
  };
  const split = resolvePhysInputs(base, 5, 1 / 60, makeSquadMixState());

  assert.equal(split.arms.f, 0.5, "hand movement is averaged");
  assert.equal(split.arms.s, 0, "opposed hand swing cancels");
  assert.equal(split.arms.a, false, "one Space cannot two-hand grab");
  assert.equal(split.arms.b, false, "one Shift cannot throw");
  assert.equal(split.arms.q, true, "left player alone owns Q grab");
  assert.equal(split.arms.e, true, "right player alone owns E grab");
  assert.deepEqual(
    { f: split.torso.f, s: split.torso.s, lx: split.torso.lx },
    { f: 0.4, s: -0.2, lx: 0.8 },
  );
  assert.deepEqual({ f: split.lleg.f, s: split.lleg.s, a: split.lleg.a }, { f: 1, s: -0.3, a: true });
  assert.deepEqual({ f: split.rleg.f, s: split.rleg.s, a: split.rleg.a }, { f: -1, s: 0.4, a: false });

  const together = resolvePhysInputs(
    {
      ...base,
      rhand: input({ f: 1, s: -1, a: true, b: true, e: true }),
    },
    5,
    1 / 60,
    makeSquadMixState(),
  );
  assert.equal(together.arms.a, true);
  assert.equal(together.arms.b, true);
});
