// Server-only Lovable AI Gateway helpers. Never import from client code.
import { createOpenAI } from "@ai-sdk/openai";
import { streamText, Output } from "ai";
import type { z } from "zod";

export type Effort = "normal" | "advanced";

const MODEL = "openai/gpt-6-astra";
const RUN_ID = "X-Lovable-AIG-Run-ID";

function provider() {
  const apiKey = process.env["LOVABLE_API_KEY"];
  if (!apiKey) throw new Error("Lovable AI is not configured.");
  let runId: string | undefined;
  return createOpenAI({
    baseURL: "https://ai.gateway.lovable.dev/v1",
    apiKey,
    headers: { "Lovable-API-Key": apiKey, "X-Lovable-AIG-SDK": "vercel-ai-sdk" },
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      if (runId && !headers.has(RUN_ID)) headers.set(RUN_ID, runId);
      const res = await fetch(input, { ...init, headers });
      runId ??= res.headers.get(RUN_ID) ?? undefined;
      if (!res.ok) {
        const msg =
          res.status === 402
            ? "Your workspace is out of AI credits. Add credits in Settings → Plans & credits."
            : res.status === 429
              ? "AI is busy right now. Please try again in a minute."
              : res.status === 403
                ? "AI access is blocked for this workspace."
                : null;
        if (msg) throw new Error(msg);
      }
      return res;
    },
  });
}

export const BASE_INSTRUCTIONS = `You are Mirza Assist, a support tool inside a boutique transactional law firm's matter-management system.
You work like a careful associate or paralegal: you prepare, organize and flag; the attorney decides.
Rules:
- Stay strictly within the matter context provided. Do not invent facts, parties, dates or numbers. If unknown, say so.
- Prefer what is customary and routine. Do not over-complicate standard transactions.
- Be concise and plain. No legal conclusions presented as final advice. Tax points are flags for the attorney's awareness only.
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

export async function aiText(effort: Effort, instructions: string, prompt: string) {
  const result = streamText({
    model: provider().responses(MODEL),
    system: `${BASE_INSTRUCTIONS}\n\n${instructions}`,
    prompt,
    providerOptions: opts(effort) as never,
  });
  const text = await result.text;
  const usage = await result.usage;
  return { text, usage };
}

export async function aiObject<T extends z.ZodTypeAny>(
  effort: Effort,
  instructions: string,
  prompt: string,
  schema: T,
): Promise<{ output: z.infer<T>; usage: { inputTokens?: number | undefined; outputTokens?: number | undefined } }> {
  const result = streamText({
    model: provider().responses(MODEL),
    system: `${BASE_INSTRUCTIONS}\n\n${instructions}`,
    prompt,
    output: Output.object({ schema }),
    providerOptions: opts(effort) as never,
  });
  try {
    const output = await result.output;
    return { output, usage: await result.usage };
  } catch (e) {
    const text = await Promise.resolve(result.text).catch(() => "");
    try {
      return { output: JSON.parse(text), usage: await result.usage };
    } catch {
      throw e;
    }
  }
}
