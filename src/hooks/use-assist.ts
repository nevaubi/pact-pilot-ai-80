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
  apply?: { state: "applied" | "failed" | "partial"; note: string } | undefined;
  /** Spreadsheets: sheet active when asked; legacy cell answers are pinned to it. */
  askSheet?: string | undefined;
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
  | { t: "done"; usage: Usage; runId: string | null; steps?: number; exhausted?: boolean }
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
        ? {
            ...x,
            status: "stopped" as const,
            activity: x.activity?.map((a) =>
              a.status === "running" ? { ...a, status: "error" as const } : a,
            ),
          }
        : x,
    );
  } catch {
    return [];
  }
}

export type SendOpts = {
  label?: string;
  document?: DocContext | undefined;
  attachments?: AttachmentPayload[] | undefined;
  /** Called synchronously once the request is accepted (lock acquired), before any network work. */
  onStart?: () => void;
};

type Req = {
  id: string;
  key: string;
  controller: AbortController;
  /** False once superseded (clear / file switch / unmount): nothing it does may touch state again. */
  alive: boolean;
  pending: string;
  timer: ReturnType<typeof setTimeout> | null;
};

function persist(key: string, turns: Turn[]) {
  try {
    sessionStorage.setItem(key, JSON.stringify(turns.slice(-20)));
  } catch {
    /* quota or storage disabled */
  }
}

/**
 * Streaming conversation with /api/assist for one file. One request at a time (synchronous ref lock).
 * Every state change a request makes — deltas, events, errors, cleanup — is owned by that request's
 * identity and ignored once it is superseded, so a stale request can never write into a newer turn.
 * Deltas are batched (~50 ms) per request; persistence is debounced while streaming and flushed on
 * stop, file switch and unmount.
 */
