export type LimitedJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: "invalid" | "too_large" };

export async function readLimitedJson(request: Request, maxBytes: number): Promise<LimitedJsonResult> {
  if (!request.body) return { ok: false, reason: "invalid" };

  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The size result is authoritative even if the stream rejects cancellation.
        }
        return { ok: false, reason: "too_large" };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, value: JSON.parse(text) };
  } catch {
    try {
      await reader.cancel();
    } catch {
      // The malformed-body result should not depend on stream cleanup behavior.
    }
    return { ok: false, reason: "invalid" };
  } finally {
    reader.releaseLock();
  }
}
