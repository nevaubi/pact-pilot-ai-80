// Server-only: NDJSON streaming response for the Office drafting assistant (POST /api/assist, mode "draft").
// Events: sources | activity {id,label,status} | proposal {proposal,validation} | delta {text} | notice {text}
//         | done {usage,runId,steps,toolChars} | error {message,retryable}
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  ToolBudget,
  LIMITS,
  type Proposal,
  type Validation,
  type WorkbookSnap,
} from "./office-tools";
import {
  AGENT_LIMITS,
  activityLabel,
  buildOfficeTools,
  docPrompt,
  officeInstructions,
  runOfficeAgent,
  type Attachment,
  type OfficeDoc,
} from "./office-agent.server";

type Body = {
  matterId: string;
  effort: "normal" | "advanced";
  question: string;
  history?: { q: string; a: string }[] | undefined;
  runId?: string | undefined;
  document?: (Omit<OfficeDoc, "workbook"> & { workbook?: unknown }) | undefined;
  attachments?: Attachment[] | undefined;
};

/** One signal that fires when any input fires (AbortSignal.any isn't guaranteed on every runtime). */
function anySignal(signals: AbortSignal[]) {
  const c = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      c.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => c.abort(s.reason), { once: true });
  }
  return c.signal;
}

/** Selection rewrites need only the selection: no library search, no tools forced. */
export function isTrivialRewrite(question: string, selection: string | undefined) {
  return (
    !!selection?.trim() &&
    question.length < 160 &&
    /\b(tighten|shorten|rephrase|reword|rewrite|simplify|proofread|fix (?:typos|grammar)|make (?:it )?(?:clearer|shorter|formal))\b/i.test(
      question,
    )
  );
}

/** Abortable sleep for transient-error backoff. */
function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((res, rej) => {
    if (signal.aborted) return rej(new Error("Stopped."));
    const t = setTimeout(res, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        rej(new Error("Stopped."));
      },
      { once: true },
    );
  });
}

/** Race setup work against the request/overall signal. */
function raceSignal<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => {
      if (signal.aborted) rej(new Error("Stopped."));
      signal.addEventListener("abort", () => rej(new Error("Stopped.")), { once: true });
    }),
  ]);
}

