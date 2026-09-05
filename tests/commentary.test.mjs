import assert from "node:assert/strict";
import test from "node:test";

import {
  COMMENTARY_CHALLENGE_IDS,
  CommentarySystem,
  createCommentarySystem,
} from "../src/game/commentary.ts";

const input = (overrides = {}) => ({
  f: 0,
  s: 0,
  a: false,
  b: false,
  q: false,
  e: false,
  lx: 0,
  ly: 0,
  ...overrides,
});

const frame = (overrides = {}) => ({
  timeMs: 0,
  challengeId: "wobble-run",
  running: true,
  finished: false,
  squadSize: 3,
  inputs: {},
  pelvisTilt: 0.08,
  grounded: true,
  fallen: false,
  hanging: false,
  holding: 0,
  verticalSpeed: 0,
  horizontalSpeed: 0,
  brace: 0,
  crouch: false,
  checkpoint: -1,
  score: 0,
  delivery: false,
  ...overrides,
});

function deterministicReplay() {
  const system = createCommentarySystem({ seed: "round-17" });
  const output = [];
  output.push(system.update(frame()));
  output.push(system.update(frame({
    timeMs: 100,
    pelvisTilt: 0.84,
    inputs: { torso: input({ f: 0.9 }) },
  })));
  output.push(system.update(frame({
    timeMs: 900,
    pelvisTilt: 0.82,
    inputs: { torso: input({ f: 0.8 }) },
  })));
  output.push(system.update(frame({ timeMs: 1_300, pelvisTilt: 0.2, brace: 1 })));
  output.push(system.update(frame({
    timeMs: 2_600,
    pelvisTilt: 1.18,
    fallen: true,
    inputs: { torso: input({ f: 1 }) },
  })));
  return output;
}

test("recorded frames replay byte-for-byte deterministically", () => {
  assert.deepEqual(deterministicReplay(), deterministicReplay());
  assert.ok(deterministicReplay().filter(Boolean).length >= 3);
});

test("global/category cooldowns suppress spam and consecutive text is deduplicated", () => {
  const system = new CommentarySystem({ seed: 4 });
  system.update(frame());

  const first = system.onObjectiveEvent({ type: "splash" }, frame({ timeMs: 100 }));
  const blocked = system.onObjectiveEvent({ type: "splash" }, frame({ timeMs: 200 }));
  const later = system.onObjectiveEvent({ type: "splash" }, frame({ timeMs: 1_100 }));

  assert.equal(first?.kind, "failure");
  assert.equal(blocked, null);
  assert.equal(later?.kind, "failure");
  assert.notEqual(later?.text, first?.text);
});

test("all five challenge-specific objective payoffs are covered", () => {
  assert.deepEqual(COMMENTARY_CHALLENGE_IDS, [
    "wobble-run",
    "ferry-job",
    "summit-sync",
    "egg-express",
    "slam-dunk",
  ]);

  const wobble = new CommentarySystem({ seed: 1 }).onObjectiveEvent(
    { type: "checkpoint", value: 0 },
    frame({ challengeId: "wobble-run", checkpoint: 0 }),
  );
  const ferry = new CommentarySystem({ seed: 1 }).onObjectiveEvent(
    { type: "delivery" },
    frame({ challengeId: "ferry-job", delivery: true }),
  );
  const summit = new CommentarySystem({ seed: 1 }).onObjectiveEvent(
    { type: "score", value: 0 },
    frame({ challengeId: "summit-sync" }),
  );
  const egg = new CommentarySystem({ seed: 1 }).onObjectiveEvent(
    { type: "crack" },
    frame({ challengeId: "egg-express" }),
  );
  const dunk = new CommentarySystem({ seed: 1 }).onObjectiveEvent(
    { type: "score", value: 1, target: 3 },
    frame({ challengeId: "slam-dunk", score: 1 }),
  );

  assert.match(wobble?.text ?? "", /Checkpoint|bridge/i);
  assert.match(ferry?.text ?? "", /Cargo|Ferry/i);
  assert.match(summit?.text ?? "", /Core|gate/i);
  assert.match(egg?.text ?? "", /egg|scrambled/i);
  assert.match(dunk?.text ?? "", /1\/3|Score|hoop/i);
  assert.deepEqual([wobble, ferry, summit, dunk].map((line) => line?.kind), [
    "completion",
    "completion",
    "completion",
    "completion",
  ]);
  assert.equal(egg?.kind, "failure");
});

