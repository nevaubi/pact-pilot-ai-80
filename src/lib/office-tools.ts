/**
 * Deterministic, side-effect-free helpers behind the Office drafting tools. Shared by the server tool
 * loop and the browser editors so validation is identical on both sides. Document content handled
 * here is untrusted data: nothing in it is ever executed or treated as an instruction, and every
 * search is literal (no model-supplied regex).
 */
import { z } from "zod";

// ---------- limits ----------
export const LIMITS = {
  docChars: 400_000,
  blockChars: 2_000,
  readRangeChars: 8_000,
  searchMatches: 25,
  snippetContext: 120,
  queryChars: 200,
  attachmentBytes: 10 * 1024 * 1024,
  attachmentChars: 200_000,
  attachmentsTotalChars: 400_000,
  attachments: 5,
  sheetCells: 20_000,
  readCells: 400,
  maxRows: 1_048_576,
  maxCols: 16_384,
  wordEdits: 20,
  sheetOps: 500,
} as const;

// ---------- document blocks ----------
export type Block = { id: string; start: number; end: number; text: string };

/** Split text into stable paragraph blocks with exact character offsets. Long paragraphs are cut at LIMITS.blockChars. */
export function toBlocks(text: string): Block[] {
  const out: Block[] = [];
  const re = /[^\n]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const raw = m[0];
    if (!raw.trim()) continue;
    for (let i = 0; i < raw.length; i += LIMITS.blockChars) {
      const start = m.index + i;
      const piece = raw.slice(i, i + LIMITS.blockChars);
      out.push({ id: `b${out.length + 1}`, start, end: start + piece.length, text: piece });
    }
  }
  return out;
}

const HEADING =
  /^(?:(?:article|section|schedule|exhibit|part)\b|\d+(?:\.\d+)*[.)]?\s+[A-Z]|[A-Z][A-Z0-9 ,&'()-]{3,80}$)/i;

/** Headings-like blocks (numbered sections, ARTICLE/Section lines, all-caps lines) with offsets. */
export function outline(blocks: Block[], max = 80) {
  return blocks
    .filter((b) => b.text.length <= 140 && HEADING.test(b.text.trim()))
    .slice(0, max)
    .map((b) => ({ id: b.id, start: b.start, text: b.text.trim() }));
}

export function readRange(text: string, start: number, end: number) {
  const s = Math.max(0, Math.min(Math.floor(start), text.length));
  const e = Math.max(s, Math.min(Math.floor(end), text.length, s + LIMITS.readRangeChars));
  return {
    start: s,
    end: e,
    text: text.slice(s, e),
    truncated: e < Math.min(end, text.length),
    length: text.length,
  };
}

export type SearchHit = { start: number; end: number; snippet: string; blockId: string | null };

/** Literal search with exact offsets and bounded matches. Never compiles the query as a regex. */
export function searchLiteral(
  text: string,
  query: string,
  o: { caseSensitive?: boolean; limit?: number; blocks?: Block[] } = {},
): { total: number; hits: SearchHit[]; truncated: boolean } {
  const q = query.slice(0, LIMITS.queryChars);
  if (!q.trim()) return { total: 0, hits: [], truncated: false };
  const limit = Math.max(1, Math.min(o.limit ?? 10, LIMITS.searchMatches));
  const hay = o.caseSensitive ? text : text.toLowerCase();
  const needle = o.caseSensitive ? q : q.toLowerCase();
  const hits: SearchHit[] = [];
  let total = 0;
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at < 0) break;
    total++;
    if (hits.length < limit) {
      const c = LIMITS.snippetContext;
      const block = o.blocks?.find((b) => b.start <= at && at < b.end) ?? null;
      hits.push({
        start: at,
        end: at + q.length,
        snippet: text.slice(Math.max(0, at - c), Math.min(text.length, at + q.length + c)),
        blockId: block?.id ?? null,
      });
    }
    from = at + Math.max(1, needle.length);
    if (total > 10_000) break;
  }
  return { total, hits, truncated: total > hits.length };
}

