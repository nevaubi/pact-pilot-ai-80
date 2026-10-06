import {
  createFileRoute,
  Link,
  useBlocker,
  useRouter,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Download, FileDown, Save, History, PanelRight } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { tryAction } from "@/lib/mutate";
import { logBoundaryError, logClientError } from "@/lib/error-log";
import {
  downloadBlob,
  officeKind,
  KIND_LABEL,
  saveBlobLocally,
  saveNewVersion,
  restoreVersion,
  SaveConflict,
} from "@/lib/office";
import type { DocMode, EditorHandle } from "@/components/office/DocxEditor";
import type { DocContext } from "@/hooks/use-assist";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

const DocxEditor = lazy(() =>
  import("@/components/office/DocxEditor").then((m) => ({ default: m.DocxEditor })),
);
const PdfViewer = lazy(() =>
  import("@/components/office/PdfViewer").then((m) => ({ default: m.PdfViewer })),
);
const SheetEditor = lazy(() =>
  import("@/components/office/SheetEditor").then((m) => ({ default: m.SheetEditor })),
);
const DraftPanel = lazy(() =>
  import("@/components/office/DraftPanel").then((m) => ({ default: m.DraftPanel })),
);

const PANEL_MIN = 288;
const PANEL_MAX = 640;
/** The editor always keeps at least this much width, so the panel can't crowd it out at 768–1024px. */
const EDITOR_MIN = 420;
const clampW = (w: number, container: number) =>
  Math.max(
    PANEL_MIN,
    Math.min(PANEL_MAX, Math.max(PANEL_MIN, container - EDITOR_MIN), Math.round(w)),
  );
function readStored(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStored(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* storage disabled */
  }
}

