import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

// All AI calls live here (auth-protected) and in src/routes/api/assist.ts (streaming chat).
// Helpers (provider, context, logging) are in ai.server.ts and loaded inside handlers only.

export type Effort = "normal" | "advanced";
export type Usage = { inputTokens?: number | undefined; outputTokens?: number | undefined };
type Ctx = { supabase: SupabaseClient<Database>; userId: string };

const effortZ = z.enum(["normal", "advanced"]);
const uuid = z.string().uuid();
const runIdZ = z.string().max(200).optional();

/** Runs an AI step, logs it to ai_runs, and converts any failure into a plain message the UI can show. */
async function runAi<T extends { usage: Usage }>(ctx: Ctx, matterId: string, kind: string, effort: Effort, fn: () => Promise<T>): Promise<T> {
  const { logRun, toAiError } = await import("./ai.server");
  try {
    const r = await fn();
    await logRun(ctx.supabase, ctx.userId, matterId, kind, effort, r.usage);
    return r;
  } catch (e) {
    const err = toAiError(e);
    console.error(`[ai:${kind}]`, err.status ?? "", err.message);
    throw new Error(err.message);
  }
}

const sourced = { why: z.string().describe("One sentence: the reason, plus the exact source text it came from, quoted") };

export const askMatter = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { matterId: string; effort: Effort; question: string; history?: { q: string; a: string }[]; runId?: string }) =>
    z
      .object({
        matterId: uuid,
        effort: effortZ,
        question: z.string().min(1).max(4000),
        history: z.array(z.object({ q: z.string().max(4000), a: z.string().max(20000) })).max(8).optional(),
        runId: runIdZ,
      })
      .parse(d),
  )
  .handler(async ({ data, context }) =>
    runAi(context, data.matterId, "ask", data.effort, async () => {
      const { aiText, matterContext, askInstructions } = await import("./ai.server");
      const ctx = await matterContext(context.supabase, data.matterId, data.effort, data.effort === "advanced");
      const r = await aiText(data.effort, askInstructions(data.effort), `${ctx}\n\nATTORNEY REQUEST:\n${data.question}`, {
        ...(data.history ? { history: data.history } : {}),
        ...(data.runId ? { runId: data.runId } : {}),
      });
      return { text: r.text, usage: r.usage, runId: r.runId };
    }),
  );

export const mapDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { matterId: string; effort: Effort; fileName: string; text: string }) =>
    z.object({ matterId: uuid, effort: effortZ, fileName: z.string().max(300), text: z.string().min(20).max(400000) }).parse(d),
  )
  .handler(async ({ data, context }) =>
    runAi(context, data.matterId, "intake", data.effort, async () => {
      const { aiObject, matterContext } = await import("./ai.server");
      const ctx = await matterContext(context.supabase, data.matterId, data.effort);
      const schema = z.object({
        summary: z.string().describe("Two or three plain sentences on what this document is and where the deal stands"),
        document_type: z.string().describe("e.g. Letter of Intent, Purchase Agreement, Lease, Questionnaire"),
        parties: z.array(z.object({ name: z.string(), role: z.string(), ...sourced })),
        deadlines: z.array(
          z.object({
            title: z.string(),
            due_on: z.string().describe("YYYY-MM-DD. Compute from the document when stated relative to a date in it; otherwise 'unknown'"),
            kind: z.string().describe("Contract, Closing, Filing, Internal, or Client"),
            ...sourced,
          }),
        ),
        tasks: z.array(z.object({ title: z.string(), assignee: z.string().describe("Attorney, Associate, Staff, Client, or Other party"), ...sourced })),
        deliverables: z.array(z.object({ deliverable: z.string(), responsible: z.string().describe("Buyer, Seller, Lender, Title, Escrow, Firm, or a named party"), ...sourced })),
      });
      const cap = data.effort === "advanced" ? 100_000 : 40_000;
      const text = data.text.slice(0, cap);
      const r = await aiObject(
        data.effort,
        "Map this incoming document into a structured plan to get the deal done: key dates/deadlines, follow-up tasks, closing deliverables and parties. Do not over-process: extract only what is actually in the document and is customary to track. Skip items already in the matter. Keep every list short — typically fewer than 10 entries each. Never invent dates; if a deadline has no determinable date, set due_on to 'unknown'.",
        `${ctx}\n\nDOCUMENT "${data.fileName}"${text.length < data.text.length ? " (truncated)" : ""}:\n${text}`,
        schema,
      );
      return { ...r.output, usage: r.usage, runId: r.runId, truncated: text.length < data.text.length };
    }),
  );