export function countLiteral(text: string, needle: string) {
  if (!needle) return 0;
  let n = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at < 0) return n;
    n++;
    from = at + needle.length;
  }
}

const STOP = new Set(
  "the a an and or of to in on for with by at from as is are be this that it its shall will may any all such into under per not no".split(
    " ",
  ),
);
export function terms(s: string) {
  return [
    ...new Set(
      (s.toLowerCase().match(/[a-z0-9][a-z0-9'$.%-]{2,}/g) ?? []).filter((t) => !STOP.has(t)),
    ),
  ].slice(0, 40);
}

/**
 * Build the context excerpt for the first model call: outline, the selection's neighbourhood and the
 * blocks that best match the question — not just the head/tail. Reports exactly what is covered so
 * the model knows to use tools for the rest.
 */
export function rankedContext(
  text: string,
  question: string,
  selection: string | undefined,
  budget: number,
) {
  const blocks = toBlocks(text);
  if (text.length <= budget)
    return {
      excerpt: text,
      coverage: {
        included: text.length,
        total: text.length,
        complete: true,
        blocks: blocks.length,
      },
      blocks,
    };
  const chosen = new Set<number>();
  let used = 0;
  const take = (i: number) => {
    const b = blocks[i];
    if (!b || chosen.has(i) || used + b.text.length > budget) return;
    chosen.add(i);
    used += b.text.length + 1;
  };
  // 1. Opening blocks (title, parties, recitals) — small slice of the budget.
  for (let i = 0; i < blocks.length && used < budget * 0.12; i++) take(i);
  // 2. The selection and its neighbours.
  const sel = selection?.trim();
  if (sel) {
    const at = text.indexOf(sel.slice(0, 200));
    const idx = at >= 0 ? blocks.findIndex((b) => b.start <= at && at < b.end) : -1;
    if (idx >= 0) for (let d = -3; d <= 6; d++) take(idx + d);
  }
  // 3. Blocks ranked by term overlap with question + selection.
  const ts = terms(`${question} ${sel ?? ""}`);
  if (ts.length) {
    const scored = blocks
      .map((b, i) => {
        const low = b.text.toLowerCase();
        let s = 0;
        for (const t of ts) if (low.includes(t)) s += 1 + Math.min(3, countLiteral(low, t)) * 0.2;
        return { i, s };
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    for (const { i } of scored) {
      if (used >= budget * 0.95) break;
      take(i);
      take(i + 1);
    }
  }
  const ordered = [...chosen].sort((a, b) => a - b);
  let excerpt = "";
  let prev = -2;
  for (const i of ordered) {
    const b = blocks[i]!;
    if (i !== prev + 1)
      excerpt += `\n[… gap — use read_document_range/search_document; next block ${b.id} at offset ${b.start} …]\n`;
    excerpt += `[${b.id}@${b.start}] ${b.text}\n`;
    prev = i;
  }
  return {
    excerpt,
    coverage: { included: used, total: text.length, complete: false, blocks: blocks.length },
    blocks,
  };
}

// ---------- spreadsheet ----------
export type CellSnap = { v?: string | number | boolean | null; f?: string };
export type SheetSnap = { name: string; cells: Record<string, CellSnap> };
export type WorkbookSnap = {
  active?: string;
  selection?: { sheet: string; range: string };
  sheets: SheetSnap[];
};

export function colToNum(col: string) {
  let n = 0;
  for (const ch of col.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
export function numToCol(n: number) {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
/** Parse "B12" (no sheet) into 1-based row/col; null when malformed or outside Excel's grid. */
export function parseA1(a1: string): { col: number; row: number; ref: string } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(a1.trim());
  if (!m) return null;
  const col = colToNum(m[1]!);
  const row = Number(m[2]);
  if (row < 1 || row > LIMITS.maxRows || col < 1 || col > LIMITS.maxCols) return null;
  return { col, row, ref: `${numToCol(col)}${row}` };
}
export function parseRange(r: string) {
  const [a, b] = r.split(":");
  const s = a ? parseA1(a) : null;
  const e = b ? parseA1(b) : s;
  if (!s || !e) return null;
  return {
    r1: Math.min(s.row, e.row),
    r2: Math.max(s.row, e.row),
    c1: Math.min(s.col, e.col),
    c2: Math.max(s.col, e.col),
  };
}

export function readCells(wb: WorkbookSnap, sheet: string, range: string) {
  const sh = wb.sheets.find((s) => s.name === sheet);
  if (!sh)
    return {
      error: `No sheet named "${sheet}". Sheets: ${wb.sheets.map((s) => s.name).join(", ")}`,
    };
  const r = parseRange(range);
  if (!r) return { error: `"${range}" is not a valid A1 range inside Excel's grid.` };
  const cells: { cell: string; v: CellSnap["v"]; f?: string }[] = [];
  let truncated = false;
  for (let row = r.r1; row <= r.r2; row++)
    for (let col = r.c1; col <= r.c2; col++) {
      const ref = `${numToCol(col)}${row}`;
      const c = sh.cells[ref];
      if (!c) continue;
      if (cells.length >= LIMITS.readCells) {
        truncated = true;
        break;
      }
      cells.push({ cell: ref, v: c.v ?? null, ...(c.f ? { f: c.f } : {}) });
    }
  return { sheet, range, cells, truncated };
}

export function sheetSummary(wb: WorkbookSnap) {
  return wb.sheets.map((s) => {
    let maxR = 0;
    let maxC = 0;
    let formulas = 0;
    for (const [ref, c] of Object.entries(s.cells)) {
      const p = parseA1(ref);
      if (!p) continue;
      maxR = Math.max(maxR, p.row);
      maxC = Math.max(maxC, p.col);
      if (c.f) formulas++;
    }
    return {
      name: s.name,
      used: maxR ? `A1:${numToCol(maxC)}${maxR}` : "empty",
      cells: Object.keys(s.cells).length,
      formulas,
    };
  });
}

// ---------- proposals ----------
export const wordEditZ = z.discriminatedUnion("op", [
  z.object({ op: z.literal("replace"), find: z.string(), replace: z.string() }),
  z.object({ op: z.literal("insert_after"), anchor: z.string(), text: z.string() }),
]);
export const sheetOpZ = z.object({
  sheet: z.string(),
  cell: z.string(),
  type: z.enum(["text", "number", "boolean", "formula", "clear"]),
  value: z.string(),
});
export const proposalZ = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("word"), summary: z.string(), edits: z.array(wordEditZ) }),
  z.object({ kind: z.literal("sheet"), summary: z.string(), ops: z.array(sheetOpZ) }),
]);
export type WordEdit = z.infer<typeof wordEditZ>;
export type SheetOp = z.infer<typeof sheetOpZ>;
export type Proposal = z.infer<typeof proposalZ>;
export type Validation = { ok: boolean; errors: string[] };

/** Every Word edit must target literal text that occurs exactly once; targets may not overlap. */
export function validateWordEdits(docText: string, edits: WordEdit[]): Validation {
  const errors: string[] = [];
  if (!edits.length) errors.push("No edits.");
  if (edits.length > LIMITS.wordEdits)
    errors.push(`At most ${LIMITS.wordEdits} edits per proposal.`);
  const spans: [number, number, number][] = [];
  edits.forEach((e, i) => {
    const target = e.op === "replace" ? e.find : e.anchor;
    const body = e.op === "replace" ? e.replace : e.text;
    const n = i + 1;
    if (!target.trim()) return void errors.push(`Edit ${n}: empty anchor.`);
    if (target.length > 4000)
      return void errors.push(`Edit ${n}: anchor longer than 4000 characters.`);
    if (e.op === "insert_after" && !body.trim()) errors.push(`Edit ${n}: nothing to insert.`);
    if (e.op === "replace" && body === target)
      errors.push(`Edit ${n}: replacement is identical to the original.`);
    const c = countLiteral(docText, target);
    if (c === 0) errors.push(`Edit ${n}: anchor text not found verbatim in the document.`);
    else if (c > 1)
      errors.push(`Edit ${n}: anchor occurs ${c} times — extend it until it is unique.`);
    else {
      const at = docText.indexOf(target);
      spans.push([at, at + target.length, n]);
    }
  });
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++)
    if (spans[i]![0] < spans[i - 1]![1])
      errors.push(`Edits ${spans[i - 1]![2]} and ${spans[i]![2]} overlap.`);
  return { ok: errors.length === 0, errors };
}

/** Whole-batch preflight for sheet ops. Any error rejects the batch; nothing is partially applied. */
export function validateSheetOps(sheetNames: string[], ops: SheetOp[]): Validation {
  const errors: string[] = [];
  if (!ops.length) errors.push("No cell operations.");
  if (ops.length > LIMITS.sheetOps) errors.push(`At most ${LIMITS.sheetOps} cells per proposal.`);
  const seen = new Set<string>();
  ops.forEach((o, i) => {
    const n = `Op ${i + 1} (${o.sheet}!${o.cell})`;
    if (!sheetNames.includes(o.sheet)) errors.push(`${n}: unknown sheet "${o.sheet}".`);
    const p = parseA1(o.cell);
    if (!p) errors.push(`${n}: not a valid cell inside Excel's grid (max XFD1048576).`);
    else {
      const key = `${o.sheet}!${p.ref}`;
      if (seen.has(key)) errors.push(`${n}: duplicate target.`);
      seen.add(key);
    }
    if (o.type === "number" && !/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(o.value.trim()))
      errors.push(`${n}: "${o.value}" is not a plain number (no currency symbols or commas).`);
    if (o.type === "formula" && !o.value.startsWith("="))
      errors.push(`${n}: formula must start with "=".`);
    if (o.type === "boolean" && !/^(true|false)$/i.test(o.value))
      errors.push(`${n}: boolean must be TRUE or FALSE.`);
    if (o.value.length > 32_767)
      errors.push(`${n}: longer than Excel's 32,767-character cell limit.`);
  });
  return { ok: errors.length === 0, errors };
}

/** The literal value a sheet op writes. Text stays text — "00123" is never coerced to 123. */
export function sheetOpValue(o: SheetOp): string | number | boolean | null {
  if (o.type === "clear") return null;
  if (o.type === "number") return Number(o.value);
  if (o.type === "boolean") return /^true$/i.test(o.value);
  return o.value;
}

// ---------- public search hygiene ----------
/**
 * External search receives only short public legal terms: strips emails, phone/account-like numbers,
 * dollar amounts and quoted passages, and caps length. Returns null when nothing usable remains.
 */
export function publicQuery(q: string): string | null {
  const cleaned = q
    .replace(/"[^"]{25,}"/g, " ")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, " ")
    .replace(/\$\s?[\d,.]+/g, " ")
    .replace(/\b\d{5,}\b/g, " ")
    .replace(/\b\d{3}[-.\s]\d{3,4}[-.\s]\d{4}\b/g, " ")
    .replace(/[^\w\s§.()'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 12)
    .join(" ");
  return cleaned.length >= 3 ? cleaned.slice(0, 120) : null;
}

/** Aggregate budget for tool output across one request. */
export class ToolBudget {
  used = 0;
  constructor(readonly total: number) {}
  /** Clip a serialised tool result to what remains; marks clipping so the model knows. */
  take(s: string) {
    const left = this.total - this.used;
    if (left <= 0)
      return '{"error":"Tool output budget for this request is used up. Answer from what you have read."}';
    const out = s.length > left ? `${s.slice(0, left)}… [clipped: tool budget reached]` : s;
    this.used += out.length;
    return out;
  }
}
