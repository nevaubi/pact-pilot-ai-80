import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import type { EditorHandle } from "./DocxEditor";
import { Skeleton } from "@/components/ui/skeleton";
import { workbookDataText, workbookToXlsx, xlsxToWorkbook, type WorkbookData } from "@/lib/office";
import { logClientError } from "@/lib/error-log";
import { coerceCellValue, parseCellAssignments } from "@/lib/office-proposals";

type Props = {
  blob: Blob;
  name: string;
  onDirty: () => void;
  onReady?: () => void;
  onError?: (message: string) => void;
  handle: Ref<EditorHandle | null>;
};

type FRange = {
  getValues: () => unknown[][];
  setValue: (v: string | number | boolean | null) => unknown;
  setFormula: (f: string) => unknown;
  getA1Notation: (withSheet?: boolean) => string;
  isBlank?: () => boolean;
  getNumberFormat?: () => string;
  setNumberFormat?: (pattern: string) => unknown;
};
type FSheet = {
  getSheetName: () => string;
  getRange: (a1: string) => FRange;
  getSelection: () => { getActiveRange: () => FRange | null } | null;
};
type Api = {
  getActiveWorkbook: () => {
    save: () => WorkbookData;
    getActiveSheet: () => FSheet;
    getSheetByName: (name: string) => FSheet | null;
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
        const [{ createUniver, LocaleType, mergeLocales }, { UniverSheetsCorePreset }, en, data] =
          await Promise.all([
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
        logClientError(e, "office", { kind: "xlsx", stage: "open" });
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
          const sheet = apiRef.current?.getActiveWorkbook()?.getActiveSheet();
          const r = sheet?.getSelection()?.getActiveRange();
          const v = r?.getValues() ?? [];
          if (!r || !sheet || (v.length === 1 && v[0]?.length === 1)) return "";
          const grid = v
            .map((row) => row.map((c) => (c == null ? "" : String(c))).join("\t"))
            .join("\n")
            .trim();
          return `Selected ${r.getA1Notation()} on sheet "${sheet.getSheetName()}":\n${grid}`;
        } catch {
          return "";
        }
      },
      insert: async (text) => {
        const wb = apiRef.current?.getActiveWorkbook();
        if (!wb) return { ok: false, reason: "The spreadsheet isn't open yet." };
        try {
          const assignments = parseCellAssignments(text);
          if (assignments.length === 0) {
            // Free text: put it in the selected cell only.
            const r = wb.getActiveSheet().getSelection()?.getActiveRange();
            if (!r)
              return {
                ok: false,
                reason: "Click a cell first, or ask for cell assignments like B12 = =SUM(B2:B11).",
              };
            r.setValue(text.trim());
            onDirty();
            return {
              ok: true,
              tracked: false,
              how: "cells",
              detail: `Written to ${r.getA1Notation()}.`,
            };
          }
          const missing: string[] = [];
          const touched: string[] = [];
          for (const a of assignments) {
            const sheet = a.sheet ? wb.getSheetByName(a.sheet) : wb.getActiveSheet();
            if (!sheet) {
              missing.push(`${a.sheet}!${a.cell}`);
              continue;
            }
            const range = sheet.getRange(a.cell);
            const value = a.value.startsWith("=") ? a.value : coerceCellValue(a.value);
            // A new number in a blank cell inherits the format of the cell above (currency, dates), like a filled-down column.
            const wasBlank = range.isBlank?.() ?? false;
            if (a.value.startsWith("=")) range.setFormula(a.value);
            else range.setValue(value);
            if (
              wasBlank &&
              (typeof value === "number" || a.value.startsWith("=")) &&
              !(range.getNumberFormat?.() || "").replace(/General/i, "")
            ) {
              const m = /^([A-Z]+)(\d+)$/.exec(a.cell);
              const above =
                m && Number(m[2]) > 1 ? sheet.getRange(`${m[1]}${Number(m[2]) - 1}`) : null;
              const fmt = above?.getNumberFormat?.();
              if (fmt && !/General/i.test(fmt)) range.setNumberFormat?.(fmt);
            }
            touched.push(a.sheet ? `${a.sheet}!${a.cell}` : a.cell);
          }
          if (touched.length === 0)
            return {
              ok: false,
              reason: `No sheet named ${missing.map((m) => m.split("!")[0]).join(", ")} in this workbook.`,
            };
          onDirty();
          const list =
            touched.length <= 6
              ? touched.join(", ")
              : `${touched.slice(0, 5).join(", ")} and ${touched.length - 5} more`;
          const skipped = missing.length ? ` Skipped ${missing.length} on an unknown sheet.` : "";
          return {
            ok: true,
            tracked: false,
            how: "cells",
            detail: `Updated ${list}.${skipped} Review them, then save.`,
          };
        } catch (e) {
          logClientError(e, "office", { kind: "xlsx", stage: "apply-cells" });
          return {
            ok: false,
            reason: e instanceof Error ? e.message : "The spreadsheet couldn't apply that change.",
          };
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