test("three-player arms, torso, and legs each influence feedback", () => {
  const arms = new CommentarySystem({ seed: 2 });
  arms.update(frame());
  const armsLine = arms.update(frame({
    timeMs: 100,
    pelvisTilt: 0.61,
    inputs: { arms: input({ f: 1 }) },
  }));

  const torso = new CommentarySystem({ seed: 2 });
  torso.update(frame());
  const torsoLine = torso.update(frame({
    timeMs: 100,
    pelvisTilt: 0.82,
    inputs: { torso: input({ s: -1 }) },
  }));

  const legs = new CommentarySystem({ seed: 2 });
  legs.update(frame());
  const legsLine = legs.update(frame({
    timeMs: 100,
    pelvisTilt: 0.61,
    inputs: { legs: input({ f: 1 }) },
  }));

  assert.match(armsLine?.text ?? "", /hands|arms/i);
  assert.match(torsoLine?.text ?? "", /left|torso|balance|wobble/i);
  assert.match(legsLine?.text ?? "", /legs|step|torso/i);
});

test("five-player split hands, split legs, and torso each influence feedback", () => {
  const hands = new CommentarySystem({ seed: 3 });
  hands.update(frame({ squadSize: 5 }));
  const handsLine = hands.update(frame({
    timeMs: 100,
    squadSize: 5,
    inputs: {
      lhand: input({ a: true }),
      rhand: input({ a: false }),
    },
  }));

  const legs = new CommentarySystem({ seed: 3 });
  legs.update(frame({ squadSize: 5 }));
  const legsLine = legs.update(frame({
    timeMs: 100,
    squadSize: 5,
    inputs: {
      lleg: input({ f: 1 }),
      rleg: input({ f: 1 }),
    },
  }));

  const torso = new CommentarySystem({ seed: 3 });
  torso.update(frame({ squadSize: 5 }));
  const torsoLine = torso.update(frame({
    timeMs: 100,
    squadSize: 5,
    pelvisTilt: 0.82,
    inputs: { torso: input({ f: -1 }) },
  }));

  assert.match(handsLine?.text ?? "", /Both hands|One hand/i);
  assert.match(legsLine?.text ?? "", /Both legs|One leg/i);
  assert.match(torsoLine?.text ?? "", /back|torso|balance/i);
});

test("split-hand grab, throw, and movement mismatches are distinct", () => {
  const scenarios = [
    {
      inputs: { lhand: input({ a: true }), rhand: input() },
      holding: 0,
      expected: /grab|hand/i,
    },
    {
      inputs: { lhand: input({ b: true }), rhand: input() },
      holding: 1,
      expected: /throw|hands/i,
    },
    {
      inputs: { lhand: input({ s: -1 }), rhand: input({ s: 1 }) },
      holding: 0,
      expected: /directions|steering|swing/i,
    },
  ];

  for (const scenario of scenarios) {
    const system = new CommentarySystem({ seed: 9 });
    system.update(frame({ squadSize: 5 }));
    const line = system.update(frame({
      timeMs: 100,
      squadSize: 5,
      inputs: scenario.inputs,
      holding: scenario.holding,
    }));
    assert.equal(line?.kind, "coordination");
    assert.match(line?.text ?? "", scenario.expected);
  }
});

