/**
 * Attorney-triggered application of AI proposals to the live editors. Pure orchestration over small
 * engine interfaces so the safety rules are unit-tested:
 *  - Word: the whole batch is revalidated against the LIVE text, previewed with the engine's native
 *    atomic mutation plan (`exactlyOne` text selectors), then applied atomically with the previewed
 *    revision as a precondition. Success requires an explicit `success: true` receipt whose steps all
 *    report a change, and the outcome is re-observed in the document afterwards.
 *  - Sheet: the whole batch is preflighted, every cell's exact prior state is snapshotted, each write
 *    is verified by type, and on failure the snapshot is restored and the restore itself verified. A
 *    failed restore is reported as a partial state — never as "rolled back".
 */
import {
  LIMITS,
  editTarget,
  parseA1,
  sameFormula,
  sheetOpHasStyle,
  sheetOpValue,
  validateSheetOps,
  validateWordEdits,
  type SheetOp,
  type WordEdit,
  type WordFormat,
} from "./office-tools";

export type ApplyResult =
  | { ok: true; detail: string; applied: number }
  | {
      ok: false;
      reason: string;
      applied: number;
      /** Some changes may be in the document; never offer an automatic re-apply. */
      partial?: boolean;
    };

// ---------- receipts ----------
/** Only an explicit `success: true` counts. Missing, null or shapeless receipts are failures. */
export function strictReceipt(r: unknown): { ok: true } | { ok: false; message: string } {
  if (!r || typeof r !== "object")
    return { ok: false, message: "The editor returned no receipt, so the change can't be confirmed." };
  const x = r as { success?: unknown; failure?: { message?: unknown; code?: unknown } };
  if (x.success === true) return { ok: true };
  if (x.success === false) {
    const m = typeof x.failure?.message === "string" ? x.failure.message : "";
    return { ok: false, message: m || "The editor declined the change." };
  }
  return { ok: false, message: "The editor's receipt didn't confirm the change." };
}

// ---------- Word ----------
type TextSelect = { type: "text"; pattern: string; mode: "contains"; caseSensitive: true };
type SelectWhere = { by: "select"; select: TextSelect; require: "exactlyOne" };
export type WordStep =
  | { id: string; op: "text.rewrite"; where: SelectWhere; args: { replacement: { text: string } } }
  | {
      id: string;
      op: "text.insert";
      where: SelectWhere;
      args: { position: "after"; content: { text: string } };
    }
  | {
      id: string;
      op: "format.apply";
      where: SelectWhere;
      args: {
        inline: {
          bold?: boolean;
          italic?: boolean;
          underline?: boolean;
          fontSize?: number;
          fontFamily?: string;
        };
      };
    };
export type WordPreview = {
  valid: boolean;
  evaluatedRevision: string;
  failures?: { stepId: string; message: string }[] | undefined;
};
export type WordPlanReceipt = {
  success?: unknown;
  revision?: { before: string; after: string };
  steps?: { stepId: string; effect: string }[];
};
export type WordEngine = {
  /** Current monotonic document revision. */
  revision: () => Promise<string>;
  /** Live visible text (used to revalidate the whole batch before applying). */
  text: () => Promise<string>;
  preview: (steps: WordStep[]) => Promise<WordPreview>;
  apply: (steps: WordStep[], expectedRevision: string) => Promise<WordPlanReceipt>;
  /** Literal, case-sensitive count of visible matches (post-apply verification). */
  count: (text: string) => Promise<number>;
};

const where = (pattern: string): SelectWhere => ({
  by: "select",
  select: { type: "text", pattern, mode: "contains", caseSensitive: true },
  require: "exactlyOne",
});

function inlinePatch(f: WordFormat) {
  const p: Extract<WordStep, { op: "format.apply" }>["args"]["inline"] = {};
  if (f.bold != null) p.bold = f.bold;
  if (f.italic != null) p.italic = f.italic;
  if (f.underline != null) p.underline = f.underline;
  if (f.fontSize != null) p.fontSize = f.fontSize;
  if (f.fontFamily != null) p.fontFamily = f.fontFamily;
  return p;
}

