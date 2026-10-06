import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, RefreshCw, Paperclip, Pin, Trash2, Search } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { mattersQ, fmtDate, fmtDateTime, logActivity } from "@/lib/data";
import { mut, tryAction } from "@/lib/mutate";
import { extractText } from "@/lib/extract";
import { indexAuthority } from "@/lib/library.functions";
import { authorityTextQ, authorityUpdatesQ, syncOne, topicLabel, KINDS, type AuthorityRow } from "@/lib/library";
import { StatusChip, JurChip, Snippet } from "./SourceBits";
import { Confirm, ListState } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function AuthoritySheet({
  a,
  onClose,
  matterId,
}: {
  a: AuthorityRow | null;
  onClose: () => void;
  /** When opened from a matter, "Pin" targets that matter directly. */
  matterId?: string;
}) {
  return (
    <Sheet open={!!a} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        {a && <Body a={a} matterId={matterId} onClose={onClose} />}
      </SheetContent>
    </Sheet>
  );
}

function Body({ a, matterId, onClose }: { a: AuthorityRow; matterId?: string | undefined; onClose: () => void }) {
  const qc = useQueryClient();
  const textQ = useQuery({ ...authorityTextQ(a.id), enabled: a.status === "ready" });
  const updatesQ = useQuery(authorityUpdatesQ(a.id));
  const matters = useQuery({ ...mattersQ, enabled: !matterId });
  const [busy, setBusy] = useState<string | null>(null);
  const [find, setFind] = useState("");
  const [shown, setShown] = useState(4000);
  const [pinTo, setPinTo] = useState<string>(matterId ?? "");
  const fileRef = useRef<HTMLInputElement>(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["authorities"] });
    qc.invalidateQueries({ queryKey: ["authority-text", a.id] });
    qc.invalidateQueries({ queryKey: ["authority-updates", a.id] });
  };

  const text = textQ.data?.text ?? "";
  const matches = useMemo(() => {
    const f = find.trim().toLowerCase();
    if (f.length < 2 || !text) return null;
    const paras = text.split(/\n+/);
    return paras.filter((p) => p.toLowerCase().includes(f)).slice(0, 40);
  }, [find, text]);

  async function refetch() {
    setBusy("Fetching the current text…");
    await tryAction(async () => {
      await syncOne(a);
      toast.success(`${a.citation} is up to date`);
      refresh();
    }, "Couldn't refresh this source");
    setBusy(null);
  }

  async function attach(file: File) {
    setBusy(`Reading ${file.name}…`);
    await tryAction(async () => {
      const t = await extractText(file, 250);
      if (t.trim().length < 200) throw new Error("No readable text in that file. Save the page as PDF with text, or paste the text into a .txt file.");
      const path = `${a.id}-copy-${file.name.replace(/[^\w.-]+/g, "_")}`;
      const { error } = await supabase.storage.from("law-library").upload(path, file, { upsert: true });
      if (error) throw new Error(error.message);
      await indexAuthority({
        data: { id: a.id, text: t, versionLabel: `Attorney-attached copy, ${new Date().toISOString().slice(0, 10)}`, storagePath: path, mime: file.type || "application/octet-stream" },
      });
      toast.success(`${a.citation}: copy attached and indexed`);
      refresh();
    }, "Couldn't attach the copy");
    setBusy(null);
  }

  async function pin() {
    if (!pinTo) return;
    await tryAction(async () => {
      await mut(
        supabase.from("matter_authorities").upsert({ matter_id: pinTo, authority_id: a.id }, { onConflict: "matter_id,authority_id", ignoreDuplicates: true }).select("id"),
        { success: "Pinned to the matter" },
      );
      await logActivity(pinTo, `Pinned source ${a.citation}`);
      qc.invalidateQueries({ queryKey: ["matter_authorities", pinTo] });
    });
  }

  async function remove() {
    await tryAction(async () => {
      if (a.storage_path) await supabase.storage.from("law-library").remove([a.storage_path]);
      await mut(supabase.from("authorities").delete().eq("id", a.id).select("id"), { success: "Source removed" });
      refresh();
      onClose();
    });
  }

  return (
    <div className="space-y-4">
      <SheetHeader className="space-y-1 text-left">
        <div className="flex flex-wrap items-center gap-2">
          <JurChip j={a.jurisdiction} />
          <span className="rounded-sm bg-raised px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">{KINDS[a.kind] ?? a.kind}</span>
          <StatusChip a={a} />
        </div>
        <SheetTitle className="font-mono text-base">{a.citation}</SheetTitle>
        <SheetDescription className="text-sm text-foreground">{a.title}</SheetDescription>
      </SheetHeader>

      {a.summary && <p className="text-sm text-muted-foreground">{a.summary}</p>}

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Topics</dt>
        <dd>{a.topics.map(topicLabel).join(", ") || "—"}</dd>
        <dt className="text-muted-foreground">Version</dt>
        <dd>{a.version_label ?? "—"}</dd>
        <dt className="text-muted-foreground">Fetched</dt>
        <dd>{a.fetched_at ? fmtDateTime(a.fetched_at) : "never"}{a.checked_at && a.fetched_at !== a.checked_at ? ` · checked ${fmtDateTime(a.checked_at)}` : ""}</dd>
        <dt className="text-muted-foreground">Text</dt>
        <dd>{a.text_chars ? `${Math.round(a.text_chars / 1000)}k characters indexed` : "none yet"}</dd>
      </dl>

      {(a.status === "blocked" || a.status === "error") && (
        <div className="rounded border border-ink-red/30 bg-ink-red/5 px-3 py-2 text-xs">
          <b>{a.status === "blocked" ? "This site blocks automated downloads." : "The last fetch failed."}</b> {a.error}
          <br />
          Open the official page, save it as a PDF (or copy the text into a .txt file), then attach it here. The attached copy is indexed exactly like a fetched one.
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="outline" asChild>
          <a href={a.url} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="mr-1.5 h-3.5 w-3.5" /> Open source
          </a>
        </Button>
        <Button size="sm" variant="outline" onClick={refetch} disabled={!!busy}>
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} /> {a.status === "ready" ? "Check for updates" : "Fetch now"}
        </Button>
        <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()} disabled={!!busy}>
          <Paperclip className="mr-1.5 h-3.5 w-3.5" /> Attach copy
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.txt,.html,.htm,.docx"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) attach(f);
            e.target.value = "";
          }}
        />
        {!a.is_catalog && (
          <Confirm title="Remove this source?" description="It will be removed from the library and from any matter it is pinned to." action="Remove" onConfirm={remove}>
            <Button size="sm" variant="ghost" className="text-ink-red hover:text-ink-red">
              <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Remove
            </Button>
          </Confirm>
        )}
      </div>
      {busy && <p className="text-xs text-muted-foreground">{busy}</p>}

      <div className="flex flex-wrap items-center gap-2 rounded border bg-card p-2">
        <Pin className="h-3.5 w-3.5 text-muted-foreground" />
        {matterId ? (
          <span className="text-xs">Pin to this matter so Assist and reviews cite it.</span>
        ) : (
          <Select value={pinTo} onValueChange={setPinTo}>
            <SelectTrigger className="h-8 w-64 text-xs" aria-label="Matter to pin to">
              <SelectValue placeholder="Pin to a matter…" />
            </SelectTrigger>
            <SelectContent>
              {(matters.data ?? []).map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.number ? `${m.number} · ` : ""}
                  {m.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button size="sm" onClick={pin} disabled={!pinTo}>
          Pin
        </Button>
      </div>

      <ListState query={updatesQ} empty={<span className="text-xs">No Federal Register activity tracked for this source.</span>} rows={1}>
        {(rows) => (
          <section>
            <h3 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Recent Federal Register activity</h3>
            <ul className="divide-y rounded border bg-card">
              {rows.map((u) => (
                <li key={u.id} className="px-3 py-2 text-xs">
                  <a href={u.html_url ?? "#"} target="_blank" rel="noopener noreferrer" className="font-medium hover:text-primary">
                    {u.title}
                  </a>
                  <div className="text-muted-foreground">
                    {u.doc_type ?? "Document"} · {fmtDate(u.publication_date)}
                    {u.effective_on ? ` · effective ${fmtDate(u.effective_on)}` : ""}
                    {u.agency ? ` · ${u.agency}` : ""}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </ListState>

      {a.status === "ready" && (
        <section className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase text-muted-foreground">Text</h3>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find in text" className="h-8 w-56 pl-7 text-xs" aria-label="Find in text" />
            </div>
          </div>
          {textQ.isPending ? (
            <p className="text-xs text-muted-foreground">Loading text…</p>
          ) : matches ? (
            matches.length ? (
              <ul className="space-y-1.5">
                {matches.map((p, i) => (
                  <li key={i} className="rounded border bg-card px-3 py-2 text-xs leading-relaxed">
                    <Snippet text={p.replace(new RegExp(`(${find.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"), "[[$1]]")} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">No paragraph contains “{find.trim()}”.</p>
            )
          ) : (
            <div className="rounded border bg-card px-3 py-2 font-serif text-[13px] leading-relaxed">
              <pre className="whitespace-pre-wrap font-[inherit]">{text.slice(0, shown)}</pre>
              {text.length > shown && (
                <Button size="sm" variant="ghost" className="mt-1" onClick={() => setShown((s) => s + 8000)}>
                  Show more ({Math.round((text.length - shown) / 1000)}k more)
                </Button>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
