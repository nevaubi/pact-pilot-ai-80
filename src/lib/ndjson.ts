/** Incremental NDJSON decoding that survives UTF-8 characters and JSON lines split across network chunks. */
export function createNdjsonDecoder<T = unknown>() {
  const dec = new TextDecoder();
  let buf = "";
  let bad = 0;
  const parse = (lines: string[]) => {
    const out: T[] = [];
    for (const l of lines) {
      if (!l.trim()) continue;
      try {
        out.push(JSON.parse(l) as T);
      } catch {
        bad++;
      }
    }
    return out;
  };
  return {
    push(chunk: Uint8Array): T[] {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      return parse(lines);
    },
    /** Flush the decoder and parse a final line that arrived without a trailing newline. */
    end(): T[] {
      buf += dec.decode();
      const rest = buf;
      buf = "";
      return parse([rest]);
    },
    get malformed() {
      return bad;
    },
  };
}

/** Read a whole NDJSON body, calling onEvent per event. Reports whether a terminal event was seen. */
export async function readNdjson<T extends { t: string }>(
  body: ReadableStream<Uint8Array>,
  onEvent: (e: T) => void,
  terminal: (e: T) => boolean = (e) => e.t === "done" || e.t === "error",
  signal?: AbortSignal,
): Promise<{ terminal: boolean; malformed: number }> {
  const d = createNdjsonDecoder<T>();
  const reader = body.getReader();
  // Cancel the reader on abort so a stalled body can't keep the request alive.
  const onAbort = () => void reader.cancel().catch(() => {});
  if (signal?.aborted) onAbort();
  signal?.addEventListener("abort", onAbort, { once: true });
  let seen = false;
  const handle = (evs: T[]) => {
    for (const e of evs) {
      if (terminal(e)) seen = true;
      onEvent(e);
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) handle(d.push(value));
    }
    handle(d.end());
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return { terminal: seen, malformed: d.malformed };
}
