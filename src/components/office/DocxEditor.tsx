import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import type { SuperDoc as SuperDocType } from "superdoc";
import "superdoc/style.css";
import { Skeleton } from "@/components/ui/skeleton";
import { logClientError } from "@/lib/error-log";
import { applyWordEdits, resolveReplaceTarget, type ApplyResult, type MatchTarget, type WordEngine } from "@/lib/office-apply";
import type { Proposal } from "@/lib/office-tools";

export type DocMode = "editing" | "suggesting" | "viewing";

/** What the Office shell and the drafting panel need from any editor. */
/** Outcome of an AI-proposed edit the attorney clicked into the document. */
export type InsertResult =
  | { ok: true; tracked: boolean; how: "cursor" | "replace" | "cells"; detail?: string }
  | { ok: false; reason: string };

export type EditorHandle = {
  /** Full plain text of the open document (for AI context and re-indexing). */
  getText: () => Promise<string>;
  /** Currently selected text, "" when nothing is selected. */
  getSelection: () => Promise<string>;
  /**
   * Insert text at the cursor or replace the current selection. `anchor` is the text that was
   * selected when the attorney asked; if the live selection is gone, the editor locates it again.
   */
  insert: (text: string, mode: "cursor" | "replace", anchor?: string) => Promise<InsertResult>;
  /** Serialize the current document for saving. */
  export: () => Promise<Blob>;
  /** Apply a validated structured proposal (Word edits or sheet ops) after the attorney clicks Apply. */
  applyProposal?: (p: Proposal) => Promise<ApplyResult>;
  /** Spreadsheet snapshot (values + formulas) for the assistant's cell tools. */
  getWorkbook?: () => Promise<import("@/lib/office-tools").WorkbookSnap>;
  setMode?: (mode: DocMode) => void;
  acceptAllChanges?: () => Promise<void>;
  rejectAllChanges?: () => Promise<void>;
  focus?: () => void;
};

type Props = {
  blob: Blob;
  name: string;
  user: { name: string; email?: string | undefined };
  mode: DocMode;
  onDirty: () => void;
  onReady?: () => void;
  onError?: (message: string) => void;
  handle: Ref<EditorHandle | null>;
};

type DocApi = NonNullable<NonNullable<SuperDocType["activeEditor"]>["doc"]>;

const TRACKED = { changeMode: "tracked" } as const;

function receipt(r: unknown): { success: boolean; message?: string } {
  const x = r as { success?: boolean; failure?: { message?: string } } | undefined;
  return x && x.success === false ? { success: false, message: x.failure?.message || "The editor declined the change." } : { success: true };
}

function plainError(e: unknown) {
  const m = e instanceof Error ? e.message : "";
  if (/no change/i.test(m)) return "The proposal is identical to the text it would replace — nothing to change.";
  if (/read[- ]?only|viewing/i.test(m)) return "The document is in view-only mode. Switch to Editing or Suggesting first.";
  return m || "The editor couldn't apply that change.";
}

/** SuperDoc Document API adapter: literal case-sensitive query.match targets and checked receipts, always tracked. */
function wordEngine(d: DocApi): WordEngine {
  return {
    match: async (text) => {
      const r = (await d.query.match({
        select: { type: "text", pattern: text, mode: "contains", caseSensitive: true },
        limit: 2,
      } as never)) as { total?: number; items?: { target?: MatchTarget }[] };
      return { total: r?.total ?? r?.items?.length ?? 0, target: r?.items?.[0]?.target ?? null };
    },
    selection: async () => {
      const s = (await d.selection.current({ includeText: true } as never)) as
        | { empty?: boolean; text?: string; target?: MatchTarget | null; selectionTarget?: MatchTarget | null }
        | undefined;
      if (!s || s.empty) return { text: "", target: (s?.selectionTarget ?? s?.target) ?? null };
      return { text: s.text ?? "", target: s.selectionTarget ?? s.target ?? null };
    },
    replace: async (target, text) => receipt(await d.replace({ target, text } as never, TRACKED as never)),
    insertAt: async (target, text) => receipt(await d.insert({ target, value: text, type: "text" } as never, TRACKED as never)),
  };
}

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * Word (.docx) editor on SuperDoc: page-faithful rendering, built-in toolbar, comments and
 * tracked changes. The AI never writes here directly — the shell calls `insert()` only after the
 * attorney clicks Insert/Replace, and in Suggesting mode those land as tracked changes.
 * Telemetry is off: nothing about the firm's documents leaves the browser except to the firm's own storage.
 */
