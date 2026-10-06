// Server-only Lovable AI Gateway helpers. Never import from client code.
import { createOpenAI } from "@ai-sdk/openai";
import { streamText, Output, NoObjectGeneratedError, APICallError } from "ai";
import type { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export type Effort = "normal" | "advanced";
export type Usage = { inputTokens?: number | undefined; outputTokens?: number | undefined };
export type Turn = { q: string; a: string };

const MODEL = "openai/gpt-6-astra";
const GATEWAY = "https://ai.gateway.lovable.dev/v1";
const RUN_ID = "X-Lovable-AIG-Run-ID";

/** A failure the UI can show verbatim. `retryable` tells the UI whether "try again" makes sense. */
export class AiError extends Error {
  status: number | undefined;
  retryable: boolean;
  constructor(message: string, status?: number, retryable = false) {
    super(message);
    this.name = "AiError";
    this.status = status;
    this.retryable = retryable;
  }
}

function safeMessageFromBody(body: string | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const j = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    const m = typeof j.error === "string" ? j.error : (j.error?.message ?? j.message);
    return typeof m === "string" && m.length < 400 ? m : undefined;
  } catch {
    return undefined;
  }
}

/** Gateway status → message an attorney can act on (see ai-gateway-error-semantics). */
export function describeStatus(
  status: number,
  upstream?: string,
): { message: string; retryable: boolean } {
  switch (status) {
    case 400:
      return {
        message:
          "The request was too large or malformed for the model. Try a shorter document or question.",
        retryable: false,
      };
    case 401:
      return {
        message:
          "Lovable AI isn't configured for this workspace. Ask your administrator to check the AI key.",
        retryable: false,
      };
    case 402:
      return {
        message:
          upstream ??
          "Your workspace is out of AI credits. Add credits in Settings → Plans & credits, then try again.",
        retryable: false,
      };
    case 403:
      return {
        message:
          upstream ??
          "AI access is blocked for this workspace. A workspace admin can review the AI limit in workspace settings.",
        retryable: false,
      };
    case 404:
      return { message: "The AI model isn't available right now.", retryable: false };
    case 429:
      return {
        message: "AI is busy right now. Please wait a moment and try again.",
        retryable: true,
      };
    default:
      return status >= 500
        ? {
            message: "The AI service had a temporary problem. Please try again in a minute.",
            retryable: true,
          }
        : { message: upstream ?? `AI request failed (${status}).`, retryable: false };
  }
}

/** Turn any thrown value from the SDK into an AiError with a safe message. */
export function toAiError(e: unknown): AiError {
  if (e instanceof AiError) return e;
  if (APICallError.isInstance(e)) {
    const status = e.statusCode ?? 0;
    const d = describeStatus(status, safeMessageFromBody(e.responseBody));
    return new AiError(d.message, status, d.retryable);
  }
  if (NoObjectGeneratedError.isInstance(e))
    return new AiError(
      "The AI answer couldn't be read as a structured result. Please try again.",
      undefined,
      true,
    );
  if (e instanceof Error) {
    if (e.name === "AbortError") return new AiError("Stopped.", 499, false);
    if (/credits/i.test(e.message)) return new AiError(e.message, 402, false);
    return new AiError(e.message || "AI request failed.", undefined, false);
  }
  return new AiError("AI request failed.", undefined, false);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch wrapper for the gateway: reuses the run ID across follow-ups, applies a bounded
 * backoff on 429/5xx only (never on other statuses, never on cancellation), and converts
 * terminal statuses into AiError before the SDK sees them.
 */
function gatewayFetch(ref: { runId: string | undefined }): typeof fetch {
  return async (input, init) => {
    const MAX_RETRIES = 2;
    for (let attempt = 0; ; attempt++) {
      const headers = new Headers(init?.headers);
      if (ref.runId && !headers.has(RUN_ID)) headers.set(RUN_ID, ref.runId);
      const res = await fetch(input, { ...init, headers });
      ref.runId ??= res.headers.get(RUN_ID)?.trim() || undefined;
      if (res.ok) return res;

      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < MAX_RETRIES && !init?.signal?.aborted) {
        const ra = Number(res.headers.get("Retry-After"));
        const base = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1500 * 2 ** attempt;
        await res.body?.cancel().catch(() => undefined);
        await sleep(Math.min(base + Math.random() * 500, 10_000));
        continue;
      }
      const body = await res.text().catch(() => "");
      const d = describeStatus(res.status, safeMessageFromBody(body));
      throw new AiError(d.message, res.status, d.retryable);
    }
  };
}

