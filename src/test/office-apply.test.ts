import { describe, expect, it, vi } from "vitest";
import {
  applySheetOps,
  applyWordEdits,
  strictReceipt,
  verifyWrite,
  type CellState,
  type SheetEngine,
  type WordEngine,
  type WordStep,
} from "@/lib/office-apply";
import { assignmentsToOps } from "@/components/office/SheetEditor";
import type { SheetOp } from "@/lib/office-tools";

/** Fake native plan engine over a string. Applies steps atomically like SuperDoc's mutations.apply. */
function fakeWord(
  initial: string,
  o: { throwAfterChange?: boolean; dropStep?: string; noReceipt?: boolean } = {},
) {
  let doc = initial;
  let rev = 1;
  const count = (t: string) => doc.split(t).length - 1;
  const eng: WordEngine & { doc: () => string; applies: number } = {
    applies: 0,
    doc: () => doc,
    revision: async () => String(rev),
    text: async () => doc,
    count: async (t) => count(t),
    preview: async (steps) => ({
      valid: steps.every((s) => count(s.where.select.pattern) === 1),
      evaluatedRevision: String(rev),
    }),
    apply: async (steps: WordStep[], expected) => {
      eng.applies++;
      if (expected !== String(rev)) throw new Error("REVISION_MISMATCH");
      const before = String(rev);
      for (const s of steps) {
        if (s.op === "text.rewrite")
          doc = doc.replace(s.where.select.pattern, s.args.replacement.text);
        if (s.op === "text.insert")
          doc = doc.replace(s.where.select.pattern, s.where.select.pattern + s.args.content.text);
        rev++;
        if (o.throwAfterChange) throw new Error("engine crashed");
      }
      if (o.noReceipt) return undefined as never;
      return {
        success: true,
        revision: { before, after: String(rev) },
        steps: steps
          .filter((s) => s.id !== o.dropStep)
          .map((s) => ({ stepId: s.id, effect: "changed" })),
      };
    },
  };
  return eng;
}

describe("receipts", () => {
  it("only an explicit success:true counts", () => {
    expect(strictReceipt(undefined).ok).toBe(false);
    expect(strictReceipt(null).ok).toBe(false);
    expect(strictReceipt({}).ok).toBe(false);
    expect(strictReceipt({ success: "yes" }).ok).toBe(false);
    expect(strictReceipt({ success: false, failure: { message: "nope" } })).toEqual({
      ok: false,
      message: "nope",
    });
    expect(strictReceipt({ success: true }).ok).toBe(true);
  });
});

