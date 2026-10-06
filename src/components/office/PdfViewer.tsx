import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import type { EditorHandle } from "./DocxEditor";
import { Skeleton } from "@/components/ui/skeleton";

type Registry = {
  getPlugin: (id: string) => { provides: () => unknown } | null | undefined;
};

type Props = {
  blob: Blob;
  name: string;
  text: string;
  author: string;
  dark: boolean;
  onDirty: () => void;
  onReady?: () => void;
  onError?: (message: string) => void;
  handle: Ref<EditorHandle | null>;
};

/**
 * PDF viewer/annotator on EmbedPDF (PDFium in WebAssembly, runs entirely in the browser).
 * Highlights, notes, shapes, search and text selection come from the drop-in viewer; the
 * annotated copy is saved back to the matter as a new version.
 */
export function PdfViewer({ blob, name, text, author, dark, onDirty, onReady, onError, handle }: Props) {
  const [Viewer, setViewer] = useState<null | typeof import("@embedpdf/react-pdf-viewer").PDFViewer>(null);
  const [wasmUrl, setWasmUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const registryRef = useRef<Registry | null>(null);
  const url = useMemo(() => URL.createObjectURL(blob), [blob]);
  const docId = useMemo(() => `doc-${crypto.randomUUID().slice(0, 8)}`, []);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const [{ PDFViewer }, wasm] = await Promise.all([import("@embedpdf/react-pdf-viewer"), import("@embedpdf/pdfium/pdfium.wasm?url")]);
        if (disposed) return;
        setViewer(() => PDFViewer);
        setWasmUrl(wasm.default);
      } catch (e) {
        console.error("[office:pdf:init]", e);
        if (!disposed) setFailed(e instanceof Error ? e.message : "The PDF viewer couldn't start.");
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  // Watch annotation commits so the shell knows there is something to save.
  useEffect(() => {
    const reg = registryRef.current;
    if (!reg) return;
    const ann = reg.getPlugin("annotation")?.provides() as { onAnnotationEvent?: (cb: (e: unknown) => void) => (() => void) | void } | undefined;
    const off = ann?.onAnnotationEvent?.((e) => {
      const ev = e as { type?: string };
      if (ev?.type === "create" || ev?.type === "update" || ev?.type === "delete" || ev?.type === "commit") onDirty();
    });
    return () => {
      if (typeof off === "function") off();
    };
  }, [onDirty, Viewer]);

  useImperativeHandle(
    handle,
    () => ({
      getText: async () => text,
      getSelection: async () => {
        const reg = registryRef.current;
        if (!reg) return "";
        try {
          const sel = reg.getPlugin("selection")?.provides() as
            | { getSelectedText?: () => { toPromise: () => Promise<string[]> }; forDocument?: (id: string) => { getSelectedText: () => { toPromise: () => Promise<string[]> } } }
            | undefined;
          const scoped = sel?.forDocument?.(docId) ?? sel;
          const lines = await scoped?.getSelectedText?.().toPromise();
          return (lines ?? []).join("\n").trim();
        } catch {
          return "";
        }
      },
      insert: async () => false,
      export: async () => {
        const reg = registryRef.current;
        if (!reg) throw new Error("The viewer isn't ready yet.");
        const exp = reg.getPlugin("export")?.provides() as
          | { saveAsCopy?: () => { toPromise: () => Promise<ArrayBuffer> }; forDocument?: (id: string) => { saveAsCopy: () => { toPromise: () => Promise<ArrayBuffer> } } }
          | undefined;
        const scoped = exp?.forDocument?.(docId) ?? exp;
        const buf = await scoped?.saveAsCopy?.().toPromise();
        if (!buf) throw new Error("The viewer couldn't produce a PDF.");
        return new Blob([buf], { type: "application/pdf" });
      },
    }),
    [text, docId],
  );

  if (failed)
    return (
      <div className="m-6 rounded border border-ink-red/30 bg-ink-red/5 p-4 text-sm">
        <p className="font-medium">Couldn't open this PDF</p>
        <p className="mt-1 text-muted-foreground">{failed}</p>
      </div>
    );
  if (!Viewer || !wasmUrl)
    return (
      <div className="flex h-full items-start justify-center bg-raised p-6">
        <div className="w-full max-w-3xl space-y-3 rounded border bg-card p-10 shadow-sm">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-11/12" />
          <p className="pt-2 text-xs text-muted-foreground">Starting the PDF viewer…</p>
        </div>
      </div>
    );

  return (
    <div className="office-pdf h-full min-h-0">
      <Viewer
        style={{ width: "100%", height: "100%" }}
        config={{
          wasmUrl,
          tabBar: "never",
          theme: {
            preference: dark ? "dark" : "light",
            light: { accent: { primary: "#3B82F6" } },
            dark: { accent: { primary: "#3B82F6" } },
          },
          documentManager: { initialDocuments: [{ url, documentId: docId, name, autoActivate: true }] },
          annotations: { annotationAuthor: author },
          export: { defaultFileName: name },
          disabledCategories: ["signature"],
        }}
        onReady={(registry) => {
          registryRef.current = registry as unknown as Registry;
          onReady?.();
          try {
            const ann = (registry as unknown as Registry).getPlugin("annotation")?.provides() as { onAnnotationEvent?: (cb: (e: unknown) => void) => void } | undefined;
            ann?.onAnnotationEvent?.((e) => {
              const ev = e as { type?: string };
              if (ev?.type && ev.type !== "select" && ev.type !== "deselect") onDirty();
            });
          } catch (e) {
            console.warn("[office:pdf:events]", e);
          }
        }}
        onInit={(container) => {
          const el = container as unknown as { addEventListener?: (t: string, cb: (e: unknown) => void) => void };
          el.addEventListener?.("error", (e) => onError?.(String((e as { detail?: unknown }).detail ?? "PDF error")));
        }}
      />
    </div>
  );
}
