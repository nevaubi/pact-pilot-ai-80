import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import type { SuperDoc as SuperDocType } from "superdoc";
import "superdoc/style.css";
import { Skeleton } from "@/components/ui/skeleton";

export type DocMode = "editing" | "suggesting" | "viewing";

/** What the Office shell and the drafting panel need from any editor. */
export type EditorHandle = {
  /** Full plain text of the open document (for AI context and re-indexing). */
  getText: () => Promise<string>;
  /** Currently selected text, "" when nothing is selected. */
  getSelection: () => Promise<string>;
  /** Insert text at the cursor or replace the current selection. Returns false when the editor can't. */
  insert: (text: string, mode: "cursor" | "replace") => Promise<boolean>;
  /** Serialize the current document for saving. */
  export: () => Promise<Blob>;
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

/**
 * Word (.docx) editor on SuperDoc: page-faithful rendering, built-in toolbar, comments and
 * tracked changes. The AI never writes here directly — the shell calls `insert()` only after the
 * attorney clicks Insert/Replace, and in Suggesting mode those land as tracked changes.
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
    (async () => {
      try {
        const { SuperDoc } = await import("superdoc");
        if (disposed || !hostRef.current || !toolbarRef.current) return;
        hostRef.current.innerHTML = "";
        toolbarRef.current.innerHTML = "";
        const file = new File([blob], name, { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
        instance = new SuperDoc({
          selector: hostRef.current,
          documentMode: modeRef.current,
          role: modeRef.current === "viewing" ? "viewer" : "editor",
          document: { data: file, name, type: "docx" },
          user: { name: user.name, email: user.email ?? "" },
          ui: { toolbar: { container: toolbarRef.current }, search: true, comments: true, contextMenu: true },
          uiDisplayFallbackFont: '"Figtree", "Inter", system-ui, sans-serif',
          onReady: () => {
            if (disposed) return;
            // Load-time transactions fire editor updates; only count edits after the document settled.
            setTimeout(() => {
              readyRef.current = true;
            }, 400);
            setReady(true);
            onReady?.();
          },
          onEditorUpdate: () => {
            if (!disposed && readyRef.current) onDirty();
          },
          onException: (p: unknown) => {
            const e = (p as { error?: unknown } | undefined)?.error;
            const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "The document editor reported a problem.";
            console.error("[office:docx]", p);
            onError?.(msg);
          },
          onContentError: () => {
            if (disposed) return;
            setFailed("This document couldn't be opened in the editor. It may be damaged or use a feature the editor doesn't support yet. You can still download it.");
          },
        } as unknown as ConstructorParameters<typeof SuperDoc>[0]);
        sdRef.current = instance;
      } catch (e) {
        console.error("[office:docx:init]", e);
        if (!disposed) setFailed(e instanceof Error ? e.message : "The editor couldn't start.");
      }
    })();
    return () => {
      disposed = true;
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

  const doc = (): DocApi | null => (sdRef.current?.activeEditor?.doc as DocApi | null | undefined) ?? null;

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
          if (typeof first === "string") return new DOMParser().parseFromString(first, "text/html").body.innerText;
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
      insert: async (text, how) => {
        const d = doc();
        if (!d) return false;
        const tracked = modeRef.current === "suggesting";
        const opts = tracked ? { changeMode: "tracked" as const } : {};
        try {
          const s = await d.selection.current({ includeText: true } as never);
          const target = s?.selectionTarget ?? s?.target ?? undefined;
          if (how === "replace" && s && !s.empty && target) {
            await d.replace({ target, text } as never, opts as never);
          } else if (target) {
            await d.insert({ target, value: text, type: "text" } as never, opts as never);
          } else {
            await d.insert({ value: text, type: "text" } as never, opts as never);
          }
          onDirty();
          return true;
        } catch (e) {
          console.error("[office:docx:insert]", e);
          return false;
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
      <div ref={toolbarRef} className="shrink-0 border-b bg-card" aria-label="Formatting toolbar" />
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
