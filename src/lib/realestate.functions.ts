import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Real-estate review (title commitment + survey), grounded on the matter's documents and the
// law library. Same rules as ai.functions.ts: auth-protected, logged to ai_runs, suggestions only.

const uuid = z.string().uuid();
const effortZ = z.enum(["normal", "advanced"]);

export const reviewTitleSurvey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { matterId: string; effort: "normal" | "advanced"; commitmentId?: string; surveyId?: string; contractId?: string; instruction?: string }) =>
    z
      .object({
        matterId: uuid,
        effort: effortZ,
        commitmentId: uuid.optional(),
        surveyId: uuid.optional(),
        contractId: uuid.optional(),
        instruction: z.string().max(1000).optional(),
      })
      .refine((v) => v.commitmentId || v.surveyId, { message: "Pick a title commitment or a survey to review." })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { aiObject, matterContext, matterSources, logRun, toAiError } = await import("./ai.server");
    const { quoteVerified } = await import("./library.server");
    const { supabase, userId } = context;
    try {
      const ids = [data.commitmentId, data.surveyId, data.contractId].filter((x): x is string => !!x);
      const { data: files, error } = await supabase.from("files").select("id,name,extracted_text").in("id", ids);
      if (error) throw new Error(error.message);
      const byId = new Map((files ?? []).map((f) => [f.id, f]));
      const cap = data.effort === "advanced" ? 70_000 : 30_000;
      const doc = (id: string | undefined, label: string) => {
        if (!id) return "";
        const f = byId.get(id);
        if (!f) return `${label}: file not found\n`;
        const t = (f.extracted_text ?? "").slice(0, cap);
        return `=== ${label}: ${f.name}${(f.extracted_text?.length ?? 0) > cap ? " (truncated)" : ""} ===\n${t || "[no readable text]"}\n`;
      };
      // matterContext already carries the property/deal record line when one exists.
      const ctx = await matterContext(supabase, data.matterId, data.effort, false);
      const src = await matterSources(
        supabase,
        data.matterId,
        "Real Estate",
        [
          "schedule B exceptions standard exceptions extended coverage ALTA statement survey",
          "mechanics lien waiver contractor subcontractor notice",
          "mortgage release payoff reconveyance",
          "easement encroachment building line setback plat of survey",
          "condominium assessments lien resale disclosure 22.1",
          "transfer declaration transfer tax exemption",
          "withholding foreign person non-foreign certification",
          "title insurance escrow closing protection Illinois",
        ],
        data.effort,
        { budget: data.effort === "advanced" ? 18_000 : 8_000, topic: "real_estate" },
      );
      const schema = z.object({
        summary: z.string().describe("Three or four plain sentences: what was reviewed, the state of title, and the two or three things that matter most"),
        schedule_a: z
          .array(z.object({ item: z.string(), value: z.string(), ok: z.boolean().describe("true if consistent with the contract/matter facts"), why: z.string() }))
          .describe("Commitment date, proposed insured, policy amount(s), estate, vesting, legal description check, PIN check — only what the document shows"),
        requirements: z.array(z.object({ text: z.string().describe("Verbatim or near-verbatim requirement from Schedule B-I"), who: z.string().describe("Seller, Buyer, Lender, Title, Association or named party"), action: z.string() })),
        exceptions: z.array(
          z.object({
            number: z.string().describe("Exception number as printed, or '—'"),
            text: z.string().describe("The exception copied verbatim (shortened with … if very long)"),
            category: z.enum(["standard", "tax", "mortgage", "lien", "easement", "covenant", "survey", "lease", "other"]),
            action: z.enum(["clear", "waive", "endorse", "accept", "investigate"]).describe("clear = must be removed at/before closing; waive = standard exception removed with ALTA statement/survey; endorse = acceptable with an endorsement; accept = customary and benign; investigate = need more information"),
            why: z.string(),
            survey_match: z.string().describe("How the survey shows this item, quoted, or empty if no survey or not shown"),
          }),
        ),
        survey_findings: z.array(
          z.object({
            finding: z.string(),
            verbatim: z.string().describe("Words copied from the survey (notes, legend, dimensions)"),
            severity: z.enum(["high", "medium", "low"]),
            relates_to: z.string().describe("Exception number it relates to, or empty"),
          }),
        ),
        flags: z.array(
          z.object({
            title: z.string(),
            severity: z.enum(["high", "medium", "low"]),
            detail: z.string(),
            basis_ref: z.string().describe("Source tag (e.g. S2) supporting the point, or empty"),
            basis_quote: z.string().describe("Verbatim words from that source, or empty"),
            next_step: z.string(),
          }),
        ),
        checklist: z.array(z.object({ deliverable: z.string(), responsible: z.string(), why: z.string() })).describe("Closing deliverables this review adds — payoff letters, releases, affidavits, endorsements, association letters, survey corrections"),
      });
      const r = await aiObject(
        data.effort,
        `You are reviewing a title commitment and/or a plat of survey for a transactional attorney in Illinois, as a careful associate would.
Rules:
- Work only from the documents and matter facts provided. Quote exceptions and survey notes verbatim; never paraphrase an exception into something it does not say.
- Classify each Schedule B exception and recommend the customary action: standard/general exceptions are waived with an ALTA statement and (where extended coverage is wanted) a current survey; mortgages, judgments and liens are cleared with payoffs and releases; utility easements along lot lines are usually accepted; building-line and recorded restrictions get compared with the survey; anything unclear is "investigate".
- Cross-reference: for each exception, say what the survey shows (quoted) if a survey is provided; for each survey finding, name the exception it relates to.
- Where a legal point is involved (lien waivers, transfer tax, FIRPTA, condominium disclosures), cite a SOURCE tag with a verbatim quote; otherwise leave basis empty.
- Be concise and customary. Do not invent parties, dates or amounts; use "unknown" when the document is silent.`,
        `${ctx}\n\n${propLine}\n\n${src.block}\n\n${doc(data.commitmentId, "TITLE COMMITMENT")}\n${doc(data.surveyId, "PLAT OF SURVEY")}\n${doc(data.contractId, "CONTRACT")}\n${data.instruction ? `ATTORNEY INSTRUCTION: ${data.instruction}\n` : ""}Review now.`,
        schema,
      );
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
      const result = {
        ...r.output,
        flags,
        sources: src.meta,
        files: ids.map((id) => ({ id, name: byId.get(id)?.name ?? "file" })),
        instruction: data.instruction ?? null,
      };
      await logRun(supabase, userId, data.matterId, "title", data.effort, r.usage);
      const { data: review, error: insErr } = await supabase
        .from("reviews")
        .insert({
          matter_id: data.matterId,
          kind: "title",
          title: `Title & survey review — ${new Date().toISOString().slice(0, 10)}`,
          effort: data.effort,
          input_tokens: r.usage.inputTokens ?? null,
          output_tokens: r.usage.outputTokens ?? null,
          result,
          file_ids: ids,
          authority_ids: [...new Set(src.meta.map((s) => s.authority_id))],
          created_by: userId,
        })
        .select("id,created_at")
        .single();
      if (insErr) throw new Error(insErr.message);
      return { reviewId: review.id, createdAt: review.created_at, ...result, usage: r.usage, runId: r.runId };
    } catch (e) {
      const err = toAiError(e);
      console.error("[ai:title]", err.status ?? "", err.message);
      throw new Error(err.message);
    }
  });
