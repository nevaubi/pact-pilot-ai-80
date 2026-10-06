import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type Effort = "normal" | "advanced";
type Ctx = { supabase: SupabaseClient<Database>; userId: string };

async function matterContext(supabase: Ctx["supabase"], matterId: string, includeDocs = false) {
  const [m, t, d, n, c, f] = await Promise.all([
    supabase.from("matters").select("*").eq("id", matterId).single(),
    supabase.from("tasks").select("title,assignee,due_on,done").eq("matter_id", matterId),
    supabase.from("deadlines").select("title,due_on,kind").eq("matter_id", matterId),
    supabase.from("notes").select("title,body,created_at").eq("matter_id", matterId).order("created_at", { ascending: false }).limit(6),
    supabase.from("closing_items").select("deliverable,responsible,status,due_on").eq("matter_id", matterId).order("position"),
    supabase.from("files").select("name,extracted_text").eq("matter_id", matterId).limit(8),
  ]);
  if (m.error || !m.data) throw new Error("Matter not found");
  const mm = m.data;
  const docs = (f.data ?? [])
    .map((x) => (includeDocs && x.extracted_text ? `--- ${x.name} ---\n${x.extracted_text.slice(0, 12000)}` : `- ${x.name}`))
    .join("\n");
  return `MATTER ${mm.number ?? ""}: ${mm.title}
Client: ${mm.client ?? "—"} | Practice: ${mm.practice_area} | Status: ${mm.status} | Today: ${new Date().toISOString().slice(0, 10)}
Summary: ${mm.summary ?? "—"}
Tasks:\n${(t.data ?? []).map((x) => `- [${x.done ? "x" : " "}] ${x.title} (${x.assignee ?? "unassigned"}, due ${x.due_on ?? "—"})`).join("\n") || "none"}
Deadlines:\n${(d.data ?? []).map((x) => `- ${x.due_on}: ${x.title} (${x.kind})`).join("\n") || "none"}
Closing checklist:\n${(c.data ?? []).map((x) => `- ${x.deliverable} — ${x.responsible ?? "?"} — ${x.status}${x.due_on ? ` (due ${x.due_on})` : ""}`).join("\n") || "none"}
Recent notes:\n${(n.data ?? []).map((x) => `- ${x.title ?? "Note"}: ${x.body.slice(0, 600)}`).join("\n") || "none"}
Files:\n${docs || "none"}`;
}

async function logRun(ctx: Ctx, matterId: string | null, kind: string, effort: Effort, usage: { inputTokens?: number | undefined; outputTokens?: number | undefined }) {
  await ctx.supabase.from("ai_runs").insert({
    matter_id: matterId,
    user_id: ctx.userId,
    kind,
    effort,
    input_tokens: usage.inputTokens ?? null,
    output_tokens: usage.outputTokens ?? null,
  });
}

const effortZ = z.enum(["normal", "advanced"]);

export const askMatter = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { matterId: string; effort: Effort; question: string }) =>
    z.object({ matterId: z.string().uuid(), effort: effortZ, question: z.string().min(1).max(4000) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { aiText } = await import("./ai.server");
    const ctx = await matterContext(context.supabase, data.matterId, data.effort === "advanced");
    const { text, usage } = await aiText(
      data.effort,
      data.effort === "advanced"
        ? "Advanced effort: analyze carefully, flag issues and risks, and cite which part of the matter or document supports each point. End with 'For your review:' listing what the attorney should check personally."
        : "Normal effort: practical case-management help. Keep it short. End with one line 'For your review:' naming what to double-check.",
      `${ctx}\n\nATTORNEY REQUEST:\n${data.question}`,
    );
    await logRun(context, data.matterId, "ask", data.effort, usage);
    return { text, usage };
  });

const sourced = { why: z.string().describe("Short reason and the quoted source text it came from") };

export const mapDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { matterId: string; effort: Effort; fileName: string; text: string }) =>
    z.object({ matterId: z.string().uuid(), effort: effortZ, fileName: z.string(), text: z.string().min(20).max(120000) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { aiObject } = await import("./ai.server");
    const ctx = await matterContext(context.supabase, data.matterId);
    const schema = z.object({
      summary: z.string(),
      document_type: z.string(),
      parties: z.array(z.object({ name: z.string(), role: z.string(), ...sourced })),
      deadlines: z.array(z.object({ title: z.string(), due_on: z.string().describe("YYYY-MM-DD; compute from the document if relative"), kind: z.string(), ...sourced })),
      tasks: z.array(z.object({ title: z.string(), assignee: z.string().describe("Attorney, Associate, Staff, Client, or Other party"), ...sourced })),
      deliverables: z.array(z.object({ deliverable: z.string(), responsible: z.string(), ...sourced })),
    });
    const { output, usage } = await aiObject(
      data.effort,
      "Map this incoming document into a structured plan to get the deal done: key dates/deadlines, follow-up tasks, closing deliverables and parties. Do not over-process: extract only what is actually in the document and is customary to track. Skip items already in the matter. Keep lists short (typically under 10 each).",
      `${ctx}\n\nDOCUMENT "${data.fileName}":\n${data.text.slice(0, data.effort === "advanced" ? 100000 : 40000)}`,
      schema,
    );
    await logRun(context, data.matterId, "intake", data.effort, usage);
    return output;
  });

