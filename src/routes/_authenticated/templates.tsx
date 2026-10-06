import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Upload, Trash2, FileText } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import { templatesQ, PRACTICE_AREAS } from "@/lib/data";
import { extractText, templateFields } from "@/lib/extract";
import { PageHeader, Empty, PracticeChip, Panel } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/templates")({
  head: () => ({
    meta: [
      { title: "House templates — Mirza" },
      { name: "description", content: "Your firm's standard forms, used as the base for every draft." },
      { property: "og:title", content: "House templates — Mirza" },
      { property: "og:description", content: "Firm house template library." },
    ],
  }),
  component: Templates,
});

function Templates() {
  const { data = [] } = useQuery(templatesQ);
  const qc = useQueryClient();
  const [sel, setSel] = useState<Tables<"templates"> | null>(null);
  const [area, setArea] = useState<string>("Corporate");
  const [busy, setBusy] = useState(false);

  async function onFiles(list: FileList | null) {
    if (!list?.length) return;
    setBusy(true);
    try {
      for (const f of Array.from(list)) {
        const body = await extractText(f);
        if (!body.trim()) { toast.error(`${f.name}: no readable text`); continue; }
        await supabase.from("templates").insert({ name: f.name.replace(/\.(docx|txt|md|pdf)$/i, ""), practice_area: area, body });
      }
      qc.invalidateQueries({ queryKey: ["templates"] });
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }

  async function save(t: Tables<"templates">) {
    await supabase.from("templates").update({ name: t.name, practice_area: t.practice_area, body: t.body }).eq("id", t.id);
    qc.invalidateQueries({ queryKey: ["templates"] });
    toast.success("Template saved");
  }

  return (
    <div className="pb-10">
      <PageHeader title="House templates" subtitle="Drafts always start from these forms, so every deal reads the way your firm writes." />
      <div className="grid gap-4 px-4 md:px-8 lg:grid-cols-3">
        <div className="space-y-4">
          <Panel title="Add templates">
            <div className="space-y-3">
              <div className="space-y-1">
                <Label className="text-xs">Practice area</Label>
                <Select value={area} onValueChange={setArea}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{PRACTICE_AREAS.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <label className="flex cursor-pointer flex-col items-center gap-1 rounded-lg border-2 border-dashed p-5 text-center hover:border-primary">
                <Upload className="h-5 w-5 text-muted-foreground" />
                <span className="text-sm">{busy ? "Reading…" : "Upload .docx, .txt or .md"}</span>
                <input type="file" multiple accept=".docx,.txt,.md" className="hidden" onChange={(e) => onFiles(e.target.files)} />
              </label>
              <p className="text-xs text-muted-foreground">Mark blanks as <code className="rounded bg-raised px-1">[[Buyer Name]]</code> or <code className="rounded bg-raised px-1">{"{{Closing Date}}"}</code>. Each blank becomes a question when drafting.</p>
            </div>
          </Panel>
          <Panel title={`Library · ${data.length}`}>
            {!data.length ? <Empty>No templates yet.</Empty> : (
              <ul className="space-y-1">
                {data.map((t) => (
                  <li key={t.id}>
                    <button onClick={() => setSel(t)} className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm ${sel?.id === t.id ? "bg-raised" : "hover:bg-raised/60"}`}>
                      <FileText className="h-4 w-4 text-ink-blue" />
                      <span className="flex-1 truncate">{t.name}</span>
                      {t.practice_area && <PracticeChip area={t.practice_area} />}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
        <div className="lg:col-span-2">
          {sel ? (
            <Panel title="Edit template" action={<Button size="icon" variant="ghost" aria-label="Delete" onClick={async () => { await supabase.from("templates").delete().eq("id", sel.id); setSel(null); qc.invalidateQueries({ queryKey: ["templates"] }); }}><Trash2 className="h-4 w-4" /></Button>}>
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input value={sel.name} onChange={(e) => setSel({ ...sel, name: e.target.value })} />
                  <Select value={sel.practice_area ?? "Corporate"} onValueChange={(v) => setSel({ ...sel, practice_area: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>{PRACTICE_AREAS.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <p className="text-xs text-muted-foreground">Blanks found: {templateFields(sel.body).join(", ") || "none"}</p>
                <Textarea className="min-h-[55vh] bg-raised font-serif text-[13px]" value={sel.body} onChange={(e) => setSel({ ...sel, body: e.target.value })} />
                <Button onClick={() => save(sel)}>Save template</Button>
              </div>
            </Panel>
          ) : (
            <div className="grid h-full min-h-[300px] place-items-center rounded-xl border border-dashed text-sm text-muted-foreground">Select a template to view or edit it.</div>
          )}
        </div>
      </div>
    </div>
  );
}
