import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { FileText, Upload, Map, Download, ScanText } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import { mapDocument } from "@/lib/ai.functions";
import { extractText, ocrPdf } from "@/lib/extract";
import { tableQ, logActivity, fmtDate } from "@/lib/data";
import { mut, tryAction, humanize } from "@/lib/mutate";
import { useEffort } from "@/hooks/use-effort";
import {
  Panel,
  ListState,
  DeleteButton,
  EffortToggle,
  UsageNote,
  ReviewBanner,
  Why,
} from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { toast } from "sonner";

export const MAX_FILE_MB = 25;
const ACCEPT = ".pdf,.docx,.txt,.md";

export async function uploadMatterFile(
  matterId: string | null,
  file: File,
  onOcr?: (page: number, total: number) => void,
) {
  if (file.size > MAX_FILE_MB * 1024 * 1024)
    throw new Error(`${file.name} is larger than ${MAX_FILE_MB} MB.`);
  const path = `${matterId ?? "firm"}/${crypto.randomUUID()}-${file.name.replace(/[^\w.-]+/g, "_")}`;
  const { error } = await supabase.storage.from("matter-files").upload(path, file);
  if (error) throw new Error(humanize(error.message));
  let text = "";
  let readable = true;
  try {
    text = (await extractText(file)).replace(/\s+\n/g, "\n").trim().slice(0, 300000);
  } catch {
    readable = false;
  }
  if (text.length < 50 && file.name.toLowerCase().endsWith(".pdf")) {
    try {
      const o = (await ocrPdf(file, onOcr)).slice(0, 300000);
      if (o.length > text.length) {
        text = o;
        readable = true;
      }
    } catch {
      /* keep stored; user can retry from the list */
    }
  }
  const { data, error: e2 } = await supabase
    .from("files")
    .insert({
      matter_id: matterId,
      name: file.name,
      path,
      size: file.size,
      extracted_text: text || null,
    })
    .select()
    .single();
  if (e2) {
    await supabase.storage.from("matter-files").remove([path]);
    throw new Error(humanize(e2.message));
  }
  return { row: data, readable: readable && text.length > 0 };
}

export async function downloadFile(path: string, name?: string) {
  const { data, error } = await supabase.storage
    .from("matter-files")
    .createSignedUrl(path, 120, name ? { download: name } : undefined);
  if (error || !data?.signedUrl) {
    toast.error("Couldn't open the file", {
      description: error ? humanize(error.message) : undefined,
    });
    return;
  }
  window.open(data.signedUrl, "_blank", "noopener");
}

export async function deleteFile(f: { id: string; path: string }) {
  await supabase.storage.from("matter-files").remove([f.path]);
  await mut(supabase.from("files").delete().eq("id", f.id).select("id"), {
    success: "File deleted",
  });
}

