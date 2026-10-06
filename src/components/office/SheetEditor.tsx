import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import type { EditorHandle } from "./DocxEditor";
import { Skeleton } from "@/components/ui/skeleton";
import { workbookDataText, workbookToXlsx, xlsxToWorkbook, type WorkbookData } from "@/lib/office";

type Props = {
  blob: Blob;
  name: string;
  onDirty: () => void;
  onReady?: () => void;
  onError?: (message: string) => void;
  handle: Ref<EditorHandle | null>;
};

type Api = {
  getActiveWorkbook: () => {
    save: () => WorkbookData;
    getActiveSheet: () => { getSelection: () => { getActiveRange: () => { getValues: () => unknown[][]; setValue: (v: string) => void } | null } | null };
  } | null;
  createWorkbook: (d: WorkbookData) => unknown;
  addEvent?: (ev: unknown, cb: (e: unknown) => void) => { dispose: () => void };
  Event?: Record<string, unknown>;
  onCommandExecuted?: (cb: (c: { id: string; type?: number }) => void) => { dispose: () => void };
  dispose?: () => void;
};

/** Spreadsheet editor on Univer (formulas, formatting, freeze, merges). Round-trips .xlsx through ExcelJS. */
export function SheetEditor({ blob, name, onDirty, onReady, onError, handle }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<Api | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let univer: { dispose: () => void } | null = null;
    let sub: { dispose: () => void } | undefined;
    (async () => {
      try {
        const [{ createUniver, LocaleType, mergeLocales }, { UniverSheetsCorePreset }, en, data] = await Promise.all([
          import("@univerjs/presets"),
          import("@univerjs/preset-sheets-core"),
          import("@univerjs/preset-sheets-core/locales/en-US"),
          blob.arrayBuffer().then((b) => xlsxToWorkbook(b, name)),
          import("@univerjs/preset-sheets-core/lib/index.css"),
        ]);
        if (disposed || !hostRef.current) return;
        const made = createUniver({
          locale: LocaleType.EN_US,
          locales: { [LocaleType.EN_US]: mergeLocales(en.default) },
          presets: [UniverSheetsCorePreset({ container: hostRef.current })],
        });
        univer = made.univer;
        const api = made.univerAPI as unknown as Api;
        api.createWorkbook(data);
        apiRef.current = api;
        // Mutations (type 2) are real edits; operations are selection/scroll.
        let settled = false;
        setTimeout(() => (settled = true), 500);
        sub = api.onCommandExecuted?.((c) => {
          if (settled && c.type === 2) onDirty();
        });
        setReady(true);
        onReady?.();
      } catch (e) {
        console.error("[office:xlsx:init]", e);
        const msg = e instanceof Error ? e.message : "The spreadsheet couldn't open.";
        if (!disposed) {
          setFailed(msg);
          onError?.(msg);
        }
      }
    })();
    return () => {
      disposed = true;
      sub?.dispose();
      try {
        univer?.dispose();
      } catch {
        /* torn down */
      }
      apiRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blob, name]);

  useImperativeHandle(
    handle,
    () => ({
      getText: async () => {
        const wb = apiRef.current?.getActiveWorkbook();
        return wb ? workbookDataText(wb.save()) : "";
      },
      getSelection: async () => {
        try {
          const r = apiRef.current?.getActiveWorkbook()?.getActiveSheet().getSelection()?.getActiveRange();
          const v = r?.getValues() ?? [];
          if (v.length === 1 && v[0]?.length === 1) return "";
          return v.map((row) => row.map((c) => (c == null ? "" : String(c))).join("\t")).join("\n").trim();
        } catch {
          return "";
        }
      },
      insert: async (text) => {
        try {
          const r = apiRef.current?.getActiveWorkbook()?.getActiveSheet().getSelection()?.getActiveRange();
          if (!r) return false;
          r.setValue(text);
          onDirty();
          return true;
        } catch {
          return false;
        }
      },
      export: async () => {
        const wb = apiRef.current?.getActiveWorkbook();
        if (!wb) throw new Error("The spreadsheet isn't ready yet.");
        return workbookToXlsx(wb.save());
      },
    }),
    [onDirty],
  );

  if (failed)
    return (
      <div className="m-6 rounded border border-ink-red/30 bg-ink-red/5 p-4 text-sm">
        <p className="font-medium">Couldn't open this spreadsheet</p>
        <p className="mt-1 text-muted-foreground">{failed}</p>
      </div>
    );
  return (
    <div className="relative h-full min-h-0">
      {!ready && (
        <div className="absolute inset-0 z-10 space-y-2 bg-background p-6">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-64 w-full" />
          <p className="text-xs text-muted-foreground">Opening the spreadsheet…</p>
        </div>
      )}
      <div ref={hostRef} className="h-full w-full" />
    </div>
  );
}
