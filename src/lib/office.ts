// Office helpers shared by the editors: file kinds, storage round-trips with version history,
// Excel <-> Univer workbook conversion (ExcelJS, open source), and docx generation from text.
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import { humanize } from "@/lib/mutate";

export type OfficeKind = "docx" | "pdf" | "xlsx" | "text";

export function officeKind(name: string): OfficeKind | null {
  const n = name.toLowerCase();
  if (n.endsWith(".docx")) return "docx";
  if (n.endsWith(".pdf")) return "pdf";
  if (n.endsWith(".xlsx")) return "xlsx";
  if (n.endsWith(".txt") || n.endsWith(".md")) return "text";
  return null;
}

export const KIND_LABEL: Record<OfficeKind, string> = { docx: "Word", pdf: "PDF", xlsx: "Spreadsheet", text: "Text" };

export const MIME: Record<OfficeKind, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  text: "text/plain",
};

/** Short-lived signed URL for a private object in matter-files. */
export async function signedUrl(path: string, seconds = 600) {
  const { data, error } = await supabase.storage.from("matter-files").createSignedUrl(path, seconds);
  if (error || !data?.signedUrl) throw new Error(error ? humanize(error.message) : "Couldn't open the file.");
  return data.signedUrl;
}

export async function downloadBlob(path: string): Promise<Blob> {
  const { data, error } = await supabase.storage.from("matter-files").download(path);
  if (error || !data) throw new Error(error ? humanize(error.message) : "Couldn't download the file.");
  return data;
}

export function saveBlobLocally(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export class SaveConflict extends Error {
  constructor() {
    super(
      "Someone saved this file after you opened it. Your changes were not saved over theirs — download your copy, reopen the file and reapply them.",
    );
    this.name = "SaveConflict";
  }
}

/**
 * Conflict-safe save. The bytes go to a fresh object path first; then one database call locks the
 * file row, checks that its current path is still `expectedPath` (the version this editing session
 * loaded — never re-fetched just before saving), records the old path in file_versions and points
 * the file at the new object. If that call fails or conflicts, only the just-uploaded object is
 * removed; the current file and its history are untouched. Returns the new storage path.
 */
export async function saveNewVersion(
  file: Pick<Tables<"files">, "id" | "name" | "matter_id">,
  expectedPath: string,
  blob: Blob,
  o: { text?: string | null; note?: string } = {},
) {
  if (!blob.size) throw new Error("The editor produced an empty file, so nothing was saved.");
  const storage = supabase.storage.from("matter-files");
  const newPath = `${file.matter_id ?? "firm"}/${crypto.randomUUID()}-${file.name.replace(/[^\w.-]+/g, "_")}`;
  const { error: upErr } = await storage.upload(newPath, blob, {
    upsert: false,
    ...(blob.type ? { contentType: blob.type } : {}),
  });
  if (upErr) throw new Error(humanize(upErr.message));
  const { data, error } = await supabase.rpc("save_file_version", {
    p_file_id: file.id,
    p_expected_path: expectedPath,
    p_new_path: newPath,
    p_size: blob.size,
    p_extracted_text: o.text ?? null,
    p_update_text: o.text !== undefined,
    ...(o.note ? { p_note: o.note } : {}),
  });
  if (error) {
    await storage.remove([newPath]).catch(() => {});
    if (error.code === "40001" || /conflict/i.test(error.message)) throw new SaveConflict();
    throw new Error(humanize(error.message));
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || row.path !== newPath) {
    throw new Error("The save could not be confirmed. Reload the file to check its current version.");
  }
  return newPath;
}

/** Restore a prior version through the same conflict-safe path; the version must belong to this file. */
export async function restoreVersion(
  file: Pick<Tables<"files">, "id" | "name" | "matter_id">,
  expectedPath: string,
  version: Tables<"file_versions">,
) {
  if (version.file_id !== file.id) throw new Error("That version belongs to a different file.");
  const blob = await downloadBlob(version.path);
  let text: string | null | undefined;
  try {
    const { extractText } = await import("./extract");
    text = (await extractText(new File([blob], file.name))).slice(0, 300000) || null;
  } catch {
    text = undefined;
  }
  return saveNewVersion(file, expectedPath, blob, {
    ...(text !== undefined ? { text } : {}),
    note: `Restored version from ${new Date(version.created_at).toLocaleString()}`,
  });
}

/** Every storage object that belongs to these files: current bytes plus all kept versions. */
export async function storagePathsForFiles(files: { id: string; path: string }[]) {
  if (!files.length) return [] as string[];
  const { data } = await supabase.from("file_versions").select("path").in("file_id", files.map((f) => f.id));
  return Array.from(new Set([...files.map((f) => f.path), ...(data ?? []).map((v) => v.path)]));
}

/** Create a new matter file from raw bytes (used for drafts started from house templates). */
export async function createMatterFile(matterId: string, name: string, blob: Blob, text: string | null) {
  const path = `${matterId}/${crypto.randomUUID()}-${name.replace(/[^\w.-]+/g, "_")}`;
  const { error } = await supabase.storage.from("matter-files").upload(path, blob, blob.type ? { contentType: blob.type } : undefined);
  if (error) throw new Error(humanize(error.message));
  const { data, error: e2 } = await supabase.from("files").insert({ matter_id: matterId, name, path, size: blob.size, extracted_text: text }).select().single();
  if (e2) {
    await supabase.storage.from("matter-files").remove([path]);
    throw new Error(humanize(e2.message));
  }
  return data;
}

// ---------- Word documents from plain text (text drafts -> real .docx) ----------

/** Build a simple, cleanly formatted .docx from paragraphs of text. Blank lines separate paragraphs; a line in ALL CAPS becomes a heading. */
export async function docxFromText(title: string, body: string): Promise<Blob> {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = await import("docx");
  const paras = body.replace(/\r\n/g, "\n").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const children = [
    new Paragraph({ heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER, children: [new TextRun({ text: title })] }),
    ...paras.map((p) => {
      const heading = p.length < 80 && /^[A-Z0-9 .,;:()&'’\-–—]+$/.test(p) && /[A-Z]/.test(p);
      if (heading) return new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: p })] });
      const lines = p.split("\n");
      return new Paragraph({
        spacing: { after: 160, line: 300 },
        children: lines.flatMap((l, i) => (i ? [new TextRun({ break: 1 }), new TextRun({ text: l })] : [new TextRun({ text: l })])),
      });
    }),
  ];
  const doc = new Document({
    creator: "Mirza",
    title,
    styles: { default: { document: { run: { font: "Times New Roman", size: 24 } } } },
    sections: [{ properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } }, children }],
  });
  const blob = await Packer.toBlob(doc);
  return new Blob([blob], { type: MIME.docx });
}