function provider(runId?: string) {
  const apiKey = process.env["LOVABLE_API_KEY"];
  if (!apiKey) throw new AiError("Lovable AI isn't configured for this workspace.", 401);
  const ref = { runId: runId?.trim() || undefined };
  const openai = createOpenAI({
    baseURL: GATEWAY,
    apiKey,
    headers: { "Lovable-API-Key": apiKey, "X-Lovable-AIG-SDK": "vercel-ai-sdk" },
    fetch: gatewayFetch(ref),
  });
  return { model: openai.responses(MODEL), getRunId: () => ref.runId };
}

export const BASE_INSTRUCTIONS = `You are Mirza Assist, a support tool inside a boutique transactional law firm's matter-management system.
You work like a careful associate or paralegal: you prepare, organize and flag; the attorney decides.
Rules:
- Stay strictly within the matter context provided. Do not invent facts, parties, dates or numbers. If something is unknown, say "unknown" rather than guessing.
- Prefer what is customary and routine. Do not over-complicate standard transactions.
- Be concise and plain. No legal conclusions presented as final advice. Tax points are flags for the attorney's awareness only, never advice.
- When you point something out, briefly say why and quote or reference the source text so the attorney can verify it.`;

function opts(effort: Effort) {
  return {
    openai: {
      forceReasoning: true,
      reasoningEffort: effort === "advanced" ? "high" : "low",
      reasoningSummary: "auto",
      store: false,
      include: ["reasoning.encrypted_content"],
    },
  } as const;
}

function normalizeUsage(
  u: { inputTokens?: number | undefined; outputTokens?: number | undefined } | undefined,
): Usage {
  return { inputTokens: u?.inputTokens ?? undefined, outputTokens: u?.outputTokens ?? undefined };
}

function messages(prompt: string, history: Turn[] | undefined) {
  const prior = (history ?? []).slice(-6).flatMap((t) => [
    { role: "user" as const, content: t.q },
    { role: "assistant" as const, content: t.a },
  ]);
  return [...prior, { role: "user" as const, content: prompt }];
}

/** Start a streaming text call. Caller consumes `result` (textStream / text / usage). */
export function aiStream(
  effort: Effort,
  instructions: string,
  prompt: string,
  o: { history?: Turn[]; runId?: string; signal?: AbortSignal } = {},
) {
  const p = provider(o.runId);
  const result = streamText({
    model: p.model,
    system: `${BASE_INSTRUCTIONS}\n\n${instructions}`,
    messages: messages(prompt, o.history),
    providerOptions: opts(effort) as never,
    maxRetries: 0,
    ...(o.signal ? { abortSignal: o.signal } : {}),
  });
  return { result, getRunId: p.getRunId };
}

/** Full text answer (streamed from the gateway, returned whole). */
export async function aiText(
  effort: Effort,
  instructions: string,
  prompt: string,
  o: { history?: Turn[]; runId?: string } = {},
) {
  const { result, getRunId } = aiStream(effort, instructions, prompt, o);
  try {
    const text = await result.text;
    const usage = normalizeUsage(await result.usage);
    return { text, usage, runId: getRunId() };
  } catch (e) {
    throw toAiError(e);
  }
}

function stripFences(s: string) {
  return s
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
}

