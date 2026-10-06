import { memo, useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  ArrowDown,
  Check,
  ChevronRight,
  CircleAlert,
  Copy,
  CornerDownLeft,
  FileText,
  Loader2,
  Paperclip,
  Replace,
  RotateCcw,
  Send,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useEffort } from "@/hooks/use-effort";
import { linkCitations, useAssist, type AttachmentPayload, type DocContext, type Turn } from "@/hooks/use-assist";
import { EffortToggle, UsageNote, ReviewBanner } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { copyText } from "@/lib/clipboard";
import { splitDraft } from "@/lib/office-proposals";
import { LIMITS, type Proposal } from "@/lib/office-tools";
import { logClientError } from "@/lib/error-log";
import type { EditorHandle } from "./DocxEditor";

type Props = {
  matterId: string;
  fileId: string;
  fileName: string;
  kind: DocContext["kind"];
  canInsert: boolean;
  getDoc: () => Promise<DocContext>;
  editor: React.RefObject<EditorHandle | null>;
  onClose?: () => void;
};

const QUICK: Record<"docx" | "xlsx" | "other", { label: string; prompt: string; needsSel?: boolean }[]> = {
  docx: [
    { label: "Fill blanks", prompt: "Find each unfilled [[Field]] or {{Field}} blank and propose its value from the matter record or files as Word edits. Leave any blank you can't source; list those as 'Needs attorney input'. Do not invent values." },
    { label: "Check deal terms", prompt: "Compare this document with the matter's deal terms, dates and parties. List only concrete mismatches, each with the verbatim document text and what the matter record says." },
    { label: "Tighten selection", prompt: "Tighten the selected text without changing its legal meaning.", needsSel: true },
    { label: "Explain selection", prompt: "Explain the selected clause in plain terms: what it does, who it favours, and anything customary that appears missing.", needsSel: true },
  ],
  xlsx: [
    { label: "Check the math", prompt: "Review the formulas and totals. List any cell whose formula or value looks inconsistent with its label or neighbours, quoting the cell reference." },
    { label: "Tie to matter", prompt: "Compare amounts and dates in this spreadsheet with the matter's deal terms and property record. List concrete mismatches with cell references." },
    { label: "Add totals row", prompt: "Propose a totals row for the main table on the active sheet using SUM formulas, as a sheet proposal." },
  ],
  other: [
    { label: "Summarize", prompt: "Summarize this document for the matter file in under 150 words: parties, purpose, key dates and amounts, open items. Quote dates and amounts exactly." },
    { label: "Dates & deliverables", prompt: "List every date, deadline and deliverable in this document with the verbatim sentence it comes from." },
    { label: "Check deal terms", prompt: "Compare this document with the matter's deal terms, dates and parties. List only concrete mismatches with the verbatim text." },
  ],
};

type Attached = AttachmentPayload & { chars: number };

function IconBtn(p: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={p.label} onClick={p.onClick} disabled={p.disabled}>
          {p.children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{p.label}</TooltipContent>
    </Tooltip>
  );
}

