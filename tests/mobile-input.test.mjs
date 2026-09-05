import assert from "node:assert/strict";
import test from "node:test";
import { InputManager } from "../src/game/input.ts";

const assertClose = (actual, expected) => {
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${actual} to equal ${expected}`);
};

test("virtual movement is clamped and non-finite values reset to neutral", () => {
  const input = new InputManager();

  input.setVirtualMovement(2, -3);
  assert.deepEqual(
    { f: input.read("legs", true).f, s: input.read("legs", true).s },
    { f: 1, s: -1 },
  );

  input.setVirtualMovement(Number.POSITIVE_INFINITY, Number.NaN);
  assert.deepEqual(
    { f: input.read("legs", true).f, s: input.read("legs", true).s },
    { f: 0, s: 0 },
  );
});

test("virtual movement combines with keyboard axes without changing keyboard controls", () => {
  const input = new InputManager();
  input.keys.add("KeyW");
  input.keys.add("KeyA");
  input.setVirtualMovement(-0.25, 0.75);

  const mixed = input.read("torso", true);
  assertClose(mixed.f, 0.75);
  assertClose(mixed.s, -0.25);

  input.resetVirtualControls();
  const keyboardOnly = input.read("torso", true);
  assert.equal(keyboardOnly.f, 1);
  assert.equal(keyboardOnly.s, -1);
});

test("virtual actions are ORed with keyboard actions for the active role", () => {
  const input = new InputManager();
  input.keys.add("Space");
  input.keys.add("KeyQ");
  input.setVirtualAction("b", true);
  input.setVirtualAction("e", true);

  const active = input.read("arms", true);
  assert.deepEqual(
    { a: active.a, b: active.b, q: active.q, e: active.e },
    { a: true, b: true, q: true, e: true },
  );

  const inactive = input.read("arms", false);
  assert.deepEqual(
    { f: inactive.f, s: inactive.s, a: inactive.a, b: inactive.b, q: inactive.q, e: inactive.e },
    { f: 0, s: 0, a: false, b: false, q: false, e: false },
  );
});

test("virtual movement steers torso camera with the same signs and rates as WASD", () => {
  const keyboard = new InputManager();
  keyboard.keys.add("KeyW");
  keyboard.keys.add("KeyD");
  keyboard.tickHead(0.1, true);

  const virtual = new InputManager();
  virtual.setVirtualMovement(1, 1);
  virtual.tickHead(0.1, true);

  assertClose(virtual.yaw, keyboard.yaw);
  assertClose(virtual.pitch, keyboard.pitch);

  virtual.tickHead(1, false);
  assertClose(virtual.yaw, keyboard.yaw);
  assertClose(virtual.pitch, keyboard.pitch);
});

test("reset and detach release every virtual control", () => {
  const input = new InputManager();
  input.setVirtualMovement(0.8, -0.6);
  for (const action of ["a", "b", "q", "e"]) input.setVirtualAction(action, true);

  input.resetVirtualControls();
  assert.deepEqual(input.read("torso", true), {
    f: 0,
    s: 0,
    a: false,
    b: false,
    q: false,
    e: false,
    lx: 0,
    ly: 0,
  });

  input.setVirtualMovement(-1, 1);
  input.setVirtualAction("a", true);
  input.detach();
  assert.deepEqual(input.read("torso", true), {
    f: 0,
    s: 0,
    a: false,
    b: false,
    q: false,
    e: false,
    lx: 0,
    ly: 0,
  });
});
