import type { SquadSize } from "./types";

export const LEADERBOARD_LIMIT = 10;

export interface LeaderboardRow {
  id: string;
  challengeId: string;
  squadSize: SquadSize;
  teamName: string;
  players: string[];
  timeMs: number;
}

/**
 * Keep leaderboard ordering stable on every client. SpacetimeDB subscriptions
 * deliver a live set of rows, but intentionally make no ordering guarantee.
 */
export function compareLeaderboardRows(a: LeaderboardRow, b: LeaderboardRow): number {
  if (a.timeMs !== b.timeMs) return a.timeMs - b.timeMs;

  // IDs are auto-incrementing u64s. Comparing as bigint keeps "10" after "2"
  // and makes the earlier submitted run win an exact tie.
  const aId = BigInt(a.id);
  const bId = BigInt(b.id);
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

/** Select one global board before limiting it, so busy categories cannot starve others. */
export function topLeaderboardRows(
  rows: Iterable<LeaderboardRow>,
  challengeId: string,
  squadSize: SquadSize,
  limit = LEADERBOARD_LIMIT
): LeaderboardRow[] {
  return [...rows]
    .filter((row) => row.challengeId === challengeId && row.squadSize === squadSize)
    .sort(compareLeaderboardRows)
    .slice(0, Math.max(0, limit));
}