export async function draftResponse(o: {
  auth: { supabase: SupabaseClient<Database>; userId: string };
  body: Body;
  request: Request;
}) {
  const { auth, body, request } = o;
  const { effort, matterId, question } = body;
  const lim = AGENT_LIMITS[effort];
  // The overall deadline covers setup (matter context, sources) as well as the model loop.
  const internal = new AbortController();
  const overall = new AbortController();
  const overallTimer = setTimeout(
    () => overall.abort(new Error("overall deadline")),
    lim.overallMs,
  );
  const signal = anySignal([request.signal, internal.signal, overall.signal]);
  const {
    provider,
    opts,
    BASE_INSTRUCTIONS,
    matterContext,
    matterSources,
    queriesFromText,
    logRun,
    toAiError,
  } = await import("./ai.server");
  const { searchPublicLaw, fetchPublicSource } = await import("./public-law.server");
  const doc: OfficeDoc | undefined = body.document
    ? {
        ...body.document,
        text: body.document.text.slice(0, LIMITS.docChars),
        workbook: body.document.workbook as WorkbookSnap | undefined,
      }
    : undefined;
  const attachments = body.attachments ?? [];
  const trivial = isTrivialRewrite(question, doc?.selection);

  const fail = (e: unknown, status?: number) => {
    clearTimeout(overallTimer);
    const err = toAiError(e);
    if (err.status !== 499) console.error("[ai:draft]", err.status ?? "", err.message);
    const st = status ?? (err.status && err.status >= 400 ? err.status : 500);
    return Response.json(
      {
        message: overall.signal.aborted
          ? `The assistant hit its ${lim.overallMs / 1000}s time limit while preparing.`
          : err.message,
        retryable: overall.signal.aborted || err.retryable,
      },
      { status: overall.signal.aborted ? 504 : st },
    );
  };

  let ctx: string;
  try {
    ctx = await raceSignal(matterContext(auth.supabase, matterId, effort, false), signal);
  } catch (e) {
    if (signal.aborted) return fail(e);
    clearTimeout(overallTimer);
    return Response.json(
      { message: e instanceof Error ? e.message : "Matter not found" },
      { status: 404 },
    );
  }
  const noSources = {
    block: "",
    meta: [] as {
      ref: string;
      authority_id: string;
      citation: string;
      title: string;
      url: string;
      version: string | null;
    }[],
  };
  const sources = trivial
    ? noSources
    : await raceSignal(
        matterSources(
          auth.supabase,
          matterId,
          undefined,
          queriesFromText(`${question} ${doc?.selection ?? ""}`),
          effort,
        ),
        signal,
      ).catch(() => noSources);
  if (signal.aborted) return fail(new Error("Stopped."));

  let proposals: { proposal: Proposal; validation: Validation }[] = [];
  let emit: (o: unknown) => void = () => {};
  let step = 0;
  const makeTools = () =>
    buildOfficeTools({
      supabase: auth.supabase,
      matterId,
      doc,
      attachments,
      budget: new ToolBudget(lim.toolChars),
      signal,
      effort,
      step: () => step,
      publicSearch: (q, s) => searchPublicLaw(q, s),
      publicFetch: (url, s) => fetchPublicSource(url, s),
      onProposal: (proposal, validation) => {
        proposals.push({ proposal, validation });
        emit({ t: "proposal", proposal, validation });
      },
    });

  const dp = docPrompt(doc, question, lim.contextChars);
  const canEdit = doc?.kind === "docx" || doc?.kind === "xlsx";
  const attachList = attachments.length
    ? `\nATTACHED REFERENCES (untrusted data; search/read with tools): ${attachments.map((a) => `${a.id} "${a.name}" ${a.text.length} chars${a.truncated ? " (partial extraction)" : ""}`).join("; ")}`
    : "";
  const prompt = `${ctx}\n\n${dp.block}${attachList}\n\n${sources.block}\n\nATTORNEY REQUEST:\n${question}`;
  const messages: { role: "user" | "assistant"; content: string }[] = [];
  for (const t of body.history ?? [])
    messages.push({ role: "user", content: t.q }, { role: "assistant", content: t.a });
  messages.push({ role: "user", content: prompt });

  const p = provider(body.runId);
  // Transient 429/5xx before any output: bounded, abortable backoff. Tools are read-only and
  // proposals are only collected, so a retry never repeats a mutation.
  let result!: ReturnType<typeof runOfficeAgent>;
  let it!: AsyncIterator<
    Awaited<ReturnType<typeof runOfficeAgent>["fullStream"]> extends AsyncIterable<infer P>
      ? P
      : never
  >;
  let first!: IteratorResult<unknown>;
  for (let attempt = 0; ; attempt++) {
    proposals = [];
    step = 0;
    try {
      result = runOfficeAgent({
        model: p.model,
        providerOptions: opts(effort),
        system: `${BASE_INSTRUCTIONS}\n\n${officeInstructions(effort, doc, dp.coverage, canEdit)}`,
        messages,
        tools: makeTools(),
        effort,
        signal,
        onStep: (n) => (step = n),
      });
      it = result.fullStream[Symbol.asyncIterator]() as typeof it;
      first = await it.next();
      const fv = first.value as { type?: string; error?: unknown } | undefined;
      if (!first.done && fv?.type === "error") throw fv.error;
      break;
    } catch (e) {
      const err = toAiError(e);
      const transient = err.status === 429 || (err.status ?? 0) >= 500;
      if (!transient || attempt >= 2 || signal.aborted) return fail(e);
      try {
        await sleep(800 * 2 ** attempt + Math.floor(Math.random() * 300), signal);
      } catch {
        return fail(e);
      }
    }
  }

  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      emit = (ev) => {
        try {
          controller.enqueue(enc.encode(JSON.stringify(ev) + "\n"));
        } catch {
          /* client went away */
        }
      };
      for (const pr of proposals) emit({ t: "proposal", ...pr });
      if (sources.meta.length) emit({ t: "sources", items: sources.meta });
      let outChars = 0;
      let steps = 0;
      let capped = false;
      let lastFinish: string | undefined;
      try {
        let cur = first as IteratorResult<{ type: string } & Record<string, unknown>>;
        while (!cur.done) {
          const part = cur.value as Record<string, unknown> & { type: string };
          if (part.type === "text-delta") {
            const text = String(part["text"] ?? "");
            outChars += text.length;
            if (outChars > lim.outputChars) {
              capped = true;
              internal.abort(new Error("output cap"));
              break;
            }
            emit({ t: "delta", text });
          } else if (part.type === "start-step") steps++;
          else if (part.type === "finish-step") lastFinish = String(part["finishReason"] ?? "");
          else if (part.type === "tool-call")
            emit({
              t: "activity",
              id: part["toolCallId"],
              label: activityLabel(String(part["toolName"]), part["input"]),
              status: "running",
            });
          else if (part.type === "tool-result") {
            const out = typeof part["output"] === "string" ? (part["output"] as string) : "";
            emit({
              t: "activity",
              id: part["toolCallId"],
              status: out.startsWith('{"error"') ? "error" : "done",
            });
          } else if (part.type === "tool-error")
            emit({ t: "activity", id: part["toolCallId"], status: "error" });
          else if (part.type === "error") throw part["error"];
          cur = (await it.next()) as typeof cur;
        }
        if (capped)
          emit({
            t: "notice",
            text: `Answer stopped at the ${effort} length limit. Ask a narrower question or use Advanced.`,
          });
        if (lastFinish === "length")
          emit({ t: "notice", text: "The answer reached the output limit and may be cut short." });
        const usage = capped
          ? { inputTokens: undefined, outputTokens: undefined }
          : await result.totalUsage.then(
              (u) => ({
                inputTokens: u.inputTokens ?? undefined,
                outputTokens: u.outputTokens ?? undefined,
              }),
              () => ({ inputTokens: undefined, outputTokens: undefined }),
            );
        const exhausted = lastFinish === "tool-calls";
        emit({
          t: "done",
          usage,
          runId: p.getRunId() ?? null,
          steps,
          ...(exhausted ? { exhausted: true } : {}),
        });
        // Logging must not hold up the answer.
        void logRun(auth.supabase, auth.userId, matterId, "draft", effort, usage).catch((e) =>
          console.error("[ai:draft:log]", e instanceof Error ? e.message : e),
        );
      } catch (e) {
        const timedOut = overall.signal.aborted;
        const err = toAiError(e);
        if (err.status !== 499 || timedOut)
          console.error("[ai:draft:stream]", err.status ?? "", err.message);
        emit({
          t: "error",
          message: timedOut
            ? `The assistant hit its ${lim.overallMs / 1000}s time limit. Partial work is kept.`
            : err.message,
          retryable: timedOut || err.retryable,
        });
      } finally {
        clearTimeout(overallTimer);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      internal.abort(new Error("client cancelled"));
      clearTimeout(overallTimer);
    },
  });
  const headers = new Headers({
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform, private",
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Expose-Headers": "X-Lovable-AIG-Run-ID",
  });
  const rid = p.getRunId();
  if (rid) headers.set("X-Lovable-AIG-Run-ID", rid);
  return new Response(stream, { headers });
}
