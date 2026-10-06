import { createFileRoute } from "@tanstack/react-router";

// Voice dictation for the AI chat boxes: bearer-verified caller uploads one WAV recording,
// we forward it to the Lovable AI Gateway transcription endpoint and return plain text.
// Audio is not stored. Only 429/5xx are retryable (gateway error semantics).
const GATEWAY = "https://ai.gateway.lovable.dev/v1";
const MODEL = "openai/gpt-transcribe";
const MAX_BYTES = 24_000_000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function describe(status: number): string {
  if (status === 402) return "AI credits are used up. Add credits in Settings → Plans & credits.";
  if (status === 403) return "Voice dictation is not available for this workspace right now.";
  if (status === 429) return "Too many requests — wait a moment and try again.";
  if (status === 400) return "The recording couldn't be read. Try recording again.";
  if (status >= 500) return "The transcription service had a problem. Try again shortly.";
  return "Transcription failed.";
}

export const Route = createFileRoute("/api/transcribe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { authFromRequest } = await import("@/lib/auth.server");
        const auth = await authFromRequest(request);
        if (!auth) return json({ error: "Please sign in again." }, 401);
        const key = process.env["LOVABLE_API_KEY"];
        if (!key) return json({ error: "AI is not configured." }, 500);

        const declared = Number(request.headers.get("content-length") ?? "");
        if (Number.isFinite(declared) && declared > MAX_BYTES + 10_000)
          return json({ error: "Recording is too long. Keep dictation under about 4 minutes." }, 413);

        let file: File | null = null;
        try {
          const form = await request.formData();
          const f = form.get("file");
          if (f instanceof File) file = f;
        } catch {
          return json({ error: "Invalid upload." }, 400);
        }
        if (!file || file.size < 2048) return json({ error: "Recording was empty — try again." }, 400);
        if (file.size > MAX_BYTES)
          return json({ error: "Recording is too long. Keep dictation under about 4 minutes." }, 413);
        if (!file.type.startsWith("audio/")) return json({ error: "Unexpected file type." }, 400);

        const body = new FormData();
        body.append("model", MODEL);
        body.append("file", file, "dictation.wav");
        body.append("response_format", "json");
        body.append("stream", "true");
        body.append("prompt", "Legal dictation for a law firm matter. Preserve names, dates and amounts.");

        let res: Response | null = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          res = await fetch(`${GATEWAY}/audio/transcriptions`, {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, "X-Lovable-AIG-SDK": "fetch" },
            body,
            signal: request.signal,
          });
          if (res.status !== 429 && res.status < 500) break;
          if (attempt === 0) await new Promise((r) => setTimeout(r, 1200 + Math.random() * 600));
        }
        if (!res || !res.ok || !res.body) {
          const status = res?.status ?? 502;
          return json({ error: describe(status), retryable: status === 429 || status >= 500 }, status);
        }

        // Consume the SSE stream; prefer the final "done" text, else join deltas.
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        let deltas = "";
        let done: string | null = null;
        const handle = (line: string) => {
          if (!line.startsWith("data:")) return;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") return;
          try {
            const ev = JSON.parse(data) as { type?: string; delta?: string; text?: string };
            if (ev.type === "transcript.text.delta" && ev.delta) deltas += ev.delta;
            if (ev.type === "transcript.text.done" && typeof ev.text === "string") done = ev.text;
          } catch {
            /* ignore keep-alives */
          }
        };
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n")) >= 0) {
            handle(buf.slice(0, i).trim());
            buf = buf.slice(i + 1);
          }
        }
        handle(buf.trim());
        const text = (done ?? deltas).trim();
        if (!text) return json({ error: "No speech was detected. Try again closer to the mic." }, 422);
        return json({ text });
      },
    },
  },
});
