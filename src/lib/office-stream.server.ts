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

export async function draftResponse(o: {
  auth: { supabase: SupabaseClient<Database>; userId: string };
  body: Body;
  request: Request;
}) {
  const { auth, body, request } = o;
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
  const { searchEcfr, searchFederalRegister, searchCourtListener } =
    await import("./library.server");
  const { effort, matterId, question } = body;
  const lim = AGENT_LIMITS[effort];
  const doc: OfficeDoc | undefined = body.document
    ? {
        ...body.document,
        text: body.document.text.slice(0, LIMITS.docChars),
        workbook: body.document.workbook as WorkbookSnap | undefined,
      }
    : undefined;
  // Attachments: per-request only, already bounded by the route schema; total capped here too.
  let left: number = LIMITS.attachmentsTotalChars;
  const attachments = (body.attachments ?? []).map((a) => {
    const text = a.text.slice(0, Math.max(0, left));
    left -= text.length;
    return { ...a, text, truncated: a.truncated || text.length < a.text.length };
  });

  let ctx: string;
  try {
    ctx = await matterContext(auth.supabase, matterId, effort, false);
  } catch (e) {
    return Response.json(
      { message: e instanceof Error ? e.message : "Matter not found" },
      { status: 404 },
    );
  }
  const sources = await matterSources(
    auth.supabase,
    matterId,
    undefined,
    queriesFromText(`${question} ${doc?.selection ?? ""}`),
    effort,
  ).catch(() => ({
    block: "",
    meta: [] as {
      ref: string;
      authority_id: string;
      citation: string;
      title: string;
      url: string;
      version: string | null;
    }[],
  }));

  const internal = new AbortController();
  const overall = new AbortController();
  const overallTimer = setTimeout(
    () => overall.abort(new Error("overall deadline")),
    lim.overallMs,
  );
  const signal = anySignal([request.signal, internal.signal, overall.signal]);

  const proposals: { proposal: Proposal; validation: Validation }[] = [];
  let emit: (o: unknown) => void = () => {};
  const tools = buildOfficeTools({
    supabase: auth.supabase,
    matterId,
    doc,
    attachments,
    budget: new ToolBudget(lim.toolChars),
    signal,
    publicSearch: async (q) => {
      const r = await Promise.allSettled([
        searchEcfr(q),
        searchFederalRegister(q),
        searchCourtListener(q),
      ]);
      return r
        .flatMap((x) => (x.status === "fulfilled" ? x.value : []))
        .map(({ provider: p, citation, title, url, snippet, date }) => ({
          provider: p,
          citation,
          title,
          url,
          snippet,
          date,
        }));
    },
    onProposal: (proposal, validation) => {
      proposals.push({ proposal, validation });
      emit({ t: "proposal", proposal, validation });
    },
  });

  const dp = docPrompt(doc, question, lim.contextChars);
  const canEdit = doc?.kind === "docx" || doc?.kind === "xlsx";
  const attachList = attachments.length
    ? `\nATTACHED REFERENCES (search/read with tools): ${attachments.map((a) => `${a.id} "${a.name}" ${a.text.length} chars${a.truncated ? " (truncated at upload)" : ""}`).join("; ")}`
    : "";
  const prompt = `${ctx}\n\n${dp.block}${attachList}\n\n${sources.block}\n\nATTORNEY REQUEST:\n${question}`;
  const messages: { role: "user" | "assistant"; content: string }[] = [];
  for (const t of body.history ?? [])
    messages.push({ role: "user", content: t.q }, { role: "assistant", content: t.a });
  messages.push({ role: "user", content: prompt });

  const p = provider(body.runId);
  const fail = (e: unknown) => {
    clearTimeout(overallTimer);
    const err = toAiError(e);
    if (err.status !== 499) console.error("[ai:draft]", err.status ?? "", err.message);
    return Response.json(
      { message: err.message, retryable: err.retryable },
      { status: err.status && err.status >= 400 ? err.status : 500 },
    );
  };
  let result: ReturnType<typeof runOfficeAgent>;
  try {
    result = runOfficeAgent({
      model: p.model,
      providerOptions: opts(effort),
      system: `${BASE_INSTRUCTIONS}\n\n${officeInstructions(effort, doc, dp.coverage, canEdit)}`,
      messages,
      tools,
      effort,
      signal,
    });
  } catch (e) {
    return fail(e);
  }
  const it = result.fullStream[Symbol.asyncIterator]();
  let first: Awaited<ReturnType<typeof it.next>>;
  try {
    first = await it.next();
  } catch (e) {
    return fail(e);
  }
  if (!first.done && first.value.type === "error") return fail(first.value.error);

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
      if (sources.meta.length) emit({ t: "sources", items: sources.meta });
      let outChars = 0;
      let steps = 0;
      let capped = false;
      try {
        let cur = first;
        while (!cur.done) {
          const part = cur.value;
          if (part.type === "text-delta") {
            outChars += part.text.length;
            if (outChars > lim.outputChars) {
              capped = true;
              internal.abort(new Error("output cap"));
              break;
            }
            emit({ t: "delta", text: part.text });
          } else if (part.type === "start-step") steps++;
          else if (part.type === "tool-call")
            emit({
              t: "activity",
              id: part.toolCallId,
              label: activityLabel(part.toolName, part.input),
              status: "running",
            });
          else if (part.type === "tool-result") {
            const out = typeof part.output === "string" ? part.output : "";
            emit({
              t: "activity",
              id: part.toolCallId,
              status: out.startsWith('{"error"') ? "error" : "done",
            });
          } else if (part.type === "tool-error")
            emit({ t: "activity", id: part.toolCallId, status: "error" });
          else if (part.type === "error") throw part.error;
          cur = await it.next();
        }
        if (capped)
          emit({
            t: "notice",
            text: `Answer stopped at the ${effort} length limit. Ask a narrower question or use Advanced.`,
          });
        const usage = await result.totalUsage.then(
          (u) => ({
            inputTokens: u.inputTokens ?? undefined,
            outputTokens: u.outputTokens ?? undefined,
          }),
          () => ({ inputTokens: undefined, outputTokens: undefined }),
        );
        await logRun(auth.supabase, auth.userId, matterId, "draft", effort, usage);
        emit({ t: "done", usage, runId: p.getRunId() ?? null, steps });
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