export function FilesTab({ matterId }: { matterId: string }) {
  const q = useQuery(tableQ("files", matterId));
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [mapping, setMapping] = useState<Tables<"files"> | null>(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["files", matterId] });
    qc.invalidateQueries({ queryKey: ["files-hub"] });
    qc.invalidateQueries({ queryKey: ["activity", matterId] });
  };

  async function onFiles(list: FileList | File[] | null) {
    const files = Array.from(list ?? []);
    if (!files.length) return;
    for (const f of files) {
      setBusy(`Uploading ${f.name}…`);
      await tryAction(async () => {
        const { readable } = await uploadMatterFile(matterId, f, (p, n) =>
          setBusy(`Reading scanned page ${p} of ${n} — ${f.name}`),
        );
        await logActivity(matterId, `Added file ${f.name}`);
        if (readable)
          toast.success(`${f.name} added`, { description: "Text extracted — ready to map." });
        else
          toast.warning(`${f.name} added, but no readable text`, {
            description: "Text couldn't be read from this file. It is still stored on the matter.",
          });
      }, "Upload failed");
      refresh();
    }
    setBusy(null);
  }

  async function readScanned(f: Tables<"files">) {
    setBusy(`Reading ${f.name}…`);
    await tryAction(async () => {
      const { data, error } = await supabase.storage.from("matter-files").download(f.path);
      if (error || !data) throw new Error(humanize(error?.message ?? "Download failed"));
      const text = (
        await ocrPdf(data, (p, n) => setBusy(`Reading scanned page ${p} of ${n} — ${f.name}`))
      ).slice(0, 300000);
      if (text.length < 20) throw new Error("No text could be recognised in this document.");
      await mut(supabase.from("files").update({ extracted_text: text }).eq("id", f.id).select("id"), {
        success: `${f.name}: text read — ready to map`,
      });
      refresh();
    }, "Couldn't read the scanned document");
    setBusy(null);
  }

  return (
    <div className="space-y-4">
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          onFiles(e.dataTransfer.files);
        }}
        className={`flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed bg-card p-8 text-center transition-colors ${over ? "border-primary bg-primary/5" : "hover:border-primary"} ${busy ? "pointer-events-none opacity-70" : ""}`}
      >
        <Upload className="h-6 w-6 text-muted-foreground" />
        <p className="text-sm font-medium">
          {busy ? `Uploading ${busy}…` : "Drop deal documents here, or click to choose"}
        </p>
        <p className="text-xs text-muted-foreground">
          PDF, Word (.docx) or text, up to {MAX_FILE_MB} MB. LOIs, agreements, questionnaires.
        </p>
        <input
          type="file"
          multiple
          className="hidden"
          accept={ACCEPT}
          onChange={(e) => {
            onFiles(e.target.files);
            e.target.value = "";
          }}
          disabled={!!busy}
        />
      </label>
      <Panel title="Files">
        <ListState
          query={q}
          empty="No files yet. Drop an LOI or agreement above, then use “Map this deal” to pull out its dates and deliverables."
        >
          {(rows) => (
            <ul className="divide-y">
              {rows.map((f) => (
                <li key={f.id} className="flex flex-wrap items-center gap-3 py-2.5">
                  <FileText className="h-5 w-5 shrink-0 text-ink-blue" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{f.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {f.size ? `${Math.max(1, Math.round(f.size / 1024))} KB · ` : ""}
                      {fmtDate(f.created_at.slice(0, 10))}
                      {!f.extracted_text && (
                        <span
                          className="ml-1 text-ink-amber"
                          title="Scanned or image-only document. OCR isn't available yet."
                        >
                          · no readable text
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!f.extracted_text}
                      title={
                        f.extracted_text
                          ? "Pull dates, tasks and deliverables out of this document"
                          : "No readable text to map"
                      }
                      onClick={() => setMapping(f)}
                    >
                      <Map className="mr-1.5 h-3.5 w-3.5" />
                      Map this deal
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Download ${f.name}`}
                      onClick={() => downloadFile(f.path, f.name)}
                    >
                      <Download className="h-4 w-4" />
                    </Button>
                    <DeleteButton
                      what="file"
                      description={`${f.name} will be removed from the matter and from storage.`}
                      onConfirm={() =>
                        tryAction(async () => {
                          await deleteFile(f);
                          refresh();
                        })
                      }
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </ListState>
      </Panel>
      {mapping && (
        <IntakeDialog matterId={matterId} file={mapping} onClose={() => setMapping(null)} />
      )}
    </div>
  );
}

type MapResult = Awaited<ReturnType<typeof mapDocument>>;
const isoDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

function IntakeDialog({
  matterId,
  file,
  onClose,
}: {
  matterId: string;
  file: Tables<"files">;
  onClose: () => void;
}) {
  const [effort, setEffort] = useEffort();
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [res, setRes] = useState<(MapResult & { effort: typeof effort }) | null>(null);
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [dates, setDates] = useState<Record<number, string>>({});
  const run = useServerFn(mapDocument);
  const qc = useQueryClient();

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const r = await run({
        data: { matterId, effort, fileName: file.name, text: file.extracted_text ?? "" },
      });
      setRes({ ...r, effort });
      const s: Record<string, boolean> = {};
      const d: Record<number, string> = {};
      r.deadlines.forEach((x, i) => {
        s[`d${i}`] = isoDate(x.due_on);
        d[i] = isoDate(x.due_on) ? x.due_on : "";
      });
      r.tasks.forEach((_, i) => (s[`t${i}`] = true));
      r.deliverables.forEach((_, i) => (s[`c${i}`] = true));
      setSel(s);
      setDates(d);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!res || saving) return;
    setSaving(true);
    await tryAction(async () => {
      const d = res.deadlines
        .map((x, i) => ({ x, i }))
        .filter(({ i }) => sel[`d${i}`] && isoDate(dates[i] ?? ""))
        .map(({ x, i }) => ({
          matter_id: matterId,
          title: x.title,
          due_on: dates[i]!,
          kind: x.kind || "Contract",
          source: "assist",
        }));
      const t = res.tasks
        .filter((_, i) => sel[`t${i}`])
        .map((x) => ({
          matter_id: matterId,
          title: x.title,
          assignee: x.assignee || null,
          source: "assist",
        }));
      const c = res.deliverables
        .filter((_, i) => sel[`c${i}`])
        .map((x, i) => ({
          matter_id: matterId,
          deliverable: x.deliverable,
          responsible: x.responsible || null,
          position: 100 + i,
        }));
      if (!d.length && !t.length && !c.length) {
        toast("Nothing selected.");
        return;
      }
      if (d.length) await mut(supabase.from("deadlines").insert(d).select("id"));
      if (t.length) await mut(supabase.from("tasks").insert(t).select("id"));
      if (c.length) await mut(supabase.from("closing_items").insert(c).select("id"));
      await logActivity(
        matterId,
        `Mapped ${file.name}: ${d.length} deadlines, ${t.length} tasks, ${c.length} closing items`,
      );
      ["deadlines", "tasks", "closing_items", "activity"].forEach((k) =>
        qc.invalidateQueries({ queryKey: [k, matterId] }),
      );
      qc.invalidateQueries({ queryKey: ["today-deadlines"] });
      qc.invalidateQueries({ queryKey: ["today-tasks"] });
      toast.success("Added to the matter", {
        description: `${d.length} deadlines · ${t.length} tasks · ${c.length} closing items`,
      });
      onClose();
    });
    setSaving(false);
  }

  const toggleAll = (prefix: string, n: number, v: boolean) =>
    setSel((s) => {
      const c = { ...s };
      for (let i = 0; i < n; i++) c[`${prefix}${i}`] = v;
      return c;
    });
  const picked = Object.values(sel).filter(Boolean).length;

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScanText className="h-4 w-4 text-ink-purple" />
            Map this deal
          </DialogTitle>
          <DialogDescription className="truncate">{file.name}</DialogDescription>
        </DialogHeader>
        {!res ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Mirza reads the document and suggests the dates, deadlines, tasks and closing
              deliverables worth tracking. Nothing is added until you tick it.
            </p>
            <p className="text-xs text-muted-foreground">
              {Math.round((file.extracted_text?.length ?? 0) / 1000)}k characters of text ·{" "}
              {effort === "advanced"
                ? "Advanced reads up to 100k characters and reasons more carefully."
                : "Normal reads up to 40k characters."}
            </p>
            {error && (
              <p className="rounded-lg border border-ink-red/30 bg-ink-red/5 px-3 py-2 text-sm">
                {error}
              </p>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <EffortToggle value={effort} onChange={setEffort} />
              <Button onClick={go} disabled={busy}>
                {busy ? "Reading the document…" : error ? "Try again" : "Map this deal"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <ReviewBanner />
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold">{res.document_type}</h3>
                <UsageNote effort={res.effort} usage={res.usage} />
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{res.summary}</p>
              {res.truncated && (
                <p className="mt-1 text-xs text-ink-amber">
                  Only the first part of a long document was read. Switch to Advanced for more.
                </p>
              )}
            </div>
            {res.parties.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {res.parties.map((p, i) => (
                  <span key={i} className="rounded-md bg-raised px-2 py-1 text-xs" title={p.why}>
                    <b>{p.name}</b> · {p.role}
                  </span>
                ))}
              </div>
            )}
            <Section
              title="Deadlines"
              n={res.deadlines.length}
              onAll={(v) => toggleAll("d", res.deadlines.length, v)}
            >
              {res.deadlines.map((x, i) => (
                <li key={i} className="flex gap-2 rounded-lg border p-2">
                  <Checkbox
                    className="mt-0.5"
                    checked={!!sel[`d${i}`]}
                    disabled={!isoDate(dates[i] ?? "")}
                    onCheckedChange={(v) => setSel({ ...sel, [`d${i}`]: !!v })}
                    aria-label={x.title}
                  />
                  <div className="min-w-0 flex-1 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span>{x.title}</span>
                      <span className="text-xs text-muted-foreground">· {x.kind}</span>
                      <input
                        type="date"
                        value={dates[i] ?? ""}
                        onChange={(e) => {
                          setDates({ ...dates, [i]: e.target.value });
                          if (isoDate(e.target.value)) setSel((s) => ({ ...s, [`d${i}`]: true }));
                        }}
                        className="h-7 rounded-md border bg-card px-1.5 text-xs"
                        aria-label={`Date for ${x.title}`}
                      />
                      {!isoDate(dates[i] ?? "") && (
                        <span className="text-xs text-ink-amber">
                          date not in document — set one to add
                        </span>
                      )}
                    </div>
                    <Why text={x.why} />
                  </div>
                </li>
              ))}
            </Section>
            <Section
              title="Tasks"
              n={res.tasks.length}
              onAll={(v) => toggleAll("t", res.tasks.length, v)}
            >
              {res.tasks.map((x, i) => (
                <Row
                  key={i}
                  checked={!!sel[`t${i}`]}
                  onChange={(v) => setSel({ ...sel, [`t${i}`]: v })}
                  title={x.title}
                  meta={x.assignee}
                  why={x.why}
                />
              ))}
            </Section>
            <Section
              title="Closing deliverables"
              n={res.deliverables.length}
              onAll={(v) => toggleAll("c", res.deliverables.length, v)}
            >
              {res.deliverables.map((x, i) => (
                <Row
                  key={i}
                  checked={!!sel[`c${i}`]}
                  onChange={(v) => setSel({ ...sel, [`c${i}`]: v })}
                  title={x.deliverable}
                  meta={x.responsible}
                  why={x.why}
                />
              ))}
            </Section>
            {!res.deadlines.length && !res.tasks.length && !res.deliverables.length && (
              <p className="text-sm text-muted-foreground">
                Nothing new to track was found in this document.
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => setRes(null)} disabled={saving}>
                Run again
              </Button>
              <Button variant="outline" onClick={onClose} disabled={saving}>
                Discard
              </Button>
              <Button onClick={apply} disabled={saving || !picked}>
                {saving ? "Adding…" : `Add ${picked} selected`}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Row({
  checked,
  onChange,
  title,
  meta,
  why,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  meta: string;
  why: string;
}) {
  return (
    <li className="flex gap-2 rounded-lg border p-2">
      <Checkbox
        className="mt-0.5"
        checked={checked}
        onCheckedChange={(v) => onChange(!!v)}
        aria-label={title}
      />
      <div className="min-w-0 text-sm">
        {title} {meta && <span className="text-xs text-muted-foreground">· {meta}</span>}
        <Why text={why} />
      </div>
    </li>
  );
}

function Section({
  title,
  n,
  onAll,
  children,
}: {
  title: string;
  n: number;
  onAll: (v: boolean) => void;
  children: React.ReactNode;
}) {
  if (!n) return null;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <p className="text-xs font-semibold text-muted-foreground">
          {title} · {n}
        </p>
        <div className="flex gap-2 text-xs">
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => onAll(true)}
          >
            All
          </button>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => onAll(false)}
          >
            None
          </button>
        </div>
      </div>
      <ul className="space-y-2">{children}</ul>
    </div>
  );
}
