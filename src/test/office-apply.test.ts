import { describe, expect, it, vi } from "vitest";
import {
  applySheetOps,
  applyWordEdits,
  resolveReplaceTarget,
  type WordEngine,
} from "@/lib/office-apply";
import { assignmentsToOps } from "@/components/office/SheetEditor";

function fakeWord(text: string, sel = "") {
  let doc = text;
  const eng: WordEngine & { doc: () => string } = {
    doc: () => doc,
    match: async (t) => {
      let n = 0,
        i = -1,
        from = 0,
        first = -1;
      while ((i = doc.indexOf(t, from)) >= 0) {
        if (first < 0) first = i;
        n++;
        from = i + t.length;
      }
      return {
        total: n,
        target: first >= 0 ? { kind: "selection", start: first, end: first + t.length } : null,
      };
    },
    selection: async () => ({
      text: sel,
      target: sel
        ? { kind: "selection", start: doc.indexOf(sel), end: doc.indexOf(sel) + sel.length }
        : null,
    }),
    replace: vi.fn(async (tg, t) => {
      const s = tg.start as number,
        e = tg.end as number;
      doc = doc.slice(0, s) + t + doc.slice(e);
      return { success: true };
    }),
    insertAt: vi.fn(async (tg, t) => {
      const s = tg.start as number;
      doc = doc.slice(0, s) + t + doc.slice(s);
      return { success: true };
    }),
  };
  return eng;
}

describe("Word replace targeting", () => {
  it("uses the captured anchor, not a different live selection", async () => {
    const eng = fakeWord("Alpha clause. Beta clause.", "Beta clause.");
    const r = await resolveReplaceTarget(eng, "Alpha clause.");
    expect(r).toEqual({ target: { kind: "selection", start: 0, end: 13 } });
  });
  it("refuses stale, ambiguous and missing anchors", async () => {
    expect(await resolveReplaceTarget(fakeWord("Gone text."), "Alpha")).toHaveProperty("reason");
    expect(await resolveReplaceTarget(fakeWord("Dup. Dup."), "Dup.")).toHaveProperty("reason");
    expect(
      await resolveReplaceTarget(fakeWord("Live selection", "Live selection"), undefined),
    ).toHaveProperty("reason");
  });
  it("preflights all edits: nothing written when any anchor is ambiguous", async () => {
    const eng = fakeWord("A one. B two. B two.");
    const r = await applyWordEdits(eng, [
      { op: "replace", find: "A one.", replace: "A 1." },
      { op: "replace", find: "B two.", replace: "B 2." },
    ]);
    expect(r.ok).toBe(false);
    expect(r.applied).toBe(0);
    expect(eng.replace).not.toHaveBeenCalled();
  });
  it("applies a valid batch and checks receipts", async () => {
    const eng = fakeWord("A one. B two.");
    const r = await applyWordEdits(eng, [
      { op: "replace", find: "A one.", replace: "A 1." },
      { op: "insert_after", anchor: "B two.", text: " C." },
    ]);
    expect(r).toMatchObject({ ok: true, applied: 2 });
    expect(eng.doc()).toBe("A 1. B two. C.");
    eng.replace = vi.fn(async () => ({ success: false, message: "locked" }));
    const r2 = await applyWordEdits(eng, [{ op: "replace", find: "A 1.", replace: "A one." }]);
    expect(r2).toMatchObject({ ok: false, applied: 0 });
  });
});

function fakeSheet(names: string[], coerce = false) {
  const cells = new Map<string, { value: unknown; formula: string | null }>();
  const write = vi.fn(
    (
      s: string,
      c: string,
      op: { kind: "value"; value: unknown } | { kind: "formula"; formula: string },
    ) => {
      if (op.kind === "formula") cells.set(`${s}!${c}`, { value: 0, formula: op.formula });
      else
        cells.set(`${s}!${c}`, {
          value:
            coerce && typeof op.value === "string" && /^\d+$/.test(op.value)
              ? Number(op.value)
              : op.value,
          formula: null,
        });
    },
  );
  return {
    cells,
    write,
    eng: {
      sheetNames: () => names,
      write,
      read: (s: string, c: string) => cells.get(`${s}!${c}`) ?? { value: null, formula: null },
    },
  };
}

describe("sheet apply", () => {
  it("is all-or-nothing on unknown sheet / bounds", () => {
    const f = fakeSheet(["S"]);
    const r = applySheetOps(f.eng, [
      { sheet: "S", cell: "A1", type: "number", value: "1" },
      { sheet: "T", cell: "A2", type: "number", value: "2" },
    ]);
    expect(r.ok).toBe(false);
    expect(f.write).not.toHaveBeenCalled();
    expect(
      applySheetOps(f.eng, [{ sheet: "S", cell: "A1048577", type: "text", value: "x" }]).ok,
    ).toBe(false);
    expect(f.write).not.toHaveBeenCalled();
  });
  it("writes typed values and keeps 00123 text", () => {
    const f = fakeSheet(["S"]);
    const r = applySheetOps(f.eng, [
      { sheet: "S", cell: "A1", type: "text", value: "00123" },
      { sheet: "S", cell: "A2", type: "number", value: "123" },
      { sheet: "S", cell: "A3", type: "formula", value: "=SUM(A2)" },
    ]);
    expect(r.ok).toBe(true);
    expect(f.cells.get("S!A1")?.value).toBe("00123");
    expect(f.cells.get("S!A2")?.value).toBe(123);
  });
  it("rolls back when the engine coerces a value", () => {
    const f = fakeSheet(["S"], true);
    f.cells.set("S!A1", { value: "old", formula: null });
    const r = applySheetOps(f.eng, [{ sheet: "S", cell: "A1", type: "text", value: "00123" }]);
    expect(r.ok).toBe(false);
    expect(f.cells.get("S!A1")?.value).toBe("old");
  });
  it("legacy assignments pin the sheet and keep leading zeros as text", () => {
    expect(assignmentsToOps("B2 = 00123\nDeadlines!C4 = 42\nB3 = =SUM(B1:B2)", "Costs")).toEqual([
      { sheet: "Costs", cell: "B2", type: "text", value: "00123" },
      { sheet: "Deadlines", cell: "C4", type: "number", value: "42" },
      { sheet: "Costs", cell: "B3", type: "formula", value: "=SUM(B1:B2)" },
    ]);
    expect(assignmentsToOps("Just an explanation sentence.", "Costs")).toEqual([]);
  });
});
