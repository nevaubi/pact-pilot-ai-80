import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { FileSearch, Loader2, ListPlus, CheckCircle2, AlertTriangle, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import { reviewTitleSurvey } from "@/lib/realestate.functions";
import { reviewsQ, tableQ, logActivity, fmtDateTime } from "@/lib/data";
import { authoritiesQ, type AuthorityRow } from "@/lib/library";
import { mut, tryAction } from "@/lib/mutate";
import { useEffort } from "@/hooks/use-effort";
import { Panel, ListState, EffortToggle, UsageNote, ReviewBanner, type Effort } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Result = Awaited<ReturnType<typeof reviewTitleSurvey>>;
type Exception = Result["exceptions"][number];

const DOC_TYPES = [
  ["", "—"],
  ["title_commitment", "Title commitment"],
  ["survey", "Survey"],
  ["contract", "Contract"],
  ["deed", "Deed / vesting"],
  ["payoff", "Payoff / release"],
  ["other", "Other"],
] as const;

const catTone: Record<string, string> = {
  standard: "bg-raised text-muted-foreground",
  tax: "bg-ink-amber/10 text-ink-amber",
  mortgage: "bg-ink-red/10 text-ink-red",
  lien: "bg-ink-red/10 text-ink-red",
  easement: "bg-ink-teal/10 text-ink-teal",
  covenant: "bg-ink-purple/10 text-ink-purple",
  survey: "bg-ink-blue/10 text-ink-blue",
  lease: "bg-ink-purple/10 text-ink-purple",
  other: "bg-raised text-muted-foreground",
};
const actionTone: Record<string, string> = {
  clear: "bg-ink-red/10 text-ink-red",
  waive: "bg-ink-blue/10 text-ink-blue",
  endorse: "bg-ink-purple/10 text-ink-purple",
  accept: "bg-ink-green/10 text-ink-green",
  investigate: "bg-ink-amber/10 text-ink-amber",
};
const sevTone: Record<string, string> = { high: "bg-ink-red/10 text-ink-red", medium: "bg-ink-amber/10 text-ink-amber", low: "bg-raised text-muted-foreground" };

export function TitleReview({ matter, property, onOpenAuthority }: { matter: Tables<"matters">; property: Tables<"matter_properties"> | null; onOpenAuthority: (a: AuthorityRow) => void }) {
  const qc = useQueryClient();
  const files = useQuery(tableQ("files", matter.id));
  const reviews = useQuery(reviewsQ(matter.id, "title"));
  const [effort, setEffort] = useEffort();
  const [instruction, setInstruction] = useState("");
  const [commitmentId, setCommitmentId] = useState("");
  const [surveyId, setSurveyId] = useState("");
  const [contractId, setContractId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const run = useServerFn(reviewTitleSurvey);
  void property;

  const readable = (files.data ?? []).filter((f) => f.extracted_text);
  const pick = (type: string) => readable.find((f) => f.doc_type === type)?.id ?? "";
  const cId = commitmentId || pick("title_commitment");
  const sId = surveyId || pick("survey");
  const kId = contractId || pick("contract");

  async function tag(f: Tables<"files">, doc_type: string) {
    await tryAction(async () => {
      await mut(supabase.from("files").update({ doc_type: doc_type || null }).eq("id", f.id).select("id"));
      qc.invalidateQueries({ queryKey: ["files", matter.id] });
    });
  }

  async function go() {
    if (!cId && !sId) {
      toast("Choose a title commitment or a survey first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await run({
        data: {
          matterId: matter.id,
          effort,
          ...(cId ? { commitmentId: cId } : {}),
          ...(sId ? { surveyId: sId } : {}),
          ...(kId ? { contractId: kId } : {}),
          ...(instruction.trim() ? { instruction: instruction.trim() } : {}),
        },
      });
      await logActivity(matter.id, `Ran title & survey review (${r.exceptions.length} exceptions, ${effort})`);
      qc.invalidateQueries({ queryKey: ["reviews", matter.id, "title"] });
      qc.invalidateQueries({ queryKey: ["activity", matter.id] });
      qc.invalidateQueries({ queryKey: ["ai-usage"] });
      setSelectedId(r.reviewId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const current = useMemo(() => {
    const list = reviews.data ?? [];
    return list.find((r) => r.id === selectedId) ?? list[0] ?? null;
  }, [reviews.data, selectedId]);

  return (
    <Panel title="Title & survey review">
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Tag the documents on the Files tab (or here), then run the review. Mirza classifies every Schedule B exception, recommends the customary action, cross-references the survey, and cites the law it leans on. You decide what goes on the checklist.
        </p>
        <ListState query={files} empty="No files on this matter yet. Upload the title commitment and survey on the Files tab." rows={2}>
          {(rows) => (
            <ul className="divide-y rounded border">
              {rows.map((f) => (
                <li key={f.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-sm">
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  {!f.extracted_text && <span className="text-xs text-ink-amber">no readable text</span>}
                  <Select value={f.doc_type ?? ""} onValueChange={(v) => tag(f, v)}>
                    <SelectTrigger className="h-7 w-40 text-xs" aria-label={`Document type for ${f.name}`}>
                      <SelectValue placeholder="Type" />
                    </SelectTrigger>
                    <SelectContent>
                      {DOC_TYPES.filter(([v]) => v !== "").map(([v, l]) => (
                        <SelectItem key={v} value={v}>
                          {l}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </li>
              ))}
            </ul>
          )}
        </ListState>
        <div className="grid gap-2 sm:grid-cols-3">
          <FilePick label="Title commitment" value={cId} onChange={setCommitmentId} files={readable} />
          <FilePick label="Plat of survey" value={sId} onChange={setSurveyId} files={readable} />
          <FilePick label="Contract (optional)" value={kId} onChange={setContractId} files={readable} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="Instruction (optional): e.g. buyer wants extended coverage; focus on the shared driveway" className="min-w-[16rem] flex-1" aria-label="Instruction" />
          <EffortToggle value={effort} onChange={setEffort} />
          <Button onClick={go} disabled={busy || (!cId && !sId)}>
            {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <FileSearch className="mr-1.5 h-4 w-4" />}
            {busy ? "Reading the documents…" : "Review title & survey"}
          </Button>
        </div>
        {error && <p className="rounded border border-ink-red/30 bg-ink-red/5 px-3 py-2 text-sm">{error}</p>}

        <ListState query={reviews} empty="No review yet." rows={1}>
          {(list) => (
            <div className="space-y-3">
              {list.length > 1 && (
                <div className="flex flex-wrap gap-1.5 text-xs">
                  {list.map((r) => (
                    <button key={r.id} onClick={() => setSelectedId(r.id)} className={`rounded border px-2 py-1 ${current?.id === r.id ? "bg-raised font-medium" : "hover:bg-raised"}`}>
                      {fmtDateTime(r.created_at)} · {r.effort}
                    </button>
                  ))}
                </div>
              )}
              {current && <ReviewBody key={current.id} review={current} matterId={matter.id} onOpenAuthority={onOpenAuthority} />}
            </div>
          )}
        </ListState>
      </div>
    </Panel>
  );
}

function FilePick({ label, value, onChange, files }: { label: string; value: string; onChange: (v: string) => void; files: Tables<"files">[] }) {
  return (
    <div className="space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Select value={value || "none"} onValueChange={(v) => onChange(v === "none" ? "" : v)}>
        <SelectTrigger aria-label={label} className="text-xs">
          <SelectValue placeholder="None" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">None</SelectItem>
          {files.map((f) => (
            <SelectItem key={f.id} value={f.id}>
              {f.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function ReviewBody({ review, matterId, onOpenAuthority }: { review: Tables<"reviews">; matterId: string; onOpenAuthority: (a: AuthorityRow) => void }) {
  const qc = useQueryClient();
  const lib = useQuery(authoritiesQ);
  const closing = useQuery(tableQ("closing_items", matterId));
  const res = review.result as unknown as Omit<Result, "reviewId" | "createdAt" | "usage" | "runId">;
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const existing = new Set((closing.data ?? []).map((c) => c.deliverable.toLowerCase()));
  const byId = useMemo(() => new Map((lib.data ?? []).map((a) => [a.id, a])), [lib.data]);

  const exceptionItem = (e: Exception) => ({
    deliverable: `Title exception ${e.number}: ${e.action} — ${e.text.slice(0, 120)}${e.text.length > 120 ? "…" : ""}`,
    responsible: e.category === "mortgage" || e.category === "lien" ? "Seller" : e.category === "standard" ? "Seller / Title" : "Title",
    notes: `${e.why}${e.survey_match ? ` Survey: ${e.survey_match}` : ""}`,
  });

  async function addSelected() {
    const items: { deliverable: string; responsible: string; notes: string }[] = [];
    res.exceptions.forEach((e, i) => {
      if (sel[`e${i}`]) items.push(exceptionItem(e));
    });
    res.checklist.forEach((c, i) => {
      if (sel[`c${i}`]) items.push({ deliverable: c.deliverable, responsible: c.responsible, notes: c.why });
    });
    res.requirements.forEach((r, i) => {
      if (sel[`r${i}`]) items.push({ deliverable: `Schedule B-I requirement: ${r.text.slice(0, 140)}`, responsible: r.who, notes: r.action });
    });
    const fresh = items.filter((x) => !existing.has(x.deliverable.toLowerCase()));
    if (!fresh.length) {
      toast("Nothing new selected.");
      return;
    }
    setSaving(true);
    await tryAction(async () => {
      const base = 300 + (closing.data?.length ?? 0);
      await mut(
        supabase
          .from("closing_items")
          .insert(fresh.map((x, i) => ({ matter_id: matterId, ...x, position: base + i })))
          .select("id"),
        { success: `${fresh.length} item${fresh.length > 1 ? "s" : ""} added to the closing checklist` },
      );
      await logActivity(matterId, `Added ${fresh.length} title/survey item${fresh.length > 1 ? "s" : ""} to the closing checklist`);
      qc.invalidateQueries({ queryKey: ["closing_items", matterId] });
      setSel({});
    });
    setSaving(false);
  }

  const selectActionable = () => {
    const s: Record<string, boolean> = {};
    res.exceptions.forEach((e, i) => {
      if (e.action !== "accept") s[`e${i}`] = true;
    });
    res.checklist.forEach((_, i) => (s[`c${i}`] = true));
    res.requirements.forEach((_, i) => (s[`r${i}`] = true));
    setSel(s);
  };
  const picked = Object.values(sel).filter(Boolean).length;

  return (
    <div className="space-y-3 rounded border bg-card p-3">
      <ReviewBanner />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <UsageNote effort={review.effort as Effort} usage={{ inputTokens: review.input_tokens ?? undefined, outputTokens: review.output_tokens ?? undefined }} />
          <span className="text-muted-foreground">{fmtDateTime(review.created_at)}</span>
          <span className="text-muted-foreground">· {res.files.map((f) => f.name).join(", ")}</span>
        </div>
        <div className="flex gap-1.5">
          <Button size="sm" variant="ghost" onClick={selectActionable}>
            Select everything needing action
          </Button>
          <Button size="sm" onClick={addSelected} disabled={saving || !picked}>
            <ListPlus className="mr-1.5 h-3.5 w-3.5" /> Add {picked || ""} to closing checklist
          </Button>
        </div>
      </div>
      <p className="text-sm">{res.summary}</p>

      {res.schedule_a.length > 0 && (
        <section>
          <h4 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Schedule A</h4>
          <table className="w-full text-xs">
            <tbody className="divide-y">
              {res.schedule_a.map((a, i) => (
                <tr key={i}>
                  <td className="py-1 pr-2 text-muted-foreground">{a.item}</td>
                  <td className="py-1 pr-2">{a.value}</td>
                  <td className="py-1">
                    {a.ok ? <span className="inline-flex items-center gap-1 text-ink-green"><CheckCircle2 className="h-3 w-3" /> consistent</span> : <span className="inline-flex items-center gap-1 text-ink-amber"><AlertTriangle className="h-3 w-3" /> {a.why}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {res.requirements.length > 0 && (
        <section>
          <h4 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Schedule B-I requirements</h4>
          <ul className="space-y-1">
            {res.requirements.map((r, i) => (
              <li key={i} className="flex items-start gap-2 text-xs">
                <Checkbox className="mt-0.5" checked={!!sel[`r${i}`]} onCheckedChange={(v) => setSel({ ...sel, [`r${i}`]: !!v })} aria-label={r.text} />
                <span>
                  <span className="font-medium">{r.who}:</span> {r.text} <span className="text-muted-foreground">— {r.action}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {res.exceptions.length > 0 && (
        <section>
          <h4 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Schedule B exceptions ({res.exceptions.length})</h4>
          <ul className="divide-y rounded border">
            {res.exceptions.map((e, i) => (
              <li key={i} className="flex items-start gap-2 px-2.5 py-2 text-xs">
                <Checkbox className="mt-0.5" checked={!!sel[`e${i}`]} onCheckedChange={(v) => setSel({ ...sel, [`e${i}`]: !!v })} aria-label={`Exception ${e.number}`} />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono font-semibold">#{e.number}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${catTone[e.category] ?? catTone["other"]}`}>{e.category}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${actionTone[e.action]}`}>{e.action}</span>
                  </div>
                  <blockquote className="border-l-2 pl-2 font-serif italic leading-relaxed">{e.text}</blockquote>
                  <p>{e.why}</p>
                  {e.survey_match && (
                    <p className="text-ink-blue">
                      <b>Survey:</b> {e.survey_match}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {res.survey_findings.length > 0 && (
        <section>
          <h4 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Survey findings</h4>
          <ul className="space-y-1.5">
            {res.survey_findings.map((s, i) => (
              <li key={i} className="rounded border px-2.5 py-1.5 text-xs">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${sevTone[s.severity]}`}>{s.severity}</span>
                  <span className="font-medium">{s.finding}</span>
                  {s.relates_to && <span className="text-muted-foreground">· exception #{s.relates_to}</span>}
                </div>
                {s.verbatim && <blockquote className="mt-1 border-l-2 pl-2 font-serif italic">{s.verbatim}</blockquote>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {res.flags.length > 0 && (
        <section>
          <h4 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Flags</h4>
          <ul className="space-y-1.5">
            {res.flags.map((f, i) => {
              const a = f.basis ? byId.get(f.basis.authority_id) : undefined;
              return (
                <li key={i} className="rounded border px-2.5 py-1.5 text-xs">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${sevTone[f.severity]}`}>{f.severity}</span>
                    <span className="font-medium">{f.title}</span>
                  </div>
                  <p className="mt-0.5">{f.detail}</p>
                  {f.basis && (
                    <div className="mt-1 rounded border-l-2 border-ink-blue/40 bg-raised/60 px-2 py-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button className="font-mono font-medium hover:underline" onClick={() => a && onOpenAuthority(a)}>
                          {f.basis.citation}
                        </button>
                        <a href={f.basis.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-ink-blue hover:underline">
                          open <ExternalLink className="h-3 w-3" />
                        </a>
                        {f.verified ? <span className="inline-flex items-center gap-1 text-ink-green"><CheckCircle2 className="h-3 w-3" /> quote verified</span> : <span className="inline-flex items-center gap-1 text-ink-amber"><AlertTriangle className="h-3 w-3" /> quote not found verbatim</span>}
                      </div>
                      {f.basis_quote && <blockquote className="mt-0.5 font-serif italic">“{f.basis_quote}”</blockquote>}
                    </div>
                  )}
                  <p className="mt-0.5">
                    <b>Next:</b> {f.next_step}
                  </p>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {res.checklist.length > 0 && (
        <section>
          <h4 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Closing deliverables this review adds</h4>
          <ul className="space-y-1">
            {res.checklist.map((c, i) => (
              <li key={i} className="flex items-start gap-2 text-xs">
                <Checkbox className="mt-0.5" checked={!!sel[`c${i}`]} disabled={existing.has(c.deliverable.toLowerCase())} onCheckedChange={(v) => setSel({ ...sel, [`c${i}`]: !!v })} aria-label={c.deliverable} />
                <span>
                  <span className="font-medium">{c.deliverable}</span> <span className="text-muted-foreground">— {c.responsible} · {c.why}</span>
                  {existing.has(c.deliverable.toLowerCase()) && <span className="ml-1 rounded bg-ink-green/10 px-1 text-[10px] font-semibold text-ink-green">on checklist</span>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
