/** Convert SpacetimeDB timestamps, which are stored in microseconds, to milliseconds. */
export function microsToMilliseconds(micros: bigint): number {
  return Number(micros / 1000n);
}

/** Convert gameplay durations, which the module already stores in milliseconds. */
export function storedMilliseconds(milliseconds: bigint): number {
  return Number(milliseconds);
}