export function wordSteps(edits: WordEdit[]): WordStep[] {
  return edits.map((e, i): WordStep => {
    const id = `e${i + 1}`;
    if (e.op === "replace")
      return { id, op: "text.rewrite", where: where(e.find), args: { replacement: { text: e.replace } } };
    if (e.op === "insert_after")
      return {
        id,
        op: "text.insert",
        where: where(e.anchor),
        args: { position: "after", content: { text: e.text } },
      };
    return { id, op: "format.apply", where: where(e.find), args: { inline: inlinePatch(e.format) } };
  });
}

/**
 * Apply a Word proposal as one native atomic plan. Identity is the exact unique anchor text in the
 * live document; a different live selection with equal text is never treated as the same target.
 */
export async function applyWordEdits(eng: WordEngine, edits: WordEdit[]): Promise<ApplyResult> {
  if (!edits.length) return { ok: false, reason: "The proposal has no edits.", applied: 0 };
  if (edits.length > LIMITS.wordEdits)
    return { ok: false, reason: `Too many edits (max ${LIMITS.wordEdits}).`, applied: 0 };
  const live = await eng.text();
  const v = validateWordEdits(live, edits);
  if (!v.ok)
    return {
      ok: false,
      applied: 0,
      reason: `Nothing was changed — the document no longer matches this proposal: ${v.errors.slice(0, 3).join(" ")}`,
    };
  const steps = wordSteps(edits);
  const pv = await eng.preview(steps);
  if (!pv || pv.valid !== true || typeof pv.evaluatedRevision !== "string") {
    const f = pv?.failures?.[0];
    return {
      ok: false,
      applied: 0,
      reason: `Nothing was changed — the editor's dry run rejected the plan${f ? ` (${f.stepId}: ${f.message})` : ""}.`,
    };
  }
  const before = await eng.revision();
  let receipt: WordPlanReceipt;
  try {
    receipt = await eng.apply(steps, pv.evaluatedRevision);
  } catch (e) {
    const moved = (await eng.revision()) !== before;
    return {
      ok: false,
      applied: 0,
      ...(moved ? { partial: true } : {}),
      reason: moved
        ? "The editor reported an error after the document changed. Review the tracked changes before doing anything else; this proposal won't be re-applied automatically."
        : `Nothing was changed: ${e instanceof Error ? e.message : "the editor rejected the plan"}.`,
    };
  }
  const r = strictReceipt(receipt);
  if (!r.ok) {
    const moved = (await eng.revision()) !== before;
    return {
      ok: false,
      applied: 0,
      ...(moved ? { partial: true } : {}),
      reason: moved ? `${r.message} The document did change — review the tracked changes.` : r.message,
    };
  }
  const outcomes = Array.isArray(receipt.steps) ? receipt.steps : [];
  const byId = new Map(outcomes.map((s) => [s.stepId, s.effect]));
  const bad = steps.filter((s) => {
    const eff = byId.get(s.id);
    return s.op === "format.apply" ? eff !== "changed" && eff !== "noop" : eff !== "changed";
  });
  // Re-observe: inserted/replacement text must now be visible in the document.
  const missing: string[] = [];
  for (const [i, e] of edits.entries()) {
    const want = e.op === "replace" ? e.replace : e.op === "insert_after" ? e.text : "";
    if (want.trim() && (await eng.count(want)) < 1) missing.push(`edit ${i + 1}`);
  }
  if (bad.length || missing.length || receipt.revision?.after === receipt.revision?.before) {
    return {
      ok: false,
      partial: true,
      applied: steps.length - bad.length,
      reason: `The editor's receipt didn't confirm every change (${[...bad.map((s) => s.id), ...missing].join(", ") || "no revision change"}). Review the tracked changes; this proposal won't be re-applied automatically.`,
    };
  }
  const noops = steps.filter((s) => byId.get(s.id) === "noop").length;
  return {
    ok: true,
    applied: steps.length,
    detail: `${steps.length} tracked change${steps.length === 1 ? "" : "s"} added${noops ? ` (${noops} formatting already in place)` : ""} — accept or reject them in the document.`,
  };
}

export { editTarget };

// ---------- Sheet ----------
export type CellStyle = {
  numberFormat: string | null;
  bold: boolean;
  fill: string | null;
  align: "left" | "center" | "right" | null;
};
/** Exact cell state used for verification and restore. `raw` is the engine's own cell record. */
export type CellState = {
  v: string | number | boolean | null;
  f: string | null;
  style: CellStyle;
  raw: unknown;
};
export type SheetEngine = {
  sheetNames: () => string[];
  read: (sheet: string, cell: string) => CellState;
  write: (sheet: string, cell: string, op: SheetOp) => void;
  /** Put back the exact prior record (value, type, formula and style). */
  restore: (sheet: string, cell: string, prev: CellState) => void;
};