export const Route = createFileRoute("/_authenticated/office/$fileId")({
  head: () => ({
    meta: [
      { title: "Document editor — Mirza" },
      {
        name: "description",
        content:
          "Edit Word, PDF and spreadsheet files on a matter with a drafting assistant grounded in the matter's sources.",
      },
      { property: "og:title", content: "Document editor — Mirza" },
      {
        property: "og:description",
        content: "Edit matter documents with an attorney-reviewed drafting assistant.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: OfficePage,
  errorComponent: OfficeError,
});

/** An editor crash must not take the whole app down: log it, explain, and offer a way back. */
function OfficeError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const { fileId } = Route.useParams();
  useEffect(() => {
    logBoundaryError(error, "office", { fileId });
  }, [error, fileId]);
  return (
    <div className="mx-auto max-w-lg p-6 text-sm">
      <p className="font-display text-base font-semibold">The editor hit a problem</p>
      <p className="mt-1 text-muted-foreground">
        The document itself is safe — your last saved version is unchanged. This has been added to
        the error log under Settings.
      </p>
      <p className="mt-2 rounded border bg-raised px-2 py-1 font-mono text-xs text-muted-foreground">
        {error instanceof Error ? error.message : String(error)}
      </p>
      <div className="mt-4 flex gap-2">
        <Button
          size="sm"
          onClick={() => {
            router.invalidate();
            reset();
          }}
        >
          Reopen the document
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link to="/files">Back to files</Link>
        </Button>
      </div>
    </div>
  );
}

function OfficePage() {
  const { fileId } = Route.useParams();
  // Everything (refs, revisions, panel state) resets when the file changes.
  return <OfficeFile key={fileId} fileId={fileId} />;
}

function OfficeFile({ fileId }: { fileId: string }) {
  const qc = useQueryClient();
  const fileQ = useQuery({
    queryKey: ["office-file", fileId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("files")
        .select("*, matters(id, title)")
        .eq("id", fileId)
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new Error("This file no longer exists.");
      const blob = await downloadBlob(data.path);
      return { file: data, blob };
    },
    staleTime: Infinity,
    gcTime: 0,
  });
  const versionsQ = useQuery({
    queryKey: ["file-versions", fileId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("file_versions")
        .select("*")
        .eq("file_id", fileId)
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return data;
    },
  });
  const [user, setUser] = useState<{ id: string | null; name: string; email?: string }>({
    id: null,
    name: "Attorney",
  });
  useEffect(() => {
    let live = true;
    supabase.auth.getUser().then(({ data }) => {
      const u = data.user;
      if (u && live)
        setUser({
          id: u.id,
          name: (u.user_metadata?.["full_name"] as string) || u.email?.split("@")[0] || "Attorney",
          ...(u.email ? { email: u.email } : {}),
        });
    });
    return () => {
      live = false;
    };
  }, []);

  const editor = useRef<EditorHandle | null>(null);
  /** Storage path this editing session is based on (the save precondition) and its exact bytes. */
  const basePath = useRef<string | null>(null);
  const baseBlob = useRef<Blob | null>(null);
  /** Edit revision: bumps on every real edit; `saved` is the revision last written to storage. */
  const rev = useRef(0);
  const savedRev = useRef(0);
  const saveLock = useRef(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<DocMode>("editing");
  const [panel, setPanel] = useState(true);
  const [showVersions, setShowVersions] = useState(false);
  /** Bumps to remount the editor after a restore (new bytes, fresh baseline). */
  const [generation, setGeneration] = useState(0);
  const onDirty = useCallback(() => {
    rev.current++;
    setDirty(rev.current !== savedRev.current);
  }, []);

  if (fileQ.data && basePath.current === null) {
    basePath.current = fileQ.data.file.path;
    baseBlob.current = fileQ.data.blob;
  }

  const containerRef = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(1280);
  const [panelW, setPanelW] = useState(352);
  const [isWide, setIsWide] = useState(true);
  useEffect(() => {
    const saved = Number(readStored("mirza-panel-w"));
    if (saved) setPanelW(saved);
    const mq = window.matchMedia("(min-width: 768px)");
    const on = () => {
      setIsWide(mq.matches);
      if (!mq.matches) setPanel(false);
    };
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => e && setContainerW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [fileQ.data]);
  const width = clampW(panelW, containerW);
  useEffect(() => writeStored("mirza-panel-w", String(panelW)), [panelW]);
  const stopResize = useRef<(() => void) | null>(null);
  useEffect(() => () => stopResize.current?.(), []);
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = width;
    const move = (ev: PointerEvent) => setPanelW(clampW(w0 + (x0 - ev.clientX), containerW));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      stopResize.current = null;
    };
    stopResize.current = up;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  useBlocker({
    shouldBlockFn: () =>
      rev.current !== savedRev.current &&
      !window.confirm("You have unsaved changes in this document. Leave without saving?"),
    enableBeforeUnload: () => rev.current !== savedRev.current,
  });

  if (fileQ.isLoading)
    return (
      <div className="space-y-3 p-6">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-[60vh] w-full" />
      </div>
    );
  if (fileQ.error || !fileQ.data)
    return (
      <div className="p-6 text-sm">
        <p className="font-medium">Couldn't open this document</p>
        <p className="text-muted-foreground">{(fileQ.error as Error)?.message}</p>
      </div>
    );

  const { file, blob } = fileQ.data;
  const kind = officeKind(file.name);
  const matter = file.matters as { id: string; title: string } | null;

  async function save() {
    const ed = editor.current;
    if (!ed || saveLock.current || rev.current === savedRev.current) return;
    saveLock.current = true;
    setSaving(true);
    const at = rev.current;
    try {
      // Export and indexed text must come from the same revision; an edit in between aborts the save.
      const out = await ed.export();
      const text = kind === "pdf" ? undefined : (await ed.getText()).slice(0, 300000) || null;
      if (rev.current !== at) {
        toast.error(
          "You edited while the file was being prepared. Nothing was saved — press Save again.",
        );
        return;
      }
      const newPath = await saveNewVersion(file, basePath.current!, out, {
        ...(text !== undefined ? { text } : {}),
      });
      basePath.current = newPath;
      baseBlob.current = out;
      ed.markSaved?.(out);
      savedRev.current = at;
      setDirty(rev.current !== savedRev.current);
      qc.invalidateQueries({ queryKey: ["file-versions", fileId] });
      qc.invalidateQueries({ queryKey: ["files"] });
      qc.invalidateQueries({ queryKey: ["files-hub"] });
      toast.success(
        rev.current !== at
          ? "Saved the version from when you pressed Save; your newer edits are still unsaved."
          : "Saved. The previous version is kept in history.",
      );
    } catch (e) {
      logClientError(e, "office", { fileId, kind: kind ?? "unknown", stage: "save" });
      toast.error(
        e instanceof SaveConflict
          ? e.message
          : `Not saved: ${e instanceof Error ? e.message : "the editor couldn't produce the file"}. Your changes are still open here.`,
        { duration: 10_000 },
      );
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  }

  async function download() {
    try {
      // Unchanged since load/save: hand back the exact stored bytes, never a reserialised copy.
      const out =
        rev.current === savedRev.current || !editor.current
          ? (baseBlob.current ?? blob)
          : await editor.current.export();
      saveBlobLocally(out, file.name);
    } catch (e) {
      logClientError(e, "office", { fileId, kind: kind ?? "unknown", stage: "download" });
      toast.error(
        `Couldn't export your edited copy: ${e instanceof Error ? e.message : "unknown error"}. Use "Original" to download the last saved file.`,
      );
    }
  }

  async function restore(v: NonNullable<typeof versionsQ.data>[number]) {
    if (
      rev.current !== savedRev.current &&
      !window.confirm(
        "Restoring replaces the open document and discards your unsaved changes. Continue?",
      )
    )
      return;
    if (saveLock.current) return;
    saveLock.current = true;
    try {
      await restoreVersion(file, basePath.current!, v);
      toast.success("Version restored.");
      basePath.current = null;
      baseBlob.current = null;
      rev.current = 0;
      savedRev.current = 0;
      setDirty(false);
      await qc.invalidateQueries({ queryKey: ["office-file", fileId] });
      qc.invalidateQueries({ queryKey: ["file-versions", fileId] });
      setGeneration((g) => g + 1);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't restore that version.");
    } finally {
      saveLock.current = false;
    }
  }

  const getDoc = async (): Promise<DocContext> => ({
    name: file.name,
    kind: kind ?? "text",
    text: (await editor.current?.getText()) || file.extracted_text || "",
    selection: (await editor.current?.getSelection()) || undefined,
  });

  // Editor-reported problems (can't open, export failed) are shown and logged with the file kind, never its contents.
  const onEditorError = (m: string) => {
    toast.error(m);
    logClientError(new Error(m), "office", { fileId, kind: kind ?? "unknown" });
  };
  const editorKey = `${file.id}:${generation}`;
  return (
    <div className="flex h-[calc(100vh-3rem)] min-h-0 flex-col md:h-screen">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-card px-3 py-1.5">
        <Button asChild size="icon" variant="ghost" className="h-7 w-7" aria-label="Back">
          {matter ? (
            <Link to="/matters/$id" params={{ id: matter.id }} search={{ tab: "Files" } as never}>
              <ArrowLeft className="h-4 w-4" />
            </Link>
          ) : (
            <Link to="/files">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          )}
        </Button>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{file.name}</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {kind ? KIND_LABEL[kind] : "File"}
            {matter ? ` · ${matter.title}` : " · Firm"}
            {dirty ? " · Unsaved changes" : ""}
          </p>
        </div>
        <span className="flex-1" />
        {kind === "docx" && (
          <div
            className="inline-flex rounded border bg-raised p-0.5 text-xs"
            role="radiogroup"
            aria-label="Document mode"
          >
            {(["editing", "suggesting", "viewing"] as const).map((m) => (
              <button
                key={m}
                role="radio"
                aria-checked={mode === m}
                onClick={() => setMode(m)}
                className={`rounded-sm px-2 py-0.5 capitalize ${mode === m ? "bg-card shadow-sm" : "text-muted-foreground"}`}
              >
                {m}
              </button>
            ))}
          </div>
        )}
        {kind === "docx" && (
          <>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() =>
                tryAction(async () => {
                  await editor.current?.acceptAllChanges?.();
                  toast.success("All tracked changes accepted. Save to keep them.");
                }, "Couldn't accept the changes")
              }
            >
              Accept all
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() =>
                tryAction(async () => {
                  await editor.current?.rejectAllChanges?.();
                  toast.success(
                    "All tracked changes rejected. Save to keep the document as it was.",
                  );
                }, "Couldn't reject the changes")
              }
            >
              Reject all
            </Button>
          </>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          onClick={() => setShowVersions((v) => !v)}
        >
          <History className="mr-1 h-3.5 w-3.5" />
          History ({versionsQ.data?.length ?? 0})
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          onClick={() => void download()}
          title={
            dirty ? "Download your edited copy" : "Download the saved file (exact original bytes)"
          }
        >
          <Download className="mr-1 h-3.5 w-3.5" />
          Download
        </Button>
        {dirty && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            title="Download the last saved file, without your unsaved edits"
            onClick={() => saveBlobLocally(baseBlob.current ?? blob, file.name)}
          >
            <FileDown className="mr-1 h-3.5 w-3.5" />
            Original
          </Button>
        )}
        <Button
          size="sm"
          className="h-7 text-xs"
          disabled={saving || !dirty || kind === "text" || !kind}
          title={dirty ? "Save a new version" : "No unsaved changes"}
          onClick={() => void save()}
        >
          <Save className="mr-1 h-3.5 w-3.5" />
          {saving ? "Saving…" : "Save"}
        </Button>
        {matter && (
          <Button
            size="icon"
            variant={panel ? "secondary" : "ghost"}
            className="h-7 w-7"
            aria-label="Toggle drafting assistant"
            onClick={() => setPanel((p) => !p)}
          >
            <PanelRight className="h-4 w-4" />
          </Button>
        )}
      </header>
      {showVersions && (
        <div className="max-h-48 shrink-0 overflow-y-auto border-b bg-raised px-3 py-2 text-xs">
          {!versionsQ.data?.length ? (
            <p className="text-muted-foreground">
              No earlier versions yet. Each save keeps the previous copy here.
            </p>
          ) : (
            <ul className="divide-y">
              {versionsQ.data.map((v) => (
                <li key={v.id} className="flex items-center gap-2 py-1">
                  <span>{new Date(v.created_at).toLocaleString()}</span>
                  {v.note && <span className="truncate text-muted-foreground">{v.note}</span>}
                  <span className="flex-1" />
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 text-xs"
                    onClick={() => void restore(v)}
                  >
                    Restore
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div ref={containerRef} className="relative flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1">
          <Suspense fallback={<Skeleton className="m-6 h-[60vh]" />}>
            {kind === "docx" && (
              <DocxEditor
                key={editorKey}
                blob={blob}
                name={file.name}
                user={user}
                mode={mode}
                onDirty={onDirty}
                handle={editor}
                onError={onEditorError}
              />
            )}
            {kind === "pdf" && (
              <PdfViewer
                key={editorKey}
                blob={blob}
                name={file.name}
                text={file.extracted_text ?? ""}
                author={user.name}
                dark={document.documentElement.classList.contains("dark")}
                onDirty={onDirty}
                handle={editor}
                onError={onEditorError}
              />
            )}
            {kind === "xlsx" && (
              <SheetEditor
                key={editorKey}
                blob={blob}
                name={file.name}
                onDirty={onDirty}
                handle={editor}
                onError={onEditorError}
              />
            )}
            {(kind === "text" || !kind) && (
              <pre className="h-full overflow-auto whitespace-pre-wrap p-6 text-sm">
                {file.extracted_text ??
                  "This file type can't be opened in the editor. Download it instead."}
              </pre>
            )}
          </Suspense>
        </div>
        {panel && matter && (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize assistant panel"
              aria-valuemin={PANEL_MIN}
              aria-valuemax={PANEL_MAX}
              aria-valuenow={width}
              tabIndex={0}
              className="hidden w-1 shrink-0 cursor-col-resize border-l bg-border/40 hover:bg-primary/40 focus-visible:bg-primary/60 focus-visible:outline-none md:block"
              onPointerDown={startResize}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft") setPanelW(clampW(width + 16, containerW));
                if (e.key === "ArrowRight") setPanelW(clampW(width - 16, containerW));
              }}
            />
            <div
              className="absolute inset-y-0 right-0 z-20 w-full max-w-[26rem] border-l shadow-lg md:static md:z-auto md:max-w-none md:shadow-none"
              style={isWide ? { width } : undefined}
            >
              <Suspense fallback={<div className="h-full bg-card" />}>
                <DraftPanel
                  key={file.id}
                  matterId={matter.id}
                  fileId={file.id}
                  fileName={file.name}
                  kind={kind ?? "text"}
                  canInsert={kind === "docx" || kind === "xlsx"}
                  getDoc={getDoc}
                  editor={editor}
                  onClose={() => setPanel(false)}
                />
              </Suspense>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
