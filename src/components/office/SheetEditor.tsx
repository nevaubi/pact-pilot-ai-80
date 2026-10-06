import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import type { EditorHandle } from "./DocxEditor";
import { Skeleton } from "@/components/ui/skeleton";
import { workbookDataText, workbookToXlsx, xlsxToWorkbook, type WorkbookData } from "@/lib/office";
import { logClientError } from "@/lib/error-log";
import { parseCellAssignments } from "@/lib/office-proposals";
import { applySheetOps, type SheetEngine } from "@/lib/office-apply";
import { LIMITS, numToCol, type SheetOp, type WorkbookSnap } from "@/lib/office-tools";

/** Values + formulas per sheet for the assistant's read_cells tool (bounded). */
export function workbookSnapshot(data: WorkbookData, active?: string, selection?: { sheet: string; range: string }): WorkbookSnap {
  let budget: number = LIMITS.sheetCells;
  const sheets = data.sheetOrder.map((id) => {
    const sh = data.sheets[id]!;
    const cells: WorkbookSnap["sheets"][number]["cells"] = {};
    for (const [r, row] of Object.entries(sh.cellData ?? {}))
      for (const [c, cell] of Object.entries(row ?? {})) {
        const cd = cell as { v?: string | number | boolean | null; f?: string };
        if (budget <= 0 || (cd.v == null && !cd.f)) continue;
        budget--;
        cells[`${numToCol(Number(c) + 1)}${Number(r) + 1}`] = { ...(cd.v != null ? { v: typeof cd.v === "string" ? cd.v.slice(0, 2000) : cd.v } : {}), ...(cd.f ? { f: cd.f } : {}) };
      }
    return { name: sh.name, cells };
  });
  return { ...(active ? { active } : {}), ...(selection ? { selection } : {}), sheets };
}

/** Legacy "A1 = value" lines → typed ops pinned to a sheet. Leading-zero and non-plain values stay text. */
export function assignmentsToOps(text: string, defaultSheet: string): SheetOp[] {
  return parseCellAssignments(text).map((a) => {
    const v = a.value;
    const type: SheetOp["type"] = v.startsWith("=")
      ? "formula"
      : v === "" || /^(blank|empty|null)$/i.test(v)
        ? "clear"
        : /^(true|false)$/i.test(v)
          ? "boolean"
          : /^-?(0|[1-9]\d*)(\.\d+)?$/.test(v)
            ? "number"
            : "text";
    return { sheet: a.sheet ?? defaultSheet, cell: a.cell, type, value: type === "clear" ? "" : v };
  });
}

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
  getValue?: () => unknown;
  getFormula?: () => string;
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
    getSheets?: () => FSheet[];
  } | null;
  createWorkbook: (d: WorkbookData) => unknown;
  addEvent?: (ev: unknown, cb: (e: unknown) => void) => { dispose: () => void };
  Event?: Record<string, unknown>;
  onCommandExecuted?: (cb: (c: { id: string; type?: number }) => void) => { dispose: () => void };
  dispose?: () => void;
};

type Wb = NonNullable<ReturnType<Api["getActiveWorkbook"]>>;
function engine(wb: Wb): SheetEngine {
  const names = () => {
    const all = wb.getSheets?.();
    return all ? all.map((s) => s.getSheetName()) : [wb.getActiveSheet().getSheetName()];
  };
  const range = (sheet: string, cell: string) => {
    const sh = wb.getSheetByName(sheet);
    if (!sh) throw new Error(`No sheet named "${sheet}".`);
    return sh.getRange(cell);
  };
  return {
    sheetNames: names,
    write: (sheet, cell, op) => {
      const r = range(sheet, cell);
      if (op.kind === "formula") r.setFormula(op.formula);
      // Literal text that looks numeric (e.g. 00123) is written as a string cell so Univer can't coerce it.
      else if (typeof op.value === "string" && /^[-+]?[\d.,]+(e[+-]?\d+)?%?$/i.test(op.value.trim()))
        r.setValue({ v: op.value, t: 1 } as never);
      else r.setValue(op.value);
    },
    read: (sheet, cell) => {
      const r = range(sheet, cell);
      const f = r.getFormula?.() ?? "";
      return { value: r.getValue ? r.getValue() : (r.getValues()[0]?.[0] ?? null), formula: f || null };
    },
  };
}

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
          if (!r || !sheet) return "";
          // A single selected cell is a real target too — include it.
          const v = r.getValues() ?? [];
          const grid = v.map((row) => row.map((c) => (c == null ? "" : String(c))).join("\t")).join("\n");
          const f = v.length === 1 && v[0]?.length === 1 ? r.getFormula?.() : "";
          return `Selected ${r.getA1Notation()} on sheet "${sheet.getSheetName()}":\n${grid}${f ? `\nFormula: ${f}` : ""}`;
        } catch {
          return "";
        }
      },
      getWorkbook: async () => {
        const wb = apiRef.current?.getActiveWorkbook();
        if (!wb) return { sheets: [] };
        const sheet = wb.getActiveSheet();
        let selection: { sheet: string; range: string } | undefined;
        try {
          const r = sheet.getSelection()?.getActiveRange();
          if (r) selection = { sheet: sheet.getSheetName(), range: r.getA1Notation() };
        } catch {
          /* no selection */
        }
        return workbookSnapshot(wb.save(), sheet.getSheetName(), selection);
      },
      insert: async (text) => {
        const wb = apiRef.current?.getActiveWorkbook();
        if (!wb) return { ok: false, reason: "The spreadsheet isn't open yet." };
        const ops = assignmentsToOps(text, wb.getActiveSheet().getSheetName());
        // Free text is never written into a cell; only explicit cell assignments are applied.
        if (!ops.length) return { ok: false, reason: "No cell assignments to apply (expected lines like B12 = =SUM(B2:B11))." };
        const r = applySheetOps(engine(wb), ops);
        if (!r.ok) return { ok: false, reason: r.reason };
        onDirty();
        return { ok: true, tracked: false, how: "cells", detail: r.detail };
      },
      applyProposal: async (p) => {
        const wb = apiRef.current?.getActiveWorkbook();
        if (!wb) return { ok: false, reason: "The spreadsheet isn't open yet.", applied: 0 };
        if (p.kind !== "sheet") return { ok: false, reason: "That proposal is for a Word document.", applied: 0 };
        try {
          const r = applySheetOps(engine(wb), p.ops);
          if (r.applied) onDirty();
          return r;
        } catch (e) {
          logClientError(e, "office", { kind: "xlsx", stage: "apply-proposal" });
          return { ok: false, reason: e instanceof Error ? e.message : "Couldn't apply the cells.", applied: 0 };
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