export const processMeetingNotes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { matterId: string; effort: Effort; notes: string }) =>
    z.object({ matterId: z.string().uuid(), effort: effortZ, notes: z.string().min(5).max(40000) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { aiObject } = await import("./ai.server");
    const ctx = await matterContext(context.supabase, data.matterId);
    const schema = z.object({
      title: z.string(),
      summary: z.string().describe("Clean meeting memo in markdown: attendees if known, discussion, decisions, open questions"),
      tasks: z.array(z.object({ title: z.string(), assignee: z.string(), ...sourced })),
    });
    const { output, usage } = await aiObject(
      data.effort,
      "Turn rough meeting notes into a clean memo for the file plus follow-up tasks. Keep the attorney's wording where possible; do not add content that wasn't discussed.",
      `${ctx}\n\nROUGH NOTES:\n${data.notes}`,
      schema,
    );
    await logRun(context, data.matterId, "meeting", data.effort, usage);
    return output;
  });

export const draftClosingChecklist = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { matterId: string; effort: Effort }) => z.object({ matterId: z.string().uuid(), effort: effortZ }).parse(d))
  .handler(async ({ data, context }) => {
    const { aiObject } = await import("./ai.server");
    const ctx = await matterContext(context.supabase, data.matterId, true);
    const schema = z.object({
      items: z.array(z.object({ deliverable: z.string(), responsible: z.string(), ...sourced })),
    });
    const { output, usage } = await aiObject(
      data.effort,
      "Propose a customary closing checklist for this matter type: documents, consents, certificates, filings, funds flow. Use the matter's documents where available; otherwise the standard items for this kind of deal. Do not repeat items already on the checklist. Keep it to what a boutique firm actually tracks.",
      ctx,
      schema,
    );
    await logRun(context, data.matterId, "closing", data.effort, usage);
    return output;
  });

export const suggestTemplateAnswers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { matterId: string; effort: Effort; fields: string[] }) =>
    z.object({ matterId: z.string().uuid(), effort: effortZ, fields: z.array(z.string()).max(80) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { aiObject } = await import("./ai.server");
    const ctx = await matterContext(context.supabase, data.matterId, true);
    const schema = z.object({
      answers: z.array(z.object({ field: z.string(), value: z.string().describe("Empty string if not found in matter"), ...sourced })),
    });
    const { output, usage } = await aiObject(
      data.effort,
      "Fill blanks of the firm's house template using only facts in the matter. Never guess: leave value empty when the matter does not say.",
      `${ctx}\n\nTEMPLATE BLANKS:\n${data.fields.map((f) => `- ${f}`).join("\n")}`,
      schema,
    );
    await logRun(context, data.matterId, "draft_fill", data.effort, usage);
    return output;
  });

export const suggestDraftEdits = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { matterId: string; effort: Effort; body: string; instruction: string }) =>
    z.object({ matterId: z.string().uuid(), effort: effortZ, body: z.string().min(10).max(100000), instruction: z.string().max(2000) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { aiObject } = await import("./ai.server");
    const ctx = await matterContext(context.supabase, data.matterId);
    const schema = z.object({
      edits: z.array(
        z.object({
          original: z.string().describe("Exact verbatim text from the draft to replace"),
          suggested: z.string(),
          reason: z.string(),
        }),
      ),
    });
    const { output, usage } = await aiObject(
      data.effort,
      "This draft is based on the firm's house template. Preserve the house form: suggest only targeted, minimal edits needed for this deal (or the attorney's instruction). Never restructure or rewrite whole sections. 'original' must be copied verbatim from the draft. Usually fewer than 8 edits.",
      `${ctx}\n\nATTORNEY INSTRUCTION: ${data.instruction || "Tailor to this matter where clearly needed."}\n\nDRAFT:\n${data.body}`,
      schema,
    );
    await logRun(context, data.matterId, "draft_edit", data.effort, usage);
    return output;
  });
