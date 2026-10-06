/**
 * Original-package XLSX saving. Instead of rebuilding a workbook (which loses charts, comments,
 * custom XML, defined names, …), we keep the original ZIP and patch only the worksheet cells (and
 * appended style records) that actually changed. Every other ZIP entry is carried over unchanged.
 * Anything we can't patch safely — structural edits, shared/array formula regions, merged or
 * protected cells, unsupported formatting — fails closed with a clear reason, and nothing is saved.
 */
import JSZip from "jszip";
import type { WorkbookData } from "./office";

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";

export const PACKAGE_LIMITS = { entries: 2_000, uncompressedBytes: 200 * 1024 * 1024 } as const;

export class XlsxUnsupported extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XlsxUnsupported";
  }
}

type Cell = { v?: string | number | boolean | null; f?: string | null; s?: unknown; t?: number | null };
type Style = { bl?: number; bg?: { rgb?: string }; ht?: number; n?: { pattern?: string } } & Record<string, unknown>;
const SUPPORTED_STYLE_KEYS = new Set(["bl", "bg", "ht", "n"]);

export type CellChange = {
  sheet: string;
  ref: string;
  row: number;
  col: number;
  value: { kind: "text"; text: string } | { kind: "number"; n: number } | { kind: "bool"; b: boolean } | { kind: "formula"; f: string } | { kind: "empty" };
  style: { bold?: boolean; fill?: string | null; align?: "left" | "center" | "right" | null; numFmt?: string | null } | null;
};