export const processMeetingNotes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { matterId: string; effort: Effort; notes: string }) =>
    z.object({ matterId: uuid, effort: effortZ, notes: z.string().min(5).max(40000) }).parse(d),
  )
  .handler(async ({ data, context }) =>
    runAi(context, data.matterId, "meeting", data.effort, async () => {
      const { aiObject, matterContext } = await import("./ai.server");
      const ctx = await matterContext(context.supabase, data.matterId, data.effort);
      const schema = z.object({
        title: z.string().describe("Short memo title, e.g. 'Call with seller's counsel — closing timing'"),
        summary: z.string().describe("Clean meeting memo in markdown: attendees if known, discussion, decisions, open questions"),
        tasks: z.array(z.object({ title: z.string(), assignee: z.string().describe("Attorney, Associate, Staff, Client, or Other party"), ...sourced })),
      });
      const r = await aiObject(
        data.effort,
        "Turn rough meeting notes into a clean memo for the file plus follow-up tasks. Keep the attorney's wording where possible; do not add content that wasn't discussed. Keep the task list short (usually under 8).",
        `${ctx}\n\nROUGH NOTES:\n${data.notes}`,
        schema,
      );
      return { ...r.output, usage: r.usage, runId: r.runId };
    }),
  );

export const draftClosingChecklist = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { matterId: string; effort: Effort }) => z.object({ matterId: uuid, effort: effortZ }).parse(d))
  .handler(async ({ data, context }) =>
    runAi(context, data.matterId, "closing", data.effort, async () => {
      const { aiObject, matterContext } = await import("./ai.server");
      const ctx = await matterContext(context.supabase, data.matterId, data.effort, true);
      const schema = z.object({
        items: z.array(z.object({ deliverable: z.string(), responsible: z.string().describe("Buyer, Seller, Lender, Title, Escrow, Firm, or a named party"), ...sourced })),
      });
      const r = await aiObject(
        data.effort,
        "Propose a customary closing checklist for this matter type: documents, consents, certificates, filings, funds flow. Use the matter's documents where available; otherwise the standard items for this kind of deal. Do not repeat items already on the checklist. Keep it to what a boutique firm actually tracks — usually 8 to 20 items.",
        ctx,
        schema,
      );
      return { ...r.output, usage: r.usage, runId: r.runId };
    }),
  );

export const suggestTemplateAnswers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { matterId: string; effort: Effort; fields: string[] }) =>
    z.object({ matterId: uuid, effort: effortZ, fields: z.array(z.string().max(200)).max(80) }).parse(d),
  )
  .handler(async ({ data, context }) =>
    runAi(context, data.matterId, "draft_fill", data.effort, async () => {
      const { aiObject, matterContext } = await import("./ai.server");
      const ctx = await matterContext(context.supabase, data.matterId, data.effort, true);
      const schema = z.object({
        answers: z.array(z.object({ field: z.string().describe("The blank's name exactly as given"), value: z.string().describe("Empty string if the matter does not say"), ...sourced })),
      });
      const r = await aiObject(
        data.effort,
        "Fill the blanks of the firm's house template using only facts in the matter (its summary, notes, contacts and documents). Give each value exactly as it should read inside the blank — e.g. '$4,250,000', 'December 15, 2026', 'Brightwater Holdings LLC' — with no commentary, qualifiers or parentheticals. Never guess: leave value as an empty string when the matter does not say. Return one answer per blank, in the order given.",
        `${ctx}\n\nTEMPLATE BLANKS:\n${data.fields.map((f) => `- ${f}`).join("\n")}`,
        schema,
      );
      return { ...r.output, usage: r.usage, runId: r.runId };
    }),
  );

export const suggestDraftEdits = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { matterId: string; effort: Effort; body: string; instruction: string }) =>
    z.object({ matterId: uuid, effort: effortZ, body: z.string().min(10).max(100000), instruction: z.string().max(2000) }).parse(d),
  )
  .handler(async ({ data, context }) =>
    runAi(context, data.matterId, "draft_edit", data.effort, async () => {
      const { aiObject, matterContext } = await import("./ai.server");
      const ctx = await matterContext(context.supabase, data.matterId, data.effort);
      const schema = z.object({
        edits: z.array(
          z.object({
            original: z.string().describe("Exact verbatim text copied from the draft (a phrase or sentence), to be replaced"),
            suggested: z.string().describe("The replacement text"),
            reason: z.string().describe("Why, citing the matter fact or instruction that calls for it"),
          }),
        ),
      });
      const r = await aiObject(
        data.effort,
        "This draft is based on the firm's house template. Preserve the house form: suggest only targeted, minimal edits needed for this deal (or the attorney's instruction). Never restructure or rewrite whole sections. 'original' must be copied character-for-character from the draft so it can be located. Usually fewer than 8 edits; return an empty list if nothing needs changing.",
        `${ctx}\n\nATTORNEY INSTRUCTION: ${data.instruction || "Tailor to this matter where clearly needed."}\n\nDRAFT:\n${data.body}`,
        schema,
      );
      return { ...r.output, usage: r.usage, runId: r.runId };
    }),
  );
