import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Effort } from "@/components/kit";
import { readNdjson } from "@/lib/ndjson";
import type { Proposal, Validation, WorkbookSnap } from "@/lib/office-tools";

export type Usage = { inputTokens?: number | undefined; outputTokens?: number | undefined };
export type SourceMeta = {
  ref: string;
  authority_id: string;
  citation: string;
  title: string;
  url: string;
  version: string | null;
};
export type Activity = { id: string; label: string; status: "running" | "done" | "error" };
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
  /** Text selected in the open document when this was asked; Replace targets only this. */
  anchor?: string | undefined;
  activity?: Activity[] | undefined;
  /** Last proposal the assistant validated (valid or not). */
  proposal?: { proposal: Proposal; validation: Validation } | undefined;
  notice?: string | undefined;
  steps?: number | undefined;
  /** Attorney-driven apply outcome: never re-attempted automatically. */
  apply?: { state: "applied" | "failed"; note: string } | undefined;
  attachments?: string[] | undefined;
};

/** What the open document contributes to a drafting request. Built per send so it is always current. */
export type DocContext = {
  name: string;
  kind: "docx" | "pdf" | "xlsx" | "text";
  text: string;
  selection?: string | undefined;
  workbook?: WorkbookSnap | undefined;
};
export type AttachmentPayload = { id: string; name: string; text: string; truncated: boolean };

type Event =
  | { t: "delta"; text: string }
  | { t: "sources"; items: SourceMeta[] }
  | { t: "activity"; id: string; label?: string; status: Activity["status"] }
  | { t: "proposal"; proposal: Proposal; validation: Validation }
  | { t: "notice"; text: string }
  | { t: "done"; usage: Usage; runId: string | null; steps?: number }
  | { t: "error"; message: string; retryable: boolean };

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

/** Last completed turns, newest kept first when trimming, within a character budget. */
export function budgetHistory(turns: Turn[], excludeId?: string, maxTurns = 6, maxChars = 24_000) {
  const done = turns.filter((t) => t.status === "done" && t.id !== excludeId).slice(-maxTurns);
  const out: { q: string; a: string }[] = [];
  let used = 0;
  for (let i = done.length - 1; i >= 0; i--) {
    const t = done[i]!;
    const q = t.q.slice(0, 4000);
    const a = t.a.slice(0, 6000);
    if (used + q.length + a.length > maxChars) break;
    used += q.length + a.length;
    out.unshift({ q, a });
  }
  return out;
}

function loadTurns(key: string): Turn[] {
  try {
    const raw = sessionStorage.getItem(key);
    const t = raw ? (JSON.parse(raw) as Turn[]) : [];
    // A reload mid-stream leaves a dangling turn; mark it stopped so the UI is honest.
    return t.map((x) =>
      x.status === "streaming"
        ? { ...x, status: "stopped" as const, activity: x.activity?.map((a) => (a.status === "running" ? { ...a, status: "error" as const } : a)) }
        : x,
    );
  } catch {
    return [];
  }
}

export type SendOpts = {
  replaceId?: string;
  label?: string;
  document?: DocContext | undefined;
  attachments?: AttachmentPayload[] | undefined;
};

/**
 * Streaming conversation with /api/assist for one file. One request at a time (synchronous ref lock);
 * each request owns an AbortController tied to its id and store key, and only that request may clean
 * up after itself. Deltas are batched (~50 ms) and persistence is debounced while streaming.
 */
