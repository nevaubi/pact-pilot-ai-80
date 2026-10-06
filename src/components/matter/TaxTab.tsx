import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { Calculator, CheckCircle2, AlertTriangle, ExternalLink, ListChecks, EyeOff, Eye, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { Tables, Json } from "@/integrations/supabase/types";
import { taxFlags } from "@/lib/ai.functions";
import { reviewsQ, logActivity, fmtDateTime } from "@/lib/data";
import { authoritiesQ, matterAuthoritiesQ } from "@/lib/library";
import { mut, tryAction } from "@/lib/mutate";
import { useEffort } from "@/hooks/use-effort";
import { Panel, ListState, EffortToggle, UsageNote, type Effort } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";

type Flag = {
  title: string;
  severity: "high" | "medium" | "low";
  issue: string;
  matter_facts: string;
  basis_ref: string;
  basis_quote: string;
  next_step: string;
  for_cpa: boolean;
  basis: { citation: string; title: string; url: string; version: string | null; authority_id: string } | null;
  verified: boolean;
};
type Result = { flags: Flag[]; clear: string[]; note: string; sources: { ref: string; citation: string; title: string; url: string }[]; focus: string | null };
type Decisions = Record<string, "reviewed" | "dismissed" | "task">;

const sevTone: Record<Flag["severity"], string> = {
  high: "bg-ink-red/10 text-ink-red",
  medium: "bg-ink-amber/10 text-ink-amber",
  low: "bg-raised text-muted-foreground",
};

export function TaxTab({ matter }: { matter: Tables<"matters"> }) {
  const qc = useQueryClient();
  const reviews = useQuery(reviewsQ(matter.id, "tax"));
  const lib = useQuery(authoritiesQ);
  const pinned = useQuery(matterAuthoritiesQ(matter.id));
  const [effort, setEffort] = useEffort();
  const [focus, setFocus] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const run = useServerFn(taxFlags);

  const coverage = useMemo(() => {
    const rows = lib.data ?? [];
    const tax = rows.filter((a) => a.topics.includes("tax"));
    return { ready: tax.filter((a) => a.status === "ready").length, total: tax.length, pinned: pinned.data?.length ?? 0 };
  }, [lib.data, pinned.data]);

  const current = useMemo(() => {
    const list = reviews.data ?? [];
    return list.find((r) => r.id === selectedId) ?? list[0] ?? null;
  }, [reviews.data, selectedId]);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const r = await run({ data: { matterId: matter.id, effort, ...(focus.trim() ? { focus: focus.trim() } : {}) } });
      await logActivity(matter.id, `Ran tax red-flag review (${r.flags.length} flags, ${effort})`);
      qc.invalidateQueries({ queryKey: ["reviews", matter.id, "tax"] });
      qc.invalidateQueries({ queryKey: ["activity", matter.id] });
      qc.invalidateQueries({ queryKey: ["ai-usage"] });
      setSelectedId(r.reviewId);
      setFocus("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded border border-ink-amber/30 bg-ink-amber/10 px-3 py-2 text-xs">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-ink-amber" />
        <span>
          <b>Flags only — not tax advice.</b> Mirza points at tax questions a careful associate would raise on these facts, each tied to a
          quoted passage from the firm's law library so you can verify it. Liability, elections and conclusions belong with the client's
          CPA or tax counsel.
        </span>
      </div>

      <Panel
        title="Run a check"
        action={
          <span className="text-[11px] text-muted-foreground">
            Library: {coverage.ready} of {coverage.total} tax sources ready · {coverage.pinned} pinned to this matter ·{" "}
            <Link to="/library" className="underline hover:text-foreground">
              open library
            </Link>
          </span>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <Input value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="Anything specific? e.g. seller is a Canadian LLC; buyer wants to 1031 into this" className="min-w-[18rem] flex-1" aria-label="Focus" />
          <EffortToggle value={effort} onChange={setEffort} />
          <Button onClick={go} disabled={busy}>
            {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Calculator className="mr-1.5 h-4 w-4" />}
            {busy ? (effort === "advanced" ? "Spotting issues, then reading sources…" : "Reading sources…") : "Check for red flags"}
          </Button>
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          {effort === "advanced"
            ? "Advanced first lists the questions these facts raise, then reads up to ~30k characters of law and guidance before flagging."
            : "Normal checks the customary issues for this practice area against ~12k characters of law and guidance."}
        </p>
        {error && <p className="mt-2 rounded border border-ink-red/30 bg-ink-red/5 px-3 py-2 text-sm">{error}</p>}
      </Panel>

      <ListState query={reviews} empty="No tax check yet. Run one above — results are kept on the matter." rows={2}>
        {(list) => (
          <div className="grid gap-4 lg:grid-cols-[14rem_1fr]">
            <Panel title="Past checks" className="h-fit">
              <ul className="space-y-0.5">
                {list.map((r) => (
                  <li key={r.id}>
                    <button
                      onClick={() => setSelectedId(r.id)}
                      className={`w-full rounded px-2 py-1.5 text-left text-xs hover:bg-raised ${current?.id === r.id ? "bg-raised font-medium" : ""}`}
                    >
                      <div>{fmtDateTime(r.created_at)}</div>
                      <div className="text-muted-foreground">
                        {(r.result as unknown as Result).flags?.length ?? 0} flags · {r.effort}
                        {(r.result as unknown as Result).focus ? ` · ${(r.result as unknown as Result).focus}` : ""}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </Panel>
            {current && <ReviewView key={current.id} review={current} matterId={matter.id} />}
          </div>
        )}
      </ListState>
    </div>
  );
}

function ReviewView({ review, matterId }: { review: Tables<"reviews">; matterId: string }) {
  const qc = useQueryClient();
  const res = review.result as unknown as Result;
  const [decisions, setDecisions] = useState<Decisions>((review.decisions as Decisions) ?? {});
  const [sel, setSel] = useState<Record<number, boolean>>({});
  const [showDismissed, setShowDismissed] = useState(false);
  const [saving, setSaving] = useState(false);

  async function persist(next: Decisions) {
    setDecisions(next);
    await supabase.from("reviews").update({ decisions: next as unknown as Json }).eq("id", review.id);
    qc.invalidateQueries({ queryKey: ["reviews", matterId, "tax"] });
  }

  async function addTasks() {
    const idx = Object.entries(sel)
      .filter(([, v]) => v)
      .map(([k]) => Number(k));
    if (!idx.length) {
      toast("Tick the flags to add first.");
      return;
    }
    setSaving(true);
    await tryAction(async () => {
      const rows = idx.map((i) => {
        const f = res.flags[i]!;
        return {
          matter_id: matterId,
          title: `Tax: ${f.title} — ${f.next_step}`.slice(0, 300),
          assignee: f.for_cpa ? "Client" : "Attorney",
          source: "assist",
        };
      });
      await mut(supabase.from("tasks").insert(rows).select("id"), { success: `${rows.length} task${rows.length > 1 ? "s" : ""} added` });
      await logActivity(matterId, `Added ${rows.length} tax follow-up task${rows.length > 1 ? "s" : ""} from the red-flag review`);
      const next = { ...decisions };
      idx.forEach((i) => (next[String(i)] = "task"));
      await persist(next);
      setSel({});
      qc.invalidateQueries({ queryKey: ["tasks", matterId] });
      qc.invalidateQueries({ queryKey: ["activity", matterId] });
      qc.invalidateQueries({ queryKey: ["today-tasks"] });
    });
    setSaving(false);
  }

  const visible = res.flags.map((f, i) => ({ f, i })).filter(({ i }) => showDismissed || decisions[String(i)] !== "dismissed");
  const dismissedCount = res.flags.filter((_, i) => decisions[String(i)] === "dismissed").length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <UsageNote effort={review.effort as Effort} usage={{ inputTokens: review.input_tokens ?? undefined, outputTokens: review.output_tokens ?? undefined }} />
          <span className="text-muted-foreground">{fmtDateTime(review.created_at)}</span>
          {res.focus && <span className="rounded bg-raised px-1.5 py-0.5">Focus: {res.focus}</span>}
        </div>
        <div className="flex items-center gap-1.5">
          {dismissedCount > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setShowDismissed((s) => !s)}>
              {showDismissed ? <EyeOff className="mr-1 h-3.5 w-3.5" /> : <Eye className="mr-1 h-3.5 w-3.5" />}
              {showDismissed ? "Hide dismissed" : `Show ${dismissedCount} dismissed`}
            </Button>
          )}
          <Button size="sm" onClick={addTasks} disabled={saving || !Object.values(sel).some(Boolean)}>
            <ListChecks className="mr-1.5 h-3.5 w-3.5" />
            Add selected as tasks
          </Button>
        </div>
      </div>

      {res.note && <p className="text-xs text-muted-foreground">{res.note}</p>}

      {visible.length === 0 ? (
        <p className="rounded border bg-card px-3 py-6 text-center text-sm text-muted-foreground">No flags on these facts.</p>
      ) : (
        <ul className="space-y-2">
          {visible.map(({ f, i }) => {
            const d = decisions[String(i)];
            return (
              <li key={i} className={`rounded border bg-card p-3 ${d === "dismissed" ? "opacity-60" : ""}`}>
                <div className="flex items-start gap-2.5">
                  <Checkbox className="mt-0.5" checked={!!sel[i]} onCheckedChange={(v) => setSel({ ...sel, [i]: !!v })} aria-label={`Select ${f.title}`} disabled={d === "task"} />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${sevTone[f.severity]}`}>{f.severity}</span>
                      <span className="text-sm font-semibold">{f.title}</span>
                      {f.for_cpa && <span className="rounded bg-ink-teal/10 px-1.5 py-0.5 text-[10px] font-semibold text-ink-teal">For CPA / tax counsel</span>}
                      {d === "task" && <span className="rounded bg-ink-green/10 px-1.5 py-0.5 text-[10px] font-semibold text-ink-green">Task added</span>}
                      {d === "reviewed" && <span className="rounded bg-raised px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">Reviewed</span>}
                    </div>
                    <p className="text-sm">{f.issue}</p>
                    <p className="text-xs text-muted-foreground">
                      <b className="text-foreground">In this matter:</b> {f.matter_facts}
                    </p>
                    <div className="rounded border-l-2 border-ink-blue/40 bg-raised/60 px-2.5 py-1.5 text-xs">
                      {f.basis ? (
                        <>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-mono font-medium">{f.basis.citation}</span>
                            <span className="text-muted-foreground">— {f.basis.title}</span>
                            <a href={f.basis.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-ink-blue hover:underline">
                              open <ExternalLink className="h-3 w-3" />
                            </a>
                            {f.verified ? (
                              <span className="inline-flex items-center gap-1 text-ink-green">
                                <CheckCircle2 className="h-3 w-3" /> quote verified in stored text
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-ink-amber">
                                <AlertTriangle className="h-3 w-3" /> quote not found verbatim — read the source
                              </span>
                            )}
                          </div>
                          {f.basis_quote && <blockquote className="mt-1 font-serif italic leading-relaxed">“{f.basis_quote}”</blockquote>}
                          {f.basis.version && <div className="mt-0.5 text-[10px] text-muted-foreground">{f.basis.version}</div>}
                        </>
                      ) : (
                        <span className="text-muted-foreground">No source in the library supports this flag yet — treat as a question to confirm, not a rule.</span>
                      )}
                    </div>
                    <p className="text-xs">
                      <b>Next step:</b> {f.next_step}
                    </p>
                    <div className="flex gap-1">
                      {d !== "reviewed" && d !== "task" && (
                        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => persist({ ...decisions, [String(i)]: "reviewed" })}>
                          Mark reviewed
                        </Button>
                      )}
                      {d !== "dismissed" ? (
                        <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" onClick={() => persist({ ...decisions, [String(i)]: "dismissed" })}>
                          Dismiss
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs"
                          onClick={() => {
                            const next = { ...decisions };
                            delete next[String(i)];
                            persist(next);
                          }}
                        >
                          Restore
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {res.clear?.length > 0 && (
        <Panel title="Checked, no flag">
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
            {res.clear.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </Panel>
      )}
      {res.sources?.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none hover:text-foreground">Sources read ({res.sources.length})</summary>
          <ul className="mt-1 space-y-0.5">
            {res.sources.map((s) => (
              <li key={s.ref}>
                <span className="font-semibold text-ink-blue">{s.ref}</span>{" "}
                <a href={s.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
                  <span className="font-mono">{s.citation}</span> — {s.title}
                </a>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
