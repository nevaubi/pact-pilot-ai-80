import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Send, Square, Trash2, Copy, CornerDownLeft, Replace, Grid2x2Plus } from "lucide-react";
import { toast } from "sonner";
import { useEffort } from "@/hooks/use-effort";
import { linkCitations, useAssist, type DocContext, type Turn } from "@/hooks/use-assist";
import { EffortToggle, UsageNote, ReviewBanner } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { copyText } from "@/lib/clipboard";
import type { EditorHandle } from "./DocxEditor";

type Props = {
  matterId: string;
  fileId: string;
  kind: DocContext["kind"];
  canInsert: boolean;
  getDoc: () => Promise<DocContext>;
  editor: React.RefObject<EditorHandle | null>;
};

const QUICK: Record<
  "docx" | "xlsx" | "other",
  { label: string; prompt: string; needsSel?: boolean }[]
> = {
  docx: [
    {
      label: "Fill blanks from matter",
      prompt:
        "List each unfilled [[Field]] or {{Field}} blank in this document and the value from the matter record or files that fills it. Mark any blank you can't source as 'Needs attorney input'. Do not invent values.",
    },
    {
      label: "Check against deal terms",
      prompt:
        "Compare this document with the matter's deal terms, dates and parties. List only concrete mismatches, each with the verbatim document text and what the matter record says.",
    },
    {
      label: "Tighten selection",
      prompt:
        "Tighten the selected text without changing its legal meaning. Return only the revised text in the draft block.",
      needsSel: true,
    },
    {
      label: "Explain selection",
      prompt:
        "Explain the selected clause in plain terms for the attorney: what it does, who it favours, and anything customary that appears missing.",
      needsSel: true,
    },
  ],
  xlsx: [
    {
      label: "Check the math",
      prompt:
        "Review the formulas and totals in this spreadsheet. List any cell whose formula or value looks inconsistent with its label or neighbours, quoting the cell reference and what you expected.",
    },
    {
      label: "Tie to the matter",
      prompt:
        "Compare the amounts and dates in this spreadsheet with the matter's deal terms and property record. List only concrete mismatches with the cell reference.",
    },
    {
      label: "Add a totals row",
      prompt:
        "Propose a totals row for the main table in the active sheet, as A1-style cell assignments in the draft block. Use SUM formulas, not typed numbers.",
    },
  ],
  other: [
    {
      label: "Summarize for the file",
      prompt:
        "Summarize this document for the matter file in under 150 words: parties, purpose, key dates and amounts, and open items. Quote dates and amounts exactly as written.",
    },
    {
      label: "Dates and deliverables",
      prompt:
        "List every date, deadline and deliverable in this document with the verbatim sentence it comes from.",
    },
    {
      label: "Check against deal terms",
      prompt:
        "Compare this document with the matter's deal terms, dates and parties. List only concrete mismatches, each with the verbatim document text and what the matter record says.",
    },
  ],
};

/** Split an answer into the explanation and the proposed text inside the ```draft fence, if present. */
export function splitDraft(answer: string): { proposal: string | null; explanation: string } {
  const re = /```draft[^\n]*\n([\s\S]*?)```/g;
  const blocks: string[] = [];
  const explanation = answer
    .replace(re, (_all, body: string) => {
      blocks.push(body.replace(/\s+$/, ""));
      return "";
    })
    .trim();
  if (!blocks.length) return { proposal: null, explanation: answer };
  return { proposal: blocks.join("\n\n"), explanation };
}