test("failure, near-fail, coordination, recovery, and completion are reachable", () => {
  const make = () => {
    const system = new CommentarySystem({ seed: 11 });
    system.update(frame());
    return system;
  };

  const failureSystem = make();
  const failure = failureSystem.onBodyEvent(
    { type: "fall" },
    frame({ timeMs: 100, fallen: true, pelvisTilt: 1.2 }),
  );

  const nearSystem = make();
  const near = nearSystem.update(frame({ timeMs: 100, pelvisTilt: 0.82 }));

  const coordinationSystem = make();
  const coordination = coordinationSystem.update(frame({
    timeMs: 100,
    squadSize: 5,
    inputs: { lhand: input({ a: true }), rhand: input() },
  }));

  const recoverySystem = make();
  const recovery = recoverySystem.onBodyEvent({ type: "getup" }, frame({ timeMs: 100 }));

  const completionSystem = make();
  const completion = completionSystem.onObjectiveEvent({ type: "finish" }, frame({ timeMs: 100 }));

  assert.deepEqual(
    [failure, near, coordination, recovery, completion].map((line) => line?.kind),
    ["failure", "near-fail", "coordination", "recovery", "completion"],
  );
});

test("each challenge opens with a concise anticipation cue", () => {
  for (const challengeId of COMMENTARY_CHALLENGE_IDS) {
    const system = new CommentarySystem({ seed: 15 });
    const line = system.onObjectiveEvent({ type: "start" }, frame({ challengeId }));
    assert.equal(line?.kind, "anticipation");
    assert.ok((line?.text.length ?? 0) < 80);
  }
});

test("falls explain recent torso, simultaneous-leg, and unstable-hand causes", () => {
  const torso = new CommentarySystem({ seed: 12 });
  torso.update(frame());
  const torsoFall = torso.update(frame({
    timeMs: 100,
    fallen: true,
    pelvisTilt: 1.2,
    inputs: { torso: input({ f: 1 }) },
  }));

  const legs = new CommentarySystem({ seed: 12 });
  legs.update(frame({ squadSize: 5 }));
  const legsFall = legs.update(frame({
    timeMs: 100,
    squadSize: 5,
    fallen: true,
    pelvisTilt: 1.2,
    inputs: { lleg: input({ f: 1 }), rleg: input({ f: 1 }) },
  }));

  const hands = new CommentarySystem({ seed: 12 });
  hands.update(frame());
  const handsFall = hands.update(frame({
    timeMs: 100,
    fallen: true,
    grounded: false,
    pelvisTilt: 1.2,
    inputs: { arms: input({ f: 1 }) },
  }));

  assert.match(torsoFall?.text ?? "", /torso|forward lean/i);
  assert.match(legsFall?.text ?? "", /Both legs|legs stepped/i);
  assert.match(handsFall?.text ?? "", /hands|wobbling/i);
});

test("near-fail hysteresis emits once, then rewards clutch stabilization", () => {
  const system = new CommentarySystem({ seed: 21 });
  system.update(frame());

  const danger = system.update(frame({ timeMs: 100, pelvisTilt: 0.8 }));
  const stillDanger = system.update(frame({ timeMs: 900, pelvisTilt: 0.79 }));
  const recovered = system.update(frame({ timeMs: 1_900, pelvisTilt: 0.25, brace: 1 }));

  assert.equal(danger?.kind, "near-fail");
  assert.equal(stillDanger, null);
  assert.equal(recovered?.kind, "recovery");
});

test("crouch context and an active brace shape stabilization feedback", () => {
  const crouchSystem = new CommentarySystem({ seed: 23 });
  crouchSystem.update(frame({ challengeId: "ferry-job" }));
  const crouchWarning = crouchSystem.update(frame({
    challengeId: "ferry-job",
    timeMs: 100,
    pelvisTilt: 0.82,
    holding: 2,
    crouch: true,
  }));
  assert.match(crouchWarning?.text ?? "", /Crouch|cargo|loaded/i);

  const braceSystem = new CommentarySystem({ seed: 23 });
  braceSystem.update(frame());
  braceSystem.update(frame({ timeMs: 100, pelvisTilt: 0.84 }));
  const braceRecovery = braceSystem.update(frame({ timeMs: 900, pelvisTilt: 0.62, brace: 1 }));
  assert.equal(braceRecovery?.kind, "recovery");
  assert.match(braceRecovery?.text ?? "", /Brace|control/i);
});