function colName(n: number) {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
function parseRef(ref: string) {
  const m = /^([A-Z]{1,3})(\d+)$/.exec(ref);
  if (!m) return null;
  let c = 0;
  for (const ch of m[1]!) c = c * 26 + ch.charCodeAt(0) - 64;
  return { col: c, row: Number(m[2]) };
}

function styleObj(data: WorkbookData, s: unknown): Style {
  if (!s) return {};
  if (typeof s === "string") return (data.styles[s] as Style | undefined) ?? {};
  return s as Style;
}
function pickStyle(st: Style) {
  return {
    bold: st.bl === 1,
    fill: st.bg?.rgb ? st.bg.rgb.toLowerCase() : null,
    align: st.ht === 1 ? ("left" as const) : st.ht === 2 ? ("center" as const) : st.ht === 3 ? ("right" as const) : null,
    numFmt: st.n?.pattern ?? null,
  };
}
function sameJson(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Compare the workbook as imported with the editor's current snapshot. Returns the changed cells,
 * or throws XlsxUnsupported for edits we can't write back into the original package.
 */
export function diffWorkbooks(base: WorkbookData, cur: WorkbookData): CellChange[] {
  const names = (d: WorkbookData) => d.sheetOrder.map((id) => d.sheets[id]?.name);
  if (!sameJson(names(base), names(cur)))
    throw new XlsxUnsupported("Sheets were added, removed, renamed or reordered. Saving that into the original file isn't supported yet.");
  const changes: CellChange[] = [];
  base.sheetOrder.forEach((bid, i) => {
    const b = base.sheets[bid]!;
    const c = cur.sheets[cur.sheetOrder[i]!]!;
    const norm = (m: { startRow: number; endRow: number; startColumn: number; endColumn: number }[] | undefined) =>
      (m ?? []).map((x) => `${x.startRow},${x.startColumn},${x.endRow},${x.endColumn}`).sort();
    if (!sameJson(norm(b.mergeData), norm(c.mergeData)))
      throw new XlsxUnsupported(`Merged cells changed on "${b.name}". Saving merges into the original file isn't supported yet.`);
    const sizes = (x: Record<number, { w?: number; h?: number }> | undefined) =>
      Object.entries(x ?? {}).filter(([, v]) => v && (v.w || v.h)).map(([k, v]) => `${k}:${v.w ?? ""}:${v.h ?? ""}`).sort();
    if (!sameJson(sizes(b.columnData), sizes(c.columnData)) || !sameJson(sizes(b.rowData), sizes(c.rowData)))
      throw new XlsxUnsupported(`Row heights or column widths changed on "${b.name}". That isn't saved into the original file yet — undo it to save.`);
    const keys = new Set<string>();
    for (const [r, row] of Object.entries(b.cellData ?? {})) for (const col of Object.keys(row ?? {})) keys.add(`${r}:${col}`);
    for (const [r, row] of Object.entries(c.cellData ?? {})) for (const col of Object.keys(row ?? {})) keys.add(`${r}:${col}`);
    for (const k of keys) {
      const [r, col] = k.split(":").map(Number) as [number, number];
      const bc = (b.cellData?.[r]?.[col] ?? {}) as Cell;
      const cc = (c.cellData?.[r]?.[col] ?? {}) as Cell;
      const bs = styleObj(base, bc.s);
      const cs = styleObj(cur, cc.s);
      const bv = bc.v ?? null;
      const cv = cc.v ?? null;
      const bf = bc.f || null;
      const cf = cc.f || null;
      const styleChanged = !sameJson(pickStyle(bs), pickStyle(cs));
      const otherStyleKeys = new Set([...Object.keys(bs), ...Object.keys(cs)].filter((x) => !SUPPORTED_STYLE_KEYS.has(x)));
      for (const key of otherStyleKeys)
        if (!sameJson(bs[key], cs[key]))
          throw new XlsxUnsupported(`Formatting on "${b.name}"!${colName(col + 1)}${r + 1} changed in a way that isn't saved into the original file yet (only bold, fill, alignment and number format are).`);
      const formulaChanged = bf !== cf;
      // A formula whose cached result moved isn't an edit; only a changed formula or literal value is.
      const valueChanged = formulaChanged || (!cf && bv !== cv);
      if (!valueChanged && !styleChanged) continue;
      const ref = `${colName(col + 1)}${r + 1}`;
      const value: CellChange["value"] = !valueChanged
        ? { kind: "empty" }
        : cf
          ? { kind: "formula", f: cf.replace(/^=/, "") }
          : cv === null || cv === ""
            ? { kind: "empty" }
            : typeof cv === "number"
              ? Number.isFinite(cv)
                ? { kind: "number", n: cv }
                : (() => {
                    throw new XlsxUnsupported(`${ref} holds a non-finite number.`);
                  })()
              : typeof cv === "boolean"
                ? { kind: "bool", b: cv }
                : { kind: "text", text: String(cv) };
      changes.push({
        sheet: b.name,
        ref,
        row: r + 1,
        col: col + 1,
        value: valueChanged ? value : (null as never),
        style: styleChanged ? pickStyle(cs) : null,
      });
    }
  });
  return changes;
}

function q(el: Element, local: string): Element[] {
  return Array.from(el.getElementsByTagNameNS(NS, local));
}
function child(el: Element, local: string): Element | null {
  for (const c of Array.from(el.childNodes)) if (c.nodeType === 1 && (c as Element).localName === local) return c as Element;
  return null;
}
function resolveTarget(base: string, target: string) {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

/** Package-level safety checks before we touch anything. */
export async function openPackage(buf: ArrayBuffer) {
  const head = new Uint8Array(buf.slice(0, 8));
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0)
    throw new XlsxUnsupported("This workbook is encrypted or a legacy binary file; it can't be saved from the editor.");
  if (head[0] !== 0x50 || head[1] !== 0x4b) throw new XlsxUnsupported("Not a valid .xlsx package.");
  const zip = await JSZip.loadAsync(buf);
  const files = Object.values(zip.files);
  if (files.length > PACKAGE_LIMITS.entries) throw new XlsxUnsupported("The workbook package has too many parts to patch safely.");
  let total = 0;
  for (const f of files) {
    const size = (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    total += size;
  }
  if (total > PACKAGE_LIMITS.uncompressedBytes) throw new XlsxUnsupported("The workbook is too large to patch safely in the browser.");
  if (zip.file("xl/vbaProject.bin")) throw new XlsxUnsupported("Macro-enabled workbooks can't be saved from the editor.");
  const ct = await zip.file("[Content_Types].xml")?.async("string");
  if (!ct || /macroEnabled/i.test(ct)) throw new XlsxUnsupported("Unsupported workbook type.");
  return zip;
}

type Ctx = {
  zip: JSZip;
  parser: DOMParser;
  ser: XMLSerializer;
  sheetPaths: Map<string, string>;
  styles: { path: string; doc: Document } | null;
  wb: { path: string; doc: Document };
};

async function loadDoc(ctx: Pick<Ctx, "zip" | "parser">, path: string) {
  const xml = await ctx.zip.file(path)?.async("string");
  if (xml == null) throw new XlsxUnsupported(`Missing part ${path}.`);
  const doc = ctx.parser.parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new XlsxUnsupported(`Couldn't read ${path}.`);
  return doc;
}

function appendStyle(ctx: Ctx, baseXf: number, want: NonNullable<CellChange["style"]>): number {
  if (!ctx.styles) throw new XlsxUnsupported("The workbook has no style sheet; formatting can't be saved into it.");
  const d = ctx.styles.doc;
  const root = d.documentElement;
  const cellXfs = q(root, "cellXfs")[0];
  if (!cellXfs) throw new XlsxUnsupported("The workbook's style sheet has no cell formats.");
  const xfs = q(cellXfs, "xf");
  const src = xfs[baseXf] ?? xfs[0];
  if (!src) throw new XlsxUnsupported("The workbook's style sheet has no cell formats.");
  const xf = src.cloneNode(true) as Element;
  const el = (name: string) => d.createElementNS(NS, name);
  const bump = (container: Element) => container.setAttribute("count", String(Array.from(container.childNodes).filter((n) => n.nodeType === 1).length));
  if (want.bold !== undefined) {
    const fonts = q(root, "fonts")[0]!;
    const list = q(fonts, "font");
    const f = (list[Number(xf.getAttribute("fontId") ?? 0)] ?? list[0])!.cloneNode(true) as Element;
    const b = child(f, "b");
    if (want.bold && !b) f.insertBefore(el("b"), f.firstChild);
    if (!want.bold && b) f.removeChild(b);
    fonts.appendChild(f);
    bump(fonts);
    xf.setAttribute("fontId", String(list.length));
    xf.setAttribute("applyFont", "1");
  }
  if (want.fill !== undefined) {
    const fills = q(root, "fills")[0]!;
    const n = q(fills, "fill").length;
    const fill = el("fill");
    const pf = el("patternFill");
    if (want.fill) {
      pf.setAttribute("patternType", "solid");
      const fg = el("fgColor");
      fg.setAttribute("rgb", `FF${want.fill.replace("#", "").toUpperCase()}`);
      pf.appendChild(fg);
      const bg = el("bgColor");
      bg.setAttribute("indexed", "64");
      pf.appendChild(bg);
    } else pf.setAttribute("patternType", "none");
    fill.appendChild(pf);
    fills.appendChild(fill);
    bump(fills);
    xf.setAttribute("fillId", String(n));
    xf.setAttribute("applyFill", "1");
  }
  if (want.align !== undefined) {
    let al = child(xf, "alignment");
    if (!al) {
      al = el("alignment");
      xf.insertBefore(al, xf.firstChild);
    }
    if (want.align) al.setAttribute("horizontal", want.align);
    else al.removeAttribute("horizontal");
    xf.setAttribute("applyAlignment", "1");
  }
  if (want.numFmt !== undefined) {
    if (!want.numFmt || want.numFmt === "General") xf.setAttribute("numFmtId", "0");
    else {
      let numFmts = q(root, "numFmts")[0];
      if (!numFmts) {
        numFmts = el("numFmts");
        root.insertBefore(numFmts, root.firstElementChild);
      }
      const existing = q(numFmts, "numFmt").find((x) => x.getAttribute("formatCode") === want.numFmt);
      let id = existing ? Number(existing.getAttribute("numFmtId")) : 0;
      if (!existing) {
        id = Math.max(163, ...q(numFmts, "numFmt").map((x) => Number(x.getAttribute("numFmtId") ?? 0))) + 1;
        const nf = el("numFmt");
        nf.setAttribute("numFmtId", String(id));
        nf.setAttribute("formatCode", want.numFmt);
        numFmts.appendChild(nf);
        bump(numFmts);
      }
      xf.setAttribute("numFmtId", String(id));
    }
    xf.setAttribute("applyNumberFormat", "1");
  }
  cellXfs.appendChild(xf);
  bump(cellXfs);
  return xfs.length;
}

function findOrCreateCell(doc: Document, sheetData: Element, row: number, col: number, ref: string) {
  const rows = Array.from(sheetData.childNodes).filter((n): n is Element => n.nodeType === 1 && (n as Element).localName === "row");
  let rowEl = rows.find((r) => Number(r.getAttribute("r")) === row) ?? null;
  if (!rowEl) {
    rowEl = doc.createElementNS(NS, "row");
    rowEl.setAttribute("r", String(row));
    const after = rows.find((r) => Number(r.getAttribute("r")) > row) ?? null;
    sheetData.insertBefore(rowEl, after);
  }
  const cells = Array.from(rowEl.childNodes).filter((n): n is Element => n.nodeType === 1 && (n as Element).localName === "c");
  let c = cells.find((x) => x.getAttribute("r") === ref) ?? null;
  if (!c) {
    if (cells.some((x) => !x.getAttribute("r"))) throw new XlsxUnsupported(`Row ${row} uses implicit cell positions; it can't be patched safely.`);
    c = doc.createElementNS(NS, "c");
    c.setAttribute("r", ref);
    const after = cells.find((x) => (parseRef(x.getAttribute("r") ?? "")?.col ?? 0) > col) ?? null;
    rowEl.insertBefore(c, after);
  }
  return c;
}

function inMerge(ws: Element, row: number, col: number) {
  for (const m of q(ws, "mergeCell")) {
    const [a, b] = (m.getAttribute("ref") ?? "").split(":");
    const s = parseRef(a ?? "");
    const e = parseRef(b ?? a ?? "");
    if (s && e && row >= s.row && row <= e.row && col >= s.col && col <= e.col) return { anchor: row === s.row && col === s.col };
  }
  return null;
}

/**
 * Write `changes` into the original package. Untouched parts keep their original bytes; edited
 * worksheets, styles.xml (appended records only) and workbook.xml (recalc flag, when formulas
 * changed) are reserialised.
 */
export async function patchXlsx(original: ArrayBuffer, changes: CellChange[]): Promise<Blob> {
  const zip = await openPackage(original);
  const parser = new DOMParser();
  const ser = new XMLSerializer();
  const wbDoc = await loadDoc({ zip, parser }, "xl/workbook.xml");
  const relsDoc = await loadDoc({ zip, parser }, "xl/_rels/workbook.xml.rels");
  const rels = new Map<string, { target: string; type: string }>();
  for (const r of Array.from(relsDoc.getElementsByTagNameNS(NS_PKG_REL, "Relationship")))
    rels.set(r.getAttribute("Id") ?? "", { target: r.getAttribute("Target") ?? "", type: r.getAttribute("Type") ?? "" });
  const sheetPaths = new Map<string, string>();
  for (const s of q(wbDoc.documentElement, "sheet")) {
    const rid = s.getAttributeNS(NS_R, "id") ?? "";
    const rel = rels.get(rid);
    if (rel) sheetPaths.set(s.getAttribute("name") ?? "", resolveTarget("xl/workbook.xml", rel.target));
  }
  const stylesRel = [...rels.values()].find((r) => r.type.endsWith("/styles"));
  const stylesPath = stylesRel ? resolveTarget("xl/workbook.xml", stylesRel.target) : null;
  const ctx: Ctx = {
    zip,
    parser,
    ser,
    sheetPaths,
    styles: stylesPath ? { path: stylesPath, doc: await loadDoc({ zip, parser }, stylesPath) } : null,
    wb: { path: "xl/workbook.xml", doc: wbDoc },
  };
  const bySheet = new Map<string, CellChange[]>();
  for (const c of changes) bySheet.set(c.sheet, [...(bySheet.get(c.sheet) ?? []), c]);
  let formulas = false;
  let stylesTouched = false;
  for (const [sheet, list] of bySheet) {
    const path = sheetPaths.get(sheet);
    if (!path) throw new XlsxUnsupported(`Couldn't find the part for sheet "${sheet}".`);
    const doc = await loadDoc(ctx, path);
    const ws = doc.documentElement;
    if (ws.localName !== "worksheet") throw new XlsxUnsupported(`"${sheet}" is not a regular worksheet.`);
    if (q(ws, "sheetProtection").length) throw new XlsxUnsupported(`"${sheet}" is protected; it can't be edited from here.`);
    const sheetData = q(ws, "sheetData")[0];
    if (!sheetData) throw new XlsxUnsupported(`"${sheet}" has no cell data section.`);
    // Shared/array formula regions anywhere near our targets are refused outright.
    const fEls = q(ws, "f");
    const shared = new Set<string>();
    for (const f of fEls) {
      const t = f.getAttribute("t");
      if (t === "shared" || t === "array" || t === "dataTable") {
        const ref = f.getAttribute("ref");
        const host = (f.parentNode as Element).getAttribute("r") ?? "";
        shared.add(host);
        if (ref) {
          const [a, b] = ref.split(":");
          const s = parseRef(a ?? "");
          const e = parseRef(b ?? a ?? "");
          if (s && e)
            for (const c of list)
              if (c.row >= s.row && c.row <= e.row && c.col >= s.col && c.col <= e.col)
                throw new XlsxUnsupported(`${sheet}!${c.ref} is inside a shared or array formula region (${ref}); editing it isn't supported yet.`);
        }
      }
    }
    for (const ch of list) {
      if (shared.has(ch.ref)) throw new XlsxUnsupported(`${sheet}!${ch.ref} is part of a shared or array formula; editing it isn't supported yet.`);
      const m = inMerge(ws, ch.row, ch.col);
      if (m && !m.anchor) throw new XlsxUnsupported(`${sheet}!${ch.ref} is hidden inside a merged range.`);
      const c = findOrCreateCell(doc, sheetData, ch.row, ch.col, ch.ref);
      if (ch.value) {
        for (const tag of ["f", "v", "is"]) {
          const e = child(c, tag);
          if (e) c.removeChild(e);
        }
        c.removeAttribute("t");
        const ext = child(c, "extLst");
        const add = (e: Element) => c.insertBefore(e, ext);
        const v = ch.value;
        if (v.kind === "formula") {
          const f = doc.createElementNS(NS, "f");
          f.appendChild(doc.createTextNode(v.f));
          add(f);
          formulas = true;
        } else if (v.kind === "number") {
          const e = doc.createElementNS(NS, "v");
          e.appendChild(doc.createTextNode(String(v.n)));
          add(e);
        } else if (v.kind === "bool") {
          c.setAttribute("t", "b");
          const e = doc.createElementNS(NS, "v");
          e.appendChild(doc.createTextNode(v.b ? "1" : "0"));
          add(e);
        } else if (v.kind === "text") {
          c.setAttribute("t", "inlineStr");
          const is = doc.createElementNS(NS, "is");
          const t = doc.createElementNS(NS, "t");
          t.setAttribute("xml:space", "preserve");
          t.appendChild(doc.createTextNode(v.text));
          is.appendChild(t);
          add(is);
        }
      }
      if (ch.style) {
        const want: NonNullable<CellChange["style"]> = ch.style;
        c.setAttribute("s", String(appendStyle(ctx, Number(c.getAttribute("s") ?? 0), want)));
        stylesTouched = true;
      }
    }
    zip.file(path, ser.serializeToString(doc));
  }
  if (stylesTouched && ctx.styles) zip.file(ctx.styles.path, ser.serializeToString(ctx.styles.doc));
  if (formulas) {
    // Formula caches are now stale: ask Excel to recalculate on open rather than trust old results.
    const root = wbDoc.documentElement;
    let calc = q(root, "calcPr")[0];
    if (!calc) {
      calc = wbDoc.createElementNS(NS, "calcPr");
      const ext = child(root, "extLst");
      root.insertBefore(calc, ext);
    }
    calc.setAttribute("fullCalcOnLoad", "1");
    zip.file("xl/workbook.xml", ser.serializeToString(wbDoc));
    // A stale calcChain would point Excel at removed formulas; drop only when formulas changed.
  }
  const out = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return new Blob([out as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

/** True when the workbook's base date is 1904 (Mac legacy). */
export async function isDate1904(buf: ArrayBuffer) {
  const zip = await JSZip.loadAsync(buf);
  const xml = (await zip.file("xl/workbook.xml")?.async("string")) ?? "";
  return /<(?:\w+:)?workbookPr\b[^>]*\bdate1904="(?:1|true)"/.test(xml);
}