/** Structured answer against a strict schema, with a raw-text fallback if the SDK can't parse it. */
export async function aiObject<T extends z.ZodTypeAny>(
  effort: Effort,
  instructions: string,
  prompt: string,
  schema: T,
  o: { runId?: string } = {},
): Promise<{ output: z.infer<T>; usage: Usage; runId: string | undefined }> {
  const p = provider(o.runId);
  const result = streamText({
    model: p.model,
    system: `${BASE_INSTRUCTIONS}\n\n${instructions}\n\nAnswer with JSON only, matching the requested schema exactly.`,
    prompt,
    output: Output.object({ schema }),
    providerOptions: opts(effort) as never,
    maxRetries: 0,
  });
  try {
    const output = await result.output;
    return { output, usage: normalizeUsage(await result.usage), runId: p.getRunId() };
  } catch (e) {
    const err = toAiError(e);
    if (!NoObjectGeneratedError.isInstance(e)) throw err;
    // Fallback: the model answered but the SDK couldn't parse it — try the raw text ourselves.
    const text = await Promise.resolve(result.text).catch(() => "");
    const parsed = schema.safeParse(
      (() => {
        try {
          return JSON.parse(stripFences(text));
        } catch {
          return undefined;
        }
      })(),
    );
    const usage = await Promise.resolve(result.usage).catch(() => undefined);
    if (parsed.success)
      return { output: parsed.data, usage: normalizeUsage(usage), runId: p.getRunId() };
    throw err;
  }
}

// ---------- Matter context + run logging (shared by server fns and the streaming route) ----------

type DB = SupabaseClient<Database>;

const DOC_CHARS_PER_FILE = 12_000;
const DOC_CHARS_TOTAL: Record<Effort, number> = { normal: 30_000, advanced: 90_000 };

/** One round trip: the matter plus its lists, rendered as plain text for the model. */
export async function matterContext(
  supabase: DB,
  matterId: string,
  effort: Effort,
  includeDocs = false,
) {
  const { data: m, error } = await supabase
    .from("matters")
    .select(
      "number,title,client,practice_area,status,summary,responsible,opened_on,tasks(title,assignee,due_on,done),deadlines(title,due_on,kind),notes(title,body,created_at),closing_items(deliverable,responsible,status,due_on,position),files(name,doc_type,extracted_text,created_at),matter_properties(*)",
    )
    .eq("id", matterId)
    .order("created_at", { referencedTable: "notes", ascending: false })
    .limit(6, { referencedTable: "notes" })
    .order("due_on", { referencedTable: "deadlines", ascending: true })
    .order("position", { referencedTable: "closing_items", ascending: true })
    .order("created_at", { referencedTable: "files", ascending: false })
    .limit(10, { referencedTable: "files" })
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!m) throw new Error("Matter not found");

  let budget = DOC_CHARS_TOTAL[effort];
  const docs = m.files
    .map((f) => {
      const tag = f.doc_type ? ` [${f.doc_type.replace(/_/g, " ")}]` : "";
      if (!includeDocs || !f.extracted_text || budget <= 0)
        return `- ${f.name}${tag}${f.extracted_text ? "" : " (no readable text)"}`;
      const slice = f.extracted_text.slice(0, Math.min(DOC_CHARS_PER_FILE, budget));
      budget -= slice.length;
      return `--- ${f.name}${tag} ---\n${slice}${slice.length < f.extracted_text.length ? "\n[…truncated]" : ""}`;
    })
    .join("\n");

  const line = (s: string[]) => s.join("\n") || "none";
  const prop = Array.isArray(m.matter_properties) ? m.matter_properties[0] : m.matter_properties;
  const property = prop ? propertyLine(prop) : "";
  return `MATTER ${m.number ?? ""}: ${m.title}
Client: ${m.client ?? "—"} | Practice: ${m.practice_area} | Status: ${m.status} | Responsible: ${m.responsible ?? "—"} | Opened: ${m.opened_on ?? "—"} | Today: ${new Date().toISOString().slice(0, 10)}
Summary: ${m.summary ?? "—"}${property ? `\n${property}` : ""}
Tasks:
${line(m.tasks.map((x) => `- [${x.done ? "x" : " "}] ${x.title} (${x.assignee ?? "unassigned"}, due ${x.due_on ?? "—"})`))}
Deadlines:
${line(m.deadlines.map((x) => `- ${x.due_on}: ${x.title} (${x.kind ?? "Deadline"})`))}
Closing checklist:
${line(m.closing_items.map((x) => `- ${x.deliverable} — ${x.responsible ?? "?"} — ${x.status}${x.due_on ? ` (due ${x.due_on})` : ""}`))}
Recent notes:
${line(m.notes.map((x) => `- ${x.title ?? "Note"} (${x.created_at.slice(0, 10)}): ${x.body.slice(0, 600)}`))}
Files:
${docs || "none"}`;
}

