/** Parsing of AI proposals coming back from the drafting panel: the ```draft fence and spreadsheet cell assignments. */

/** Split an answer into the explanation and the proposed text inside the ```draft fence, if present. */
export function splitDraft(answer: string): { proposal: string | null; explanation: string } {
  const re = /```draft[^\n]*\n([\s\S]*?)```/g;
  const blocks: string[] = [];
  const explanation = answer
    .replace(re, (_all, body: string) => {
      blocks.push(body.replace(/\s+$/, ""));
      return "";
    })
    .trim();
  if (!blocks.length) return { proposal: null, explanation: answer };
  return { proposal: blocks.join("\n\n"), explanation };
}

/** One `B12 = =SUM(B2:B11)` / `Deadlines!C4 = 2026-03-31` line from a proposal. */
export type CellAssignment = { sheet?: string; cell: string; value: string };

const CELL_LINE =
  /^\s*(?:[-*]\s*)?(?:`)?(?:(?:'([^']+)'|"([^"]+)"|([A-Za-z0-9_ ]+?))!)?\$?([A-Za-z]{1,3})\$?(\d{1,7})(?:`)?\s*(?::|=|→|->)\s*(.+?)\s*$/;

/** Parse proposal lines into cell assignments; lines that aren't assignments are ignored. */
export function parseCellAssignments(text: string): CellAssignment[] {
  const out: CellAssignment[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = CELL_LINE.exec(raw);
    if (!m) continue;
    const [, q1, q2, bare, col = "", row = "", rhs = ""] = m;
    if (!col || !row) continue;
    let value = rhs.trim();
    // Strip inline-code ticks and a trailing explanation after " — " or " // ".
    value = value
      .replace(/^`([^`]*)`.*$/, "$1")
      .replace(/\s+(?:—|–|\/\/|#)\s.*$/, "")
      .trim();
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    const sheet = (q1 ?? q2 ?? bare)?.trim();
    out.push({ ...(sheet ? { sheet } : {}), cell: `${col.toUpperCase()}${row}`, value });
  }
  return out;
}

export function coerceCellValue(v: string): string | number | boolean | null {
  if (v === "" || /^(blank|empty|null)$/i.test(v)) return null;
  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === "true";
  const n = v.replace(/^\$/, "").replace(/,/g, "");
  if (/^-?\d+(\.\d+)?$/.test(n)) return Number(n);
  if (/^-?\d+(\.\d+)?%$/.test(n)) return Number(n.slice(0, -1)) / 100;
  return v;
}
