import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { FileText, Upload, Map, Download, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import { mapDocument } from "@/lib/ai.functions";
import { extractText } from "@/lib/extract";
import { tableQ, logActivity } from "@/lib/data";
import { useEffort } from "@/hooks/use-effort";
import { Panel, Empty, EffortToggle, EffortBadge, ReviewBanner, Why } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";

export async function uploadMatterFile(matterId: string | null, file: File) {
  const path = `${matterId ?? "firm"}/${crypto.randomUUID()}-${file.name.replace(/[^\w.-]+/g, "_")}`;
  const { error } = await supabase.storage.from("matter-files").upload(path, file);
  if (error) throw error;
  let text = "";
  try { text = (await extractText(file)).slice(0, 200000); } catch { /* binary or unreadable — keep file only */ }
  const { data, error: e2 } = await supabase.from("files").insert({ matter_id: matterId, name: file.name, path, size: file.size, extracted_text: text || null }).select().single();
  if (e2) throw e2;
  return data;
}

export async function downloadFile(path: string) {
  const { data } = await supabase.storage.from("matter-files").createSignedUrl(path, 60);
  if (data?.signedUrl) window.open(data.signedUrl, "_blank");
}

export function FilesTab({ matterId }: { matterId: string }) {
  const { data = [] } = useQuery(tableQ("files", matterId));
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [mapping, setMapping] = useState<Tables<"files"> | null>(null);

  async function onFiles(list: FileList | null) {
    if (!list?.length) return;
    setBusy(true);
    try {
      for (const f of Array.from(list)) {
        await uploadMatterFile(matterId, f);
        await logActivity(matterId, `Added file ${f.name}`);
      }
      qc.invalidateQueries({ queryKey: ["files", matterId] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <label
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); onFiles(e.dataTransfer.files); }}
        className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed bg-card p-8 text-center hover:border-primary"
      >
        <Upload className="h-6 w-6 text-muted-foreground" />
        <p className="text-sm font-medium">{busy ? "Uploading…" : "Drop deal documents here, or click to choose"}</p>
        <p className="text-xs text-muted-foreground">PDF, Word (.docx) or text. LOIs, agreements, questionnaires.</p>
        <input type="file" multiple className="hidden" accept=".pdf,.docx,.txt,.md" onChange={(e) => onFiles(e.target.files)} />
      </label>
      <Panel title="Files">
        {!data.length ? <Empty>No files yet.</Empty> : (
          <ul className="divide-y">
            {data.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <FileText className="h-5 w-5 text-ink-blue" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{f.name}</p>
                  <p className="text-xs text-muted-foreground">{f.size ? `${Math.round(f.size / 1024)} KB` : ""} · {new Date(f.created_at).toLocaleDateString()}{!f.extracted_text && " · no readable text"}</p>
                </div>
                <Button size="sm" variant="outline" disabled={!f.extracted_text} onClick={() => setMapping(f)}><Map className="mr-1.5 h-3.5 w-3.5" />Map this deal</Button>
                <Button size="icon" variant="ghost" aria-label="Download" onClick={() => downloadFile(f.path)}><Download className="h-4 w-4" /></Button>
                <Button size="icon" variant="ghost" aria-label="Delete" onClick={async () => { await supabase.storage.from("matter-files").remove([f.path]); await supabase.from("files").delete().eq("id", f.id); qc.invalidateQueries({ queryKey: ["files", matterId] }); }}><Trash2 className="h-4 w-4" /></Button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {mapping && <IntakeDialog matterId={matterId} file={mapping} onClose={() => setMapping(null)} />}
    </div>
  );
}

type MapResult = Awaited<ReturnType<typeof mapDocument>>;

function IntakeDialog({ matterId, file, onClose }: { matterId: string; file: Tables<"files">; onClose: () => void }) {
  const [effort, setEffort] = useEffort();
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<(MapResult & { effort: typeof effort }) | null>(null);
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const run = useServerFn(mapDocument);
  const qc = useQueryClient();

  async function go() {
    setBusy(true);
    try {
      const r = await run({ data: { matterId, effort, fileName: file.name, text: file.extracted_text ?? "" } });
      setRes({ ...r, effort });
      const s: Record<string, boolean> = {};
      r.deadlines.forEach((_, i) => (s[`d${i}`] = true));
      r.tasks.forEach((_, i) => (s[`t${i}`] = true));
      r.deliverables.forEach((_, i) => (s[`c${i}`] = true));
      setSel(s);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!res) return;
    const d = res.deadlines.filter((_, i) => sel[`d${i}`] && /^\d{4}-\d{2}-\d{2}$/.test(_.due_on)).map((x) => ({ matter_id: matterId, title: x.title, due_on: x.due_on, kind: x.kind, source: "assist" }));
    const t = res.tasks.filter((_, i) => sel[`t${i}`]).map((x) => ({ matter_id: matterId, title: x.title, assignee: x.assignee, source: "assist" }));
    const c = res.deliverables.filter((_, i) => sel[`c${i}`]).map((x, i) => ({ matter_id: matterId, deliverable: x.deliverable, responsible: x.responsible, position: 100 + i }));
    if (d.length) await supabase.from("deadlines").insert(d);
    if (t.length) await supabase.from("tasks").insert(t);
    if (c.length) await supabase.from("closing_items").insert(c);
    await logActivity(matterId, `Mapped ${file.name}: ${d.length} deadlines, ${t.length} tasks, ${c.length} closing items`);
    ["deadlines", "tasks", "closing_items", "activity"].forEach((k) => qc.invalidateQueries({ queryKey: [k, matterId] }));
    toast.success("Added to the matter");
    onClose();
  }

  const Row = ({ k, title, meta, why }: { k: string; title: string; meta: string; why: string }) => (
    <li className="flex gap-2 rounded-lg border p-2">
      <Checkbox checked={!!sel[k]} onCheckedChange={(v) => setSel({ ...sel, [k]: !!v })} />
      <div className="min-w-0 text-sm">{title} <span className="text-xs text-muted-foreground">· {meta}</span><Why text={why} /></div>
    </li>
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader><DialogTitle>Map this deal — {file.name}</DialogTitle></DialogHeader>
        {!res ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">Mirza reads the document and suggests the dates, deadlines, tasks and closing deliverables to track. You pick what gets added.</p>
            <div className="flex items-center justify-between gap-2">
              <EffortToggle value={effort} onChange={setEffort} />
              <Button onClick={go} disabled={busy}>{busy ? "Reading…" : "Map this deal"}</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <ReviewBanner />
            <div>
              <div className="flex items-center gap-2"><h3 className="font-semibold">{res.document_type}</h3><EffortBadge effort={res.effort} /></div>
              <p className="text-sm text-muted-foreground">{res.summary}</p>
            </div>
            {res.parties.length > 0 && (
              <div className="flex flex-wrap gap-2">{res.parties.map((p, i) => <span key={i} className="rounded-md bg-raised px-2 py-1 text-xs"><b>{p.name}</b> · {p.role}</span>)}</div>
            )}
            <Section title="Deadlines">{res.deadlines.map((x, i) => <Row key={i} k={`d${i}`} title={x.title} meta={`${x.due_on} · ${x.kind}`} why={x.why} />)}</Section>
            <Section title="Tasks">{res.tasks.map((x, i) => <Row key={i} k={`t${i}`} title={x.title} meta={x.assignee} why={x.why} />)}</Section>
            <Section title="Closing deliverables">{res.deliverables.map((x, i) => <Row key={i} k={`c${i}`} title={x.deliverable} meta={x.responsible} why={x.why} />)}</Section>
            <div className="flex justify-end gap-2"><Button variant="outline" onClick={onClose}>Discard</Button><Button onClick={apply}>Add selected</Button></div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode[] }) {
  if (!children.length) return null;
  return (
    <div>
      <p className="mb-1 text-xs font-semibold text-muted-foreground">{title}</p>
      <ul className="space-y-2">{children}</ul>
    </div>
  );
}