export function useAssist(o: {
  matterId: string;
  storeKey: string;
  effort: Effort;
  mode?: "assist" | "draft";
  flushMs?: number;
}) {
  const { matterId, storeKey, effort, mode = "assist", flushMs = 50 } = o;
  const [turns, setTurnsState] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const turnsRef = useRef<Turn[]>([]);
  const setTurns = useCallback((fn: (ts: Turn[]) => Turn[]) => {
    turnsRef.current = fn(turnsRef.current);
    setTurnsState(turnsRef.current);
  }, []);
  const runIdRef = useRef<string | undefined>(undefined);
  const reqRef = useRef<Req | null>(null);
  const keyRef = useRef(storeKey);
  const qc = useQueryClient();

  const flushReq = useCallback(
    (r: Req) => {
      if (r.timer) clearTimeout(r.timer);
      r.timer = null;
      if (!r.alive || !r.pending) return;
      const add = r.pending;
      r.pending = "";
      setTurns((ts) => ts.map((t) => (t.id === r.id ? { ...t, a: t.a + add } : t)));
    },
    [setTurns],
  );

  /** Supersede the current request: keep its partial answer (persisted under its own key), then abort. */
  const supersede = useCallback(
    (o: { keep: boolean }) => {
      const r = reqRef.current;
      reqRef.current = null;
      if (!r) return;
      if (o.keep && r.key === keyRef.current) {
        flushReq(r);
        setTurns((ts) =>
          ts.map((t) =>
            t.id === r.id && t.status === "streaming"
              ? {
                  ...t,
                  status: t.a ? "stopped" : "error",
                  error: t.a ? undefined : "Stopped.",
                  retryable: true,
                  activity: t.activity?.map((x) =>
                    x.status === "running" ? { ...x, status: "error" as const } : x,
                  ),
                }
              : t,
          ),
        );
        persist(r.key, turnsRef.current);
      }
      if (r.timer) clearTimeout(r.timer);
      r.alive = false;
      r.controller.abort();
      setBusy(false);
    },
    [flushReq, setTurns],
  );

  // Switching files: keep and persist the old file's partial answer, abort, then load the new conversation.
  const [hydrated, setHydrated] = useState<string | null>(null);
  useEffect(() => {
    supersede({ keep: true });
    keyRef.current = storeKey;
    turnsRef.current = loadTurns(storeKey);
    setTurnsState(turnsRef.current);
    setHydrated(storeKey);
    runIdRef.current = undefined;
  }, [storeKey, supersede]);

  // Persist: immediately when idle, debounced while streaming.
  useEffect(() => {
    if (hydrated !== storeKey) return;
    if (!turns.some((t) => t.status === "streaming")) return void persist(storeKey, turns);
    const h = setTimeout(() => persist(storeKey, turnsRef.current), 1000);
    return () => clearTimeout(h);
  }, [turns, hydrated, storeKey]);

  useEffect(() => () => supersede({ keep: true }), [supersede]);

  const send = useCallback(
    async (text: string, opts: SendOpts = {}) => {
      const question = text.trim();
      if (!question || reqRef.current) return false; // synchronous lock: double submits are ignored
      const id = crypto.randomUUID();
      const me: Req = {
        id,
        key: storeKey,
        controller: new AbortController(),
        alive: true,
        pending: "",
        timer: null,
      };
      reqRef.current = me;
      const signal = me.controller.signal;
      const history = budgetHistory(turnsRef.current);
      const anchor = opts.document?.selection?.trim() ? opts.document.selection : undefined;
      const askSheet = opts.document?.workbook?.active;
      const turn: Turn = {
        id,
        q: question,
        a: "",
        effort,
        status: "streaming",
        label: opts.label,
        anchor,
        ...(askSheet ? { askSheet } : {}),
        ...(opts.attachments?.length ? { attachments: opts.attachments.map((a) => a.name) } : {}),
      };
      setTurns((ts) => [...ts, turn]);
      setBusy(true);
      opts.onStart?.();
      /** Patch only this request's turn, only while it is still the live owner. */
      const patch = (p: Partial<Turn> | ((t: Turn) => Partial<Turn>)) => {
        if (!me.alive) return;
        setTurns((ts) =>
          ts.map((t) => (t.id === id ? { ...t, ...(typeof p === "function" ? p(t) : p) } : t)),
        );
      };
      const finish = (p: Partial<Turn> | ((t: Turn) => Partial<Turn>)) => {
        flushReq(me);
        patch((t) => {
          const next = { ...t, ...(typeof p === "function" ? p(t) : p) };
          return {
            ...next,
            activity: next.activity?.map((a) =>
              a.status === "running" ? { ...a, status: "error" as const } : a,
            ),
          };
        });
      };
      let sawProposal = false;
      try {
        const { data: s } = await supabase.auth.getSession();
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
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
          signal,
        });
        if (!me.alive) return true;
        if (!res.ok || !res.body) {
          const j = (await res.json().catch(() => ({}))) as {
            message?: string;
            retryable?: boolean;
          };
          finish({
            status: "error",
            error: j.message ?? `AI request failed (${res.status}).`,
            retryable: j.retryable ?? (res.status === 429 || res.status >= 500),
          });
          return true;
        }
        const rid = res.headers.get("X-Lovable-AIG-Run-ID");
        if (rid) runIdRef.current = rid;
        const { terminal } = await readNdjson<Event>(
          res.body,
          (ev) => {
            if (!me.alive) return;
            if (ev.t === "delta") {
              me.pending += ev.text;
              if (!me.timer) me.timer = setTimeout(() => flushReq(me), flushMs);
            } else if (ev.t === "sources") patch({ sources: ev.items });
            else if (ev.t === "activity")
              patch((t) => {
                const list = t.activity ?? [];
                const has = list.some((a) => a.id === ev.id);
                return {
                  activity: has
                    ? list.map((a) =>
                        a.id === ev.id
                          ? { ...a, status: ev.status, ...(ev.label ? { label: ev.label } : {}) }
                          : a,
                      )
                    : [...list, { id: ev.id, label: ev.label ?? "Working", status: ev.status }],
                };
              });
            else if (ev.t === "proposal") {
              sawProposal = true;
              patch({ proposal: { proposal: ev.proposal, validation: ev.validation } });
            } else if (ev.t === "notice") patch({ notice: ev.text });
            else if (ev.t === "done") {
              flushReq(me);
              const answered =
                sawProposal ||
                !!turnsRef.current.find((t) => t.id === id)?.a.trim();
              if (!answered)
                finish({
                  status: "error",
                  usage: ev.usage,
                  steps: ev.steps,
                  retryable: true,
                  error: ev.exhausted
                    ? "The assistant used all of its steps without reaching an answer. Try a narrower request or Advanced."
                    : "The assistant finished without an answer. Try again or rephrase the request.",
                });
              else
                finish({
                  status: "done",
                  usage: ev.usage,
                  steps: ev.steps,
                  ...(ev.exhausted
                    ? {
                        notice:
                          "The assistant reached its step limit; the answer may be incomplete.",
                      }
                    : {}),
                });
              if (ev.runId) runIdRef.current = ev.runId;
              qc.invalidateQueries({ queryKey: ["ai-usage"] });
            } else if (ev.t === "error")
              finish((t) => ({
                status: t.a || me.pending ? "stopped" : "error",
                error: ev.message,
                retryable: ev.retryable,
              }));
          },
          undefined,
          signal,
        );
        if (me.alive && !terminal)
          finish((t) => ({
            status: t.a ? "stopped" : "error",
            error: t.a
              ? "The connection dropped — the answer may be incomplete."
              : "The connection dropped before an answer arrived.",
            retryable: true,
          }));
      } catch (e) {
        if ((e as Error).name === "AbortError")
          finish((t) => ({
            status: t.a || me.pending ? "stopped" : "error",
            error: t.a || me.pending ? undefined : "Stopped.",
            retryable: true,
          }));
        else finish({ status: "error", error: (e as Error).message, retryable: true });
      } finally {
        if (me.timer) clearTimeout(me.timer);
        if (reqRef.current === me) {
          reqRef.current = null;
          setBusy(false);
          if (me.alive) persist(me.key, turnsRef.current);
        }
        me.alive = false;
      }
      return true;
    },
    [storeKey, effort, matterId, mode, qc, flushReq, flushMs, setTurns],
  );

  /** Stop keeps the partial answer: the request finishes its own cleanup as "stopped". */
  const stop = useCallback(() => reqRef.current?.controller.abort(), []);
  const clear = useCallback(() => {
    supersede({ keep: false });
    setTurns(() => []);
    runIdRef.current = undefined;
  }, [supersede, setTurns]);
  const markApplied = useCallback(
    (id: string, apply: Turn["apply"]) =>
      setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, apply } : t))),
    [setTurns],
  );

  return { turns, busy, send, stop, clear, markApplied };
}
