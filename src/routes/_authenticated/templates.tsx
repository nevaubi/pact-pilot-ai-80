import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Upload, FileText, Download, Plus } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import { templatesQ, PRACTICE_AREAS } from "@/lib/data";
import { mut, tryAction, humanize } from "@/lib/mutate";
import { extractText, templateFields } from "@/lib/extract";
import { PageHeader, PracticeChip, Panel, ListState, DeleteButton } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { downloadFile } from "@/components/matter/FilesTab";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/templates")({
  head: () => ({
    meta: [
      { title: "House templates — Mirza" },
      {
        name: "description",
        content: "Your firm's standard forms, used as the base for every draft.",
      },
      { property: "og:title", content: "House templates — Mirza" },
      { property: "og:description", content: "Firm house template library." },
    ],
  }),
  component: Templates,
  loader: ({ context }) => context.queryClient.ensureQueryData(templatesQ),
});

type Tpl = Tables<"templates">;

function Templates() {
  const q = useQuery(templatesQ);
  const data = q.data ?? [];
  const qc = useQueryClient();
  const [selId, setSelId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Tpl | null>(null);
  const [area, setArea] = useState<string>("Corporate");
  const [busy, setBusy] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const sel = data.find((t) => t.id === selId) ?? null;
  useEffect(() => setDraft(sel ? { ...sel } : null), [sel]);
  const dirty =
    !!draft &&
    !!sel &&
    (draft.name !== sel.name ||
      draft.body !== sel.body ||
      draft.practice_area !== sel.practice_area);
  const refresh = () => qc.invalidateQueries({ queryKey: ["templates"] });

  async function onFiles(list: FileList | null) {
    const files = Array.from(list ?? []);
    if (!files.length) return;
    let lastId: string | null = null;
    for (const f of files) {
      setBusy(f.name);
      await tryAction(async () => {
        let body = "";
        try {
          body = (await extractText(f)).trim();
        } catch {
          /* handled below */
        }
        if (!body) {
          toast.error(`${f.name}: no readable text`, {
            description: "Upload a .docx, .txt or .md file with the form's text.",
          });
          return;
        }
        // Keep the original alongside the extracted text so the firm never loses its formatted form.
        const path = `templates/${crypto.randomUUID()}-${f.name.replace(/[^\w.-]+/g, "_")}`;
        const { error: upErr } = await supabase.storage.from("matter-files").upload(path, f);
        if (upErr) throw new Error(humanize(upErr.message));
        const row = await mut(
          supabase
            .from("templates")
            .insert({
              name: f.name.replace(/\.(docx|txt|md|pdf)$/i, ""),
              practice_area: area,
              body,
              path,
            })
            .select()
            .single(),
        );
        const n = templateFields(body).length;
        toast.success(`${row.name} added`, {
          description: n
            ? `${n} blank${n > 1 ? "s" : ""} found.`
            : "No [[blanks]] found — add some so drafting can ask questions.",
        });
        lastId = row.id;
      }, "Upload failed");
    }
    setBusy(null);
    refresh();
    if (lastId) setSelId(lastId);
  }

  async function createBlank() {
    await tryAction(async () => {
      const row = await mut(
        supabase
          .from("templates")
          .insert({
            name: "New template",
            practice_area: area,
            body: "TITLE OF FORM\n\nThis Agreement is made as of [[Effective Date]] between [[Party A]] and [[Party B]].\n\n1. …",
          })
          .select()
          .single(),
        { success: "Template created — edit it on the right" },
      );
      refresh();
      setSelId(row.id);
    });
  }

  async function save() {
    if (!draft || !sel || saving) return;
    setSaving(true);
    await tryAction(async () => {
      await mut(
        supabase
          .from("templates")
          .update({
            name: draft.name.trim() || sel.name,
            practice_area: draft.practice_area,
            body: draft.body,
          })
          .eq("id", sel.id)
          .select("id"),
        { success: "Template saved" },
      );
      refresh();
    });
    setSaving(false);
  }
  async function remove(t: Tpl) {
    await tryAction(async () => {
      if (t.path) await supabase.storage.from("matter-files").remove([t.path]);
      await mut(supabase.from("templates").delete().eq("id", t.id).select("id"), {
        success: "Template deleted",
      });
      if (selId === t.id) setSelId(null);
      refresh();
    });
  }

  return (
    <div className="pb-8">
      <PageHeader
        title="House templates"
        subtitle="Drafts always start from these forms, so every deal reads the way your firm writes."
      />
      <div className="grid gap-4 p-4 md:p-6 lg:grid-cols-[300px_minmax(0,1fr)]">
        <div className="space-y-4">
          <Panel title="Add templates">
            <div className="space-y-3">
              <div className="space-y-1">
                <Label className="text-xs">Practice area</Label>
                <Select value={area} onValueChange={setArea}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRACTICE_AREAS.map((a) => (
                      <SelectItem key={a} value={a}>
                        {a}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <label
                className={`flex cursor-pointer flex-col items-center gap-1 rounded border border-dashed p-4 text-center transition-colors hover:border-primary ${busy ? "pointer-events-none opacity-70" : ""}`}
              >
                <Upload className="h-5 w-5 text-muted-foreground" />
                <span className="text-sm">
                  {busy ? `Reading ${busy}…` : "Upload .docx, .txt or .md"}
                </span>
                <input
                  type="file"
                  multiple
                  accept=".docx,.txt,.md"
                  className="hidden"
                  onChange={(e) => {
                    onFiles(e.target.files);
                    e.target.value = "";
                  }}
                  disabled={!!busy}
                />
              </label>
              <Button variant="outline" size="sm" className="w-full" onClick={createBlank}>
                <Plus className="mr-1 h-4 w-4" />
                Start from a blank template
              </Button>
              <p className="text-xs text-muted-foreground">
                Mark blanks as <code className="rounded bg-raised px-1">[[Buyer Name]]</code> or{" "}
                <code className="rounded bg-raised px-1">{"{{Closing Date}}"}</code>. Each blank
                becomes a question when drafting; everything else is copied exactly.
              </p>
            </div>
          </Panel>
          <Panel title={q.data ? `Library · ${data.length}` : "Library"}>
            <ListState query={q} empty="No templates yet. Upload your firm's standard forms above.">
              {(rows) => (
                <ul className="space-y-1">
                  {rows.map((t) => (
                    <li key={t.id} className="group flex items-center gap-1">
                      <button
                        onClick={() => setSelId(t.id)}
                        aria-current={selId === t.id}
                        className={`flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-2 text-left text-sm ${selId === t.id ? "bg-raised" : "hover:bg-raised/60"}`}
                      >
                        <FileText className="h-4 w-4 shrink-0 text-ink-blue" />
                        <span className="flex-1 truncate">{t.name}</span>
                        {t.practice_area && <PracticeChip area={t.practice_area} />}
                      </button>
                      <DeleteButton
                        what="template"
                        description={`"${t.name}" will be removed from the library. Existing drafts made from it are kept.`}
                        onConfirm={() => remove(t)}
                        className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100 max-sm:opacity-100"
                      />
                    </li>
                  ))}
                </ul>
              )}
            </ListState>
          </Panel>
        </div>
        <div className="lg:col-span-2">
          {draft && sel ? (
            <Panel
              title="Edit template"
              action={
                <div className="flex items-center gap-1">
                  {sel.path && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => downloadFile(sel.path!, `${sel.name}.docx`)}
                    >
                      <Download className="mr-1 h-4 w-4" />
                      Original
                    </Button>
                  )}
                  <Button size="sm" onClick={save} disabled={!dirty || saving}>
                    {saving ? "Saving…" : dirty ? "Save template" : "Saved"}
                  </Button>
                </div>
              }
            >
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    aria-label="Template name"
                  />
                  <Select
                    value={draft.practice_area ?? "Corporate"}
                    onValueChange={(v) => setDraft({ ...draft, practice_area: v })}
                  >
                    <SelectTrigger aria-label="Practice area">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PRACTICE_AREAS.map((a) => (
                        <SelectItem key={a} value={a}>
                          {a}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Blanks body={draft.body} />
                <Textarea
                  className="min-h-[55vh] bg-raised font-mono text-[12px] leading-relaxed"
                  value={draft.body}
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                  aria-label="Template text"
                />
              </div>
            </Panel>
          ) : (
            <div className="grid h-full min-h-[300px] place-items-center rounded border border-dashed p-6 text-center text-sm text-muted-foreground">
              {data.length
                ? "Select a template to view or edit it."
                : "Upload a form on the left to get started. Word files keep their original alongside the editable text."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Blanks({ body }: { body: string }) {
  const f = templateFields(body);
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      <span>Blanks found ({f.length}):</span>
      {f.length ? (
        f.map((x) => (
          <span key={x} className="rounded bg-ink-purple/10 px-1.5 py-0.5 text-ink-purple">
            {x}
          </span>
        ))
      ) : (
        <span className="text-ink-amber">
          none — add [[Field]] markers so drafting can ask questions
        </span>
      )}
    </div>
  );
}