test("lost grips can become explicit regrab recoveries", () => {
  const system = new CommentarySystem({ seed: 25 });
  system.update(frame({ holding: 1 }));
  assert.equal(system.update(frame({ timeMs: 100, holding: 0 })), null);
  const regrab = system.update(frame({ timeMs: 850, holding: 1 }));
  assert.equal(regrab?.kind, "recovery");
  assert.match(regrab?.text ?? "", /Grip|Regrab|Caught/i);
});

test("generic action dispatch supports body and objective events", () => {
  const system = new CommentarySystem({ seed: 30, globalCooldownMs: 0, categoryCooldownMs: { recovery: 0, completion: 0 } });
  system.update(frame());
  const body = system.handle({ source: "body", event: { type: "getup" } }, frame({ timeMs: 100 }));
  const objective = system.handle({ source: "objective", event: { type: "finish" } }, frame({ timeMs: 101 }));
  assert.equal(body?.kind, "recovery");
  assert.equal(objective?.kind, "completion");
});

test("reset restores counters, cooldowns, latches, and deterministic variants", () => {
  const system = new CommentarySystem({ seed: "same-round" });
  const run = () => {
    system.update(frame());
    const near = system.update(frame({ timeMs: 100, pelvisTilt: 0.82 }));
    const recovery = system.update(frame({ timeMs: 1_400, pelvisTilt: 0.2 }));
    const finish = system.onObjectiveEvent({ type: "finish" }, frame({ timeMs: 2_400, finished: true, running: false }));
    return [near, recovery, finish];
  };

  const first = run();
  system.reset();
  const second = run();
  assert.deepEqual(second, first);
});

test("headless playtest covers every role on every challenge", async (t) => {
  const roles = [
    { role: "arms", squadSize: 3, tilt: 0.62, inputs: { arms: input({ f: 1 }) } },
    { role: "torso", squadSize: 3, tilt: 0.82, inputs: { torso: input({ f: 1 }) } },
    { role: "legs", squadSize: 3, tilt: 0.62, inputs: { legs: input({ f: 1 }) } },
    { role: "lhand", squadSize: 5, tilt: 0.62, inputs: { lhand: input({ f: 1 }) } },
    { role: "rhand", squadSize: 5, tilt: 0.62, inputs: { rhand: input({ f: 1 }) } },
    { role: "torso", squadSize: 5, tilt: 0.82, inputs: { torso: input({ s: 1 }) } },
    { role: "lleg", squadSize: 5, tilt: 0.3, inputs: { lleg: input({ f: 1 }), rleg: input({ f: 1 }) } },
    { role: "rleg", squadSize: 5, tilt: 0.3, inputs: { lleg: input({ f: 1 }), rleg: input({ f: 1 }) } },
  ];

  for (const challengeId of COMMENTARY_CHALLENGE_IDS) {
    for (const scenario of roles) {
      await t.test(`${challengeId} · ${scenario.squadSize}P ${scenario.role}`, () => {
        const system = new CommentarySystem({ seed: `${challengeId}:${scenario.squadSize}:${scenario.role}` });
        system.update(frame({ challengeId, squadSize: scenario.squadSize }));
        system.update(frame({
          challengeId,
          squadSize: scenario.squadSize,
          timeMs: 100,
          pelvisTilt: scenario.tilt,
          inputs: scenario.inputs,
        }));
        const failure = system.update(frame({
          challengeId,
          squadSize: scenario.squadSize,
          timeMs: 900,
          pelvisTilt: 1.2,
          fallen: true,
          inputs: scenario.inputs,
        }));
        const completion = system.onObjectiveEvent(
          { type: "finish" },
          frame({ challengeId, squadSize: scenario.squadSize, timeMs: 1_800, running: false, finished: true }),
        );
        assert.equal(failure?.kind, "failure");
        assert.equal(completion?.kind, "completion");
      });
    }
  }
});