export function DocxEditor({ blob, name, user, mode, onDirty, onReady, onError, handle }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const sdRef = useRef<SuperDocType | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const readyRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    let instance: SuperDocType | null = null;
    let poll: ReturnType<typeof setInterval> | undefined;
    const markReady = () => {
      if (disposed || readyRef.current) return;
      // Load-time transactions fire editor updates; only count edits after the document settled.
      setTimeout(() => {
        readyRef.current = true;
      }, 400);
      setReady(true);
      onReady?.();
    };
    (async () => {
      try {
        const { SuperDoc } = await import("superdoc");
        if (disposed || !hostRef.current || !toolbarRef.current) return;
        hostRef.current.innerHTML = "";
        toolbarRef.current.innerHTML = "";
        const file = new File([blob], name, { type: DOCX_MIME });
        instance = new SuperDoc({
          selector: hostRef.current,
          documentMode: modeRef.current,
          role: modeRef.current === "viewing" ? "viewer" : "editor",
          document: { data: file, name, type: "docx" },
          title: name,
          user: { name: user.name, email: user.email ?? "" },
          ui: {
            toolbar: { container: toolbarRef.current, responsiveTo: "container", overflow: "menu" },
            loading: false,
            search: true,
            // Measure the editor pane, not the window: with the drafting panel open the sidebar
            // bubbles would be clipped, so comments fall back to the inline layout.
            comments: { layout: "auto", responsive: { target: hostRef.current, breakpoint: 1180 } },
            contextMenu: true,
          },
          telemetry: { enabled: false },
          disablePiniaDevtools: true,
          uiDisplayFallbackFont: '"Figtree", "Inter", system-ui, sans-serif',
          onReady: markReady,
          onEditorUpdate: () => {
            if (!disposed && readyRef.current) onDirty();
          },
          onException: (p: unknown) => {
            const e = (p as { error?: unknown } | undefined)?.error;
            const msg =
              e instanceof Error
                ? e.message
                : typeof e === "string"
                  ? e
                  : "The document editor reported a problem.";
            logClientError(e instanceof Error ? e : new Error(msg), "office", {
              kind: "docx",
              stage: "editor",
            });
            onError?.(msg);
          },
          onContentError: () => {
            if (disposed) return;
            setFailed(
              "This document couldn't be opened in the editor. It may be damaged or use a feature the editor doesn't support yet. You can still download it.",
            );
          },
        } as unknown as ConstructorParameters<typeof SuperDoc>[0]);
        sdRef.current = instance;
        if (import.meta.env.DEV)
          (window as unknown as { __mirzaDocx?: unknown }).__mirzaDocx = instance;
        // Belt and braces: if the ready event is missed, detect a mounted document directly.
        poll = setInterval(() => {
          const sd = sdRef.current as unknown as {
            activeEditor?: { doc?: unknown } | null;
            state?: { documents?: { isReady?: boolean }[] };
          } | null;
          if (sd?.activeEditor?.doc && sd.state?.documents?.[0]?.isReady) {
            clearInterval(poll);
            markReady();
          }
        }, 500);
      } catch (e) {
        logClientError(e, "office", { kind: "docx", stage: "open" });
        if (!disposed) setFailed(e instanceof Error ? e.message : "The editor couldn't start.");
      }
    })();
    return () => {
      disposed = true;
      if (poll) clearInterval(poll);
      try {
        instance?.destroy();
      } catch {
        /* already torn down */
      }
      sdRef.current = null;
    };
    // The editor is created once per document; mode changes go through setDocumentMode below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blob, name]);

  useEffect(() => {
    const sd = sdRef.current;
    if (!sd || !ready) return;
    try {
      sd.setDocumentMode(mode);
    } catch (e) {
      console.warn("[office:docx:mode]", e);
    }
  }, [mode, ready]);

  const doc = (): DocApi | null =>
    (sdRef.current?.activeEditor?.doc as DocApi | null | undefined) ?? null;

  useImperativeHandle(
    handle,
    () => ({
      getText: async () => {
        const d = doc();
        if (!d) return "";
        try {
          return String((await d.getText({})) ?? "");
        } catch {
          // Fallback: strip the HTML export.
          const html = sdRef.current?.getHTML?.() as unknown[] | undefined;
          const first = Array.isArray(html) ? html[0] : undefined;
          if (typeof first === "string")
            return new DOMParser().parseFromString(first, "text/html").body.innerText;
          return "";
        }
      },
      getSelection: async () => {
        const d = doc();
        if (!d) return "";
        try {
          const s = await d.selection.current({ includeText: true } as never);
          return s && !s.empty ? (s.text ?? "") : "";
        } catch {
          return "";
        }
      },
      insert: async (text, how, anchor) => {
        const d = doc();
        if (!d) return { ok: false, reason: "The document isn't open yet." };
        if (modeRef.current === "viewing")
          return { ok: false, reason: "Switch to Editing or Suggesting first — the document is in view-only mode." };
        const eng = wordEngine(d);
        try {
          if (how === "replace") {
            // The target is the passage captured when the attorney asked — never whatever is selected now.
            const t = await resolveReplaceTarget(eng, anchor);
            if ("reason" in t) return { ok: false, reason: t.reason };
            const r = await eng.replace(t.target, text);
            if (!r.success) return { ok: false, reason: r.message ?? "The editor declined the change." };
            onDirty();
            return { ok: true, tracked: true, how: "replace", detail: "Replaced the passage you selected when you asked." };
          }
          const s = await eng.selection();
          let target = s.target;
          // "Insert" with text highlighted inserts after it, never over it.
          if (target && s.text && target.end) target = { ...target, start: target.end };
          const r = target
            ? await eng.insertAt(target, text)
            : receipt(await d.insert({ value: text, type: "text" } as never, TRACKED as never));
          if (!r.success) return { ok: false, reason: r.message ?? "The editor declined the change." };
          onDirty();
          return { ok: true, tracked: true, how: "cursor" };
        } catch (e) {
          logClientError(e, "office", { kind: "docx", stage: how === "replace" ? "replace" : "insert" });
          return { ok: false, reason: plainError(e) };
        }
      },
      applyProposal: async (p) => {
        const d = doc();
        if (!d) return { ok: false, reason: "The document isn't open yet.", applied: 0 };
        if (p.kind !== "word") return { ok: false, reason: "That proposal is for a spreadsheet.", applied: 0 };
        if (modeRef.current === "viewing")
          return { ok: false, reason: "Switch to Editing or Suggesting first — the document is in view-only mode.", applied: 0 };
        try {
          const r = await applyWordEdits(wordEngine(d), p.edits);
          if (r.applied) onDirty();
          return r;
        } catch (e) {
          logClientError(e, "office", { kind: "docx", stage: "apply-proposal" });
          return { ok: false, reason: plainError(e), applied: 0 };
        }
      },
      export: async () => {
        const sd = sdRef.current;
        if (!sd) throw new Error("The editor isn't ready yet.");
        const out = await sd.export({ triggerDownload: false, commentsType: "external" } as never);
        if (!(out instanceof Blob)) throw new Error("The editor couldn't produce a Word file.");
        return out;
      },
      setMode: (m) => sdRef.current?.setDocumentMode(m),
      acceptAllChanges: async () => {
        const d = doc();
        if (!d) return;
        await d.trackChanges.decide({ decision: "accept", target: { kind: "all" } } as never);
        onDirty();
      },
      rejectAllChanges: async () => {
        const d = doc();
        if (!d) return;
        await d.trackChanges.decide({ decision: "reject", target: { kind: "all" } } as never);
        onDirty();
      },
      focus: () => sdRef.current?.focus(),
    }),
    [onDirty],
  );

  return (
    <div className="office-docx flex h-full min-h-0 flex-col">
      <div
        ref={toolbarRef}
        className="min-w-0 shrink-0 overflow-hidden border-b bg-card"
        aria-label="Formatting toolbar"
      />
      <div className="relative min-h-0 flex-1 overflow-auto bg-raised">
        {!ready && !failed && (
          <div className="absolute inset-0 z-10 flex items-start justify-center bg-raised p-6">
            <div className="w-full max-w-3xl space-y-3 rounded border bg-card p-10 shadow-sm">
              <Skeleton className="h-6 w-1/2" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-11/12" />
              <Skeleton className="h-4 w-10/12" />
              <Skeleton className="h-4 w-full" />
              <p className="pt-2 text-xs text-muted-foreground">Opening the document…</p>
            </div>
          </div>
        )}
        {failed && (
          <div className="m-6 rounded border border-ink-red/30 bg-ink-red/5 p-4 text-sm">
            <p className="font-medium">Couldn't open this document</p>
            <p className="mt-1 text-muted-foreground">{failed}</p>
          </div>
        )}
        <div ref={hostRef} className="h-full min-h-full" />
      </div>
    </div>
  );
}
