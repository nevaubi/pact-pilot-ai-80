import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import type { EditorHandle } from "./DocxEditor";
import { Skeleton } from "@/components/ui/skeleton";
import { workbookDataText, workbookToXlsx, xlsxToWorkbook, type WorkbookData } from "@/lib/office";
import { logClientError } from "@/lib/error-log";
import { parseCellAssignments } from "@/lib/office-proposals";
import {
  applySheetOps,
  type CellState,
  type CellStyle,
  type SheetEngine,
} from "@/lib/office-apply";
import {
  LIMITS,
  numToCol,
  sheetOpHasStyle,
  type SheetOp,
  type WorkbookSnap,
} from "@/lib/office-tools";
import type { FUniver } from "@univerjs/core/facade";
import type { FRange, FWorkbook } from "@univerjs/sheets/facade";

/** Values + formulas per sheet for the assistant's read_cells tool (bounded). */
export function workbookSnapshot(
  data: WorkbookData,
  active?: string,
  selection?: { sheet: string; range: string },
): WorkbookSnap {
  let budget: number = LIMITS.sheetCells;
  const sheets = data.sheetOrder.map((id) => {
    const sh = data.sheets[id]!;
    const cells: WorkbookSnap["sheets"][number]["cells"] = {};
    for (const [r, row] of Object.entries(sh.cellData ?? {}))
      for (const [c, cell] of Object.entries(row ?? {})) {
        const cd = cell as { v?: string | number | boolean | null; f?: string };
        if (budget <= 0 || (cd.v == null && !cd.f)) continue;
        budget--;
        cells[`${numToCol(Number(c) + 1)}${Number(r) + 1}`] = {
          ...(cd.v != null ? { v: typeof cd.v === "string" ? cd.v.slice(0, 2000) : cd.v } : {}),
          ...(cd.f ? { f: cd.f } : {}),
        };
      }
    return { name: sh.name, cells };
  });
  return { ...(active ? { active } : {}), ...(selection ? { selection } : {}), sheets };
}

/**
 * Legacy "A1 = value" fence → typed ops pinned to `askSheet` (the sheet active when the attorney
 * asked, never the one active at Apply). Strict: every non-empty line must be an assignment, or the
 * whole fence is rejected — explanations are never silently skipped or written into cells.
 */
export function assignmentsToOps(
  text: string,
  askSheet: string,
): { ops: SheetOp[]; errors: string[] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const errors: string[] = [];
  const ops: SheetOp[] = [];
  for (const [i, line] of lines.entries()) {
    const a = parseCellAssignments(line)[0];
    if (!a) {
      errors.push(`Line ${i + 1} isn't a cell assignment: “${line.trim().slice(0, 60)}”`);
      continue;
    }
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
    ops.push({ sheet: a.sheet ?? askSheet, cell: a.cell, type, value: type === "clear" ? "" : v });
  }
  if (!lines.length) errors.push("No cell assignments to apply (expected lines like B12 = =SUM(B2:B11)).");
  return { ops: errors.length ? [] : ops, errors };
}

type Props = {
  blob: Blob;
  name: string;
  onDirty: () => void;
  onReady?: () => void;
  onError?: (message: string) => void;
  handle: Ref<EditorHandle | null>;
};

type Api = Pick<FUniver, "getActiveWorkbook" | "createWorkbook"> & {
  onCommandExecuted?: (cb: (c: { id: string; type?: number }) => void) => { dispose: () => void };
};
type Wb = FWorkbook;
type StyleData = NonNullable<ReturnType<FRange["getCellStyleData"]>>;
type CellData = NonNullable<ReturnType<FRange["getCellData"]>>;
const CELL_STRING = 1;
/** Univer's saved snapshot in the shape our ExcelJS bridge reads. */
const snapshotOf = (wb: Wb) => wb.save() as unknown as WorkbookData;
const CELL_NUMBER = 2;
const CELL_BOOLEAN = 3;
const CELL_FORCE_STRING = 4;
const ALIGN = { left: 1, center: 2, right: 3 } as const;

function hexOf(rgb: string | null | undefined) {
  if (!rgb) return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(rgb.trim());
  return m ? `#${m[1]!.toLowerCase()}` : rgb;
}
function styleOf(st: StyleData | null): CellStyle {
  const ht = st?.ht;
  return {
    numberFormat: st?.n?.pattern ?? null,
    bold: st?.bl === 1,
    fill: hexOf(st?.bg?.rgb ?? null),
    align: ht === 1 ? "left" : ht === 2 ? "center" : ht === 3 ? "right" : null,
  };
}

