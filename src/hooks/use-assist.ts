import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Effort } from "@/components/kit";

export type Usage = { inputTokens?: number | undefined; outputTokens?: number | undefined };
export type SourceMeta = { ref: string; authority_id: string; citation: string; title: string; url: string; version: string | null };
export type Turn = {
  id: string;
  q: string;
  a: string;
  effort: Effort;
  usage?: Usage | undefined;
  sources?: SourceMeta[] | undefined;
  status: "streaming" | "done" | "stopped" | "error";
  error?: string | undefined;
  retryable?: boolean | undefined;
  /** Short label shown instead of the raw prompt (quick actions). */
  label?: string | undefined;
};

/** What the open document contributes to a drafting request. Built lazily per send so it is always current. */
export type DocContext = {
  name: string;
  kind: "docx" | "pdf" | "xlsx" | "text";
  text: string;
  selection?: string | undefined;
};

/** Turn [S2] tags into links to the cited source and list only the sources actually cited. */
export function linkCitations(text: string, sources: SourceMeta[] | undefined) {
  if (!sources?.length) return { text, used: [] as SourceMeta[] };
  const used = new Set<string>();
  const out = text.replace(/\[(S\d+)\]/g, (all, ref: string) => {
    const s = sources.find((x) => x.ref === ref);
    if (!s) return all;
    used.add(ref);
    return `[${ref}](${s.url} "${s.citation}")`;
  });
  return { text: out, used: sources.filter((s) => used.has(s.ref)) };
}

function loadTurns(key: string): Turn[] {
  try {
    const raw = sessionStorage.getItem(key);
    const t = raw ? (JSON.parse(raw) as Turn[]) : [];
    // A reload mid-stream leaves a dangling turn; mark it stopped so the UI is honest.
    return t.map((x) => (x.status === "streaming" ? { ...x, status: "stopped" as const } : x));
  } catch {
    return [];
  }
}

/**
 * Streaming conversation with /api/assist for one matter. Persists the last 20 turns in
 * sessionStorage under `storeKey` so a reload or tab switch keeps the attorney's place.
 */
export function useAssist(o: {
  matterId: string;
  storeKey: string;
  effort: Effort;
  mode?: "assist" | "draft";
  document?: (() => DocContext | undefined) | undefined;
}) {
  const { matterId, storeKey, effort, mode = "assist", document } = o;
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const runIdRef = useRef<string | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const docRef = useRef(document);
  docRef.current = document;
  const qc = useQueryClient();

  const [hydrated, setHydrated] = useState<string | null>(null);
  useEffect(() => {
    setTurns(loadTurns(storeKey));
    setHydrated(storeKey);
    runIdRef.current = undefined;
  }, [storeKey]);
  useEffect(() => {
    if (hydrated !== storeKey) return;
    try {
      sessionStorage.setItem(storeKey, JSON.stringify(turns.slice(-20)));
    } catch {
      /* quota */
    }
  }, [turns, hydrated, storeKey]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const patch = useCallback(
    (id: string, p: Partial<Turn> | ((t: Turn) => Partial<Turn>)) =>
      setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, ...(typeof p === "function" ? p(t) : p) } : t))),
    [],
  );

  const send = useCallback(
    async (text: string, opts: { replaceId?: string; label?: string } = {}) => {
      const question = text.trim();
      if (!question || busy) return;
      const id = opts.replaceId ?? crypto.randomUUID();
      const history = turns
        .filter((t) => t.status === "done" && t.id !== opts.replaceId)
        .slice(-6)
        .map(({ q, a }) => ({ q, a }));
      const turn: Turn = { id, q: question, a: "", effort, status: "streaming", label: opts.label };
      setTurns((ts) => (opts.replaceId ? ts.map((t) => (t.id === opts.replaceId ? turn : t)) : [...ts, turn]));
      setBusy(true);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const { data: s } = await supabase.auth.getSession();
        const token = s.session?.access_token;
        if (!token) throw new Error("Your session has expired. Please sign in again.");
        const doc = docRef.current?.();
        const res = await fetch("/api/assist", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            matterId,
            effort,
            question,
            history,
            mode,
            ...(doc ? { document: doc } : {}),
            ...(runIdRef.current ? { runId: runIdRef.current } : {}),
          }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const j = (await res.json().catch(() => ({}))) as { message?: string; retryable?: boolean };
          patch(id, {
            status: "error",
            error: j.message ?? `AI request failed (${res.status}).`,
            retryable: j.retryable ?? (res.status === 429 || res.status >= 500),
          });
          return;
        }
        runIdRef.current = res.headers.get("X-Lovable-AIG-Run-ID") ?? runIdRef.current;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const l of lines) {
            if (!l.trim()) continue;
            const ev = JSON.parse(l) as
              | { t: "delta"; text: string }
              | { t: "sources"; items: SourceMeta[] }
              | { t: "done"; usage: Usage; runId: string | null }
              | { t: "error"; message: string; retryable: boolean };
            if (ev.t === "delta") patch(id, (t) => ({ a: t.a + ev.text }));
            else if (ev.t === "sources") patch(id, { sources: ev.items });
            else if (ev.t === "done") {
              patch(id, { status: "done", usage: ev.usage });
              if (ev.runId) runIdRef.current = ev.runId;
              qc.invalidateQueries({ queryKey: ["ai-usage"] });
            } else
              patch(id, (t) => ({
                status: t.a ? "stopped" : "error",
                error: ev.message,
                retryable: ev.retryable,
              }));
          }
        }
        // Stream ended without a terminal event (connection dropped) — keep what we have.
        setTurns((ts) =>
          ts.map((t) =>
            t.id === id && t.status === "streaming"
              ? { ...t, status: t.a ? "stopped" : "error", error: t.a ? undefined : "The connection dropped before an answer arrived." }
              : t,
          ),
        );
      } catch (e) {
        if ((e as Error).name === "AbortError")
          patch(id, (t) => ({ status: t.a ? "stopped" : "error", error: t.a ? undefined : "Stopped." }));
        else patch(id, { status: "error", error: (e as Error).message, retryable: true });
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [busy, turns, effort, matterId, mode, patch, qc],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);
  const clear = useCallback(() => {
    abortRef.current?.abort();
    setTurns([]);
    runIdRef.current = undefined;
  }, []);

  return { turns, busy, send, stop, clear };
}
