import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

// Streaming per-matter Assist. Same rules as the server functions in src/lib/ai.functions.ts:
// bearer-verified caller, matter context only, every run logged to ai_runs.
// Wire format: newline-delimited JSON events — {t:"delta",text} | {t:"done",usage,runId} | {t:"error",message,retryable}

const bodyZ = z.object({
  matterId: z.string().uuid(),
  effort: z.enum(["normal", "advanced"]),
  question: z.string().min(1).max(4000),
  history: z.array(z.object({ q: z.string().max(4000), a: z.string().max(20000) })).max(8).optional(),
  runId: z.string().max(200).optional(),
});

export const Route = createFileRoute("/api/assist")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { authFromRequest } = await import("@/lib/auth.server");
        const { aiStream, matterContext, askInstructions, logRun, toAiError } = await import("@/lib/ai.server");

        const auth = await authFromRequest(request).catch(() => null);
        if (!auth) return Response.json({ message: "Please sign in again." }, { status: 401 });

        const parsed = bodyZ.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return Response.json({ message: "Invalid request." }, { status: 400 });
        const { matterId, effort, question, history, runId } = parsed.data;

        let ctx: string;
        try {
          ctx = await matterContext(auth.supabase, matterId, effort, effort === "advanced");
        } catch (e) {
          return Response.json({ message: e instanceof Error ? e.message : "Matter not found" }, { status: 404 });
        }

        const enc = new TextEncoder();
        const line = (o: unknown) => enc.encode(JSON.stringify(o) + "\n");
        const fail = (e: unknown) => {
          const err = toAiError(e);
          if (err.status !== 499) console.error("[ai:ask]", err.status ?? "", err.message);
          return Response.json({ message: err.message, retryable: err.retryable }, { status: err.status && err.status >= 400 ? err.status : 500 });
        };

        let stream: ReturnType<typeof aiStream>;
        try {
          stream = aiStream(effort, askInstructions(effort), `${ctx}\n\nATTORNEY REQUEST:\n${question}`, {
            ...(history ? { history } : {}),
            ...(runId ? { runId } : {}),
            signal: request.signal,
          });
        } catch (e) {
          return fail(e);
        }
        const { result, getRunId } = stream;

        // Pull the first part before sending headers so gateway denials (402/403/429…) keep their real status.
        const it = result.fullStream[Symbol.asyncIterator]();
        let first: IteratorResult<Awaited<ReturnType<typeof it.next>>["value"]>;
        try {
          first = await it.next();
        } catch (e) {
          return fail(e);
        }
        if (!first.done && first.value.type === "error") return fail(first.value.error);

        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (o: unknown) => {
              try {
                controller.enqueue(line(o));
              } catch {
                /* client went away */
              }
            };
            try {
              let cur = first;
              while (!cur.done) {
                const part = cur.value;
                if (part.type === "text-delta") send({ t: "delta", text: part.text });
                else if (part.type === "error") throw part.error;
                cur = await it.next();
              }
              const usage = await result.usage;
              const u = { inputTokens: usage.inputTokens ?? undefined, outputTokens: usage.outputTokens ?? undefined };
              await logRun(auth.supabase, auth.userId, matterId, "ask", effort, u);
              send({ t: "done", usage: u, runId: getRunId() ?? null });
            } catch (e) {
              const err = toAiError(e);
              if (err.status !== 499) console.error("[ai:ask:stream]", err.status ?? "", err.message);
              send({ t: "error", message: err.message, retryable: err.retryable });
            } finally {
              try {
                controller.close();
              } catch {
                /* already closed */
              }
            }
          },
        });

        const headers = new Headers({
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-cache, no-transform, private",
          "X-Content-Type-Options": "nosniff",
          "Access-Control-Expose-Headers": "X-Lovable-AIG-Run-ID",
        });
        const rid = getRunId();
        if (rid) headers.set("X-Lovable-AIG-Run-ID", rid);
        return new Response(body, { headers });
      },
    },
  },
});
