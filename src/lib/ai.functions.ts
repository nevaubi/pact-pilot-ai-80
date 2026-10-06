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
async function runAi<T extends { usage: Usage }>(
  ctx: Ctx,
  matterId: string,
  kind: string,
  effort: Effort,
  fn: () => Promise<T>,
): Promise<T> {
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

const sourced = {
  why: z
    .string()
    .describe("One sentence: the reason, plus the exact source text it came from, quoted"),
};

export const askMatter = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      matterId: string;
      effort: Effort;
      question: string;
      history?: { q: string; a: string }[];
      runId?: string;
    }) =>
      z
        .object({
          matterId: uuid,
          effort: effortZ,
          question: z.string().min(1).max(4000),
          history: z
            .array(z.object({ q: z.string().max(4000), a: z.string().max(20000) }))
            .max(8)
            .optional(),
          runId: runIdZ,
        })
        .parse(d),
  )
  .handler(async ({ data, context }) =>
    runAi(context, data.matterId, "ask", data.effort, async () => {
      const { aiText, matterContext, askInstructions, matterSources, queriesFromText } = await import("./ai.server");
      const ctx = await matterContext(
        context.supabase,
        data.matterId,
        data.effort,
        data.effort === "advanced",
      );
      const src = await matterSources(context.supabase, data.matterId, undefined, queriesFromText(data.question), data.effort).catch(() => null);
      const r = await aiText(
        data.effort,
        askInstructions(data.effort),
        `${ctx}\n\n${src?.block ?? ""}\n\nATTORNEY REQUEST:\n${data.question}`,
        {
          ...(data.history ? { history: data.history } : {}),
          ...(data.runId ? { runId: data.runId } : {}),
        },
      );
      return { text: r.text, usage: r.usage, runId: r.runId, sources: src?.meta ?? [] };
    }),
  );

// ---------- Tax red-flag checker (flags only — never advice) ----------

const TAX_QUERIES: Record<string, string[]> = {
  "Real Estate": [
    "withholding disposition United States real property interest foreign person transferee",
    "certification non-foreign status residence exception 300,000",
    "information return real estate transaction reporting person 1099-S",
    "like-kind exchange identification period 45 days exchange period 180 days",
    "exclusion gain sale principal residence ownership use two years",
    "real estate transfer tax declaration rate per $500 exemption",
    "installment sale method payments year of sale",
    "residential real estate transfer report legal entity trust non-financed",
    "homestead exemption property tax installment due",
  ],
  Corporate: [
    "entity classification election Form 8832 default classification",
    "election by small business corporation timing 2 months 15 days",
    "election to include in gross income year of transfer 30 days section 83(b)",
    "allocation of consideration asset acquisition residual method Form 8594",
    "qualified small business stock five year holding period original issuance",
    "transfer to corporation controlled by transferor 80 percent nonrecognition",
    "pass-through entity withholding nonresident partners Illinois",
    "bulk sale notice successor liability Illinois Department of Revenue",
    "annual report due date limited liability company anniversary month",
  ],
  "Estate Planning": [
    "basic exclusion amount estate tax year decedent dies",
    "annual exclusion gifts present interest",
    "portability deceased spousal unused exclusion election timely filed return",
    "Illinois estate tax exclusion amount 4,000,000 tentative taxable estate",
    "basis of property acquired from a decedent fair market value",
    "marital deduction qualified terminable interest property election",
    "gift tax return required Form 709 gift splitting",
  ],
  Finance: [
    "installment method payments year of sale interest",
    "net investment income tax threshold",
    "accredited investor definition natural person income net worth",
    "original issue discount imputed interest below market loans",
    "allocation of consideration asset acquisition residual method",
  ],
  Compliance: [
    "penalties and interest late filing late payment Illinois",
    "withholding income tax payment filing requirements Illinois",
    "beneficial ownership information reporting company exemption domestic",
    "annual report due date limited liability company anniversary month",
    "financing statement effectiveness five years continuation statement",
  ],
};

