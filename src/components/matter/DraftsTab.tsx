import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { FilePlus2, Wand2, Check, X, Download, ArrowLeft } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import { suggestTemplateAnswers, suggestDraftEdits } from "@/lib/ai.functions";
import { tableQ, templatesQ, logActivity } from "@/lib/data";
import { templateFields, fillTemplate } from "@/lib/extract";
import { useEffort } from "@/hooks/use-effort";
import { Panel, Empty, EffortToggle, ReviewBanner, Why, PracticeChip } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

export function DraftsTab({ matter }: { matter: Tables<"matters"> }) {
  const { data = [] } = useQuery(tableQ("drafts", matter.id));
  const [mode, setMode] = useState<{ kind: "list" } | { kind: "new" } | { kind: "edit"; draft: Tables<"drafts"> }>({ kind: "list" });

  if (mode.kind === "new") return <NewDraft matter={matter} onDone={(d) => setMode(d ? { kind: "edit", draft: d } : { kind: "list" })} />;
  if (mode.kind === "edit") return <DraftEditor matter={matter} draft={mode.draft} onBack={() => setMode({ kind: "list" })} />;

  return (
    <Panel title="Drafts" action={<Button size="sm" onClick={() => setMode({ kind: "new" })}><FilePlus2 className="mr-1.5 h-4 w-4" />New from house template</Button>}>
      {!data.length ? <Empty>No drafts yet. Start one from your firm's house templates.</Empty> : (
        <ul className="divide-y">
          {data.map((d) => (
            <li key={d.id}>
              <button className="flex w-full items-center justify-between py-2.5 text-left hover:text-primary" onClick={() => setMode({ kind: "edit", draft: d })}>
                <span className="text-sm font-medium">{d.title}</span>
                <span className="text-xs text-muted-foreground">{d.status} · {new Date(d.updated_at).toLocaleDateString()}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function NewDraft({ matter, onDone }: { matter: Tables<"matters">; onDone: (d?: Tables<"drafts">) => void }) {
  const { data: templates = [] } = useQuery(templatesQ);
  const [tpl, setTpl] = useState<Tables<"templates"> | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [whys, setWhys] = useState<Record<string, string>>({});
  const [effort, setEffort] = useEffort();
  const [busy, setBusy] = useState(false);
  const fields = useMemo(() => (tpl ? templateFields(tpl.body) : []), [tpl]);
  const suggest = useServerFn(suggestTemplateAnswers);
  const qc = useQueryClient();

  async function fillFromMatter() {
    setBusy(true);
    try {
      const r = await suggest({ data: { matterId: matter.id, effort, fields } });
      const a = { ...answers }, w: Record<string, string> = {};
      r.answers.forEach((x) => { if (x.value && !a[x.field]) { a[x.field] = x.value; w[x.field] = x.why; } });
      setAnswers(a); setWhys(w);
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }

  async function create() {
    if (!tpl) return;
    const { data, error } = await supabase.from("drafts").insert({ matter_id: matter.id, template_id: tpl.id, title: `${tpl.name} — ${matter.client ?? matter.title}`, body: fillTemplate(tpl.body, answers) }).select().single();
    if (error) return toast.error(error.message);
    await logActivity(matter.id, `Created draft from house template "${tpl.name}"`);
    qc.invalidateQueries({ queryKey: ["drafts", matter.id] });
    onDone(data);
  }

  if (!tpl) {
    const sorted = [...templates].sort((a, b) => Number(b.practice_area === matter.practice_area) - Number(a.practice_area === matter.practice_area));
    return (
      <Panel title="Choose a house template" action={<Button size="sm" variant="ghost" onClick={() => onDone()}><ArrowLeft className="mr-1 h-4 w-4" />Back</Button>}>
        {!sorted.length ? (
          <Empty>No house templates yet. <Link to="/templates" className="text-primary underline">Upload your firm's forms</Link> first.</Empty>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {sorted.map((t) => (
              <li key={t.id}>
                <button onClick={() => setTpl(t)} className="w-full rounded-lg border bg-raised p-3 text-left hover:border-primary">
                  <p className="text-sm font-medium">{t.name}</p>
                  <div className="mt-1 flex items-center gap-2">{t.practice_area && <PracticeChip area={t.practice_area} />}<span className="text-xs text-muted-foreground">{templateFields(t.body).length} blanks</span></div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    );
  }

  return (
    <Panel title={`Fill in: ${tpl.name}`} action={<Button size="sm" variant="ghost" onClick={() => setTpl(null)}><ArrowLeft className="mr-1 h-4 w-4" />Templates</Button>}>
      {!fields.length ? (
        <p className="mb-3 text-sm text-muted-foreground">This template has no blanks marked with [[Field]] or {"{{Field}}"}. It will be copied as is.</p>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">Answer the template's questions. The house form stays exactly as written.</p>
            <div className="flex items-center gap-2">
              <EffortToggle value={effort} onChange={setEffort} />
              <Button size="sm" variant="outline" disabled={busy} onClick={fillFromMatter}><Wand2 className="mr-1.5 h-3.5 w-3.5" />{busy ? "Looking…" : "Fill from matter"}</Button>
            </div>
          </div>
          {Object.keys(whys).length > 0 && <div className="mb-3"><ReviewBanner /></div>}
          <div className="grid gap-3 sm:grid-cols-2">
            {fields.map((f) => (
              <div key={f} className="space-y-1">
                <Label className="text-xs">{f}{whys[f] && <span className="ml-1 rounded bg-ink-purple/10 px-1 text-[10px] text-ink-purple">suggested</span>}</Label>
                <Input value={answers[f] ?? ""} onChange={(e) => setAnswers({ ...answers, [f]: e.target.value })} />
                {whys[f] && <Why text={whys[f]} />}
              </div>
            ))}
          </div>
        </>
      )}
      <div className="mt-4 flex justify-end"><Button onClick={create}>Create draft</Button></div>
    </Panel>
  );
}

type Edit = { original: string; suggested: string; reason: string; state: "pending" | "accepted" | "rejected" };

function DraftEditor({ matter, draft, onBack }: { matter: Tables<"matters">; draft: Tables<"drafts">; onBack: () => void }) {
  const [body, setBody] = useState(draft.body);
  const [instruction, setInstruction] = useState("");
  const [edits, setEdits] = useState<Edit[]>([]);
  const [effort, setEffort] = useEffort();
  const [busy, setBusy] = useState(false);
  const run = useServerFn(suggestDraftEdits);
  const qc = useQueryClient();

  async function propose() {
    setBusy(true);
    try {
      const r = await run({ data: { matterId: matter.id, effort, body, instruction } });
      const valid = r.edits.filter((e) => e.original && body.includes(e.original));
      if (!valid.length) toast("No targeted edits suggested — the house form looks fine as is.");
      setEdits(valid.map((e) => ({ ...e, state: "pending" })));
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  function decide(i: number, accept: boolean) {
    const e = edits[i];
    if (accept) setBody((b) => b.replace(e.original, e.suggested));
    setEdits(edits.map((x, j) => (j === i ? { ...x, state: accept ? "accepted" : "rejected" } : x)));
  }
  async function save() {
    await supabase.from("drafts").update({ body, updated_at: new Date().toISOString() }).eq("id", draft.id);
    qc.invalidateQueries({ queryKey: ["drafts", matter.id] });
    toast.success("Draft saved");
  }
  function download() {
    const html = `<html><head><meta charset="utf-8"></head><body style="font-family:Times New Roman;white-space:pre-wrap">${body.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</body></html>`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([html], { type: "application/msword" }));
    a.download = `${draft.title}.doc`;
    a.click();
  }

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <Panel className="lg:col-span-3" title={draft.title} action={<div className="flex gap-1"><Button size="sm" variant="ghost" onClick={onBack}><ArrowLeft className="mr-1 h-4 w-4" />Drafts</Button><Button size="sm" variant="outline" onClick={download}><Download className="mr-1 h-4 w-4" />Word</Button><Button size="sm" onClick={save}>Save</Button></div>}>
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} className="min-h-[60vh] bg-raised font-serif text-[13px] leading-relaxed" />
      </Panel>
      <Panel className="lg:col-span-2" title="Drafting assistant">
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">Suggests small, targeted redlines to the house form for this deal. It never rewrites sections — you accept or reject each change.</p>
          <Textarea rows={3} placeholder="Optional: what should change? e.g. 'Seller is an Illinois LLC; closing is Nov 14'" value={instruction} onChange={(e) => setInstruction(e.target.value)} />
          <div className="flex items-center justify-between gap-2">
            <EffortToggle value={effort} onChange={setEffort} />
            <Button size="sm" onClick={propose} disabled={busy}><Wand2 className="mr-1.5 h-3.5 w-3.5" />{busy ? "Reviewing…" : "Suggest redlines"}</Button>
          </div>
          {edits.length > 0 && <ReviewBanner />}
          <ul className="space-y-2">
            {edits.map((e, i) => (
              <li key={i} className={`rounded-lg border p-3 text-sm ${e.state !== "pending" ? "opacity-60" : ""}`}>
                <p className="leading-relaxed"><span className="redline-del">{e.original}</span> <span className="redline-ins">{e.suggested}</span></p>
                <p className="mt-1 text-xs text-muted-foreground">{e.reason}</p>
                {e.state === "pending" ? (
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => decide(i, true)}><Check className="mr-1 h-3.5 w-3.5 text-ink-green" />Accept</Button>
                    <Button size="sm" variant="ghost" onClick={() => decide(i, false)}><X className="mr-1 h-3.5 w-3.5" />Reject</Button>
                  </div>
                ) : <p className="mt-1 text-xs font-medium">{e.state === "accepted" ? "Accepted" : "Rejected"}</p>}
              </li>
            ))}
          </ul>
        </div>
      </Panel>
    </div>
  );
}