/** Drafting side panel: streams draft-mode answers grounded in the open document, matter files and pinned sources. */
export function DraftPanel({ matterId, fileId, kind, canInsert, getDoc, editor }: Props) {
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
  const [placing, setPlacing] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Braces matter: a patched scrollIntoView can return a value, and React would try to call it on cleanup.
    endRef.current?.scrollIntoView({ block: "end" });
  }, [turns]);

  const quick = QUICK[kind === "docx" ? "docx" : kind === "xlsx" ? "xlsx" : "other"];

  async function ask(prompt: string, label?: string, needsSel?: boolean) {
    const doc = await getDoc();
    if (needsSel && !doc.selection) {
      toast.error("Select some text in the document first.");
      return;
    }
    docRef.current = doc;
    await send(prompt, label ? { label } : {});
  }

  async function place(turn: Turn, text: string, how: "cursor" | "replace") {
    const ed = editor.current;
    if (!ed) {
      toast.error("The editor isn't ready yet.");
      return;
    }
    setPlacing(turn.id + how);
    try {
      const r = await ed.insert(text.trim(), how, turn.anchor);
      if (!r.ok) {
        toast.error(r.reason);
        return;
      }
      if (r.how === "cells") toast.success(r.detail ?? "Cells updated — review them in the sheet.");
      else if (r.tracked)
        toast.success(
          how === "replace"
            ? "Replaced as a tracked change — accept or reject it in the document."
            : "Inserted as a tracked change — accept or reject it in the document.",
          { description: r.detail },
        );
      else
        toast.success(
          how === "replace"
            ? "Selection replaced — review it in the document."
            : "Inserted at the cursor.",
        );
    } finally {
      setPlacing(null);
    }
  }

  return (
    <aside
      className="flex h-full min-h-0 flex-col border-l bg-card"
      aria-label="Drafting assistant"
    >
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <span className="font-display text-sm font-semibold">Drafting assistant</span>
        <div className="flex items-center gap-1">
          <EffortToggle value={effort} onChange={setEffort} />
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            aria-label="Clear conversation"
            onClick={clear}
            disabled={!turns.length}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-sm">
        {!turns.length && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {canInsert
                ? kind === "xlsx"
                  ? "Works from this spreadsheet, the matter's files and pinned sources. Nothing changes in the sheet until you click Apply cells."
                  : "Works from this document, the matter's files and pinned sources. Nothing changes in the document until you click Insert or Replace — and then it lands as a tracked change you accept or reject."
                : "Works from this document's text, the matter's files and pinned sources. Answers can be copied; the file itself isn't edited."}
            </p>
            <div className="grid gap-1">
              {quick.map((x) => (
                <button
                  key={x.label}
                  disabled={busy}
                  onClick={() => ask(x.prompt, x.label, x.needsSel)}
                  className="rounded border px-2.5 py-1.5 text-left text-xs hover:bg-raised disabled:opacity-50"
                >
                  {x.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {turns.map((t) => {
          const { proposal, explanation } = splitDraft(t.a);
          const { text, used } = linkCitations(explanation, t.sources);
          const insertable = (proposal ?? t.a).trim();
          const isPlacing = (how: string) => placing === t.id + how;
          return (
            <div key={t.id} className="space-y-1.5">
              <p className="rounded bg-raised px-2 py-1 text-xs font-medium">{t.label ?? t.q}</p>
              {t.anchor && (
                <p className="truncate text-[11px] text-muted-foreground" title={t.anchor}>
                  On: “{t.anchor}”
                </p>
              )}
              {text && (
                <div className="prose prose-sm max-w-none dark:prose-invert prose-p:my-1 prose-li:my-0">
                  <ReactMarkdown
                    components={{
                      a: (p) => <a {...p} target="_blank" rel="noopener noreferrer" />,
                    }}
                  >
                    {text}
                  </ReactMarkdown>
                </div>
              )}
              {proposal && (
                <div className="rounded border border-primary/30 bg-primary/5">
                  <div className="flex items-center justify-between border-b border-primary/20 px-2 py-1">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-primary">
                      {kind === "xlsx" ? "Proposed cells" : "Proposed text"}
                    </span>
                    <span className="text-[11px] text-muted-foreground">Review before use</span>
                  </div>
                  <pre
                    className={`max-h-72 overflow-auto whitespace-pre-wrap px-2 py-1.5 text-xs leading-relaxed ${kind === "xlsx" ? "font-mono" : "font-sans"}`}
                  >
                    {proposal}
                  </pre>
                </div>
              )}
              {t.status === "streaming" && !t.a && (
                <p className="text-xs text-muted-foreground">Reading the document…</p>
              )}
              {t.error && <p className="text-xs text-ink-red">{t.error}</p>}
              {used.length > 0 && (
                <ul className="text-[11px] text-muted-foreground">
                  {used.map((s) => (
                    <li key={s.ref}>
                      [{s.ref}]{" "}
                      <a
                        className="underline"
                        href={s.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {s.citation}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
              {t.status === "done" && (
                <div className="flex flex-wrap items-center gap-1">
                  <UsageNote effort={t.effort} usage={t.usage} />
                  <span className="flex-1" />
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs"
                    onClick={() =>
                      copyText(insertable, proposal ? "Proposed text copied" : "Copied")
                    }
                  >
                    <Copy className="mr-1 h-3 w-3" />
                    Copy
                  </Button>
                  {canInsert && kind === "xlsx" && (
                    <Button
                      size="sm"
                      variant={proposal ? "default" : "ghost"}
                      className="h-6 px-2 text-xs"
                      disabled={!!placing}
                      onClick={() => place(t, insertable, "cursor")}
                    >
                      <Grid2x2Plus className="mr-1 h-3 w-3" />
                      {isPlacing("cursor") ? "Applying…" : "Apply cells"}
                    </Button>
                  )}
                  {canInsert && kind !== "xlsx" && (
                    <>
                      <Button
                        size="sm"
                        variant={proposal && !t.anchor ? "default" : "ghost"}
                        className="h-6 px-2 text-xs"
                        disabled={!!placing}
                        onClick={() => place(t, insertable, "cursor")}
                      >
                        <CornerDownLeft className="mr-1 h-3 w-3" />
                        {isPlacing("cursor") ? "Inserting…" : "Insert"}
                      </Button>
                      <Button
                        size="sm"
                        variant={proposal && t.anchor ? "default" : "ghost"}
                        className="h-6 px-2 text-xs"
                        disabled={!!placing}
                        onClick={() => place(t, insertable, "replace")}
                      >
                        <Replace className="mr-1 h-3 w-3" />
                        {isPlacing("replace") ? "Replacing…" : "Replace"}
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
          placeholder={
            canInsert && kind !== "xlsx"
              ? "Ask about this document or select text first…"
              : kind === "xlsx"
                ? "Ask about this spreadsheet…"
                : "Ask about this document…"
          }
          aria-label="Drafting request"
          className="resize-none text-sm"
        />
        <div className="mt-1.5 flex justify-end">
          {busy ? (
            <Button type="button" size="sm" variant="outline" onClick={stop}>
              <Square className="mr-1 h-3 w-3" />
              Stop
            </Button>
          ) : (
            <Button type="submit" size="sm" disabled={!q.trim()}>
              <Send className="mr-1 h-3 w-3" />
              Send
            </Button>
          )}
        </div>
      </form>
    </aside>
  );
}
