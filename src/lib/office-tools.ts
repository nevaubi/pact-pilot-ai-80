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

/**
 * Lower-case `text` while keeping a map from every folded code unit back to its original offset, so
 * case-insensitive hits report exact offsets even when folding changes length (e.g. "İ" → "i̇").
 */
export function foldWithMap(text: string): { folded: string; map: Int32Array | null } {
  const plain = text.toLowerCase();
  if (plain.length === text.length) return { folded: plain, map: null };
  const parts: string[] = [];
  const map = new Int32Array(plain.length + 8);
  let k = 0;
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const low = ch.toLowerCase();
    for (let j = 0; j < low.length; j++) map[k++] = i;
    parts.push(low);
    i += ch.length;
  }
  const folded = parts.join("");
  return { folded, map: map.subarray(0, folded.length) };
}

/**
 * Literal search with exact offsets and bounded matches. Never compiles the query as a regex. A query
 * longer than LIMITS.queryChars is an error, never silently shortened into a different search.
 */
export function searchLiteral(
  text: string,
  query: string,
  o: { caseSensitive?: boolean; limit?: number; blocks?: Block[] } = {},
): { total: number; hits: SearchHit[]; truncated: boolean; error?: string } {
  if (query.length > LIMITS.queryChars)
    return {
      total: 0,
      hits: [],
      truncated: false,
      error: `Search text is ${query.length} characters; the limit is ${LIMITS.queryChars}. Search for a shorter distinctive phrase.`,
    };
  const q = query;
  if (!q.trim()) return { total: 0, hits: [], truncated: false };
  const limit = Math.max(1, Math.min(o.limit ?? 10, LIMITS.searchMatches));
  let hay = text;
  let needle = q;
  let map: Int32Array | null = null;
  if (!o.caseSensitive) {
    const f = foldWithMap(text);
    hay = f.folded;
    map = f.map;
    needle = foldWithMap(q).folded;
  }
  const orig = (i: number) => (map ? (i < map.length ? map[i]! : text.length) : i);
  const hits: SearchHit[] = [];
  let total = 0;
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at < 0) break;
    total++;
    if (hits.length < limit) {
      const c = LIMITS.snippetContext;
      const start = orig(at);
      const end = at + needle.length >= hay.length ? text.length : orig(at + needle.length);
      const block = o.blocks?.find((b) => b.start <= start && start < b.end) ?? null;
      hits.push({
        start,
        end,
        snippet: text.slice(Math.max(0, start - c), Math.min(text.length, end + c)),
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
/** "A1" or "A1:B2" only — a third segment or junk is rejected, never ignored. */
export function parseRange(r: string) {
  const parts = r.trim().split(":");
  if (parts.length < 1 || parts.length > 2) return null;
  const s = parseA1(parts[0] ?? "");
  const e = parts.length === 2 ? parseA1(parts[1] ?? "") : s;
  if (!s || !e) return null;
  return {
    r1: Math.min(s.row, e.row),
    r2: Math.max(s.row, e.row),
    c1: Math.min(s.col, e.col),
    c2: Math.max(s.col, e.col),
  };
}

/**
 * Cells of a range from the bounded sparse snapshot. Iterates the snapshot's stored cells (≤
 * LIMITS.sheetCells), never the requested rectangle, so A1:XFD1048576 costs the same as A1:B2.
 */
export function readCells(wb: WorkbookSnap, sheet: string, range: string) {
  const sh = wb.sheets.find((s) => s.name === sheet);
  if (!sh)
    return {
      error: `No sheet named "${sheet}". Sheets: ${wb.sheets.map((s) => s.name).join(", ")}`,
    };
  const r = parseRange(range);
  if (!r) return { error: `"${range}" is not a valid A1 range (A1 or A1:B2) inside Excel's grid.` };
  const inside: { row: number; col: number; ref: string; c: CellSnap }[] = [];
  let scanned = 0;
  for (const [ref, c] of Object.entries(sh.cells)) {
    if (++scanned > LIMITS.sheetCells) break;
    const p = parseA1(ref);
    if (!p || p.row < r.r1 || p.row > r.r2 || p.col < r.c1 || p.col > r.c2) continue;
    inside.push({ row: p.row, col: p.col, ref: p.ref, c });
  }
  inside.sort((a, b) => a.row - b.row || a.col - b.col);
  const cells = inside.slice(0, LIMITS.readCells).map(({ ref, c }) => ({
    cell: ref,
    v: c.v ?? null,
    ...(c.f ? { f: c.f } : {}),
  }));
  return { sheet, range, cells, truncated: inside.length > cells.length, matched: inside.length };
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
/** Supported Word inline formatting (applied as native formatting on an exact unique anchor). */
export const wordFormatZ = z.object({
  bold: z.boolean().nullable(),
  italic: z.boolean().nullable(),
  underline: z.boolean().nullable(),
  fontSize: z.number().nullable(),
  fontFamily: z.string().nullable(),
});
export const wordEditZ = z.discriminatedUnion("op", [
  z.object({ op: z.literal("replace"), find: z.string(), replace: z.string() }),
  z.object({ op: z.literal("insert_after"), anchor: z.string(), text: z.string() }),
  z.object({ op: z.literal("format"), find: z.string(), format: wordFormatZ }),
]);
export const SHEET_ALIGN = ["left", "center", "right"] as const;
/** Model-facing sheet op: every key present, null when unused (strict structured-output friendly). */
export const sheetOpZ = z.object({
  sheet: z.string(),
  cell: z.string(),
  type: z.enum(["text", "number", "boolean", "formula", "clear", "keep"]),
  value: z.string(),
  numberFormat: z.string().nullable().optional(),
  bold: z.boolean().nullable().optional(),
  fill: z.string().nullable().optional(),
  align: z.enum(SHEET_ALIGN).nullable().optional(),
});
export const proposalZ = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("word"), summary: z.string(), edits: z.array(wordEditZ) }),
  z.object({ kind: z.literal("sheet"), summary: z.string(), ops: z.array(sheetOpZ) }),
]);
/** Same shapes with every key required (nullable) — what the model sees as the tool input schema. */
export const proposalToolZ = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("word"), summary: z.string(), edits: z.array(wordEditZ) }),
  z.object({
    kind: z.literal("sheet"),
    summary: z.string(),
    ops: z.array(
      sheetOpZ.extend({
        numberFormat: z.string().nullable(),
        bold: z.boolean().nullable(),
        fill: z.string().nullable(),
        align: z.enum(SHEET_ALIGN).nullable(),
      }),
    ),
  }),
]);
export type WordFormat = z.infer<typeof wordFormatZ>;
export type WordEdit = z.infer<typeof wordEditZ>;
export type SheetOp = z.infer<typeof sheetOpZ>;
export type Proposal = z.infer<typeof proposalZ>;
export type Validation = { ok: boolean; errors: string[] };