/** One-line property/deal record for prompts (Real Estate matters). Flags are spelled out so the model need not guess. */
export function propertyLine(p: {
  address: string | null; city: string | null; state: string; zip: string | null; pin: string | null; property_type: string; county: string; in_chicago: boolean;
  side: string; purchase_price: number | null; earnest_money: number | null; loan_amount: number | null; lender: string | null; acceptance_date: string | null; closing_date: string | null;
  title_company: string | null; survey_date: string | null; last_tax_bill: number | null; tax_year: number | null; flags: unknown; notes: string | null;
}) {
  const flags = (p.flags ?? {}) as Record<string, boolean>;
  const on = Object.entries(flags).filter(([, v]) => v).map(([k]) => k);
  return `Property (deal record): ${[p.address, p.city, p.state, p.zip].filter(Boolean).join(", ") || "address not entered"} | PIN ${p.pin ?? "—"} | ${p.property_type} | ${p.county} County${p.in_chicago ? ", City of Chicago" : ""} | Our side: ${p.side} | Price ${p.purchase_price ?? "—"} | Earnest ${p.earnest_money ?? "—"} | Loan ${p.loan_amount ?? "—"}${p.lender ? ` (${p.lender})` : ""} | Accepted ${p.acceptance_date ?? "—"} | Closing ${p.closing_date ?? "—"} | Title co. ${p.title_company ?? "—"} | Survey ${p.survey_date ?? "—"} | Last tax bill ${p.last_tax_bill ?? "—"}${p.tax_year ? ` (${p.tax_year})` : ""} | Flags: ${on.length ? on.join(", ") : "none"}${p.notes ? ` | Notes: ${p.notes.slice(0, 300)}` : ""}`;
}

export async function logRun(
  supabase: DB,
  userId: string,
  matterId: string | null,
  kind: string,
  effort: Effort,
  usage: Usage,
) {
  const { error } = await supabase.from("ai_runs").insert({
    matter_id: matterId,
    user_id: userId,
    kind,
    effort,
    input_tokens: usage.inputTokens ?? null,
    output_tokens: usage.outputTokens ?? null,
  });
  if (error) console.error("[ai_runs] failed to log run:", error.message);
}

export function askInstructions(effort: Effort) {
  return effort === "advanced"
    ? "Advanced effort: analyze carefully, flag issues and risks, and cite which part of the matter or document supports each point. When SOURCES are provided, ground legal points in them: cite the tag like [S2] right after the sentence and quote the operative words. Never cite a tag that was not provided and never state a rule you cannot support from the sources or the matter. End with a short 'For your review:' list naming what the attorney should check personally."
    : "Normal effort: practical case-management help. Keep it short and concrete. When SOURCES are provided and relevant, cite the tag like [S1] after the sentence; do not invent citations. End with one line 'For your review:' naming what to double-check.";
}

/**
 * Drafting assistant inside the Office editors. The attorney has a document open; the model
 * proposes text the attorney inserts or replaces by hand (tracked changes), so output must be
 * clean, insertable prose in the document's own voice.
 */
export function draftInstructions(effort: Effort, kind: "docx" | "pdf" | "xlsx" | "text") {
  const common = `You are working alongside the attorney inside an open ${kind === "xlsx" ? "spreadsheet" : kind === "pdf" ? "PDF" : "document"} (OPEN DOCUMENT below; SELECTION is the text the attorney has highlighted, if any).
Drafting rules:
- When asked to draft, rewrite, tighten or add language, answer with the proposed text itself inside a single fenced block marked \`\`\`draft so it can be inserted verbatim. Put any explanation outside the block, in one or two short lines.
- Match the document's defined terms, numbering, tense, party names and tone exactly. Reuse the firm's wording from the open document and house templates rather than inventing new styles.
- Never invent facts, dates, amounts or party details. Where a fact is unknown, leave a blank in the form [[Field Name]].
- Keep proposals as small as the request allows: a clause, a sentence, a paragraph — not a rewrite of the whole document unless asked.
- When SOURCES are provided and a point of law matters, cite the tag like [S1] after the sentence (outside the draft block) and quote the operative words; never cite a tag that was not provided.
- For questions (not drafting), answer plainly from the open document and the matter; quote the passage you rely on.`;
  const sheet = kind === "xlsx" ? `\n- For spreadsheet work, put proposed cell values or formulas inside the draft block one per line as A1-style assignments, e.g. \`B12 = =SUM(B2:B11)\` or \`Deadlines!C4 = 2026-03-31\`; use the sheet name only when the cell is not on the active sheet, write formulas with a leading =, and put reasoning outside the block. The OPEN DOCUMENT lists each sheet by name with its cells.` : "";
  const effortLine = effort === "advanced" ? "\nAdvanced effort: check the proposal against the rest of the document for conflicts (defined terms, cross-references, inconsistent dates or amounts) and list anything the attorney should reconcile under 'For your review:'." : "\nNormal effort: be quick and concrete; end with one line 'For your review:'.";
  return common + sheet + effortLine;
}