function sameState(a: CellState, b: CellState) {
  return (
    a.v === b.v &&
    (a.f ?? null) === (b.f ?? null) &&
    JSON.stringify(a.style) === JSON.stringify(b.style)
  );
}

/** Did the write produce exactly what the op asked for? Primitive type equality, never String(). */
export function verifyWrite(o: SheetOp, now: CellState): string | null {
  const ref = `${o.sheet}!${o.cell}`;
  switch (o.type) {
    case "formula":
      if (!now.f || !sameFormula(now.f, o.value)) return `${ref} did not take the proposed formula.`;
      break;
    case "clear":
      if (now.f) return `${ref} still has a formula after clearing.`;
      if (now.v !== null && now.v !== "") return `${ref} still has a value after clearing.`;
      break;
    case "keep":
      break;
    case "text":
      if (now.f) return `${ref} became a formula; text must stay literal.`;
      if (typeof now.v !== "string" || now.v !== o.value) return `${ref} did not keep the exact text.`;
      break;
    default: {
      const want = sheetOpValue(o);
      if (now.f) return `${ref} became a formula.`;
      if (typeof now.v !== typeof want || now.v !== want) return `${ref} did not take the proposed ${o.type}.`;
    }
  }
  if (o.numberFormat != null && now.style.numberFormat !== o.numberFormat)
    return `${ref} did not take the number format.`;
  if (o.bold != null && now.style.bold !== o.bold) return `${ref} did not take bold.`;
  if (o.fill != null && (now.style.fill ?? "").toLowerCase() !== o.fill.toLowerCase())
    return `${ref} did not take the fill colour.`;
  if (o.align != null && now.style.align !== o.align) return `${ref} did not take the alignment.`;
  return null;
}

/** All-or-nothing as far as the engine allows: preflight, snapshot, verified writes, verified restore. */
export function applySheetOps(eng: SheetEngine, ops: SheetOp[]): ApplyResult {
  const v = validateSheetOps(eng.sheetNames(), ops);
  if (!v.ok)
    return {
      ok: false,
      applied: 0,
      reason: `Nothing was changed: ${v.errors.slice(0, 4).join(" ")}${v.errors.length > 4 ? ` (+${v.errors.length - 4} more)` : ""}`,
    };
  const plan = ops.map((o) => {
    const ref = parseA1(o.cell)!.ref;
    return { o: { ...o, cell: ref }, ref, prev: eng.read(o.sheet, ref) };
  });
  let touched = 0;
  try {
    for (const { o, ref } of plan) {
      touched++;
      eng.write(o.sheet, ref, o);
      const err = verifyWrite(o, eng.read(o.sheet, ref));
      if (err) throw new Error(err);
    }
  } catch (e) {
    const failedRestore: string[] = [];
    for (const { o, ref, prev } of plan.slice(0, touched).reverse()) {
      try {
        eng.restore(o.sheet, ref, prev);
        if (!sameState(eng.read(o.sheet, ref), prev)) failedRestore.push(`${o.sheet}!${ref}`);
      } catch {
        failedRestore.push(`${o.sheet}!${ref}`);
      }
    }
    const why = e instanceof Error ? e.message : "Write failed.";
    if (failedRestore.length)
      return {
        ok: false,
        partial: true,
        applied: touched,
        reason: `${why} Restoring the earlier values failed for ${failedRestore.slice(0, 6).join(", ")}${failedRestore.length > 6 ? ` and ${failedRestore.length - 6} more` : ""} — check those cells (or reload without saving).`,
      };
    return {
      ok: false,
      applied: 0,
      reason: `${why} The ${touched} cell${touched === 1 ? "" : "s"} written so far were restored and verified.`,
    };
  }
  const list = plan
    .slice(0, 6)
    .map((b) => `${b.o.sheet}!${b.ref}`)
    .join(", ");
  const styled = plan.filter((p) => sheetOpHasStyle(p.o)).length;
  return {
    ok: true,
    applied: plan.length,
    detail: `Updated ${list}${plan.length > 6 ? ` and ${plan.length - 6} more` : ""}${styled ? ` (${styled} with formatting)` : ""}. Review, then save.`,
  };
}