// ---------- Excel <-> Univer ----------

type CellValue = string | number | boolean;
type CellData = { v?: CellValue; f?: string; s?: string; t?: number };
type SheetData = {
  id: string;
  name: string;
  rowCount: number;
  columnCount: number;
  cellData: Record<number, Record<number, CellData>>;
  mergeData: { startRow: number; endRow: number; startColumn: number; endColumn: number }[];
  columnData: Record<number, { w?: number }>;
  rowData: Record<number, { h?: number }>;
  freeze?: { xSplit: number; ySplit: number; startRow: number; startColumn: number };
  tabColor?: string;
  hidden?: number;
  showGridlines?: number;
  defaultColumnWidth?: number;
  defaultRowHeight?: number;
};
export type WorkbookData = {
  id: string;
  name: string;
  appVersion: string;
  locale: string;
  styles: Record<string, StyleData>;
  sheetOrder: string[];
  sheets: Record<string, SheetData>;
};
type StyleData = {
  bl?: number;
  it?: number;
  fs?: number;
  ff?: string;
  cl?: { rgb: string };
  bg?: { rgb: string };
  ht?: number;
  vt?: number;
  n?: { pattern: string };
  tb?: number;
};

const COLW = 7.0; // Excel character width -> px (approx. 7px per character at Calibri 11)
const ROWH = 1.333; // points -> px

function argbToRgb(argb?: string) {
  if (!argb) return undefined;
  const hex = argb.length === 8 ? argb.slice(2) : argb;
  return /^[0-9A-Fa-f]{6}$/.test(hex) ? `#${hex}` : undefined;
}
function rgbToArgb(rgb: string) {
  return `FF${rgb.replace("#", "").toUpperCase()}`;
}

