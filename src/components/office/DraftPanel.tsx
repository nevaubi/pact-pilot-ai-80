import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Send, Square, Trash2, Copy, CornerDownLeft, Replace } from "lucide-react";
import { toast } from "sonner";
import { useEffort } from "@/hooks/use-effort";
import { linkCitations, useAssist, type DocContext } from "@/hooks/use-assist";
import { EffortToggle, UsageNote, ReviewBanner } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { EditorHandle } from "./DocxEditor";

type Props = {
  matterId: string;
  fileId: string;
  canInsert: boolean;
  getDoc: () => Promise<DocContext>;
  editor: React.RefObject<EditorHandle | null>;
};

const QUICK: { label: string; prompt: string; needsSel?: boolean }[] = [
  { label: "Fill blanks from matter", prompt: "List each unfilled [[Field]] or {{Field}} blank in this document and the value from the matter record or files that fills it. Mark any blank you can't source as 'Needs attorney input'. Do not invent values." },
  { label: "Check against deal terms", prompt: "Compare this document with the matter's deal terms, dates and parties. List only concrete mismatches, each with the verbatim document text and what the matter record says." },
  { label: "Tighten selection", prompt: "Tighten the selected text without changing its legal meaning. Return only the revised text.", needsSel: true },
  { label: "Explain selection", prompt: "Explain the selected clause in plain terms for the attorney: what it does, who it favours, and anything customary that appears missing.", needsSel: true },
];

/** Drafting side panel: streams draft-mode answers grounded in the open document, matter files and pinned sources. */
export function DraftPanel({ matterId, fileId, canInsert, getDoc, editor }: Props) {
  const [effort, setEffort] = useEffort();
  const docRef = useRef<DocContext | undefined>(undefined);
  const { turns, busy, send, stop, clear } = useAssist({
    matterId,
    storeKey: `mirza-draft-${fileId}`,
    effort,
    mode: "draft",
    document: () => docRef.current,
  });
  const [q, setQ] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => endRef.current?.scrollIntoView({ block: "end" }), [turns]);

  async function ask(prompt: string, label?: string, needsSel?: boolean) {
    const doc = await getDoc();
    if (needsSel && !doc.selection) {
      toast.error("Select some text in the document first.");
      return;
    }
    docRef.current = doc;
    await send(prompt, label ? { label } : {});
  }

  async function place(text: string, how: "cursor" | "replace") {
    const ok = await editor.current?.insert(text.trim(), how);
    if (ok) toast.success(how === "replace" ? "Selection replaced — review it in the document." : "Inserted at the cursor.");
    else toast.error("Couldn't place the text. Click into the document first.");
  }

  return (
    <aside className="flex h-full min-h-0 flex-col border-l bg-card" aria-label="Drafting assistant">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <span className="font-display text-sm font-semibold">Drafting assistant</span>
        <div className="flex items-center gap-1">
          <EffortToggle value={effort} onChange={setEffort} />
          <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Clear conversation" onClick={clear} disabled={!turns.length}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-sm">
        {!turns.length && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Works from this document, the matter's files and pinned sources. Nothing changes in the document until you click Insert or Replace.
            </p>
            <div className="grid gap-1">
              {QUICK.map((x) => (
                <button key={x.label} disabled={busy} onClick={() => ask(x.prompt, x.label, x.needsSel)} className="rounded border px-2.5 py-1.5 text-left text-xs hover:bg-raised disabled:opacity-50">
                  {x.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {turns.map((t) => {
          const { text, used } = linkCitations(t.a, t.sources);
          return (
            <div key={t.id} className="space-y-1.5">
              <p className="rounded bg-raised px-2 py-1 text-xs font-medium">{t.label ?? t.q}</p>
              {t.a && (
                <div className="prose prose-sm max-w-none dark:prose-invert prose-p:my-1 prose-li:my-0">
                  <ReactMarkdown components={{ a: (p) => <a {...p} target="_blank" rel="noopener noreferrer" /> }}>{text}</ReactMarkdown>
                </div>
              )}
              {t.status === "streaming" && !t.a && <p className="text-xs text-muted-foreground">Reading the document…</p>}
              {t.error && <p className="text-xs text-ink-red">{t.error}</p>}
              {used.length > 0 && (
                <ul className="text-[11px] text-muted-foreground">
                  {used.map((s) => (
                    <li key={s.ref}>
                      [{s.ref}] <a className="underline" href={s.url} target="_blank" rel="noopener noreferrer">{s.citation}</a>
                    </li>
                  ))}
                </ul>
              )}
              {t.status === "done" && (
                <div className="flex flex-wrap items-center gap-1">
                  <UsageNote effort={t.effort} usage={t.usage} />
                  <span className="flex-1" />
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => navigator.clipboard.writeText(t.a).then(() => toast.success("Copied"))}>
                    <Copy className="mr-1 h-3 w-3" />Copy
                  </Button>
                  {canInsert && (
                    <>
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => place(t.a, "cursor")}>
                        <CornerDownLeft className="mr-1 h-3 w-3" />Insert
                      </Button>
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => place(t.a, "replace")}>
                        <Replace className="mr-1 h-3 w-3" />Replace
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {turns.length > 0 && <ReviewBanner />}
        <div ref={endRef} />
      </div>
      <form
        className="border-t p-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!q.trim()) return;
          const v = q;
          setQ("");
          void ask(v);
        }}
      >
        <Textarea
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          rows={2}
          placeholder="Ask about this document or select text first…"
          aria-label="Drafting request"
          className="resize-none text-sm"
        />
        <div className="mt-1.5 flex justify-end">
          {busy ? (
            <Button type="button" size="sm" variant="outline" onClick={stop}>
              <Square className="mr-1 h-3 w-3" />Stop
            </Button>
          ) : (
            <Button type="submit" size="sm" disabled={!q.trim()}>
              <Send className="mr-1 h-3 w-3" />Send
            </Button>
          )}
        </div>
      </form>
    </aside>
  );
}
