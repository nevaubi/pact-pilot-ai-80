import { memo, useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  ArrowDown,
  ArrowUp,
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
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useEffort } from "@/hooks/use-effort";
import {
  linkCitations,
  useAssist,
  type AttachmentPayload,
  type DocContext,
  type Turn,
} from "@/hooks/use-assist";
import { EffortToggle, UsageNote, ReviewBanner } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { copyText } from "@/lib/clipboard";
import { splitDraft } from "@/lib/office-proposals";
import {
  LIMITS,
  formatSummary,
  validateSheetOps,
  type Proposal,
  type SheetOp,
  type WordEdit,
} from "@/lib/office-tools";
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

type Quick = { label: string; prompt: string; needsSel?: boolean };
const QUICK: Record<"docx" | "xlsx" | "other", Quick[]> = {
  docx: [
    {
      label: "Fill blanks",
      prompt:
        "Find each unfilled [[Field]] or {{Field}} blank and propose its value from the matter record or files as Word edits. Leave any blank you can't source; list those as 'Needs attorney input'. Do not invent values.",
    },
    {
      label: "Proofread",
      prompt:
        "Proofread the document for typos, doubled words, punctuation and defined-term capitalisation. Propose only mechanical corrections as Word edits; do not change legal meaning or wording choices.",
    },
    {
      label: "Cross-references",
      prompt:
        "Check every internal cross-reference (Section/Article/Exhibit/Schedule numbers) against the headings that exist. List broken or doubtful references with the verbatim text; propose a fix only where the intended target is unambiguous.",
    },
    {
      label: "Format headings",
      prompt:
        "Make section headings consistent: propose format edits (bold, font size, font family) so headings at the same level match the most common existing heading style. Do not change heading text.",
    },
    {
      label: "Consistent style",
      prompt:
        "Find inline formatting inconsistencies in body text (stray bold/italic/underline, mixed fonts or sizes) and propose format edits restoring the dominant body style. Do not change any words.",
    },
    {
      label: "Tighten selection",
      prompt: "Tighten the selected text without changing its legal meaning.",
      needsSel: true,
    },
    {
      label: "Explain selection",
      prompt:
        "Explain the selected clause in plain terms: what it does, who it favours, and anything customary that appears missing.",
      needsSel: true,
    },
  ],
  xlsx: [
    {
      label: "Check the math",
      prompt:
        "Review the formulas and totals. List any cell whose formula or value looks inconsistent with its label or neighbours, quoting the cell reference.",
    },
    {
      label: "Tie to matter",
      prompt:
        "Compare amounts and dates in this spreadsheet with the matter's deal terms and property record. List concrete mismatches with cell references.",
    },
    {
      label: "Add totals row",
      prompt:
        "Propose a totals row for the main table on the active sheet using SUM formulas, as a sheet proposal with bold labels.",
    },
    {
      label: "Format numbers",
      prompt:
        "Propose consistent number formats for currency, percentage and date columns on the active sheet as 'keep' sheet ops with numberFormat only. Do not change values.",
    },
  ],
  other: [
    {
      label: "Summarize",
      prompt:
        "Summarize this document for the matter file in under 150 words: parties, purpose, key dates and amounts, open items. Quote dates and amounts exactly.",
    },
    {
      label: "Dates & deliverables",
      prompt:
        "List every date, deadline and deliverable in this document with the verbatim sentence it comes from.",
    },
    {
      label: "Check deal terms",
      prompt:
        "Compare this document with the matter's deal terms, dates and parties. List only concrete mismatches with the verbatim text.",
    },
  ],
};

type Attached = AttachmentPayload & { chars: number; note: string | null };
const EXT = /\.(pdf|docx|xlsx|txt|md)$/i;