/** Univer facade adapter: explicit cell types (text is FORCE_STRING so "=x", "+1", "00123" stay literal). */
export function sheetEngine(wb: Wb): SheetEngine {
  const range = (sheet: string, cell: string) => {
    const sh = wb.getSheetByName(sheet);
    if (!sh) throw new Error(`No sheet named "${sheet}".`);
    return sh.getRange(cell);
  };
  const read = (sheet: string, cell: string): CellState => {
    const r = range(sheet, cell);
    const raw = r.getCellData();
    const f = raw?.f || r.getFormula() || "";
    const v = raw?.v ?? null;
    return {
      v: typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : null,
      f: f || null,
      style: styleOf(r.getCellStyleData()),
      raw: raw ? JSON.parse(JSON.stringify(raw)) : null,
    };
  };
  return {
    sheetNames: () => wb.getSheets().map((s) => s.getSheetName()),
    read,
    write: (sheet, cell, op) => {
      const r = range(sheet, cell);
      const style: StyleData = { ...(r.getCellStyleData() ?? {}) };
      if (op.bold != null) style.bl = op.bold ? 1 : 0;
      if (op.fill != null) style.bg = { rgb: op.fill };
      if (op.align != null) style.ht = ALIGN[op.align];
      if (op.numberFormat != null) style.n = { pattern: op.numberFormat };
      const styled = sheetOpHasStyle(op);
      let next: CellData | null;
      switch (op.type) {
        case "formula":
          next = { f: op.value, s: style };
          break;
        case "text":
          next = { v: op.value, t: CELL_FORCE_STRING, f: null, si: null, s: style };
          break;
        case "number":
          next = { v: Number(op.value), t: CELL_NUMBER, f: null, si: null, s: style };
          break;
        case "boolean":
          next = { v: /^true$/i.test(op.value), t: CELL_BOOLEAN, f: null, si: null, s: style };
          break;
        case "keep":
          next = { ...(r.getCellData() ?? {}), s: style };
          break;
        case "clear":
          r.clear({ contentsOnly: true });
          next = styled ? { s: style } : null;
          break;
      }
      if (next) r.setValue(next);
    },
    restore: (sheet, cell, prev) => {
      const r = range(sheet, cell);
      r.clear();
      if (prev.raw) r.setValue(JSON.parse(JSON.stringify(prev.raw)) as CellData);
    },
  };
}
export { CELL_STRING };

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
        const api: Api = made.univerAPI;
        // Our ExcelJS-derived data uses Univer's documented snapshot shape; locale is a plain string here.
        api.createWorkbook(data as unknown as Parameters<Api["createWorkbook"]>[0]);
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
        return wb ? workbookDataText(snapshotOf(wb)) : "";
      },
      getSelection: async () => {
        try {
          const sheet = apiRef.current?.getActiveWorkbook()?.getActiveSheet();
          const r = sheet?.getSelection()?.getActiveRange();
          if (!r || !sheet) return "";
          // A single selected cell is a real target too — include it.
          const v = r.getValues() ?? [];
          const grid = v
            .map((row: unknown[]) => row.map((c) => (c == null ? "" : String(c))).join("\t"))
            .join("\n");
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
        return workbookSnapshot(snapshotOf(wb), sheet.getSheetName(), selection);
      },
      insert: async (text, _how, _anchor, askSheet) => {
        const wb = apiRef.current?.getActiveWorkbook();
        if (!wb) return { ok: false, reason: "The spreadsheet isn't open yet." };
        if (!askSheet)
          return {
            ok: false,
            reason: "This answer didn't record which sheet was active when you asked. Ask again.",
          };
        // Free text is never written into a cell; the whole fence must be cell assignments.
        const { ops, errors } = assignmentsToOps(text, askSheet);
        if (errors.length) return { ok: false, reason: `Nothing was changed: ${errors.slice(0, 3).join(" ")}` };
        const r = applySheetOps(sheetEngine(wb), ops);
        if (!r.ok) {
          if (r.partial) onDirty();
          return { ok: false, reason: r.reason };
        }
        onDirty();
        return { ok: true, tracked: false, how: "cells", detail: r.detail };
      },
      applyProposal: async (p) => {
        const wb = apiRef.current?.getActiveWorkbook();
        if (!wb) return { ok: false, reason: "The spreadsheet isn't open yet.", applied: 0 };
        if (p.kind !== "sheet")
          return { ok: false, reason: "That proposal is for a Word document.", applied: 0 };
        try {
          const r = applySheetOps(sheetEngine(wb), p.ops);
          if (r.ok || r.partial) onDirty();
          return r;
        } catch (e) {
          logClientError(e, "office", { kind: "xlsx", stage: "apply-proposal" });
          return {
            ok: false,
            reason: e instanceof Error ? e.message : "Couldn't apply the cells.",
            applied: 0,
          };
        }
      },
      export: async () => {
        const wb = apiRef.current?.getActiveWorkbook();
        if (!wb) throw new Error("The spreadsheet isn't ready yet.");
        return workbookToXlsx(snapshotOf(wb));
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
