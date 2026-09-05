import { emptyInput, type PhysRole, type Role, type RoleInput, type SquadSize } from "./types";
import type { BodyInputs } from "./body";

export interface SquadMixState {
  legT: number;
}

/** fresh per-run mixer state (3P auto-alternate legs) */
export const makeSquadMixState = (): SquadMixState => ({ legT: 0 });

const get = (ext: Partial<Record<Role, RoleInput>>, r: Role): RoleInput => ext[r] ?? emptyInput();

/**
 * Merge squad-sized player inputs into the 5 internal physics channels.
 * - Camera/heading always follows Torso's mouse (legacy Head falls back).
 * - 5P hands: raise/swing average (must move together), two-hand grab + throw
 *   require BOTH players (Space / Shift), Q/E grab a single hand alone.
 * - 3P legs: hold a direction to auto-alternate steps; Space jumps.
 */
export function resolvePhysInputs(
  ext: Partial<Record<Role, RoleInput>>,
  squad: SquadSize,
  dt: number,
  st: SquadMixState
): BodyInputs {
  const torso = get(ext, "torso");
  const headLeg = get(ext, "head");
  const yaw = ext.torso?.lx ?? headLeg.lx ?? 0;
  const pitch = ext.torso?.ly ?? headLeg.ly ?? 0;

  const head: RoleInput = { ...emptyInput(), lx: yaw, ly: pitch, a: torso.q || headLeg.a };

  let arms: RoleInput;
  if (squad === 3) {
    arms = { ...get(ext, "arms"), lx: yaw, ly: pitch };
  } else {
    const l = ext.lhand;
    const r = ext.rhand;
    if (!l && !r) {
      // solo / legacy fallback: shared arms role drives both hands
      arms = { ...get(ext, "arms"), lx: yaw, ly: pitch };
    } else {
      const lf = l?.f ?? 0;
      const rf = r?.f ?? 0;
      const ls = l?.s ?? 0;
      const rs = r?.s ?? 0;
      arms = {
        f: (lf + rf) / 2,
        s: (ls + rs) / 2,
        a: Boolean(l?.a && r?.a),
        b: Boolean(l?.b && r?.b),
        q: Boolean(l?.q),
        e: Boolean(r?.e),
        lx: yaw,
        ly: pitch,
      };
    }
  }

  let lleg: RoleInput;
  let rleg: RoleInput;
  if (squad === 3) {
    const legs = ext.legs ?? (ext.lleg ?? ext.rleg);
    if (!legs || (Math.abs(legs.f) < 0.2 && Math.abs(legs.s) < 0.2)) {
      lleg = { ...emptyInput(), lx: yaw, ly: pitch, a: Boolean(legs?.a) };
      rleg = { ...emptyInput(), lx: yaw, ly: pitch, a: Boolean(legs?.a) };
    } else {
      st.legT += dt;
      const phase = Math.floor(st.legT / 0.3) % 2;
      const active: RoleInput = { ...legs, lx: yaw, ly: pitch };
      const idle: RoleInput = { ...emptyInput(), lx: yaw, ly: pitch, a: legs.a };
      lleg = phase === 0 ? active : idle;
      rleg = phase === 1 ? active : idle;
      lleg.a = Boolean(legs.a);
      rleg.a = Boolean(legs.a);
    }
  } else {
    lleg = { ...get(ext, "lleg"), lx: yaw, ly: pitch };
    rleg = { ...get(ext, "rleg"), lx: yaw, ly: pitch };
    if (ext.legs && !ext.lleg && !ext.rleg) {
      lleg = { ...ext.legs, lx: yaw, ly: pitch };
      rleg = { ...ext.legs, lx: yaw, ly: pitch };
    }
  }

  const out: BodyInputs = { head, arms, torso: { ...torso, lx: yaw, ly: pitch }, lleg, rleg };
  return out as Record<PhysRole, RoleInput> as BodyInputs;
}