/** Drafting side panel: bounded tool-using assistant over the open file, matter files and attached references. */
export function DraftPanel({ matterId, fileId, fileName, kind, canInsert, getDoc, editor, onClose }: Props) {
  const [effort, setEffort] = useEffort();
  const { turns, busy, send, stop, clear, markApplied } = useAssist({ matterId, storeKey: `mirza-draft-${fileId}`, effort, mode: "draft" });
  const [q, setQ] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [prepError, setPrepError] = useState<string | null>(null);
  const [attached, setAttached] = useState<Attached[]>([]);
  const [extracting, setExtracting] = useState<string | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  const [selection, setSelection] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // Switching files drops transient references (they belong to the request context of that file).
  useEffect(() => setAttached([]), [fileId]);

  // Live selection indicator (cheap poll; the actual target is captured at send time).
  useEffect(() => {
    const h = setInterval(() => {
      editor.current
        ?.getSelection()
        .then((s) => setSelection((p) => (p === s ? p : s)))
        .catch(() => {});
    }, 1200);
    return () => clearInterval(h);
  }, [editor]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setShowJump(!atBottom.current);
  };
  const jump = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setShowJump(false);
  };
  useEffect(() => {
    // Follow the stream only when the attorney is already at the bottom.
    if (atBottom.current) {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    } else setShowJump(true);
  }, [turns]);

  const quick = QUICK[kind === "docx" ? "docx" : kind === "xlsx" ? "xlsx" : "other"];

  const ask = useCallback(
    async (prompt: string, o: { label?: string; needsSel?: boolean; replaceId?: string } = {}) => {
      if (busy || preparing) return false;
      setPrepError(null);
      setPreparing(true);
      try {
        const doc = await getDoc();
        if (kind === "xlsx" && editor.current?.getWorkbook) doc.workbook = await editor.current.getWorkbook();
        if (o.needsSel && !doc.selection) {
          setPrepError("Select some text in the document first.");
          return false;
        }
        setPreparing(false);
        return await send(prompt, {
          ...(o.label ? { label: o.label } : {}),
          ...(o.replaceId ? { replaceId: o.replaceId } : {}),
          document: doc,
          attachments: attached.map(({ id, name, text, truncated }) => ({ id, name, text, truncated })),
        });
      } catch (e) {
        logClientError(e, "ai", { stage: "draft-context", kind });
        setPrepError("Couldn't read the open document. Your request is kept — try again.");
        return false;
      } finally {
        setPreparing(false);
      }
    },
    [busy, preparing, getDoc, kind, editor, send, attached],
  );

  async function submit() {
    const v = q.trim();
    if (!v) return;
    // Input is cleared only once the request actually started.
    if (await ask(v)) setQ("");
  }

  async function attach(files: FileList | null) {
    if (!files?.length) return;
    const { extractText } = await import("@/lib/extract");
    for (const f of Array.from(files)) {
      if (attached.length >= LIMITS.attachments) {
        setPrepError(`At most ${LIMITS.attachments} references per conversation. Remove one first.`);
        break;
      }
      if (f.size > LIMITS.attachmentBytes) {
        setPrepError(`${f.name} is ${(f.size / 1048576).toFixed(1)} MB — the limit is ${LIMITS.attachmentBytes / 1048576} MB. Split it or add it to the matter's files.`);
        continue;
      }
      setExtracting(f.name);
      try {
        const text = await extractText(f);
        if (!text.trim()) {
          setPrepError(`${f.name} has no readable text (it may be scanned). Add it to the matter's Files and use "Read scanned text" there.`);
          continue;
        }
        const truncated = text.length > LIMITS.attachmentChars;
        setAttached((a) => [
          ...a,
          { id: `att${Date.now().toString(36)}${a.length}`, name: f.name, text: text.slice(0, LIMITS.attachmentChars), truncated, chars: text.length },
        ]);
      } catch (e) {
        logClientError(e, "ai", { stage: "attach-extract" });
        setPrepError(`Couldn't read ${f.name}. Supported: PDF, Word (.docx), Excel (.xlsx), text.`);
      } finally {
        setExtracting(null);
      }
    }
    if (fileInput.current) fileInput.current.value = "";
  }

  const place = useCallback(
    async (turn: Turn, text: string, how: "cursor" | "replace") => {
      const ed = editor.current;
      if (!ed || applying || turn.apply?.state === "applied") return;
      setApplying(turn.id);
      try {
        const r = await ed.insert(text.trim(), how, turn.anchor);
        markApplied(turn.id, r.ok ? { state: "applied", note: r.detail ?? (r.how === "replace" ? "Replaced as a tracked change." : "Inserted as a tracked change.") } : { state: "failed", note: r.reason });
      } finally {
        setApplying(null);
      }
    },
    [editor, applying, markApplied],
  );

  const applyProposal = useCallback(
    async (turn: Turn, p: Proposal) => {
      const ed = editor.current;
      if (!ed?.applyProposal || applying || turn.apply?.state === "applied") return;
      setApplying(turn.id);
      try {
        const r = await ed.applyProposal(p);
        markApplied(turn.id, r.ok ? { state: "applied", note: r.detail } : { state: "failed", note: r.reason });
      } finally {
        setApplying(null);
      }
    },
    [editor, applying, markApplied],
  );

  const lastId = turns[turns.length - 1]?.id;

  return (
    <TooltipProvider delayDuration={300}>
      <aside className="flex h-full min-h-0 flex-col bg-card" aria-label="Drafting assistant">
        <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
          <span className="truncate pl-1 font-display text-sm font-semibold">Assistant</span>
          <span className="flex-1" />
          <EffortToggle value={effort} onChange={setEffort} />
          <IconBtn label="Clear conversation" onClick={clear} disabled={!turns.length}>
            <Trash2 className="h-3.5 w-3.5" />
          </IconBtn>
          {onClose && (
            <IconBtn label="Close assistant" onClick={onClose}>
              <X className="h-3.5 w-3.5" />
            </IconBtn>
          )}
        </div>

        <div className="shrink-0 space-y-1 border-b bg-raised/60 px-3 py-1.5 text-[11px] text-muted-foreground">
          <p className="flex items-center gap-1 truncate" title={fileName}>
            <FileText className="h-3 w-3 shrink-0" />
            <span className="truncate text-foreground">{fileName}</span>
          </p>
          <p className="truncate" title={selection}>
            {selection ? <>Selection: “{selection.slice(0, 80)}{selection.length > 80 ? "…" : ""}”</> : "No selection — requests use the whole file."}
          </p>
          {(attached.length > 0 || extracting) && (
            <ul className="flex flex-wrap gap-1 pt-0.5" aria-label="Attached references">
              {attached.map((a) => (
                <li key={a.id} className="inline-flex max-w-full items-center gap-1 rounded-sm border bg-card px-1.5 py-0.5">
                  <Paperclip className="h-3 w-3 shrink-0" />
                  <span className="truncate" title={a.name}>{a.name}</span>
                  <span className="shrink-0">{Math.round(a.chars / 1000)}k{a.truncated ? `, first ${LIMITS.attachmentChars / 1000}k used` : ""}</span>
                  <button aria-label={`Remove ${a.name}`} className="shrink-0 hover:text-foreground" onClick={() => setAttached((x) => x.filter((y) => y.id !== a.id))}>
                    <X className="h-3 w-3" />
                  </button>
                </li>
              ))}
              {extracting && (
                <li className="inline-flex items-center gap-1 px-1.5 py-0.5">
                  <Loader2 className="h-3 w-3 animate-spin" /> Reading {extracting}…
                </li>
              )}
            </ul>
          )}
        </div>

        <div className="relative min-h-0 flex-1">
          <div ref={scrollRef} onScroll={onScroll} className="h-full space-y-4 overflow-y-auto p-3 text-sm" aria-live="polite">
            {!turns.length && (
              <div className="space-y-2">
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {canInsert
                    ? kind === "xlsx"
                      ? "Reads this workbook, the matter's files and any references you attach. Cell changes are proposed for review; nothing changes until you click Apply."
                      : "Reads this document, the matter's files and any references you attach. Edits are proposed for review and land as tracked changes only when you click Apply."
                    : "Reads this file, the matter's files and attached references. Answers can be copied; this file isn't edited."}
                </p>
                <div className="flex flex-wrap gap-1">
                  {quick.map((x) => (
                    <button
                      key={x.label}
                      disabled={busy || preparing}
                      onClick={() => void ask(x.prompt, { label: x.label, ...(x.needsSel ? { needsSel: true } : {}) })}
                      className="rounded-sm border bg-card px-2 py-1 text-xs hover:bg-raised disabled:opacity-50"
                    >
                      {x.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {turns.map((t) => (
              <TurnView
                key={t.id}
                t={t}
                kind={kind}
                canInsert={canInsert}
                applying={applying === t.id}
                anyApplying={!!applying}
                canRetry={!busy && !preparing && t.id === lastId}
                onPlace={place}
                onApply={applyProposal}
                onRetry={(turn) => void ask(turn.q, { replaceId: turn.id, ...(turn.label ? { label: turn.label } : {}) })}
              />
            ))}
            {turns.length > 0 && <ReviewBanner />}
          </div>
          {showJump && (
            <Button size="sm" variant="secondary" className="absolute bottom-2 left-1/2 h-6 -translate-x-1/2 px-2 text-[11px] shadow-sm" onClick={jump}>
              <ArrowDown className="mr-1 h-3 w-3" /> Jump to latest
            </Button>
          )}
        </div>

        <form
          className="shrink-0 border-t p-2"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {prepError && (
            <p role="alert" className="mb-1.5 flex items-start gap-1 text-xs text-ink-red">
              <CircleAlert className="mt-0.5 h-3 w-3 shrink-0" />
              <span className="flex-1">{prepError}</span>
              <button type="button" aria-label="Dismiss" onClick={() => setPrepError(null)}>
                <X className="h-3 w-3" />
              </button>
            </p>
          )}
          <Textarea
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              // IME-safe: don't submit while composing (e.g. Japanese/Chinese input).
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                e.preventDefault();
                void submit();
              }
            }}
            rows={2}
            placeholder={kind === "xlsx" ? "Ask about or change this spreadsheet…" : canInsert ? "Ask, or select text and describe the change…" : "Ask about this document…"}
            aria-label="Drafting request"
            className="resize-none text-sm"
          />
          <div className="mt-1.5 flex items-center gap-1">
            <input
              ref={fileInput}
              type="file"
              className="hidden"
              accept=".pdf,.docx,.xlsx,.txt,.md"
              multiple
              onChange={(e) => void attach(e.target.files)}
            />
            <IconBtn label="Attach reference (stays in this browser and this request)" onClick={() => fileInput.current?.click()} disabled={!!extracting || attached.length >= LIMITS.attachments}>
              <Paperclip className="h-3.5 w-3.5" />
            </IconBtn>
            <span className="flex-1 text-[10px] text-muted-foreground">Enter to send · Shift+Enter for a new line</span>
            {busy ? (
              <Button type="button" size="sm" variant="outline" className="h-7" onClick={stop}>
                <Square className="mr-1 h-3 w-3" /> Stop
              </Button>
            ) : (
              <Button type="submit" size="sm" className="h-7" disabled={!q.trim() || preparing || !!extracting}>
                {preparing ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Send className="mr-1 h-3 w-3" />}
                {preparing ? "Preparing…" : "Send"}
              </Button>
            )}
          </div>
        </form>
      </aside>
    </TooltipProvider>
  );
}

/** One turn. Memoised so streaming re-renders only the active turn, not every markdown block above it. */
const TurnView = memo(function TurnView(p: {
  t: Turn;
  kind: DocContext["kind"];
  canInsert: boolean;
  applying: boolean;
  anyApplying: boolean;
  canRetry: boolean;
  onPlace: (t: Turn, text: string, how: "cursor" | "replace") => void;
  onApply: (t: Turn, pr: Proposal) => void;
  onRetry: (t: Turn) => void;
}) {
  const { t, kind, canInsert } = p;
  const [showAct, setShowAct] = useState(false);
  const streaming = t.status === "streaming";
  const { proposal: fence, explanation } = splitDraft(t.a);
  const { text, used } = streaming ? { text: explanation, used: [] } : linkCitations(explanation, t.sources);
  const structured = t.proposal;
  const applied = t.apply?.state === "applied";
  const running = t.activity?.find((a) => a.status === "running");
  return (
    <div className="space-y-1.5">
      <p className="rounded-sm bg-raised px-2 py-1 text-xs font-medium">{t.label ?? t.q}</p>
      {(t.anchor || t.attachments?.length) && (
        <p className="truncate text-[11px] text-muted-foreground" title={t.anchor}>
          {t.anchor ? `On: “${t.anchor}”` : ""}
          {t.attachments?.length ? `${t.anchor ? " · " : ""}With ${t.attachments.join(", ")}` : ""}
        </p>
      )}
      {!!t.activity?.length && (
        <div className="text-[11px] text-muted-foreground">
          <button className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => setShowAct((v) => !v)} aria-expanded={showAct}>
            <ChevronRight className={`h-3 w-3 transition-transform ${showAct ? "rotate-90" : ""}`} />
            {running ? running.label + "…" : `${t.activity.length} step${t.activity.length === 1 ? "" : "s"}${t.steps ? ` · ${t.steps} model round${t.steps === 1 ? "" : "s"}` : ""}`}
          </button>
          {showAct && (
            <ul className="mt-1 space-y-0.5 border-l pl-2">
              {t.activity.map((a) => (
                <li key={a.id} className="flex items-center gap-1">
                  {a.status === "running" ? <Loader2 className="h-3 w-3 animate-spin" /> : a.status === "done" ? <Check className="h-3 w-3" /> : <CircleAlert className="h-3 w-3 text-ink-red" />}
                  {a.label}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {text && (
        <div className="prose prose-sm max-w-none dark:prose-invert prose-p:my-1 prose-li:my-0">
          {streaming ? <p className="whitespace-pre-wrap">{text}</p> : <ReactMarkdown components={{ a: (a) => <a {...a} target="_blank" rel="noopener noreferrer" /> }}>{text}</ReactMarkdown>}
        </div>
      )}
      {streaming && !t.a && !running && <p className="flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Reading the file…</p>}

      {structured && <ProposalCard {...p} t={t} pr={structured.proposal} errors={structured.validation.ok ? [] : structured.validation.errors} />}

      {!structured && fence && (
        <div className="rounded-sm border">
          <div className="flex items-center justify-between border-b bg-raised px-2 py-1 text-[11px]">
            <span className="font-medium uppercase tracking-wide">{kind === "xlsx" ? "Proposed cells" : "Proposed text"}</span>
            <span className="text-muted-foreground">{t.anchor ? "Replaces the passage above" : "Inserts at cursor"}</span>
          </div>
          <pre className={`max-h-72 overflow-auto whitespace-pre-wrap px-2 py-1.5 text-xs leading-relaxed ${kind === "xlsx" ? "font-mono" : "font-sans"}`}>{fence}</pre>
        </div>
      )}

      {t.notice && <p className="text-xs text-muted-foreground">{t.notice}</p>}
      {t.error && (
        <p className="flex items-center gap-1 text-xs text-ink-red" role="alert">
          <CircleAlert className="h-3 w-3 shrink-0" /> {t.error}
        </p>
      )}
      {t.apply && (
        <p className={`text-xs ${applied ? "text-foreground" : "text-ink-red"}`} role="status">
          {applied ? <Check className="mr-1 inline h-3 w-3" /> : <CircleAlert className="mr-1 inline h-3 w-3" />}
          {t.apply.note}
        </p>
      )}
      {used.length > 0 && (
        <ul className="text-[11px] text-muted-foreground">
          {used.map((s) => (
            <li key={s.ref}>[{s.ref}] <a className="underline" href={s.url} target="_blank" rel="noopener noreferrer">{s.citation}</a></li>
          ))}
        </ul>
      )}
      {!streaming && (
        <div className="flex flex-wrap items-center gap-1">
          {t.status === "done" && <UsageNote effort={t.effort} usage={t.usage} />}
          <span className="flex-1" />
          {t.status !== "done" && t.retryable !== false && p.canRetry && (
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => p.onRetry(t)}>
              <RotateCcw className="mr-1 h-3 w-3" /> Retry
            </Button>
          )}
          {t.a && (
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => copyText((fence ?? t.a).trim(), fence ? "Proposed text copied" : "Copied")}>
              <Copy className="mr-1 h-3 w-3" /> Copy
            </Button>
          )}
          {!structured && fence && canInsert && (
            <Button
              size="sm"
              className="h-6 px-2 text-xs"
              disabled={p.anyApplying || applied}
              onClick={() => p.onPlace(t, fence, kind === "xlsx" ? "cursor" : t.anchor ? "replace" : "cursor")}
            >
              {kind === "xlsx" ? null : t.anchor ? <Replace className="mr-1 h-3 w-3" /> : <CornerDownLeft className="mr-1 h-3 w-3" />}
              {applied ? "Applied" : p.applying ? "Applying…" : kind === "xlsx" ? "Apply cells" : t.anchor ? "Replace" : "Insert"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
});

function ProposalCard(p: {
  t: Turn;
  pr: Proposal;
  errors: string[];
  canInsert: boolean;
  applying: boolean;
  anyApplying: boolean;
  onApply: (t: Turn, pr: Proposal) => void;
}) {
  const { t, pr, errors } = p;
  const applied = t.apply?.state === "applied";
  const valid = errors.length === 0;
  return (
    <div className={`rounded-sm border ${valid ? "" : "border-ink-red/40"}`}>
      <div className="flex items-center gap-2 border-b bg-raised px-2 py-1 text-[11px]">
        <span className="font-medium uppercase tracking-wide">{pr.kind === "word" ? `${pr.edits.length} proposed edit${pr.edits.length === 1 ? "" : "s"}` : `${pr.ops.length} cell${pr.ops.length === 1 ? "" : "s"}`}</span>
        <span className="flex-1 truncate text-muted-foreground">{pr.summary}</span>
        <span className={valid ? "text-muted-foreground" : "text-ink-red"}>{valid ? "Checked" : "Didn't pass checks"}</span>
      </div>
      <div className="max-h-80 overflow-auto text-xs">
        {pr.kind === "word" ? (
          <ol className="divide-y">
            {pr.edits.map((e, i) => (
              <li key={i} className="space-y-1 px-2 py-1.5">
                {e.op === "replace" ? (
                  <>
                    <p className="whitespace-pre-wrap text-muted-foreground line-through decoration-ink-red/60">{e.find}</p>
                    <p className="whitespace-pre-wrap">{e.replace}</p>
                  </>
                ) : (
                  <>
                    <p className="truncate text-muted-foreground">After: “{e.anchor}”</p>
                    <p className="whitespace-pre-wrap">+ {e.text}</p>
                  </>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <table className="w-full font-mono text-[11px]">
            <thead className="text-left text-muted-foreground">
              <tr><th className="px-2 py-1 font-normal">Cell</th><th className="px-2 py-1 font-normal">Type</th><th className="px-2 py-1 font-normal">Value</th></tr>
            </thead>
            <tbody className="divide-y">
              {pr.ops.map((o, i) => (
                <tr key={i}>
                  <td className="whitespace-nowrap px-2 py-0.5">{o.sheet}!{o.cell}</td>
                  <td className="px-2 py-0.5 text-muted-foreground">{o.type}</td>
                  <td className="break-all px-2 py-0.5">{o.type === "clear" ? "—" : o.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {!valid && (
        <ul className="border-t px-2 py-1 text-[11px] text-ink-red">
          {errors.slice(0, 6).map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}
      {p.canInsert && t.status === "done" && (
        <div className="flex justify-end gap-1 border-t px-2 py-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            onClick={() =>
              copyText(
                pr.kind === "word"
                  ? pr.edits.map((e) => (e.op === "replace" ? e.replace : e.text)).join("\n\n")
                  : pr.ops.map((o) => `${o.sheet}!${o.cell} = ${o.value}`).join("\n"),
                "Copied",
              )
            }
          >
            <Copy className="mr-1 h-3 w-3" /> Copy
          </Button>
          <Button size="sm" className="h-6 px-2 text-xs" disabled={!valid || applied || p.anyApplying} onClick={() => p.onApply(t, pr)}>
            {applied ? <><Check className="mr-1 h-3 w-3" /> Applied</> : p.applying ? "Applying…" : pr.kind === "word" ? "Apply as tracked changes" : "Apply cells"}
          </Button>
        </div>
      )}
    </div>
  );
}
