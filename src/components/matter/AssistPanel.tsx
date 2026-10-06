import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Send, Sparkle, Square, Copy, Check, StickyNote, RotateCcw, Trash2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import { useEffort } from "@/hooks/use-effort";
import { logActivity } from "@/lib/data";
import { mut, tryAction } from "@/lib/mutate";
import { EffortToggle, UsageNote, ReviewBanner, type Effort } from "@/components/kit";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { MicButton } from "@/components/MicButton";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

type Usage = { inputTokens?: number | undefined; outputTokens?: number | undefined };
type SourceMeta = { ref: string; authority_id: string; citation: string; title: string; url: string; version: string | null };
type Turn = {
  id: string;
  q: string;
  a: string;
  effort: Effort;
  usage?: Usage | undefined;
  sources?: SourceMeta[] | undefined;
  status: "streaming" | "done" | "stopped" | "error";
  error?: string | undefined;
  retryable?: boolean | undefined;
};

/** Turn [S2] tags into links to the cited source and list only the sources actually cited. */
function linkCitations(text: string, sources: SourceMeta[] | undefined) {
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

const VERBS: Record<string, string[] | undefined> = {
  common: [
    "Catch me up",
    "What's due in the next two weeks?",
    "Draft a status email to the client",
  ],
  Corporate: [
    "List customary diligence items still open",
    "Flag tax points to raise with the client's CPA",
  ],
  "Real Estate": ["What title and survey items should I check?", "Outline the path to closing"],
  "Estate Planning": ["Summarize the client's goals", "Which documents does this plan need?"],
  Finance: ["Which terms look off-market for a deal this size?", "Where does the closing stand?"],
  Compliance: ["List upcoming filings and notices", "What obligations should we calendar?"],
};

const storeKey = (id: string) => `mirza-assist-${id}`;
function loadTurns(id: string): Turn[] {
  try {
    const raw = sessionStorage.getItem(storeKey(id));
    const t = raw ? (JSON.parse(raw) as Turn[]) : [];
    // A reload mid-stream leaves a dangling turn; mark it stopped so the UI is honest.
    return t.map((x) => (x.status === "streaming" ? { ...x, status: "stopped" as const } : x));
  } catch {
    return [];
  }
}

export function AssistPanel({
  matter,
  open,
  onOpenChange,
  initialPrompt,
}: {
  matter: Tables<"matters">;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initialPrompt?: string | undefined;
}) {
  const [effort, setEffort] = useEffort();
  const [q, setQ] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const runIdRef = useRef<string | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const initialSentRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();

  // Persist per matter for the browser session; `hydrated` guards against writing the initial empty state over saved history.
  const [hydrated, setHydrated] = useState<string | null>(null);
  useEffect(() => {
    setTurns(loadTurns(matter.id));
    setHydrated(matter.id);
    runIdRef.current = undefined;
  }, [matter.id]);
  useEffect(() => {
    if (hydrated !== matter.id) return;
    try {
      sessionStorage.setItem(storeKey(matter.id), JSON.stringify(turns.slice(-20)));
    } catch {
      /* quota */
    }
  }, [turns, hydrated, matter.id]);
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 80);
  }, [open, busy]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const patch = (id: string, p: Partial<Turn> | ((t: Turn) => Partial<Turn>)) =>
    setTurns((ts) =>
      ts.map((t) => (t.id === id ? { ...t, ...(typeof p === "function" ? p(t) : p) } : t)),
    );

  async function send(text: string, replaceId?: string) {
    const question = text.trim();
    if (!question || busy) return;
    const id = replaceId ?? crypto.randomUUID();
    const history = turns
      .filter((t) => t.status === "done" && t.id !== replaceId)
      .slice(-6)
      .map(({ q, a }) => ({ q, a }));
    const turn: Turn = { id, q: question, a: "", effort, status: "streaming" };
    setTurns((ts) => (replaceId ? ts.map((t) => (t.id === replaceId ? turn : t)) : [...ts, turn]));
    setQ("");
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const { data: s } = await supabase.auth.getSession();
      const token = s.session?.access_token;
      if (!token) throw new Error("Your session has expired. Please sign in again.");
      const res = await fetch("/api/assist", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          matterId: matter.id,
          effort,
          question,
          history,
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
            ? {
                ...t,
                status: t.a ? "stopped" : "error",
                error: t.a ? undefined : "The connection dropped before an answer arrived.",
              }
            : t,
        ),
      );
    } catch (e) {
      if ((e as Error).name === "AbortError")
        patch(id, (t) => ({
          status: t.a ? "stopped" : "error",
          error: t.a ? undefined : "Stopped.",
        }));
      else patch(id, { status: "error", error: (e as Error).message, retryable: true });
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  useEffect(() => {
    if (!open || !initialPrompt || busy || initialSentRef.current === initialPrompt) return;
    initialSentRef.current = initialPrompt;
    void send(initialPrompt);
  }, [open, initialPrompt, busy]);

  function stop() {
    abortRef.current?.abort();
  }
  function clear() {
    abortRef.current?.abort();
    setTurns([]);
    runIdRef.current = undefined;
  }

  async function saveAsNote(t: Turn) {
    await tryAction(async () => {
      await mut(
        supabase
          .from("notes")
          .insert({
            matter_id: matter.id,
            title: `Assist: ${t.q.slice(0, 80)}`,
            body: t.a,
            kind: "assist",
          })
          .select("id"),
        { success: "Saved to Notes" },
      );
      await logActivity(matter.id, `Saved an Assist answer to notes: "${t.q.slice(0, 60)}"`);
      qc.invalidateQueries({ queryKey: ["notes", matter.id] });
      qc.invalidateQueries({ queryKey: ["activity", matter.id] });
    });
  }

  const verbs = [...(VERBS["common"] ?? []), ...(VERBS[matter.practice_area] ?? [])];
  const lastDone = [...turns].reverse().find((t) => t.status === "done" || t.status === "stopped");

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-lg">
        <SheetHeader className="border-b p-4 text-left">
          <SheetTitle className="flex items-center gap-2">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded bg-ink-purple text-primary-foreground">
              <Sparkle className="h-4 w-4" />
            </span>
            <span className="truncate">
              Assist · <span className="font-normal text-muted-foreground">{matter.title}</span>
            </span>
          </SheetTitle>
          <SheetDescription className="sr-only">
            Ask about this matter. Answers are suggestions for your review.
          </SheetDescription>
          <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
            <EffortToggle value={effort} onChange={setEffort} />
            <span className="text-[11px] text-muted-foreground">
              {effort === "normal"
                ? "Case management & drafting help"
                : "Deeper analysis, issue-spotting"}
            </span>
          </div>
        </SheetHeader>
        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {!turns.length && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Assist only looks at this matter — its summary, tasks, deadlines, notes and files.
                It prepares; you review and decide.
              </p>
              <div className="flex flex-wrap gap-2">
                {verbs.map((v) => (
                  <button
                    key={v}
                    onClick={() => send(v)}
                    className="rounded border bg-raised px-2.5 py-1.5 text-left text-xs transition-colors hover:border-ink-purple hover:text-ink-purple"
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>
          )}
          {turns.map((t) => (
            <div key={t.id} className="space-y-2">
               <div className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap rounded border bg-raised px-3 py-2 text-sm text-foreground">
                {t.q}
              </div>
              {t.a || t.status !== "streaming" ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                    <UsageNote effort={t.effort} usage={t.usage} />
                    {t.status === "stopped" && (
                      <span className="rounded bg-raised px-1.5 py-0.5">stopped early</span>
                    )}
                  </div>
                  {t.a && <Answer text={t.a} sources={t.sources} />}
                  {t.status === "streaming" && (
                    <span
                      className="inline-block h-4 w-1.5 animate-pulse rounded-sm bg-ink-purple align-text-bottom"
                      aria-label="Writing…"
                    />
                  )}
                  {t.status === "error" && (
                    <div className="rounded-lg border border-ink-red/30 bg-ink-red/5 px-3 py-2 text-sm">
                      <p>{t.error}</p>
                      {t.retryable !== false && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="mt-2"
                          onClick={() => send(t.q, t.id)}
                          disabled={busy}
                        >
                          <RotateCcw className="mr-1 h-3.5 w-3.5" />
                          Try again
                        </Button>
                      )}
                    </div>
                  )}
                  {(t.status === "done" || t.status === "stopped") && t.a && (
                    <div className="flex flex-wrap items-center gap-1">
                      <CopyButton text={t.a} />
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        onClick={() => saveAsNote(t)}
                      >
                        <StickyNote className="mr-1 h-3.5 w-3.5" />
                        Save to notes
                      </Button>
                      {t === lastDone && <span className="ml-auto" />}
                    </div>
                  )}
                  {t === lastDone && <ReviewBanner />}
                </div>
              ) : (
                <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
                  <span className="flex gap-1">
                    <span className="h-2 w-2 animate-bounce rounded-full bg-ink-purple" />
                    <span className="h-2 w-2 animate-bounce rounded-full bg-ink-purple [animation-delay:120ms]" />
                    <span className="h-2 w-2 animate-bounce rounded-full bg-ink-purple [animation-delay:240ms]" />
                  </span>
                  {t.effort === "advanced"
                    ? "Reading the matter and its documents carefully…"
                    : "Reading the matter…"}
                </div>
              )}
            </div>
          ))}
          <div ref={endRef} />
        </div>
        <form
          className="border-t p-3"
          onSubmit={(e) => {
            e.preventDefault();
            send(q);
          }}
        >
          <div className="flex items-end gap-2 rounded border bg-card p-2">
            <Textarea
              ref={inputRef}
              rows={2}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(q);
                }
              }}
              placeholder="Ask about this matter…"
              aria-label="Ask about this matter"
              className="min-h-0 resize-none border-0 p-1 shadow-none focus-visible:ring-0"
            />
            <MicButton
              className="h-9 w-9"
              onText={(t) => {
                setQ((cur) => (cur.trim() ? `${cur.trimEnd()} ${t}` : t));
                inputRef.current?.focus();
              }}
            />
            {busy ? (
              <Button type="button" size="icon" variant="outline" onClick={stop} aria-label="Stop">
                <Square className="h-4 w-4" />
              </Button>
            ) : (
              <Button type="submit" size="icon" disabled={!q.trim()} aria-label="Send">
                <Send className="h-4 w-4" />
              </Button>
            )}
          </div>
          {turns.length > 0 && (
            <div className="mt-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
              <span>Follow-ups remember the last few answers.</span>
              <button
                type="button"
                onClick={clear}
                className="inline-flex items-center gap-1 hover:text-foreground"
              >
                <Trash2 className="h-3 w-3" />
                Clear conversation
              </button>
            </div>
          )}
        </form>
      </SheetContent>
    </Sheet>
  );
}