export const taxFlags = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { matterId: string; effort: Effort; focus?: string }) =>
    z.object({ matterId: uuid, effort: effortZ, focus: z.string().max(1000).optional() }).parse(d),
  )
  .handler(async ({ data, context }) =>
    runAi(context, data.matterId, "tax", data.effort, async () => {
      const { aiObject, matterContext, matterSources } = await import("./ai.server");
      const { quoteVerified } = await import("./library.server");
      const { data: m, error: mErr } = await context.supabase
        .from("matters")
        .select("practice_area,title")
        .eq("id", data.matterId)
        .maybeSingle();
      if (mErr) throw new Error(mErr.message);
      if (!m) throw new Error("Matter not found");
      const ctx = await matterContext(context.supabase, data.matterId, data.effort, true);
      const usage = { inputTokens: 0, outputTokens: 0 };
      const addUsage = (u: Usage) => {
        usage.inputTokens += u.inputTokens ?? 0;
        usage.outputTokens += u.outputTokens ?? 0;
      };

      // Which law to pull: customary issues for the practice area, the attorney's focus, and (Advanced) the model's own issue list.
      let queries = [...(data.focus ? [data.focus] : []), ...(TAX_QUERIES[m.practice_area] ?? TAX_QUERIES["Compliance"]!)];
      let runId: string | undefined;
      if (data.effort === "advanced") {
        const plan = await aiObject(
          "normal",
          "You are issue-spotting for a tax red-flag review. From the matter facts, list the specific tax questions a careful associate would check, as short search queries into a library of statutes, regulations and IRS/Illinois guidance (e.g. 'withholding foreign seller real property', 'S election deadline new corporation'). Only questions that the facts actually raise. 3 to 8 queries.",
          ctx.slice(0, 24_000),
          z.object({ queries: z.array(z.string().max(120)).max(8) }),
        );
        addUsage(plan.usage);
        runId = plan.runId;
        queries = [...plan.output.queries, ...queries];
      }
      const src = await matterSources(context.supabase, data.matterId, m.practice_area, queries, data.effort, {
        budget: data.effort === "advanced" ? 30_000 : 12_000,
        topic: "tax",
      });

      const schema = z.object({
        flags: z.array(
          z.object({
            title: z.string().describe("Short flag title, e.g. 'FIRPTA withholding — seller may be a foreign person'"),
            severity: z.enum(["high", "medium", "low"]).describe("high = money or a deadline at closing; medium = filing or election to confirm; low = awareness"),
            issue: z.string().describe("One to three plain sentences: what the question is and why it comes up on these facts"),
            matter_facts: z.string().describe("The matter facts that trigger it, quoted or closely paraphrased from the matter context; 'not stated' if inferred"),
            basis_ref: z.string().describe("The source tag that supports the flag, e.g. S3. Empty string if no provided source supports it"),
            basis_quote: z.string().describe("One or two sentences copied character-for-character from that source. Empty string if basis_ref is empty"),
            next_step: z.string().describe("The concrete next step for the attorney: a question to ask, a form to calendar, a person to involve. Never a tax conclusion"),
            for_cpa: z.boolean().describe("true when the point should go to the client's CPA or tax counsel"),
          }),
        ),
        clear: z.array(z.string()).describe("Areas you checked that raise no flag on these facts, one short line each"),
        note: z.string().describe("One or two sentences on coverage: what the sources did and did not cover, and what facts are missing"),
      });
      const r = await aiObject(
        data.effort,
        `You prepare a TAX RED-FLAG LIST for a transactional attorney who is not a CPA and may not give tax advice.
Rules:
- Flags only. Each flag names a question to raise, who should answer it, and the deadline or form involved. Never compute a liability, never say what the client "should" elect, never conclude.
- Ground every flag in the SOURCES: set basis_ref to the tag and copy basis_quote verbatim from that source. If no provided source supports a flag you still think matters, keep it with an empty basis_ref and say so in next_step ("no source in library — confirm").
- Use only the matter facts given. If a fact is unknown (e.g. whether the seller is foreign), the flag is "confirm whether…", not an assumption.
- Customary issues first; do not pad. Usually 3 to 9 flags. Order by severity.
- The attorney's focus, when given, must be addressed first.`,
        `${ctx}\n\n${src.block}\n\n${data.focus ? `ATTORNEY FOCUS: ${data.focus}\n\n` : ""}Prepare the tax red-flag list.`,
        schema,
        runId ? { runId } : {},
      );
      addUsage(r.usage);

      const flags = r.output.flags.map((f) => {
        const ref = f.basis_ref.replace(/[[\]\s]/g, "");
        const s = src.meta.find((x) => x.ref === ref);
        return {
          ...f,
          basis_ref: s ? ref : "",
          basis: s ? { citation: s.citation, title: s.title, url: s.url, version: s.version, authority_id: s.authority_id } : null,
          verified: s ? quoteVerified(src.passages, ref, f.basis_quote) : false,
        };
      });
      const result = { flags, clear: r.output.clear, note: r.output.note, sources: src.meta, focus: data.focus ?? null };
      const { data: review, error } = await context.supabase
        .from("reviews")
        .insert({
          matter_id: data.matterId,
          kind: "tax",
          title: `Tax red flags — ${new Date().toISOString().slice(0, 10)}${data.focus ? ` — ${data.focus.slice(0, 60)}` : ""}`,
          effort: data.effort,
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          result,
          authority_ids: [...new Set(src.meta.map((s) => s.authority_id))],
          created_by: context.userId,
        })
        .select("id,created_at")
        .single();
      if (error) throw new Error(error.message);
      return { reviewId: review.id, createdAt: review.created_at, ...result, usage, runId: r.runId };
    }),
  );

