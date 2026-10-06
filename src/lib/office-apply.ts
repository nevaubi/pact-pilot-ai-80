/**
 * Attorney-triggered application of AI proposals to the live editors. Pure orchestration over minimal
 * engine interfaces so the safety rules are unit-tested: targets are resolved from text captured at
 * ask time, ambiguous/stale targets are refused, whole batches are preflighted before any write, and
 * every write's receipt is checked.
 */
import {
  LIMITS,
  parseA1,
  sheetOpValue,
  validateSheetOps,
  type SheetOp,
  type WordEdit,
} from "./office-tools";

export type ApplyResult =
  { ok: true; detail: string; applied: number } | { ok: false; reason: string; applied: number };

// ---------- Word ----------
export type MatchTarget = { kind?: string; start?: unknown; end?: unknown };
export type WordEngine = {
  /** Literal, case-sensitive match. Returns total occurrences and the first target. */
  match: (text: string) => Promise<{ total: number; target: MatchTarget | null }>;
  /** Current selection's text and target ("" when empty). */
  selection: () => Promise<{ text: string; target: MatchTarget | null }>;
  replace: (target: MatchTarget, text: string) => Promise<{ success: boolean; message?: string }>;
  insertAt: (target: MatchTarget, text: string) => Promise<{ success: boolean; message?: string }>;
};

/**
 * Where a Replace for a turn should land. The captured anchor wins: the live selection is used only
 * when its text is exactly the anchor. No anchor at ask time ⇒ refuse (no silent fallback to Insert).
 */
export async function resolveReplaceTarget(
  eng: WordEngine,
  anchor: string | undefined,
): Promise<{ target: MatchTarget } | { reason: string }> {
  const needle = anchor?.trim();
  if (!needle)
    return {
      reason:
        "Nothing was selected when you asked, so there is no passage to replace. Select it and ask again.",
    };
  const live = await eng.selection();
  if (live.target && live.text.trim() === needle) return { target: live.target };
  const m = await eng.match(needle);
  if (m.total === 0 || !m.target)
    return {
      reason:
        "The passage you selected when you asked is no longer in the document. Select it again and re-ask.",
    };
  if (m.total > 1)
    return {
      reason: `The passage you selected appears ${m.total} times. Select the exact one and re-ask.`,
    };
  return { target: m.target };
}

export async function applyWordEdits(eng: WordEngine, edits: WordEdit[]): Promise<ApplyResult> {
  if (!edits.length) return { ok: false, reason: "The proposal has no edits.", applied: 0 };
  if (edits.length > LIMITS.wordEdits)
    return { ok: false, reason: `Too many edits (max ${LIMITS.wordEdits}).`, applied: 0 };
  // Preflight the whole batch against the live document before touching it.
  for (const [i, e] of edits.entries()) {
    const needle = e.op === "replace" ? e.find : e.anchor;
    const m = await eng.match(needle);
    if (m.total !== 1)
      return {
        ok: false,
        applied: 0,
        reason: `Edit ${i + 1}: its anchor text ${m.total === 0 ? "is no longer in the document" : `appears ${m.total} times`}. Nothing was changed.`,
      };
  }
  let applied = 0;
  for (const [i, e] of edits.entries()) {
    // Re-resolve right before each write: earlier edits change positions.
    const needle = e.op === "replace" ? e.find : e.anchor;
    const m = await eng.match(needle);
    if (m.total !== 1 || !m.target)
      return {
        ok: false,
        applied,
        reason: `Edit ${i + 1} could not be placed after ${applied} change(s) were applied — review the tracked changes.`,
      };
    const r =
      e.op === "replace"
        ? await eng.replace(m.target, e.replace)
        : await eng.insertAt({ ...m.target, start: m.target.end }, e.text);
    if (!r.success)
      return {
        ok: false,
        applied,
        reason: `Edit ${i + 1} was declined by the editor: ${r.message ?? "unknown reason"}.`,
      };
    applied++;
  }
  return {
    ok: true,
    applied,
    detail: `${applied} tracked change${applied === 1 ? "" : "s"} added — accept or reject them in the document.`,
  };
}

// ---------- Sheet ----------
export type SheetEngine = {
  sheetNames: () => string[];
  write: (
    sheet: string,
    cell: string,
    op:
      | { kind: "value"; value: string | number | boolean | null }
      | { kind: "formula"; formula: string },
  ) => void;
  read: (sheet: string, cell: string) => { value: unknown; formula: string | null };
};

/** All-or-nothing: preflight the entire batch (sheets, bounds, duplicates, types) before any write; verify each write. */
export function applySheetOps(eng: SheetEngine, ops: SheetOp[]): ApplyResult {
  const v = validateSheetOps(eng.sheetNames(), ops);
  if (!v.ok)
    return {
      ok: false,
      applied: 0,
      reason: `Nothing was changed: ${v.errors.slice(0, 4).join(" ")}${v.errors.length > 4 ? ` (+${v.errors.length - 4} more)` : ""}`,
    };
  const before = ops.map((o) => ({
    o,
    ref: parseA1(o.cell)!.ref,
    prev: eng.read(o.sheet, parseA1(o.cell)!.ref),
  }));
  let applied = 0;
  try {
    for (const { o, ref } of before) {
      if (o.type === "formula") eng.write(o.sheet, ref, { kind: "formula", formula: o.value });
      else eng.write(o.sheet, ref, { kind: "value", value: sheetOpValue(o) });
      const now = eng.read(o.sheet, ref);
      const okWrite =
        o.type === "formula"
          ? (now.formula ?? "").replace(/^=/, "").toUpperCase() ===
            o.value.replace(/^=/, "").toUpperCase()
          : o.type === "clear"
            ? now.value == null || now.value === ""
            : String(now.value) === String(sheetOpValue(o));
      if (!okWrite) throw new Error(`${o.sheet}!${ref} did not take the proposed value.`);
      applied++;
    }
  } catch (e) {
    // Roll back what was written so the sheet is never left half-applied.
    for (const { o, ref, prev } of before.slice(0, applied + 1)) {
      try {
        if (prev.formula) eng.write(o.sheet, ref, { kind: "formula", formula: prev.formula });
        else
          eng.write(o.sheet, ref, {
            kind: "value",
            value: (prev.value as string | number | boolean | null) ?? null,
          });
      } catch {
        /* best effort */
      }
    }
    return {
      ok: false,
      applied: 0,
      reason: `${e instanceof Error ? e.message : "Write failed."} All changes in this batch were rolled back.`,
    };
  }
  const list = before
    .slice(0, 6)
    .map((b) => `${b.o.sheet}!${b.ref}`)
    .join(", ");
  return {
    ok: true,
    applied,
    detail: `Updated ${list}${before.length > 6 ? ` and ${before.length - 6} more` : ""}. Review, then save.`,
  };
}