function Answer({ text, sources }: { text: string; sources: SourceMeta[] | undefined }) {
  const { text: linked, used } = linkCitations(text, sources);
  return (
    <div className="space-y-2">
      <div className="md text-sm">
        <ReactMarkdown
          components={{
            a: ({ href, title, children }) => (
              <a
                href={href}
                title={title}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-sm bg-ink-blue/10 px-1 align-baseline text-[11px] font-semibold text-ink-blue no-underline hover:bg-ink-blue/20"
              >
                {children}
              </a>
            ),
          }}
        >
          {linked}
        </ReactMarkdown>
      </div>
      {used.length > 0 && (
        <ul className="space-y-0.5 rounded border bg-card px-2.5 py-1.5 text-[11px]">
          {used.map((s) => (
            <li key={s.ref} className="flex gap-1.5">
              <span className="shrink-0 font-semibold text-ink-blue">{s.ref}</span>
              <a href={s.url} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate hover:underline">
                <span className="font-mono">{s.citation}</span> — {s.title}
                {s.version ? <span className="text-muted-foreground"> · {s.version}</span> : null}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-7 text-xs"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setOk(true);
          setTimeout(() => setOk(false), 1500);
        } catch {
          toast.error("Couldn't copy to the clipboard.");
        }
      }}
    >
      {ok ? (
        <Check className="mr-1 h-3.5 w-3.5 text-ink-green" />
      ) : (
        <Copy className="mr-1 h-3.5 w-3.5" />
      )}
      {ok ? "Copied" : "Copy"}
    </Button>
  );
}
