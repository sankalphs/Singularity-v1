export interface ObjectiveSnapshot {
  p: number[];
  props: number[];
  fallen: boolean;
  score: number;
}

type ObjectiveZone = { pos: [number, number, number]; size: [number, number, number] };

const OBJECTIVE_ZONES: Record<string, { body?: ObjectiveZone; prop?: ObjectiveZone }> = {
  'wobble-run': { body: { pos: [0, 1.5, -64], size: [8, 4, 2] } },
  'ferry-job': { prop: { pos: [0, 1.2, -37.5], size: [2.4, 1.6, 2.4] } },
  'summit-sync': {
    body: { pos: [0, 1.5, -60], size: [6, 4, 1.6] },
    prop: { pos: [0, 1.2, -46.5], size: [1.6, 1.4, 1.6] },
  },
  'egg-express': { prop: { pos: [0, 1.2, -40], size: [2.4, 1.6, 2.4] } },
};

function pointInObjectiveZone(values: number[], offset: number, zone: ObjectiveZone): boolean {
  const x = values[offset];
  const y = values[offset + 1];
  const z = values[offset + 2];
  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    Number.isFinite(z) &&
    Math.abs(x - zone.pos[0]) <= zone.size[0] / 2 &&
    Math.abs(y - zone.pos[1]) <= zone.size[1] / 2 &&
    Math.abs(z - zone.pos[2]) <= zone.size[2] / 2
  );
}

function propInObjectiveZone(values: number[], zone: ObjectiveZone): boolean {
  for (let offset = 0; offset + 7 < values.length; offset += 8) {
    if (pointInObjectiveZone(values, offset + 1, zone)) return true;
  }
  return false;
}

export function snapshotMatchesObjective(challengeId: string, proof: ObjectiveSnapshot): boolean {
  if (challengeId === 'slam-dunk') return proof.score >= 3;
  const zones = OBJECTIVE_ZONES[challengeId];
  if (!zones) return false;
  if (zones.body && (proof.fallen || !pointInObjectiveZone(proof.p, 0, zones.body))) return false;
  if (zones.prop && !propInObjectiveZone(proof.props, zones.prop)) return false;
  return true;
}
