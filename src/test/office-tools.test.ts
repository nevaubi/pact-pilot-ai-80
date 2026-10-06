import { describe, expect, it } from "vitest";
import {
  LIMITS,
  parseRange,
  sameFormula,
  publicQuery,
  rankedContext,
  readCells,
  readRange,
  searchLiteral,
  sheetOpValue,
  toBlocks,
  validateSheetOps,
  validateWordEdits,
  ToolBudget,
} from "@/lib/office-tools";

const filler = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => `Clause ${i}. The parties agree to ordinary boilerplate number ${i}.`,
  ).join("\n");

describe("document retrieval", () => {
  it("finds a passage in the middle of a large document (not just head/tail)", () => {
    const mid = "Seller shall deliver the estoppel certificates no later than March 3.";
    const text = `${filler(3000)}\n${mid}\n${filler(3000)}`;
    expect(text.length).toBeGreaterThan(300_000);
    const rc = rankedContext(text, "When are estoppel certificates due?", undefined, 16_000);
    expect(rc.coverage.complete).toBe(false);
    expect(rc.excerpt).toContain(mid);
    expect(rc.excerpt.length).toBeLessThan(20_000);
    const s = searchLiteral(text, "estoppel certificates", { blocks: rc.blocks });
    expect(s.total).toBe(1);
    expect(text.slice(s.hits[0]!.start, s.hits[0]!.end)).toBe("estoppel certificates");
    expect(s.hits[0]!.blockId).toMatch(/^b\d+$/);
  });
  it("bounds matches and treats queries literally (no regex)", () => {
    const text = "a.b ".repeat(5000);
    const s = searchLiteral(text, "a.b", { limit: 999 });
    expect(s.total).toBe(5000);
    expect(s.hits.length).toBe(LIMITS.searchMatches);
    expect(s.truncated).toBe(true);
    expect(searchLiteral("axb", "a.b").total).toBe(0);
    expect(searchLiteral("x".repeat(100), "(x+)+$").total).toBe(0);
  });
  it("case option", () => {
    expect(searchLiteral("Buyer buyer", "buyer").total).toBe(2);
    expect(searchLiteral("Buyer buyer", "buyer", { caseSensitive: true }).total).toBe(1);
  });
  it("guards range bounds", () => {
    const r = readRange("hello world", -50, 1e9);
    expect(r).toMatchObject({ start: 0, end: 11, text: "hello world" });
    const big = readRange("x".repeat(50_000), 0, 50_000);
    expect(big.text.length).toBe(LIMITS.readRangeChars);
    expect(big.truncated).toBe(true);
  });
  it("blocks carry exact offsets", () => {
    const t = "One\n\nTwo two\nThree";
    for (const b of toBlocks(t)) expect(t.slice(b.start, b.end)).toBe(b.text);
  });
  it("tool budget returns valid JSON and never passes total − reserve with document data", () => {
    const b = new ToolBudget(1000);
    const outs = [
      b.take({ t: "x".repeat(300) }),
      b.take({ t: "y".repeat(2000) }),
      b.take({ t: "z".repeat(50) }),
    ];
    for (const o of outs) expect(() => JSON.parse(o)).not.toThrow();
    expect(JSON.parse(outs[1]!).truncated).toBe(true);
    expect(JSON.parse(outs[2]!).error).toMatch(/budget/);
    expect(b.used).toBeLessThanOrEqual(1000);
    const docChars = outs.slice(0, 2).reduce((n, o) => n + o.length, 0);
    expect(docChars).toBeLessThanOrEqual(1000 - ToolBudget.RESERVE);
  });
});

describe("word proposal validation", () => {
  const doc = "Seller shall deliver audited financial statements. Buyer pays. Buyer pays.";
  it("accepts a unique verbatim anchor", () => {
    expect(
      validateWordEdits(doc, [
        {
          op: "replace",
          find: "audited financial statements",
          replace: "reviewed financial statements",
        },
      ]).ok,
    ).toBe(true);
  });
  it("rejects missing, ambiguous, identical and overlapping anchors", () => {
    const v = validateWordEdits(doc, [
      { op: "replace", find: "Buyer pays.", replace: "Buyer pays promptly." },
      { op: "replace", find: "not here", replace: "x" },
      { op: "replace", find: "Seller", replace: "Seller" },
      { op: "insert_after", anchor: "Seller shall deliver", text: " promptly" },
    ]);
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/occurs 2 times/);
    expect(v.errors.join(" ")).toMatch(/not found/);
    expect(v.errors.join(" ")).toMatch(/identical/);
    expect(v.errors.join(" ")).toMatch(/overlap/);
  });
});