describe("Word apply (native atomic plan)", () => {
  const text =
    "Seller shall deliver audited financial statements within ten (10) days. Buyer pays.";
  it("applies a validated batch in one plan with the previewed revision", async () => {
    const eng = fakeWord(text);
    const r = await applyWordEdits(eng, [
      { op: "replace", find: "ten (10) days", replace: "five (5) days" },
      { op: "insert_after", anchor: "Buyer pays.", text: " Time is of the essence." },
    ]);
    expect(r).toMatchObject({ ok: true, applied: 2 });
    expect(eng.doc()).toContain("five (5) days");
    expect(eng.applies).toBe(1);
  });
  it("revalidates against the LIVE text: a stale anchor changes nothing", async () => {
    const eng = fakeWord(text.replace("ten (10) days", "fifteen days"));
    const r = await applyWordEdits(eng, [
      { op: "replace", find: "ten (10) days", replace: "five (5) days" },
    ]);
    expect(r.ok).toBe(false);
    expect(eng.applies).toBe(0);
  });
  it("refuses a duplicated passage even if a selection has the same text", async () => {
    const eng = fakeWord("Buyer pays. Buyer pays.");
    const r = await applyWordEdits(eng, [
      { op: "replace", find: "Buyer pays.", replace: "Seller pays." },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/2 times/);
    expect(eng.applies).toBe(0);
  });
  it("an exception after the document changed is reported as partial, never applied:0 clean", async () => {
    const eng = fakeWord(text, { throwAfterChange: true });
    const r = await applyWordEdits(eng, [
      { op: "replace", find: "ten (10) days", replace: "five (5) days" },
    ]);
    expect(r).toMatchObject({ ok: false, partial: true });
  });
  it("a missing receipt or a step without a 'changed' outcome is not success", async () => {
    const a = await applyWordEdits(fakeWord(text, { noReceipt: true }), [
      { op: "replace", find: "ten (10) days", replace: "five (5) days" },
    ]);
    expect(a).toMatchObject({ ok: false, partial: true });
    const b = await applyWordEdits(fakeWord(text, { dropStep: "e2" }), [
      { op: "replace", find: "ten (10) days", replace: "five (5) days" },
      { op: "insert_after", anchor: "Buyer pays.", text: " X." },
    ]);
    expect(b).toMatchObject({ ok: false, partial: true });
  });
  it("builds exactlyOne literal case-sensitive selectors and inline format patches", async () => {
    const eng = fakeWord(text);
    const spy = vi.spyOn(eng, "preview");
    await applyWordEdits(eng, [
      {
        op: "format",
        find: "Buyer pays.",
        format: { bold: true, italic: null, underline: null, fontSize: 11, fontFamily: null },
      },
    ]);
    const steps = spy.mock.calls[0]![0];
    expect(steps[0]).toEqual({
      id: "e1",
      op: "format.apply",
      where: {
        by: "select",
        select: { type: "text", pattern: "Buyer pays.", mode: "contains", caseSensitive: true },
        require: "exactlyOne",
      },
      args: { inline: { bold: true, fontSize: 11 } },
    });
  });
});

/** Fake typed cell engine with an optional write/restore fault. */
function fakeSheet(
  o: { failOn?: string; restoreFails?: boolean; clearKeepsFormula?: boolean } = {},
) {
  const style = { numberFormat: null, bold: false, fill: null, align: null } as CellState["style"];
  const cells = new Map<string, CellState>();
  const k = (s: string, c: string) => `${s}!${c}`;
  cells.set(k("Main", "A1"), { v: 5, f: null, style, raw: { v: 5 } });
  cells.set(k("Main", "B1"), { v: 10, f: "=A1*2", style, raw: { v: 10, f: "=A1*2" } });
  const eng: SheetEngine & { cells: typeof cells; writes: number } = {
    cells,
    writes: 0,
    sheetNames: () => ["Main", "Other"],
    read: (s, c) => cells.get(k(s, c)) ?? { v: null, f: null, style, raw: null },
    write: (s, c, op: SheetOp) => {
      eng.writes++;
      if (o.failOn === c) throw new Error("engine refused");
      const prev = eng.read(s, c);
      const st = {
        ...prev.style,
        ...(op.bold != null ? { bold: op.bold } : {}),
        ...(op.fill != null ? { fill: op.fill } : {}),
      };
      const v =
        op.type === "number"
          ? Number(op.value)
          : op.type === "boolean"
            ? op.value === "TRUE"
            : op.type === "clear" || op.type === "formula"
              ? null
              : op.type === "keep"
                ? prev.v
                : op.value;
      const f =
        op.type === "formula"
          ? op.value
          : op.type === "clear" && o.clearKeepsFormula
            ? prev.f
            : op.type === "keep"
              ? prev.f
              : null;
      cells.set(k(s, c), { v, f, style: st, raw: { v, f } });
    },
    restore: (s, c, prev) => {
      if (o.restoreFails) throw new Error("restore failed");
      cells.set(k(s, c), prev);
    },
  };
  return eng;
}

describe("Sheet apply", () => {
  it("preflights the whole batch: unknown sheet and out-of-grid cells write nothing", () => {
    const eng = fakeSheet();
    const r = applySheetOps(eng, [
      { sheet: "Main", cell: "A2", type: "text", value: "ok" },
      { sheet: "Nope", cell: "A1", type: "text", value: "x" },
      { sheet: "Main", cell: "XFE1", type: "text", value: "x" },
    ]);
    expect(r.ok).toBe(false);
    expect(eng.writes).toBe(0);
  });
  it("keeps 00123 and '=literal' as exact text; verifies primitive types", () => {
    const eng = fakeSheet();
    const r = applySheetOps(eng, [
      { sheet: "Main", cell: "C1", type: "text", value: "00123" },
      { sheet: "Main", cell: "C2", type: "text", value: "=not a formula" },
      { sheet: "Main", cell: "C3", type: "number", value: "123" },
    ]);
    expect(r.ok).toBe(true);
    expect(eng.read("Main", "C1").v).toBe("00123");
    expect(eng.read("Main", "C2")).toMatchObject({ v: "=not a formula", f: null });
    expect(
      verifyWrite(
        { sheet: "S", cell: "A1", type: "number", value: "123" },
        { v: "123", f: null, style: eng.read("Main", "A1").style, raw: null },
      ),
    ).toMatch(/did not take/);
  });
  it("rolls back and verifies the restore when a later write fails", () => {
    const eng = fakeSheet({ failOn: "A3" });
    const r = applySheetOps(eng, [
      { sheet: "Main", cell: "A1", type: "number", value: "99" },
      { sheet: "Main", cell: "A3", type: "number", value: "1" },
    ]);
    expect(r).toMatchObject({ ok: false, applied: 0 });
    expect(eng.read("Main", "A1").v).toBe(5);
    if (!r.ok) expect(r.reason).toMatch(/restored and verified/);
  });
  it("a failed restore is reported as partial, never as rolled back", () => {
    const eng = fakeSheet({ failOn: "A3", restoreFails: true });
    const r = applySheetOps(eng, [
      { sheet: "Main", cell: "A1", type: "number", value: "99" },
      { sheet: "Main", cell: "A3", type: "number", value: "1" },
    ]);
    expect(r).toMatchObject({ ok: false, partial: true });
    if (!r.ok) expect(r.reason).not.toMatch(/rolled back|restored and verified/);
  });
  it("clearing must remove the formula", () => {
    const eng = fakeSheet({ clearKeepsFormula: true });
    const r = applySheetOps(eng, [{ sheet: "Main", cell: "B1", type: "clear", value: "" }]);
    expect(r.ok).toBe(false);
    expect(eng.read("Main", "B1").f).toBe("=A1*2");
  });
  it("applies and verifies formatting-only ops", () => {
    const eng = fakeSheet();
    const r = applySheetOps(eng, [
      { sheet: "Main", cell: "A1", type: "keep", value: "", bold: true, fill: "#ffcc00" },
    ]);
    expect(r.ok).toBe(true);
    expect(eng.read("Main", "A1")).toMatchObject({ v: 5, style: { bold: true, fill: "#ffcc00" } });
  });
});

describe("legacy cell fences", () => {
  it("pin to the ask-time sheet and reject any non-assignment line", () => {
    expect(assignmentsToOps("B2 = 00123\nC2 = =SUM(A1:A2)", "Deadlines")).toEqual({
      ops: [
        { sheet: "Deadlines", cell: "B2", type: "text", value: "00123" },
        { sheet: "Deadlines", cell: "C2", type: "formula", value: "=SUM(A1:A2)" },
      ],
      errors: [],
    });
    const bad = assignmentsToOps("B2 = 5\nThis totals the column.", "Deadlines");
    expect(bad.ops).toEqual([]);
    expect(bad.errors[0]).toMatch(/isn't a cell assignment/);
  });
});