function IconBtn(p: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          aria-label={p.label}
          onClick={p.onClick}
          disabled={p.disabled}
        >
          {p.children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{p.label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Drafting side panel: bounded tool-using assistant over the open file, matter files and transient
 * references. Mounted per file (the route keys it by file id), so a file switch resets everything.
 */
export function DraftPanel({
  matterId,
  fileId,
  fileName,
  kind,
  canInsert,
  getDoc,
  editor,
  onClose,
}: Props) {
  const [effort, setEffort] = useEffort();
  const { turns, busy, send, stop, clear, markApplied } = useAssist({
    matterId,
    storeKey: `mirza-draft-${fileId}`,
    effort,
    mode: "draft",
  });
  const [q, setQ] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [prepError, setPrepError] = useState<string | null>(null);
  const [attached, setAttached] = useState<Attached[]>([]);
  const attachedRef = useRef<Attached[]>([]);
  attachedRef.current = attached;
  const [extracting, setExtracting] = useState<string | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  const [selection, setSelection] = useState("");
  // Synchronous locks: two clicks before React re-renders must not both run.
  const prepLock = useRef(false);
  const applyLock = useRef(false);
  const extractLock = useRef(false);
  /** Bumps on Clear: in-flight context reads and extractions from before are discarded. */
  const gen = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

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
    if (atBottom.current) {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    } else setShowJump(true);
  }, [turns]);

  const quick = QUICK[kind === "docx" ? "docx" : kind === "xlsx" ? "xlsx" : "other"];
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const ask = useCallback(
    async (prompt: string, o: { label?: string; needsSel?: boolean; onStart?: () => void } = {}) => {
      if (busyRef.current || prepLock.current) return false;
      prepLock.current = true;
      const myGen = gen.current;
      setPrepError(null);
      setPreparing(true);
      try {
        const doc = await getDoc();
        if (kind === "xlsx" && editor.current?.getWorkbook)
          doc.workbook = await editor.current.getWorkbook();
        if (myGen !== gen.current) return false; // cleared while reading
        if (o.needsSel && !doc.selection) {
          setPrepError("Select some text in the document first.");
          return false;
        }
        const refs = attachedRef.current.map(({ id, name, text, truncated }) => ({
          id,
          name,
          text,
          truncated,
        }));
        prepLock.current = false;
        setPreparing(false);
        return await send(prompt, {
          ...(o.label ? { label: o.label } : {}),
          ...(o.onStart ? { onStart: o.onStart } : {}),
          document: doc,
          attachments: refs,
        });
      } catch (e) {
        logClientError(e, "ai", { stage: "draft-context", kind });
        if (myGen === gen.current)
          setPrepError("Couldn't read the open document. Your request is kept — try again.");
        return false;
      } finally {
        prepLock.current = false;
        setPreparing(false);
      }
    },
    [getDoc, kind, editor, send],
  );

  function submit() {
    const v = q.trim();
    if (!v) return;
    // Only the sent text is cleared, and only once the request is accepted — anything typed
    // since (or a failure to read the document) leaves the box untouched.
    void ask(v, { onStart: () => setQ((cur) => (cur.trim() === v ? "" : cur)) });
  }

  const doClear = useCallback(() => {
    gen.current++;
    clear();
    setAttached([]);
    setPrepError(null);
  }, [clear]);

  async function attach(list: FileList | null) {
    const files = Array.from(list ?? []);
    if (fileInput.current) fileInput.current.value = "";
    if (!files.length || extractLock.current) return;
    // Preflight the whole selection before reading anything.
    const have = attachedRef.current.length;
    const problems: string[] = [];
    if (have + files.length > LIMITS.attachments)
      problems.push(
        `You can attach at most ${LIMITS.attachments} references (${have} attached, ${files.length} selected).`,
      );
    for (const f of files) {
      if (!EXT.test(f.name)) problems.push(`${f.name}: unsupported type (PDF, .docx, .xlsx, .txt, .md).`);
      else if (f.size > LIMITS.attachmentBytes)
        problems.push(
          `${f.name} is ${(f.size / 1048576).toFixed(1)} MB — the limit is ${LIMITS.attachmentBytes / 1048576} MB.`,
        );
    }
    if (problems.length) return setPrepError(`Nothing was attached. ${problems.join(" ")}`);
    extractLock.current = true;
    const myGen = gen.current;
    const { extractWithCoverage } = await import("@/lib/extract");
    const notes: string[] = [];
    try {
      for (const f of files) {
        if (myGen !== gen.current) return;
        setExtracting(f.name);
        try {
          const x = await extractWithCoverage(f);
          if (myGen !== gen.current) return;
          if (!x.text.trim()) {
            notes.push(`${f.name} has no readable text (it may be scanned) — not attached. Add it to the matter's Files and use "Read scanned text" there.`);
            continue;
          }
          if (x.text.length > LIMITS.attachmentChars) {
            notes.push(`${f.name} has ${Math.round(x.text.length / 1000)}k characters of text; the per-reference limit is ${LIMITS.attachmentChars / 1000}k — not attached. Attach the relevant part instead.`);
            continue;
          }
          const used = attachedRef.current.reduce((n, a) => n + a.text.length, 0);
          if (used + x.text.length > LIMITS.attachmentsTotalChars) {
            notes.push(`${f.name} would take the references past ${LIMITS.attachmentsTotalChars / 1000}k characters in total — not attached. Remove one first.`);
            continue;
          }
          const item: Attached = {
            id: `att${crypto.randomUUID().slice(0, 8)}`,
            name: f.name,
            text: x.text,
            truncated: !x.complete,
            chars: x.text.length,
            note: x.note,
          };
          attachedRef.current = [...attachedRef.current, item];
          setAttached(attachedRef.current);
          if (x.note) notes.push(`${f.name}: only the ${x.note} could be read.`);
        } catch (e) {
          logClientError(e, "ai", { stage: "attach-extract" });
          notes.push(`Couldn't read ${f.name}.`);
        }
      }
    } finally {
      extractLock.current = false;
      setExtracting(null);
    }
    if (notes.length && myGen === gen.current) setPrepError(notes.join(" "));
  }

  // Stable handlers (refs, not state) so memoised turns don't re-render on every token.
  const applyingRef = useRef(applying);
  applyingRef.current = applying;
  const runApply = useCallback(
    async (turn: Turn, fn: () => Promise<{ ok: boolean; note: string; partial?: boolean }>) => {
      // A failed (nothing changed) apply may be tried again by hand; applied/partial never.
      if (applyLock.current || (turn.apply && turn.apply.state !== "failed")) return;
      applyLock.current = true;
      setApplying(turn.id);
      try {
        const r = await fn();
        markApplied(turn.id, {
          state: r.ok ? "applied" : r.partial ? "partial" : "failed",
          note: r.note,
        });
      } finally {
        applyLock.current = false;
        setApplying(null);
      }
    },
    [markApplied],
  );

  const place = useCallback(
    (turn: Turn, text: string, how: "cursor" | "replace") =>
      void runApply(turn, async () => {
        const ed = editor.current;
        if (!ed) return { ok: false, note: "The editor isn't ready." };
        const r = await ed.insert(text.trim(), how, turn.anchor, turn.askSheet);
        return r.ok
          ? {
              ok: true,
              note:
                r.detail ??
                (r.how === "replace" ? "Replaced as a tracked change." : "Inserted as a tracked change."),
            }
          : { ok: false, note: r.reason };
      }),
    [editor, runApply],
  );

  const applyProposal = useCallback(
    (turn: Turn, p: Proposal) =>
      void runApply(turn, async () => {
        const ed = editor.current;
        if (!ed?.applyProposal) return { ok: false, note: "This editor can't apply proposals." };
        const r = await ed.applyProposal(p);
        return r.ok
          ? { ok: true, note: r.detail }
          : { ok: false, note: r.reason, ...(r.partial ? { partial: true } : {}) };
      }),
    [editor, runApply],
  );

  const onRetry = useCallback(
    (turn: Turn) => {
      const now = attachedRef.current.map((a) => a.name).join(", ");
      const then = (turn.attachments ?? []).join(", ");
      void ask(turn.q, {
        ...(turn.label ? { label: turn.label } : {}),
        onStart: () =>
          setPrepError(
            now !== then
              ? `Retrying as a new request with the document as it is now and ${now ? `these references: ${now}` : "no references"} (the original used ${then || "none"}).`
              : null,
          ),
      });
    },
    [ask],
  );

  const lastId = turns[turns.length - 1]?.id;
  const idle = !busy && !preparing;

  return (
    <TooltipProvider delayDuration={300}>
      <aside className="flex h-full min-h-0 flex-col bg-card" aria-label="Drafting assistant">
        <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
          <span className="truncate pl-1 font-display text-sm font-semibold">Assistant</span>
          <span className="flex-1" />
          <EffortToggle value={effort} onChange={setEffort} />
          <IconBtn label="Clear conversation" onClick={doClear} disabled={!turns.length && !attached.length}>
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
            {selection ? (
              <>
                Selection: “{selection.slice(0, 80)}
                {selection.length > 80 ? "…" : ""}”
              </>
            ) : (
              "No selection — requests use the whole file."
            )}
          </p>
          {(attached.length > 0 || extracting) && (
            <ul className="flex flex-wrap gap-1 pt-0.5" aria-label="Attached references">
              {attached.map((a) => (
                <li
                  key={a.id}
                  className="inline-flex max-w-full items-center gap-1 rounded-sm border bg-card px-1.5 py-0.5"
                  title={a.note ? `Partial: ${a.note}` : a.name}
                >
                  <Paperclip className="h-3 w-3 shrink-0" />
                  <span className="truncate">{a.name}</span>
                  <span className="shrink-0">
                    {Math.max(1, Math.round(a.chars / 1000))}k{a.note ? " · partial" : ""}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${a.name}`}
                    className="shrink-0 hover:text-foreground"
                    onClick={() => {
                      attachedRef.current = attachedRef.current.filter((y) => y.id !== a.id);
                      setAttached(attachedRef.current);
                    }}
                  >
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
          {attached.length > 0 && (
            <p>References are transient: sent with each AI request from this panel, not saved to the matter's files.</p>
          )}
        </div>

        <div className="relative min-h-0 flex-1">
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="h-full space-y-4 overflow-y-auto p-3 text-sm"
            aria-live="polite"
          >
            {!turns.length && (
              <div className="space-y-2">
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {canInsert
                    ? kind === "xlsx"
                      ? "Reads this workbook, the matter's files and any references you attach. Cell and format changes are proposed for review; nothing changes until you click Apply."
                      : "Reads this document, the matter's files and any references you attach. Edits and formatting are proposed for review and land as tracked changes only when you click Apply."
                    : "Reads this file, the matter's files and attached references. Answers can be copied; this file isn't edited."}
                </p>
                <div className="flex flex-wrap gap-1">
                  {quick.map((x) => (
                    <button
                      key={x.label}
                      type="button"
                      disabled={!idle}
                      onClick={() =>
                        void ask(x.prompt, {
                          label: x.label,
                          ...(x.needsSel ? { needsSel: true } : {}),
                        })
                      }
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
                anyApplying={applying !== null}
                canRetry={idle && t.id === lastId}
                onPlace={place}
                onApply={applyProposal}
                onRetry={onRetry}
              />
            ))}
            {turns.length > 0 && <ReviewBanner />}
          </div>
          {showJump && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="absolute bottom-2 left-1/2 h-6 -translate-x-1/2 px-2 text-[11px] shadow-sm"
              onClick={jump}
            >
              <ArrowDown className="mr-1 h-3 w-3" /> Jump to latest
            </Button>
          )}
        </div>

        <form
          className="shrink-0 border-t p-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
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
          <div className="relative">
            <Textarea
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                // IME-safe: don't submit while composing (e.g. Japanese/Chinese input).
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                  e.preventDefault();
                  if (idle && !extracting) submit();
                }
              }}
              rows={2}
              placeholder={
                kind === "xlsx"
                  ? "Ask about or change this spreadsheet…"
                  : canInsert
                    ? "Ask, or select text and describe the change…"
                    : "Ask about this document…"
              }
              aria-label="Drafting request"
              className="resize-none pr-10 text-sm"
            />
            <div className="absolute bottom-1.5 right-1.5">
              {busy ? (
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="h-7 w-7"
                  aria-label="Stop"
                  onClick={stop}
                >
                  <Square className="h-3 w-3" />
                </Button>
              ) : (
                <Button
                  type="submit"
                  size="icon"
                  className="h-7 w-7"
                  aria-label={preparing ? "Preparing" : "Send"}
                  disabled={!q.trim() || preparing || !!extracting}
                >
                  {preparing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUp className="h-3.5 w-3.5" />}
                </Button>
              )}
            </div>
          </div>
          <div className="mt-1 flex items-center gap-1">
            <input
              ref={fileInput}
              type="file"
              className="hidden"
              accept=".pdf,.docx,.xlsx,.txt,.md"
              multiple
              onChange={(e) => void attach(e.target.files)}
            />
            <IconBtn
              label="Attach reference (sent with AI requests from this panel; not saved to the matter)"
              onClick={() => fileInput.current?.click()}
              disabled={!!extracting || attached.length >= LIMITS.attachments}
            >
              <Paperclip className="h-3.5 w-3.5" />
            </IconBtn>
            <span className="flex-1 text-[10px] text-muted-foreground">
              Enter to send · Shift+Enter for a new line
            </span>
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
  const { text, used } = streaming
    ? { text: explanation, used: [] }
    : linkCitations(explanation, t.sources);
  const structured = t.proposal;
  const decided = !!t.apply && t.apply.state !== "failed";
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
          <button
            type="button"
            className="inline-flex items-center gap-1 hover:text-foreground"
            onClick={() => setShowAct((v) => !v)}
            aria-expanded={showAct}
          >
            <ChevronRight className={`h-3 w-3 transition-transform ${showAct ? "rotate-90" : ""}`} />
            {running
              ? running.label + "…"
              : `${t.activity.length} step${t.activity.length === 1 ? "" : "s"}${t.steps ? ` · ${t.steps} model round${t.steps === 1 ? "" : "s"}` : ""}`}
          </button>
          {showAct && (
            <ul className="mt-1 space-y-0.5 border-l pl-2">
              {t.activity.map((a) => (
                <li key={a.id} className="flex items-center gap-1">
                  {a.status === "running" ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : a.status === "done" ? (
                    <Check className="h-3 w-3" />
                  ) : (
                    <CircleAlert className="h-3 w-3 text-ink-red" />
                  )}
                  {a.label}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {text && (
        <div className="prose prose-sm max-w-none dark:prose-invert prose-p:my-1 prose-li:my-0">
          {streaming ? (
            <p className="whitespace-pre-wrap">{text}</p>
          ) : (
            <ReactMarkdown components={{ a: (a) => <a {...a} target="_blank" rel="noopener noreferrer" /> }}>
              {text}
            </ReactMarkdown>
          )}
        </div>
      )}
      {streaming && !t.a && !running && (
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Reading the file…
        </p>
      )}

      {structured && (
        <ProposalCard
          t={t}
          pr={structured.proposal}
          errors={structured.validation.ok ? [] : structured.validation.errors}
          canInsert={canInsert}
          applying={p.applying}
          anyApplying={p.anyApplying}
          onApply={p.onApply}
        />
      )}

      {!structured && fence && (
        <div className="rounded-sm border">
          <div className="flex items-center justify-between border-b bg-raised px-2 py-1 text-[11px]">
            <span className="font-medium uppercase tracking-wide">
              {kind === "xlsx" ? "Proposed cells" : "Proposed text"}
            </span>
            <span className="text-muted-foreground">
              {kind === "xlsx"
                ? `Sheet: ${t.askSheet ?? "unknown"}`
                : t.anchor
                  ? "Replaces the passage above"
                  : "Inserts at cursor"}
            </span>
          </div>
          <pre
            className={`max-h-72 overflow-auto whitespace-pre-wrap px-2 py-1.5 text-xs leading-relaxed ${kind === "xlsx" ? "font-mono" : "font-sans"}`}
          >
            {fence}
          </pre>
        </div>
      )}

      {t.notice && <p className="text-xs text-muted-foreground">{t.notice}</p>}
      {t.error && (
        <p className="flex items-center gap-1 text-xs text-ink-red" role="alert">
          <CircleAlert className="h-3 w-3 shrink-0" /> {t.error}
        </p>
      )}
      {t.apply && (
        <p className={`text-xs ${t.apply.state === "applied" ? "text-foreground" : "text-ink-red"}`} role="status">
          {t.apply.state === "applied" ? (
            <Check className="mr-1 inline h-3 w-3" />
          ) : (
            <CircleAlert className="mr-1 inline h-3 w-3" />
          )}
          {t.apply.state === "partial" ? "Partly applied — " : t.apply.state === "failed" ? "Not applied — " : ""}
          {t.apply.note}
        </p>
      )}
      {used.length > 0 && (
        <ul className="text-[11px] text-muted-foreground">
          {used.map((s) => (
            <li key={s.ref}>
              [{s.ref}]{" "}
              <a className="underline" href={s.url} target="_blank" rel="noopener noreferrer">
                {s.citation}
              </a>
            </li>
          ))}
        </ul>
      )}
      {!streaming && (
        <div className="flex flex-wrap items-center gap-1">
          {t.status === "done" && <UsageNote effort={t.effort} usage={t.usage} />}
          <span className="flex-1" />
          {t.status !== "done" && t.retryable !== false && p.canRetry && (
            <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => p.onRetry(t)}>
              <RotateCcw className="mr-1 h-3 w-3" /> Retry
            </Button>
          )}
          {t.a && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={() => copyText((fence ?? t.a).trim(), fence ? "Proposed text copied" : "Copied")}
            >
              <Copy className="mr-1 h-3 w-3" /> Copy
            </Button>
          )}
          {!structured && fence && canInsert && (
            <Button
              type="button"
              size="sm"
              className="h-6 px-2 text-xs"
              disabled={p.anyApplying || decided}
              onClick={() => p.onPlace(t, fence, kind === "xlsx" ? "cursor" : t.anchor ? "replace" : "cursor")}
            >
              {kind === "xlsx" ? null : t.anchor ? (
                <Replace className="mr-1 h-3 w-3" />
              ) : (
                <CornerDownLeft className="mr-1 h-3 w-3" />
              )}
              {t.apply?.state === "applied"
                ? "Applied"
                : decided
                  ? "Partly applied"
                  : p.applying
                    ? "Applying…"
                    : kind === "xlsx"
                      ? "Apply cells"
                      : t.anchor
                        ? "Replace"
                        : "Insert"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
});

function editLabel(e: WordEdit) {
  return e.op === "format" ? `Format “${e.find}”` : e.op === "replace" ? "Replace" : `After “${e.anchor}”`;
}

/** Editable, re-validated review card for a structured proposal. */
function ProposalCard(p: {
  t: Turn;
  pr: Proposal;
  errors: string[];
  canInsert: boolean;
  applying: boolean;
  anyApplying: boolean;
  onApply: (t: Turn, pr: Proposal) => void;
}) {
  const { t, errors } = p;
  const [draft, setDraft] = useState<Proposal>(p.pr);
  const edited = JSON.stringify(draft) !== JSON.stringify(p.pr);
  const decided = !!t.apply && t.apply.state !== "failed";
  // Edited sheet values are re-checked here; Word edits are re-checked against the live document at Apply.
  const localErrors =
    edited && draft.kind === "sheet"
      ? validateSheetOps(
          [...new Set(draft.ops.map((o) => o.sheet))],
          draft.ops,
        ).errors.filter((e) => !/unknown sheet/.test(e))
      : [];
  const shown = edited ? localErrors : errors;
  const valid = shown.length === 0;
  const setWord = (i: number, e: WordEdit) =>
    draft.kind === "word" && setDraft({ ...draft, edits: draft.edits.map((x, j) => (j === i ? e : x)) });
  const setOp = (i: number, o: SheetOp) =>
    draft.kind === "sheet" && setDraft({ ...draft, ops: draft.ops.map((x, j) => (j === i ? o : x)) });
  const lockedEdit = decided || !p.canInsert || t.status !== "done";
  return (
    <div className={`rounded-sm border ${valid ? "" : "border-ink-red/40"}`}>
      <div className="flex items-center gap-2 border-b bg-raised px-2 py-1 text-[11px]">
        <span className="font-medium uppercase tracking-wide">
          {draft.kind === "word"
            ? `${draft.edits.length} proposed edit${draft.edits.length === 1 ? "" : "s"}`
            : `${draft.ops.length} cell${draft.ops.length === 1 ? "" : "s"}`}
        </span>
        <span className="flex-1 truncate text-muted-foreground">{draft.summary}</span>
        <span className={valid ? "text-muted-foreground" : "text-ink-red"}>
          {edited ? (valid ? "Edited" : "Edited — fix errors") : valid ? "Checked" : "Didn't pass checks"}
        </span>
      </div>
      <div className="max-h-80 overflow-auto text-xs">
        {draft.kind === "word" ? (
          <ol className="divide-y">
            {draft.edits.map((e, i) => (
              <li key={i} className="space-y-1 px-2 py-1.5">
                <p className="truncate text-[11px] text-muted-foreground">{editLabel(e)}</p>
                {e.op === "replace" && (
                  <>
                    <p className="whitespace-pre-wrap text-muted-foreground line-through decoration-ink-red/60">{e.find}</p>
                    <textarea
                      aria-label={`Replacement text for edit ${i + 1}`}
                      className="w-full resize-y rounded-sm border bg-background px-1 py-0.5"
                      rows={Math.min(6, Math.max(1, Math.ceil(e.replace.length / 60)))}
                      value={e.replace}
                      disabled={lockedEdit}
                      onChange={(ev) => setWord(i, { ...e, replace: ev.target.value })}
                    />
                  </>
                )}
                {e.op === "insert_after" && (
                  <textarea
                    aria-label={`Inserted text for edit ${i + 1}`}
                    className="w-full resize-y rounded-sm border bg-background px-1 py-0.5"
                    rows={Math.min(6, Math.max(1, Math.ceil(e.text.length / 60)))}
                    value={e.text}
                    disabled={lockedEdit}
                    onChange={(ev) => setWord(i, { ...e, text: ev.target.value })}
                  />
                )}
                {e.op === "format" && (
                  <p>
                    <span className="text-muted-foreground">Set: </span>
                    {formatSummary(e.format) || "—"}
                  </p>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <table className="w-full font-mono text-[11px]">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="px-2 py-1 font-normal">Cell</th>
                <th className="px-2 py-1 font-normal">Type</th>
                <th className="px-2 py-1 font-normal">Value</th>
                <th className="px-2 py-1 font-normal">Format</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {draft.ops.map((o, i) => (
                <tr key={i}>
                  <td className="whitespace-nowrap px-2 py-0.5">
                    {o.sheet}!{o.cell}
                  </td>
                  <td className="px-2 py-0.5 text-muted-foreground">{o.type}</td>
                  <td className="px-2 py-0.5">
                    {o.type === "clear" || o.type === "keep" ? (
                      "—"
                    ) : (
                      <input
                        aria-label={`Value for ${o.sheet}!${o.cell}`}
                        className="w-full rounded-sm border bg-background px-1"
                        value={o.value}
                        disabled={lockedEdit}
                        onChange={(ev) => setOp(i, { ...o, value: ev.target.value })}
                      />
                    )}
                  </td>
                  <td className="px-2 py-0.5 text-muted-foreground">
                    {[
                      o.numberFormat ? `fmt ${o.numberFormat}` : "",
                      o.bold != null ? (o.bold ? "bold" : "not bold") : "",
                      o.fill ? `fill ${o.fill}` : "",
                      o.align ? o.align : "",
                    ]
                      .filter(Boolean)
                      .join(", ") || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {!valid && (
        <ul className="border-t px-2 py-1 text-[11px] text-ink-red">
          {shown.slice(0, 6).map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      {p.canInsert && t.status === "done" && (
        <div className="flex justify-end gap-1 border-t px-2 py-1">
          {edited && !decided && (
            <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setDraft(p.pr)}>
              Reset
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            onClick={() =>
              copyText(
                draft.kind === "word"
                  ? draft.edits
                      .map((e) => (e.op === "replace" ? e.replace : e.op === "insert_after" ? e.text : `${e.find} → ${formatSummary(e.format)}`))
                      .join("\n\n")
                  : draft.ops.map((o) => `${o.sheet}!${o.cell} = ${o.value}`).join("\n"),
                "Copied",
              )
            }
          >
            <Copy className="mr-1 h-3 w-3" /> Copy
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={!valid || decided || p.anyApplying}
            onClick={() => p.onApply(t, draft)}
          >
            {t.apply?.state === "applied" ? (
              <>
                <Check className="mr-1 h-3 w-3" /> Applied
              </>
            ) : decided ? (
              "Partly applied"
            ) : p.applying ? (
              "Applying…"
            ) : draft.kind === "word" ? (
              "Apply as tracked changes"
            ) : (
              "Apply cells"
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