/** Convert an .xlsx file to Univer workbook data (values, formulas, basic styles, widths, merges, freeze). */
export async function xlsxToWorkbook(buf: ArrayBuffer, name: string): Promise<WorkbookData> {
  const ExcelJS = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const styles: Record<string, StyleData> = {};
  const styleIds = new Map<string, string>();
  const styleId = (s: StyleData) => {
    const key = JSON.stringify(s);
    if (!Object.keys(s).length) return undefined;
    let id = styleIds.get(key);
    if (!id) {
      id = `s${styleIds.size + 1}`;
      styleIds.set(key, id);
      styles[id] = s;
    }
    return id;
  };
  const sheets: Record<string, SheetData> = {};
  const order: string[] = [];
  wb.eachSheet((ws, idx) => {
    const id = `sheet-${idx}`;
    order.push(id);
    const cellData: SheetData["cellData"] = {};
    let maxR = 0;
    let maxC = 0;
    ws.eachRow({ includeEmpty: false }, (row, r) => {
      row.eachCell({ includeEmpty: false }, (cell, c) => {
        const cd: CellData = {};
        const val = cell.value as unknown;
        if (cell.type === ExcelJS.ValueType.Formula) {
          const fv = cell.value as { formula?: string; result?: unknown; sharedFormula?: string };
          if (fv.formula) cd.f = `=${fv.formula}`;
          const res = fv.result;
          if (typeof res === "number" || typeof res === "string" || typeof res === "boolean") cd.v = res;
          else if (res instanceof Date) cd.v = excelSerial(res);
        } else if (val instanceof Date) {
          cd.v = excelSerial(val);
        } else if (val && typeof val === "object" && "richText" in (val as object)) {
          cd.v = (val as { richText: { text: string }[] }).richText.map((t) => t.text).join("");
        } else if (val && typeof val === "object" && "text" in (val as object)) {
          cd.v = String((val as { text: string }).text);
        } else if (val && typeof val === "object" && "error" in (val as object)) {
          cd.v = String((val as { error: string }).error);
        } else if (typeof val === "number" || typeof val === "string" || typeof val === "boolean") {
          cd.v = val;
        } else if (val == null) {
          /* empty styled cell */
        } else cd.v = String(val);
        const s: StyleData = {};
        const font = cell.font;
        if (font?.bold) s.bl = 1;
        if (font?.italic) s.it = 1;
        if (font?.size && font.size !== 11) s.fs = font.size;
        if (font?.name && font.name !== "Calibri") s.ff = font.name;
        const fc = argbToRgb((font?.color as { argb?: string } | undefined)?.argb);
        if (fc && fc !== "#000000") s.cl = { rgb: fc };
        const fill = cell.fill as { type?: string; fgColor?: { argb?: string } } | undefined;
        const bg = fill?.type === "pattern" ? argbToRgb(fill.fgColor?.argb) : undefined;
        if (bg && bg !== "#FFFFFF") s.bg = { rgb: bg };
        if (cell.alignment?.horizontal === "center") s.ht = 2;
        else if (cell.alignment?.horizontal === "right") s.ht = 3;
        else if (cell.alignment?.horizontal === "left") s.ht = 1;
        if (cell.alignment?.wrapText) s.tb = 3;
        if (cell.numFmt && cell.numFmt !== "General") s.n = { pattern: cell.numFmt };
        const sid = styleId(s);
        if (sid) cd.s = sid;
        if (cd.v === undefined && !cd.f && !cd.s) return;
        (cellData[r - 1] ??= {})[c - 1] = cd;
        maxR = Math.max(maxR, r);
        maxC = Math.max(maxC, c);
      });
    });
    const columnData: SheetData["columnData"] = {};
    ws.columns?.forEach((col, i) => {
      if (col?.width) columnData[i] = { w: Math.round(col.width * COLW) };
    });
    const rowData: SheetData["rowData"] = {};
    ws.eachRow({ includeEmpty: false }, (row, r) => {
      if (row.height) rowData[r - 1] = { h: Math.round(row.height * ROWH) };
    });
    const mergeData: SheetData["mergeData"] = [];
    const merges = (ws as unknown as { model?: { merges?: string[] } }).model?.merges ?? [];
    for (const m of merges) {
      const mm = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(m);
      if (!mm) continue;
      mergeData.push({ startColumn: colIndex(mm[1]!), startRow: Number(mm[2]) - 1, endColumn: colIndex(mm[3]!), endRow: Number(mm[4]) - 1 });
    }
    const view = ws.views?.[0] as { state?: string; xSplit?: number; ySplit?: number; showGridLines?: boolean } | undefined;
    const sd: SheetData = {
      id,
      name: ws.name,
      rowCount: Math.max(100, maxR + 30),
      columnCount: Math.max(26, maxC + 5),
      cellData,
      mergeData,
      columnData,
      rowData,
      showGridlines: view?.showGridLines === false ? 0 : 1,
      hidden: ws.state === "hidden" || ws.state === "veryHidden" ? 1 : 0,
    };
    if (view?.state === "frozen" && (view.xSplit || view.ySplit))
      sd.freeze = { xSplit: view.xSplit ?? 0, ySplit: view.ySplit ?? 0, startRow: view.ySplit ?? 0, startColumn: view.xSplit ?? 0 };
    const tab = (ws.properties as { tabColor?: { argb?: string } } | undefined)?.tabColor?.argb;
    const tc = argbToRgb(tab);
    if (tc) sd.tabColor = tc;
    sheets[id] = sd;
  });
  if (!order.length) {
    sheets["sheet-1"] = { id: "sheet-1", name: "Sheet1", rowCount: 100, columnCount: 26, cellData: {}, mergeData: [], columnData: {}, rowData: {} };
    order.push("sheet-1");
  }
  return { id: `wb-${crypto.randomUUID().slice(0, 8)}`, name, appVersion: "1.0.0", locale: "enUS", styles, sheetOrder: order, sheets };
}

