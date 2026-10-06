import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

// Streaming per-matter Assist. Same rules as the server functions in src/lib/ai.functions.ts:
// bearer-verified caller, matter context only, every run logged to ai_runs.
// mode "draft" is handled by src/lib/office-stream.server.ts (bounded tool loop).
// Wire format: newline-delimited JSON events — {t:"delta",text} | {t:"done",usage,runId} | {t:"error",message,retryable}

const bodyZ = z.object({
  matterId: z.string().uuid(),
  effort: z.enum(["normal", "advanced"]),
  question: z.string().min(1).max(4000),
  history: z
    .array(z.object({ q: z.string().max(4000), a: z.string().max(20000) }))
    .max(8)
    .optional(),
  runId: z.string().max(200).optional(),
  /** "draft" = Office drafting panel: the open document is the primary context. */
  mode: z.enum(["assist", "draft"]).optional(),
  document: z
    .object({
      name: z.string().max(300),
      kind: z.enum(["docx", "pdf", "xlsx", "text"]),
      text: z.string().max(400_000),
      selection: z.string().max(20_000).optional(),
      workbook: z
        .object({
          active: z.string().max(200).optional(),
          selection: z.object({ sheet: z.string().max(200), range: z.string().max(40) }).optional(),
          sheets: z
            .array(
              z.object({
                name: z.string().max(200),
                cells: z.record(
                  z.string().max(12),
                  z.object({
                    v: z.union([z.string().max(32_767), z.number(), z.boolean(), z.null()]).optional(),
                    f: z.string().max(8_192).optional(),
                  }),
                ),
              }),
            )
            .max(50),
        })
        .optional(),
    })
    .optional(),
  /** Reference documents attached in the drafting panel for this request only (extracted in the browser). */
  attachments: z
    .array(z.object({ id: z.string().max(64), name: z.string().max(300), text: z.string().max(200_000), truncated: z.boolean() }))
    .max(5)
    .optional(),
});

/** Character budget for the open document per effort (the matter's other files still come through matterContext). */
const DOC_BUDGET = { normal: 24_000, advanced: 90_000 } as const;

export const Route = createFileRoute("/api/assist")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { authFromRequest } = await import("@/lib/auth.server");
        const { aiStream, matterContext, askInstructions, logRun, toAiError, matterSources, queriesFromText } =
          await import("@/lib/ai.server");

        const auth = await authFromRequest(request).catch(() => null);
        if (!auth) return Response.json({ message: "Please sign in again." }, { status: 401 });

        const parsed = bodyZ.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return Response.json({ message: "Invalid request." }, { status: 400 });
        const { matterId, effort, question, history, runId, document: doc } = parsed.data;
        const mode = parsed.data.mode ?? "assist";
        if (mode === "draft") {
          const { draftResponse } = await import("@/lib/office-stream.server");
          return draftResponse({ auth, body: parsed.data, request });
        }

        let ctx: string;
        try {
          // In draft mode the open document carries the text; other files are listed by name only.
          ctx = await matterContext(auth.supabase, matterId, effort, effort === "advanced");
        } catch (e) {
          return Response.json(
            { message: e instanceof Error ? e.message : "Matter not found" },
            { status: 404 },
          );
        }
        // Library grounding: pinned sources first, then the practice area's topic. Never fatal.
        const sources = await matterSources(auth.supabase, matterId, undefined, queriesFromText(`${question} ${doc?.selection ?? ""}`), effort).catch(
          () => ({ block: "", meta: [] as { ref: string; authority_id: string; citation: string; title: string; url: string; version: string | null }[] }),
        );

        let docBlock = "";
        if (doc) {
          const budget = DOC_BUDGET[effort];
          const sel = doc.selection?.trim();
          let text = doc.text;
          if (text.length > budget) {
            // Keep the start (definitions, parties) and a window around the selection when there is one.
            const head = text.slice(0, Math.floor(budget * 0.6));
            const at = sel ? text.indexOf(sel.slice(0, 200)) : -1;
            const tail = at > head.length ? text.slice(Math.max(head.length, at - Math.floor(budget * 0.1)), at + Math.floor(budget * 0.3)) : text.slice(-Math.floor(budget * 0.4));
            text = `${head}\n[… ${text.length - head.length - tail.length} characters omitted …]\n${tail}`;
          }
          docBlock = `\n\nOPEN DOCUMENT (${doc.kind}): ${doc.name}\n${text || "[no readable text]"}${sel ? `\n\nSELECTION:\n${sel}` : ""}`;
        }

        const enc = new TextEncoder();
        const line = (o: unknown) => enc.encode(JSON.stringify(o) + "\n");
        const fail = (e: unknown) => {
          const err = toAiError(e);
          if (err.status !== 499) console.error("[ai:ask]", err.status ?? "", err.message);
          return Response.json(
            { message: err.message, retryable: err.retryable },
            { status: err.status && err.status >= 400 ? err.status : 500 },
          );
        };

        let stream: ReturnType<typeof aiStream>;
        try {
          stream = aiStream(
            effort,
            askInstructions(effort),
            `${ctx}${docBlock}\n\n${sources.block}\n\nATTORNEY REQUEST:\n${question}`,
            {
              ...(history ? { history } : {}),
              ...(runId ? { runId } : {}),
              signal: request.signal,
            },
          );
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
            if (sources.meta.length) send({ t: "sources", items: sources.meta });
            try {
              let cur = first;
              while (!cur.done) {
                const part = cur.value;
                if (part.type === "text-delta") send({ t: "delta", text: part.text });
                else if (part.type === "error") throw part.error;
                cur = await it.next();
              }
              const usage = await result.usage;
              const u = {
                inputTokens: usage.inputTokens ?? undefined,
                outputTokens: usage.outputTokens ?? undefined,
              };
              await logRun(auth.supabase, auth.userId, matterId, "ask", effort, u);
              send({ t: "done", usage: u, runId: getRunId() ?? null });
            } catch (e) {
              const err = toAiError(e);
              if (err.status !== 499)
                console.error("[ai:ask:stream]", err.status ?? "", err.message);
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