export function useAssist(o: { matterId: string; storeKey: string; effort: Effort; mode?: "assist" | "draft"; flushMs?: number }) {
  const { matterId, storeKey, effort, mode = "assist", flushMs = 50 } = o;
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const turnsRef = useRef<Turn[]>([]);
  turnsRef.current = turns;
  const runIdRef = useRef<string | undefined>(undefined);
  const reqRef = useRef<{ id: string; key: string; controller: AbortController } | null>(null);
  const pending = useRef(new Map<string, string>());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const qc = useQueryClient();

  const flushDeltas = useCallback(() => {
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = null;
    if (!pending.current.size) return;
    const add = new Map(pending.current);
    pending.current.clear();
    setTurns((ts) => ts.map((t) => (add.has(t.id) ? { ...t, a: t.a + add.get(t.id)! } : t)));
  }, []);

  const abortCurrent = useCallback(() => {
    const r = reqRef.current;
    reqRef.current = null;
    r?.controller.abort();
    flushDeltas();
    setBusy(false);
  }, [flushDeltas]);

  // Switching files: abort the old request before loading the new conversation.
  const [hydrated, setHydrated] = useState<string | null>(null);
  useEffect(() => {
    abortCurrent();
    setTurns(loadTurns(storeKey));
    setHydrated(storeKey);
    runIdRef.current = undefined;
  }, [storeKey, abortCurrent]);

  // Persist: immediately when idle, debounced while streaming.
  useEffect(() => {
    if (hydrated !== storeKey) return;
    const write = () => {
      try {
        sessionStorage.setItem(storeKey, JSON.stringify(turnsRef.current.slice(-20)));
      } catch {
        /* quota */
      }
    };
    if (!turns.some((t) => t.status === "streaming")) return void write();
    const h = setTimeout(write, 1000);
    return () => clearTimeout(h);
  }, [turns, hydrated, storeKey]);

  useEffect(
    () => () => {
      reqRef.current?.controller.abort();
      reqRef.current = null;
      if (flushTimer.current) clearTimeout(flushTimer.current);
    },
    [],
  );

  const patch = useCallback((id: string, p: Partial<Turn> | ((t: Turn) => Partial<Turn>)) => {
    setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, ...(typeof p === "function" ? p(t) : p) } : t)));
  }, []);

  const send = useCallback(
    async (text: string, opts: SendOpts = {}) => {
      const question = text.trim();
      if (!question || reqRef.current) return false; // synchronous lock: double submits are ignored
      const id = opts.replaceId ?? crypto.randomUUID();
      const key = storeKey;
      const controller = new AbortController();
      const me = { id, key, controller };
      reqRef.current = me;
      const mine = () => reqRef.current === me;
      const history = budgetHistory(turnsRef.current, opts.replaceId);
      const anchor = opts.document?.selection?.trim() || undefined;
      const turn: Turn = {
        id,
        q: question,
        a: "",
        effort,
        status: "streaming",
        label: opts.label,
        anchor,
        ...(opts.attachments?.length ? { attachments: opts.attachments.map((a) => a.name) } : {}),
      };
      setTurns((ts) => (opts.replaceId ? ts.map((t) => (t.id === opts.replaceId ? turn : t)) : [...ts, turn]));
      setBusy(true);
      const finish = (p: Partial<Turn> | ((t: Turn) => Partial<Turn>)) => {
        flushDeltas();
        patch(id, (t) => {
          const next = { ...t, ...(typeof p === "function" ? p(t) : p) };
          return { ...next, activity: next.activity?.map((a) => (a.status === "running" ? { ...a, status: "error" as const } : a)) };
        });
      };
      try {
        const { data: s } = await supabase.auth.getSession();
        const token = s.session?.access_token;
        if (!token) throw new Error("Your session has expired. Please sign in again.");
        const res = await fetch("/api/assist", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            matterId,
            effort,
            question,
            history,
            mode,
            ...(opts.document ? { document: opts.document } : {}),
            ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
            ...(runIdRef.current ? { runId: runIdRef.current } : {}),
          }),
          signal: controller.signal,
        });
        if (!mine()) return true;
        if (!res.ok || !res.body) {
          const j = (await res.json().catch(() => ({}))) as { message?: string; retryable?: boolean };
          finish({
            status: "error",
            error: j.message ?? `AI request failed (${res.status}).`,
            retryable: j.retryable ?? (res.status === 429 || res.status >= 500),
          });
          return true;
        }
        runIdRef.current = res.headers.get("X-Lovable-AIG-Run-ID") ?? runIdRef.current;
        const { terminal } = await readNdjson<Event>(res.body, (ev) => {
          if (!mine()) return;
          if (ev.t === "delta") {
            pending.current.set(id, (pending.current.get(id) ?? "") + ev.text);
            if (!flushTimer.current) flushTimer.current = setTimeout(flushDeltas, flushMs);
          } else if (ev.t === "sources") patch(id, { sources: ev.items });
          else if (ev.t === "activity")
            patch(id, (t) => {
              const list = t.activity ?? [];
              const has = list.some((a) => a.id === ev.id);
              return {
                activity: has
                  ? list.map((a) => (a.id === ev.id ? { ...a, status: ev.status, ...(ev.label ? { label: ev.label } : {}) } : a))
                  : [...list, { id: ev.id, label: ev.label ?? "Working", status: ev.status }],
              };
            });
          else if (ev.t === "proposal") patch(id, { proposal: { proposal: ev.proposal, validation: ev.validation } });
          else if (ev.t === "notice") patch(id, { notice: ev.text });
          else if (ev.t === "done") {
            finish({ status: "done", usage: ev.usage, steps: ev.steps });
            if (ev.runId) runIdRef.current = ev.runId;
            qc.invalidateQueries({ queryKey: ["ai-usage"] });
          } else if (ev.t === "error")
            finish((t) => ({ status: t.a || pending.current.get(id) ? "stopped" : "error", error: ev.message, retryable: ev.retryable }));
        }, undefined, controller.signal);
        if (mine() && !terminal)
          finish((t) => ({
            status: t.a ? "stopped" : "error",
            error: t.a ? "The connection dropped — the answer may be incomplete." : "The connection dropped before an answer arrived.",
            retryable: true,
          }));
      } catch (e) {
        if ((e as Error).name === "AbortError")
          finish((t) => ({ status: t.a ? "stopped" : "error", error: t.a ? undefined : "Stopped.", retryable: true }));
        else finish({ status: "error", error: (e as Error).message, retryable: true });
      } finally {
        if (mine()) {
          reqRef.current = null;
          setBusy(false);
        }
      }
      return true;
    },
    [storeKey, effort, matterId, mode, patch, qc, flushDeltas, flushMs],
  );

  const stop = useCallback(() => reqRef.current?.controller.abort(), []);
  const clear = useCallback(() => {
    abortCurrent();
    setTurns([]);
    runIdRef.current = undefined;
  }, [abortCurrent]);
  const markApplied = useCallback((id: string, apply: Turn["apply"]) => patch(id, { apply }), [patch]);

  return { turns, busy, send, stop, clear, markApplied };
}
