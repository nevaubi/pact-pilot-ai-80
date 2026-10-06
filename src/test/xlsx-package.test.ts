import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import ExcelJS from "exceljs";
import { xlsxToWorkbook, type WorkbookData } from "@/lib/office";
import { diffWorkbooks, openPackage, patchXlsx, XlsxUnsupported } from "@/lib/xlsx-package";

/** jsdom's Blob lacks arrayBuffer(); FileReader works everywhere. */
const ab = (b: Blob) =>
  new Promise<ArrayBuffer>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as ArrayBuffer);
    r.onerror = () => rej(r.error);
    r.readAsArrayBuffer(b);
  });

type C = { v?: unknown; f?: string; s?: unknown };

async function fixture(o: { date1904?: boolean } = {}) {
  const wb = new ExcelJS.Workbook();
  if (o.date1904) (wb.properties as { date1904?: boolean }).date1904 = true;
  const a = wb.addWorksheet("Deal");
  a.getCell("A1").value = "Item";
  a.getCell("A1").font = { bold: true };
  a.getCell("B1").value = "Amount";
  a.getCell("A2").value = "Price";
  a.getCell("B2").value = 1000;
  a.getCell("B2").numFmt = "$#,##0";
  a.getCell("A3").value = "Fee";
  a.getCell("B3").value = 50;
  a.getCell("B4").value = { formula: "SUM(B2:B3)", result: 1050 } as never;
  a.getCell("C2").value = { formula: "B2*2", result: 2000 } as never;
  a.getCell("C3").value = { sharedFormula: "C2", result: 100 } as never;
  a.getCell("A1").note = "Reviewed by counsel";
  a.getCell("D2").value = new Date(Date.UTC(2026, 5, 30));
  const b = wb.addWorksheet("Dates");
  b.getCell("A1").value = "Closing";
  const buf = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
  // Parts ExcelJS can't author: a chart and a custom XML part must survive untouched.
  const zip = await JSZip.loadAsync(buf);
  zip.file("xl/charts/chart1.xml", '<?xml version="1.0"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><!-- keep me --></c:chartSpace>');
  zip.file("customXml/item1.xml", '<?xml version="1.0"?><firm:meta xmlns:firm="urn:firm">Matter 2026-014</firm:meta>');
  return (await zip.generateAsync({ type: "arraybuffer" })) as ArrayBuffer;
}

const cellOf = (d: WorkbookData, sheet: string, r: number, c: number) => {
  const id = d.sheetOrder.find((x) => d.sheets[x]!.name === sheet)!;
  return (d.sheets[id]!.cellData[r]?.[c] ?? undefined) as C | undefined;
};
const setCell = (d: WorkbookData, sheet: string, r: number, c: number, v: C) => {
  const id = d.sheetOrder.find((x) => d.sheets[x]!.name === sheet)!;
  (d.sheets[id]!.cellData[r] ??= {})[c] = v as never;
};
async function entries(buf: ArrayBuffer | Blob) {
  const zip = await JSZip.loadAsync(buf instanceof Blob ? await ab(buf) : buf);
  const out = new Map<string, Uint8Array>();
  for (const [name, f] of Object.entries(zip.files)) if (!f.dir) out.set(name, await f.async("uint8array"));
  return out;
}
const same = (a?: Uint8Array, b?: Uint8Array) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

