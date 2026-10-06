import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { tryAction } from "@/lib/mutate";
import type { BlankKind } from "@/lib/blank-files";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const KINDS: { kind: BlankKind; label: string; letter: string; tone: string; hint: string; def: string }[] = [
  { kind: "docx", label: "Word document", letter: "W", tone: "bg-ink-blue", hint: "Blank .docx with tracked changes and the drafting assistant", def: "Untitled document" },
  { kind: "xlsx", label: "Excel workbook", letter: "X", tone: "bg-ink-green", hint: "Blank .xlsx with one sheet", def: "Untitled workbook" },
  { kind: "pdf", label: "PDF", letter: "PDF", tone: "bg-destructive", hint: "One blank Letter page for highlights and comments — use Word to write text", def: "Untitled PDF" },
];

function FileIcon({ letter, tone }: { letter: string; tone: string }) {
  return (
    <span
      className={`flex h-8 w-7 shrink-0 items-center justify-center rounded-sm ${tone} text-[10px] font-bold tracking-tight text-primary-foreground`}
      aria-hidden
    >
      {letter}
    </span>
  );
}

export function NewDocumentStrip({ matterId }: { matterId?: string }) {
  const [kind, setKind] = useState<BlankKind | null>(null);
  const [name, setName] = useState("");
  const [matter, setMatter] = useState<string>(matterId ?? "");
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const qc = useQueryClient();
  const matters = useQuery({
    queryKey: ["matter-picker"],
    enabled: !!kind && !matterId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("matters")
        .select("id,title")
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return data;
    },
  });
  const cur = KINDS.find((k) => k.kind === kind);

  async function create() {
    if (!kind || busy) return;
    setBusy(true);
    const row = await tryAction(async () => {
      const { createBlankFile } = await import("@/lib/blank-files");
      return createBlankFile(kind, name, matter || null);
    }, "Couldn't create the document");
    setBusy(false);
    if (!row) return;
    qc.invalidateQueries({ queryKey: ["files-hub"] });
    if (matter) qc.invalidateQueries({ queryKey: ["files", matter] });
    setKind(null);
    nav({ to: "/office/$fileId", params: { fileId: row.id } });
  }

  return (
    <>
      <div className="flex flex-wrap gap-2" role="group" aria-label="New document">
        {KINDS.map((k) => (
          <button
            key={k.kind}
            type="button"
            title={k.hint}
            onClick={() => {
              setKind(k.kind);
              setName(k.def);
              setMatter(matterId ?? "");
            }}
            className="flex items-center gap-2.5 rounded border bg-card px-3 py-2 text-left text-sm transition-colors hover:border-primary/50 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <FileIcon letter={k.letter} tone={k.tone} />
            <span>
              <span className="block font-medium leading-tight">New {k.label}</span>
              <span className="block text-xs text-muted-foreground">Blank</span>
            </span>
          </button>
        ))}
      </div>
      <Dialog open={!!kind} onOpenChange={(o) => !o && !busy && setKind(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {cur && <FileIcon letter={cur.letter} tone={cur.tone} />}New {cur?.label}
            </DialogTitle>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <div className="space-y-1">
              <Label htmlFor="nd-name">Name</Label>
              <Input id="nd-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </div>
            {!matterId && (
              <div className="space-y-1">
                <Label htmlFor="nd-matter">Matter</Label>
                <select
                  id="nd-matter"
                  className="h-9 w-full rounded border bg-background px-2 text-sm"
                  value={matter}
                  onChange={(e) => setMatter(e.target.value)}
                >
                  <option value="">None — firm file (no drafting assistant)</option>
                  {(matters.data ?? []).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.title}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {cur?.kind === "pdf" && (
              <p className="text-xs text-muted-foreground">PDFs can be highlighted and commented on, not typed into.</p>
            )}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setKind(null)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !name.trim()}>
                {busy ? "Creating…" : "Create & open"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