// ---------- law-library grounding ----------

export type SourceMeta = { ref: string; authority_id: string; citation: string; title: string; url: string; version: string | null };

export async function pinnedAuthorityIds(supabase: DB, matterId: string) {
  const { data } = await supabase.from("matter_authorities").select("authority_id").eq("matter_id", matterId);
  return (data ?? []).map((r) => r.authority_id);
}

const SOURCE_BUDGET: Record<Effort, number> = { normal: 9_000, advanced: 26_000 };

/**
 * Library passages for a matter question: pinned sources first (they are the attorney's chosen
 * authorities), then the practice area's topic. Returns the prompt block plus metadata for the UI.
 */
export async function matterSources(
  supabase: DB,
  matterId: string,
  practiceArea: string | undefined,
  queries: string[],
  effort: Effort,
  o: { budget?: number; topic?: string } = {},
) {
  const budget = o.budget ?? SOURCE_BUDGET[effort];
  const { libraryPassages, renderPassages } = await import("./library.server");
  const topicByPractice: Record<string, string> = {
    "Real Estate": "real_estate",
    Corporate: "entity",
    "Estate Planning": "estate_planning",
    Finance: "finance",
    Compliance: "compliance",
  };
  if (!practiceArea) {
    const { data } = await supabase.from("matters").select("practice_area").eq("id", matterId).maybeSingle();
    practiceArea = data?.practice_area ?? "";
  }
  const pinned = await pinnedAuthorityIds(supabase, matterId);
  const qs = queries.map((q) => q.trim()).filter((q) => q.length >= 3).slice(0, 10);
  let passages = pinned.length ? await libraryPassages(supabase, qs, { ids: pinned, charBudget: Math.round(budget * 0.6), perQuery: 4 }) : [];
  const remaining = budget - passages.reduce((n, p) => n + p.body.length, 0);
  if (remaining > 1500) {
    const topic = o.topic ?? topicByPractice[practiceArea];
    const more = await libraryPassages(supabase, qs, { ...(topic ? { topic } : {}), charBudget: remaining, perQuery: 4 });
    const seen = new Set(passages.map((p) => `${p.authority_id}:${p.heading ?? ""}:${p.body.slice(0, 40)}`));
    for (const p of more) {
      const k = `${p.authority_id}:${p.heading ?? ""}:${p.body.slice(0, 40)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      passages.push({ ...p, ref: `S${passages.length + 1}` });
    }
  }
  passages = passages.map((p, i) => ({ ...p, ref: `S${i + 1}` }));
  const meta: SourceMeta[] = passages.map((p) => ({ ref: p.ref, authority_id: p.authority_id, citation: p.citation, title: p.title, url: p.url, version: p.version }));
  return { block: renderPassages(passages), passages, meta };
}

/** Turn a free-text question into a few search queries (cheap heuristics, no AI call). */
export function queriesFromText(text: string, extra: string[] = []) {
  const stop = new Set("the a an and or of to in on for with by from at as is are be this that it its our their we you they what how when which who does do did can should would could will about into than then there here also any all some such per".split(" "));
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9§.\-\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stop.has(w));
  const uniq = [...new Set(words)];
  const main = uniq.slice(0, 8).join(" ");
  const cites = [...text.matchAll(/\b\d+\s?(?:CFR|U\.?S\.?C\.?|ILCS)\s?§?\s?[\d.()a-z-]+/gi)].map((m) => m[0]);
  return [...cites, main, ...extra].filter(Boolean).slice(0, 8);
}