export const mapDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { matterId: string; effort: Effort; fileName: string; text: string }) =>
    z
      .object({
        matterId: uuid,
        effort: effortZ,
        fileName: z.string().max(300),
        text: z.string().min(20).max(400000),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) =>
    runAi(context, data.matterId, "intake", data.effort, async () => {
      const { aiObject, matterContext } = await import("./ai.server");
      const ctx = await matterContext(context.supabase, data.matterId, data.effort);
      const schema = z.object({
        summary: z
          .string()
          .describe(
            "Two or three plain sentences on what this document is and where the deal stands",
          ),
        document_type: z
          .string()
          .describe("e.g. Letter of Intent, Purchase Agreement, Lease, Questionnaire"),
        parties: z.array(z.object({ name: z.string(), role: z.string(), ...sourced })),
        deadlines: z.array(
          z.object({
            title: z.string(),
            due_on: z
              .string()
              .describe(
                "YYYY-MM-DD. Compute from the document when stated relative to a date in it; otherwise 'unknown'",
              ),
            kind: z.string().describe("Contract, Closing, Filing, Internal, or Client"),
            ...sourced,
          }),
        ),
        tasks: z.array(
          z.object({
            title: z.string(),
            assignee: z.string().describe("Attorney, Associate, Staff, Client, or Other party"),
            ...sourced,
          }),
        ),
        deliverables: z.array(
          z.object({
            deliverable: z.string(),
            responsible: z
              .string()
              .describe("Buyer, Seller, Lender, Title, Escrow, Firm, or a named party"),
            ...sourced,
          }),
        ),
      });
      const cap = data.effort === "advanced" ? 100_000 : 40_000;
      const text = data.text.slice(0, cap);
      const r = await aiObject(
        data.effort,
        "Map this incoming document into a structured plan to get the deal done: key dates/deadlines, follow-up tasks, closing deliverables and parties. Do not over-process: extract only what is actually in the document and is customary to track. Skip items already in the matter. Keep every list short — typically fewer than 10 entries each. Never invent dates; if a deadline has no determinable date, set due_on to 'unknown'.",
        `${ctx}\n\nDOCUMENT "${data.fileName}"${text.length < data.text.length ? " (truncated)" : ""}:\n${text}`,
        schema,
      );
      return {
        ...r.output,
        usage: r.usage,
        runId: r.runId,
        truncated: text.length < data.text.length,
      };
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
        title: z
          .string()
          .describe("Short memo title, e.g. 'Call with seller's counsel — closing timing'"),
        summary: z
          .string()
          .describe(
            "Clean meeting memo in markdown: attendees if known, discussion, decisions, open questions",
          ),
        tasks: z.array(
          z.object({
            title: z.string(),
            assignee: z.string().describe("Attorney, Associate, Staff, Client, or Other party"),
            ...sourced,
          }),
        ),
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
  .inputValidator((d: { matterId: string; effort: Effort }) =>
    z.object({ matterId: uuid, effort: effortZ }).parse(d),
  )
  .handler(async ({ data, context }) =>
    runAi(context, data.matterId, "closing", data.effort, async () => {
      const { aiObject, matterContext } = await import("./ai.server");
      const ctx = await matterContext(context.supabase, data.matterId, data.effort, true);
      const schema = z.object({
        items: z.array(
          z.object({
            deliverable: z.string(),
            responsible: z
              .string()
              .describe("Buyer, Seller, Lender, Title, Escrow, Firm, or a named party"),
            ...sourced,
          }),
        ),
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
    z
      .object({ matterId: uuid, effort: effortZ, fields: z.array(z.string().max(200)).max(80) })
      .parse(d),
  )
  .handler(async ({ data, context }) =>
    runAi(context, data.matterId, "draft_fill", data.effort, async () => {
      const { aiObject, matterContext } = await import("./ai.server");
      const ctx = await matterContext(context.supabase, data.matterId, data.effort, true);
      const schema = z.object({
        answers: z.array(
          z.object({
            field: z.string().describe("The blank's name exactly as given"),
            value: z.string().describe("Empty string if the matter does not say"),
            ...sourced,
          }),
        ),
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
    z
      .object({
        matterId: uuid,
        effort: effortZ,
        body: z.string().min(10).max(100000),
        instruction: z.string().max(2000),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) =>
    runAi(context, data.matterId, "draft_edit", data.effort, async () => {
      const { aiObject, matterContext } = await import("./ai.server");
      const ctx = await matterContext(context.supabase, data.matterId, data.effort);
      const schema = z.object({
        edits: z.array(
          z.object({
            original: z
              .string()
              .describe(
                "Exact verbatim text copied from the draft (a phrase or sentence), to be replaced",
              ),
            suggested: z.string().describe("The replacement text"),
            reason: z
              .string()
              .describe("Why, citing the matter fact or instruction that calls for it"),
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