export function editTarget(e: WordEdit) {
  return e.op === "insert_after" ? e.anchor : e.find;
}
export function hasFormat(f: WordFormat) {
  return (
    f.bold != null ||
    f.italic != null ||
    f.underline != null ||
    f.fontSize != null ||
    f.fontFamily != null
  );
}
export function formatSummary(f: WordFormat) {
  const out: string[] = [];
  if (f.bold != null) out.push(f.bold ? "bold" : "not bold");
  if (f.italic != null) out.push(f.italic ? "italic" : "not italic");
  if (f.underline != null) out.push(f.underline ? "underlined" : "no underline");
  if (f.fontSize != null) out.push(`${f.fontSize} pt`);
  if (f.fontFamily != null) out.push(f.fontFamily);
  return out.join(", ");
}
const FONT_FAMILY = /^[A-Za-z0-9 .,'-]{1,64}$/;

/**
 * Every Word edit must target literal text that occurs exactly once; targets may not overlap. Run on
 * the server against the supplied text AND again in the browser against the LIVE document before Apply.
 */
export function validateWordEdits(docText: string, edits: WordEdit[]): Validation {
  const errors: string[] = [];
  if (!Array.isArray(edits) || !edits.length) errors.push("No edits.");
  if (edits.length > LIMITS.wordEdits)
    errors.push(`At most ${LIMITS.wordEdits} edits per proposal.`);
  const spans: [number, number, number][] = [];
  edits.slice(0, LIMITS.wordEdits).forEach((e, i) => {
    const target = editTarget(e);
    const n = i + 1;
    if (typeof target !== "string" || !target.trim())
      return void errors.push(`Edit ${n}: empty anchor.`);
    if (target.length > 4000)
      return void errors.push(`Edit ${n}: anchor longer than 4000 characters.`);
    if (e.op === "insert_after") {
      if (!e.text.trim()) errors.push(`Edit ${n}: nothing to insert.`);
      if (e.text.length > 20_000) errors.push(`Edit ${n}: inserted text over 20,000 characters.`);
    }
    if (e.op === "replace") {
      if (e.replace === target) errors.push(`Edit ${n}: replacement is identical to the original.`);
      if (e.replace.length > 20_000) errors.push(`Edit ${n}: replacement over 20,000 characters.`);
    }
    if (e.op === "format") {
      const f = e.format;
      if (!f || !hasFormat(f)) errors.push(`Edit ${n}: no formatting to apply.`);
      else {
        if (
          f.fontSize != null &&
          (!Number.isFinite(f.fontSize) ||
            f.fontSize < 1 ||
            f.fontSize > 400 ||
            Math.round(f.fontSize * 2) !== f.fontSize * 2)
        )
          errors.push(`Edit ${n}: font size must be 1–400 pt in half-point steps.`);
        if (f.fontFamily != null && !FONT_FAMILY.test(f.fontFamily))
          errors.push(
            `Edit ${n}: font family must be a plain font name (letters, digits, spaces).`,
          );
      }
    }
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

const NUMBER = /^-?(?:\d+)(?:\.\d+)?(?:e[+-]?\d+)?$/i;
const HEX = /^#[0-9a-fA-F]{6}$/;

/** Whole-batch preflight for sheet ops. Any error rejects the batch; nothing is partially applied. */
export function validateSheetOps(sheetNames: string[], ops: SheetOp[]): Validation {
  const errors: string[] = [];
  if (!Array.isArray(ops) || !ops.length) errors.push("No cell operations.");
  if (ops.length > LIMITS.sheetOps) errors.push(`At most ${LIMITS.sheetOps} cells per proposal.`);
  const seen = new Set<string>();
  ops.slice(0, LIMITS.sheetOps).forEach((o, i) => {
    const n = `Op ${i + 1} (${o.sheet}!${o.cell})`;
    if (!sheetNames.includes(o.sheet)) errors.push(`${n}: unknown sheet "${o.sheet}".`);
    const p = parseA1(o.cell);
    if (!p) errors.push(`${n}: not a valid cell inside Excel's grid (max XFD1048576).`);
    else {
      const key = `${o.sheet}!${p.ref}`;
      if (seen.has(key)) errors.push(`${n}: duplicate target.`);
      seen.add(key);
    }
    if (typeof o.value !== "string") return void errors.push(`${n}: value must be a string.`);
    if (o.type === "number") {
      const t = o.value.trim();
      if (!NUMBER.test(t) || !Number.isFinite(Number(t)))
        errors.push(
          `${n}: "${o.value}" is not a finite plain number (no currency symbols or commas).`,
        );
    }
    if (o.type === "formula" && (!o.value.startsWith("=") || o.value.length < 2))
      errors.push(`${n}: formula must start with "=".`);
    if (o.type === "boolean" && !/^(true|false)$/i.test(o.value))
      errors.push(`${n}: boolean must be TRUE or FALSE.`);
    if (o.value.length > 32_767)
      errors.push(`${n}: longer than Excel's 32,767-character cell limit.`);
    if (
      o.numberFormat != null &&
      (o.numberFormat.length > 64 ||
        !o.numberFormat.trim() ||
        [...o.numberFormat].some((ch) => ch.charCodeAt(0) < 32))
    )
      errors.push(`${n}: number format must be 1–64 printable characters.`);
    if (o.fill != null && !HEX.test(o.fill)) errors.push(`${n}: fill must be a #RRGGBB colour.`);
    if (o.align != null && !SHEET_ALIGN.includes(o.align))
      errors.push(`${n}: align must be left, center or right.`);
    if (
      o.type === "keep" &&
      o.numberFormat == null &&
      o.bold == null &&
      o.fill == null &&
      o.align == null
    )
      errors.push(`${n}: "keep" needs at least one format change.`);
  });
  return { ok: errors.length === 0, errors };
}

export function sheetOpHasStyle(o: SheetOp) {
  return o.numberFormat != null || o.bold != null || o.fill != null || o.align != null;
}

/** The literal value a sheet op writes. Text stays text — "00123" is never coerced to 123. */
export function sheetOpValue(o: SheetOp): string | number | boolean | null {
  if (o.type === "clear") return null;
  if (o.type === "number") return Number(o.value);
  if (o.type === "boolean") return /^true$/i.test(o.value);
  return o.value;
}

/**
 * Formula comparison for write verification: function names/refs outside string literals are
 * case-insensitive (engines normalise them), but text inside "…" literals must match exactly.
 */
export function sameFormula(a: string, b: string) {
  const norm = (f: string) =>
    f
      .replace(/^=/, "")
      .split(/("(?:[^"]|"")*")/)
      .map((part, i) => (i % 2 ? part : part.replace(/\s+/g, "").toUpperCase()))
      .join("");
  return norm(a) === norm(b);
}

// ---------- public search hygiene ----------
/**
 * Best-effort reduction of a search phrase before it is sent to a public legal database: strips
 * emails, phone/account-like numbers, dollar amounts and long quoted passages, and caps length. This
 * is NOT a guarantee that confidential names or facts are removed — the tool is optional and the
 * model is instructed to send only public legal terms. Returns null when nothing usable remains.
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

/**
 * Aggregate budget for tool output across one request. Every result is valid JSON. Document-bearing
 * results never take the running total past `total − RESERVE`: oversize results become
 * `{truncated:true, partial:"…"}` sized to fit. The fixed "budget used up" notice (no document data)
 * draws on the reserve.
 */
export class ToolBudget {
  used = 0;
  static RESERVE = 240;
  constructor(readonly total: number) {}
  get left() {
    return Math.max(0, this.total - this.used);
  }
  private charge(s: string) {
    this.used += s.length;
    return s;
  }
  take(value: unknown): string {
    const room = this.left - ToolBudget.RESERVE;
    const exhausted = JSON.stringify({
      error: "Tool output budget for this request is used up. Answer from what you have read.",
    });
    // Refusal notices carry no document data; they draw on the reserve and stop being counted once it is gone.
    if (room <= 0) return this.left >= exhausted.length ? this.charge(exhausted) : exhausted;
    const full = JSON.stringify(value ?? null);
    if (full.length <= room) return this.charge(full);
    const shell = (partial: string) =>
      JSON.stringify({
        truncated: true,
        note: `Result clipped to fit the request's tool budget (${full.length} characters available, ${room} allowed). Narrow the request (smaller range or more specific search).`,
        partial,
      });
    let lo = 0;
    let hi = Math.min(full.length, room);
    let best = shell("");
    if (best.length > room)
      return this.left >= exhausted.length ? this.charge(exhausted) : exhausted;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const cand = shell(full.slice(0, mid));
      if (cand.length <= room) {
        best = cand;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return this.charge(best);
  }
}