describe("sheet preflight", () => {
  const names = ["Closing Costs", "Deadlines"];
  it("rejects the whole batch for an unknown sheet, out-of-grid cells and duplicates", () => {
    const v = validateSheetOps(names, [
      { sheet: "Closing Costs", cell: "B2", type: "number", value: "10" },
      { sheet: "Nope", cell: "A1", type: "text", value: "x" },
      { sheet: "Deadlines", cell: "XFE1", type: "text", value: "x" },
      { sheet: "Deadlines", cell: "A1048577", type: "text", value: "x" },
      { sheet: "Closing Costs", cell: "b2", type: "number", value: "11" },
      { sheet: "Deadlines", cell: "C3", type: "number", value: "$1,000" },
      { sheet: "Deadlines", cell: "C4", type: "formula", value: "SUM(A1)" },
    ]);
    expect(v.ok).toBe(false);
    expect(v.errors.length).toBe(6);
  });
  it("allows the max cell and preserves 00123 as literal text", () => {
    expect(
      validateSheetOps(names, [
        { sheet: "Deadlines", cell: "XFD1048576", type: "text", value: "00123" },
      ]).ok,
    ).toBe(true);
    expect(sheetOpValue({ sheet: "D", cell: "A1", type: "text", value: "00123" })).toBe("00123");
    expect(sheetOpValue({ sheet: "D", cell: "A1", type: "number", value: "123" })).toBe(123);
  });
  it("reads cells with formulas within a range", () => {
    const r = readCells(
      { sheets: [{ name: "S", cells: { A1: { v: 1 }, A2: { v: 3, f: "=A1*3" }, Z9: { v: 9 } } }] },
      "S",
      "A1:B5",
    );
    expect("cells" in r && r.cells).toEqual([
      { cell: "A1", v: 1 },
      { cell: "A2", v: 3, f: "=A1*3" },
    ]);
    expect(readCells({ sheets: [] }, "X", "A1")).toHaveProperty("error");
  });
});

describe("public query hygiene", () => {
  it("strips emails, amounts, account numbers and long quotes", () => {
    const q = publicQuery(
      'bulk sales notice Illinois john@client.com $1,250,000 acct 123456789 "the seller shall indemnify the buyer for all losses"',
    );
    expect(q).toBe("bulk sales notice Illinois acct");
  });
});

describe("review findings (P0-1)", () => {
  it("A1:XFD1048576 reads the sparse snapshot quickly instead of scanning 17 billion cells", () => {
    const cells: Record<string, { v: number }> = {};
    for (let i = 1; i <= 2000; i++) cells[`B${i}`] = { v: i };
    const t0 = performance.now();
    const r = readCells({ sheets: [{ name: "S", cells }] }, "S", "A1:XFD1048576");
    expect(performance.now() - t0).toBeLessThan(500);
    expect("cells" in r && r.cells.length).toBe(LIMITS.readCells);
    expect("truncated" in r && r.truncated).toBe(true);
    expect("cells" in r && r.cells[0]!.cell).toBe("B1");
  });
  it("rejects malformed ranges instead of ignoring segments", () => {
    expect(parseRange("A1:B2:C3")).toBeNull();
    expect(parseRange("A1:")).toBeNull();
    expect(parseRange("B2")).toEqual({ r1: 2, r2: 2, c1: 2, c2: 2 });
  });
  it("rejects non-finite numbers like 1e999", () => {
    expect(
      validateSheetOps(["S"], [{ sheet: "S", cell: "A1", type: "number", value: "1e999" }]).ok,
    ).toBe(false);
    expect(
      validateSheetOps(["S"], [{ sheet: "S", cell: "A1", type: "number", value: "1e3" }]).ok,
    ).toBe(true);
  });
  it("formula comparison keeps string-literal case exact", () => {
    expect(sameFormula("=sum(a1:a2)", "=SUM(A1:A2)")).toBe(true);
    expect(sameFormula('=IF(A1,"Yes","No")', '=IF(A1,"YES","NO")')).toBe(false);
  });
  it("case-insensitive search reports exact offsets when folding changes length (İ)", () => {
    const t = "İİİ Closing Date is set.";
    const r = searchLiteral(t, "closing date");
    expect(r.total).toBe(1);
    expect(t.slice(r.hits[0]!.start, r.hits[0]!.end)).toBe("Closing Date");
  });
  it("overlong search text is an error, never a silently different search", () => {
    const r = searchLiteral("abc", "x".repeat(LIMITS.queryChars + 1));
    expect(r.error).toMatch(/limit/);
    expect(r.total).toBe(0);
  });
  it("validates Word formatting edits", () => {
    const doc = "ARTICLE 1 DEFINITIONS\nBody text.";
    const ok = validateWordEdits(doc, [
      {
        op: "format",
        find: "ARTICLE 1 DEFINITIONS",
        format: {
          bold: true,
          italic: null,
          underline: null,
          fontSize: 12,
          fontFamily: "Times New Roman",
        },
      },
    ]);
    expect(ok.ok).toBe(true);
    const bad = validateWordEdits(doc, [
      {
        op: "format",
        find: "Body text.",
        format: {
          bold: null,
          italic: null,
          underline: null,
          fontSize: 0.3,
          fontFamily: "<script>",
        },
      },
    ]);
    expect(bad.errors.join(" ")).toMatch(/font size/);
    expect(bad.errors.join(" ")).toMatch(/font family/);
  });
  it("validates sheet formatting ops", () => {
    expect(
      validateSheetOps(
        ["S"],
        [{ sheet: "S", cell: "A1", type: "keep", value: "", fill: "#ffcc00", bold: true }],
      ).ok,
    ).toBe(true);
    expect(validateSheetOps(["S"], [{ sheet: "S", cell: "A1", type: "keep", value: "" }]).ok).toBe(
      false,
    );
    expect(
      validateSheetOps(["S"], [{ sheet: "S", cell: "A1", type: "keep", value: "", fill: "red" }])
        .ok,
    ).toBe(false);
  });
});