describe("XLSX original-package saving", () => {
  it("an unedited workbook diffs to no changes (caller returns the exact original bytes)", async () => {
    const buf = await fixture();
    const base = await xlsxToWorkbook(buf, "f.xlsx");
    expect(diffWorkbooks(base, structuredClone(base))).toEqual([]);
  });

  it("patches only the intended cells and keeps every other ZIP entry byte-for-byte", async () => {
    const buf = await fixture();
    const base = await xlsxToWorkbook(buf, "f.xlsx");
    const cur = structuredClone(base);
    setCell(cur, "Deal", 2, 1, { v: 75, s: cellOf(base, "Deal", 2, 1)?.s });
    setCell(cur, "Dates", 1, 1, { v: "00123" });
    const changes = diffWorkbooks(base, cur);
    expect(changes.map((c) => `${c.sheet}!${c.ref}`)).toEqual(["Deal!B3", "Dates!B2"]);
    const out = await patchXlsx(buf, changes);
    const before = await entries(buf);
    const after = await entries(out);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    const touched = new Set(["xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"]);
    for (const [name, bytes] of before)
      if (!touched.has(name)) expect(same(bytes, after.get(name)), `${name} changed`).toBe(true);
    for (const keep of ["xl/charts/chart1.xml", "customXml/item1.xml", "xl/styles.xml", "xl/workbook.xml", "xl/sharedStrings.xml"])
      if (before.has(keep)) expect(same(before.get(keep), after.get(keep))).toBe(true);
    expect([...before.keys()].some((n) => /comments/.test(n))).toBe(true);
    const re = new ExcelJS.Workbook();
    await re.xlsx.load(await ab(out));
    expect(re.getWorksheet("Deal")!.getCell("B3").value).toBe(75);
    expect(re.getWorksheet("Dates")!.getCell("B2").value).toBe("00123"); // literal text, not 123
    const f = re.getWorksheet("Deal")!.getCell("B4").value as { formula: string };
    expect(f.formula).toBe("SUM(B2:B3)"); // formulas elsewhere untouched
    expect(re.getWorksheet("Deal")!.getCell("B2").numFmt).toBe("$#,##0");
  });

  it("formula edits clear the cache and ask Excel to recalculate", async () => {
    const buf = await fixture();
    const base = await xlsxToWorkbook(buf, "f.xlsx");
    const cur = structuredClone(base);
    setCell(cur, "Deal", 4, 1, { f: "=B4*1.1" });
    const out = await patchXlsx(buf, diffWorkbooks(base, cur));
    const zip = await JSZip.loadAsync(await ab(out));
    expect(await zip.file("xl/workbook.xml")!.async("string")).toMatch(/fullCalcOnLoad="1"/);
    const sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    expect(sheet).toMatch(/<c r="B5"[^>]*><f>B4\*1\.1<\/f><\/c>/);
  });

  it("formatting appends style records and preserves the originals", async () => {
    const buf = await fixture();
    const base = await xlsxToWorkbook(buf, "f.xlsx");
    const cur = structuredClone(base);
    setCell(cur, "Deal", 2, 0, { v: "Fee", s: { bl: 1, bg: { rgb: "#ffcc00" } } });
    const before = await (await JSZip.loadAsync(buf)).file("xl/styles.xml")!.async("string");
    const out = await patchXlsx(buf, diffWorkbooks(base, cur));
    const after = await (await JSZip.loadAsync(await ab(out))).file("xl/styles.xml")!.async("string");
    const count = (x: string, tag: string) => (x.match(new RegExp(`<${tag}[ >]`, "g")) ?? []).length;
    expect(count(after, "xf")).toBe(count(before, "xf") + 1);
    expect(count(after, "font")).toBe(count(before, "font") + 1);
    const re = new ExcelJS.Workbook();
    await re.xlsx.load(await ab(out));
    const c = re.getWorksheet("Deal")!.getCell("A3");
    expect(c.font?.bold).toBe(true);
    expect((c.fill as { fgColor?: { argb?: string } }).fgColor?.argb).toBe("FFFFCC00");
    expect(re.getWorksheet("Deal")!.getCell("A1").font?.bold).toBe(true);
  });

  it("imports shared-formula children with their translated formula", async () => {
    const base = await xlsxToWorkbook(await fixture(), "f.xlsx");
    expect(cellOf(base, "Deal", 2, 2)?.f).toBe("=B3*2");
  });

  it("fails closed inside shared formula regions and for structural edits", async () => {
    const buf = await fixture();
    const base = await xlsxToWorkbook(buf, "f.xlsx");
    const cur = structuredClone(base);
    setCell(cur, "Deal", 2, 2, { f: "=B3*3" });
    await expect(patchXlsx(buf, diffWorkbooks(base, cur))).rejects.toBeInstanceOf(XlsxUnsupported);
    const renamed = structuredClone(base);
    renamed.sheets[renamed.sheetOrder[1]!]!.name = "Renamed";
    expect(() => diffWorkbooks(base, renamed)).toThrow(XlsxUnsupported);
    const merged = structuredClone(base);
    merged.sheets[merged.sheetOrder[0]!]!.mergeData.push({ startRow: 5, endRow: 5, startColumn: 0, endColumn: 1 });
    expect(() => diffWorkbooks(base, merged)).toThrow(/Merged/);
  });

  it("uses the 1904 date base when the workbook declares it", async () => {
    const d1900 = await xlsxToWorkbook(await fixture(), "a.xlsx");
    const d1904 = await xlsxToWorkbook(await fixture({ date1904: true }), "b.xlsx");
    const a = cellOf(d1900, "Deal", 1, 3)?.v as number;
    const b = cellOf(d1904, "Deal", 1, 3)?.v as number;
    expect(a - b).toBe(1462);
  });

  it("refuses macro, encrypted and zip-bomb-shaped packages", async () => {
    const zip = await JSZip.loadAsync(await fixture());
    zip.file("xl/vbaProject.bin", new Uint8Array([1, 2, 3]));
    await expect(openPackage((await zip.generateAsync({ type: "arraybuffer" })) as ArrayBuffer)).rejects.toThrow(/Macro/);
    const cfb = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).buffer;
    await expect(openPackage(cfb)).rejects.toThrow(/encrypted/);
    const many = new JSZip();
    many.file("[Content_Types].xml", "<Types/>");
    for (let i = 0; i < 2001; i++) many.file(`x/${i}.xml`, "<a/>");
    await expect(openPackage((await many.generateAsync({ type: "arraybuffer" })) as ArrayBuffer)).rejects.toThrow(/too many/);
  });
});