/** Convert Univer workbook data back to an .xlsx Blob (values, formulas, basic styles, widths, merges, freeze). */
export async function workbookToXlsx(data: WorkbookData): Promise<Blob> {
  const ExcelJS = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  wb.creator = "Mirza";
  for (const sid of data.sheetOrder) {
    const sh = data.sheets[sid];
    if (!sh) continue;
    const ws = wb.addWorksheet(sh.name || sid, {
      views: sh.freeze && (sh.freeze.xSplit || sh.freeze.ySplit) ? [{ state: "frozen", xSplit: sh.freeze.xSplit, ySplit: sh.freeze.ySplit, showGridLines: sh.showGridlines !== 0 }] : [{ showGridLines: sh.showGridlines !== 0 }],
      state: sh.hidden ? "hidden" : "visible",
    });
    for (const [ci, col] of Object.entries(sh.columnData ?? {})) {
      if (col?.w) ws.getColumn(Number(ci) + 1).width = col.w / COLW;
    }
    for (const [ri, row] of Object.entries(sh.rowData ?? {})) {
      if (row?.h) ws.getRow(Number(ri) + 1).height = row.h / ROWH;
    }
    for (const [ri, cols] of Object.entries(sh.cellData ?? {})) {
      for (const [ci, cd] of Object.entries(cols ?? {})) {
        if (!cd) continue;
        const cell = ws.getCell(Number(ri) + 1, Number(ci) + 1);
        if (cd.f) cell.value = { formula: cd.f.replace(/^=/, ""), result: cd.v as number | string | boolean | undefined } as never;
        else if (cd.v !== undefined) cell.value = cd.v;
        const s = typeof cd.s === "string" ? data.styles[cd.s] : (cd.s as StyleData | undefined);
        if (s) {
          const font: Record<string, unknown> = {};
          if (s.bl) font["bold"] = true;
          if (s.it) font["italic"] = true;
          if (s.fs) font["size"] = s.fs;
          if (s.ff) font["name"] = s.ff;
          if (s.cl?.rgb) font["color"] = { argb: rgbToArgb(s.cl.rgb) };
          if (Object.keys(font).length) cell.font = font as never;
          if (s.bg?.rgb) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: rgbToArgb(s.bg.rgb) } };
          const align: Record<string, unknown> = {};
          if (s.ht === 2) align["horizontal"] = "center";
          else if (s.ht === 3) align["horizontal"] = "right";
          else if (s.ht === 1) align["horizontal"] = "left";
          if (s.tb === 3) align["wrapText"] = true;
          if (Object.keys(align).length) cell.alignment = align as never;
          if (s.n?.pattern) cell.numFmt = s.n.pattern;
        }
      }
    }
    for (const m of sh.mergeData ?? []) ws.mergeCells(m.startRow + 1, m.startColumn + 1, m.endRow + 1, m.endColumn + 1);
  }
  const out = await wb.xlsx.writeBuffer();
  return new Blob([out as ArrayBuffer], { type: MIME.xlsx });
}

/** Plain-text rendering of a workbook for search and AI context: sheet name, then tab-separated rows (formulas shown). */
export function workbookDataText(data: WorkbookData, maxChars = 300000) {
  const parts: string[] = [];
  for (const sid of data.sheetOrder) {
    const sh = data.sheets[sid];
    if (!sh) continue;
    parts.push(`### Sheet: ${sh.name}`);
    const rows = Object.keys(sh.cellData ?? {}).map(Number).sort((a, b) => a - b);
    for (const r of rows) {
      const cols = sh.cellData[r] ?? {};
      const idxs = Object.keys(cols).map(Number).sort((a, b) => a - b);
      const last = idxs[idxs.length - 1] ?? -1;
      const cells: string[] = [];
      for (let c = 0; c <= last; c++) {
        const cd = cols[c];
        cells.push(cd ? (cd.f ? `${cd.v ?? ""} {${cd.f}}` : String(cd.v ?? "")) : "");
      }
      parts.push(`${r + 1}\t${cells.join("\t")}`);
    }
    if (parts.join("\n").length > maxChars) break;
  }
  return parts.join("\n").slice(0, maxChars);
}

export async function workbookText(buf: ArrayBuffer) {
  return workbookDataText(await xlsxToWorkbook(buf, "workbook"));
}

function colIndex(letters: string) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
function excelSerial(d: Date) {
  return Math.round(((d.getTime() - Date.UTC(1899, 11, 30)) / 86_400_000) * 1e6) / 1e6;
}
