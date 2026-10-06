import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, Square } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

/** Dictation: click to record, click again to transcribe; text is handed to onText (never auto-sent). */
const MAX_SECONDS = 240;

function encodeWav(chunks: Float32Array[], rate: number): Blob {
  const len = chunks.reduce((s, c) => s + c.length, 0);
  const buf = new ArrayBuffer(44 + len * 2);
  const v = new DataView(buf);
  const tag = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  tag(0, "RIFF");
  v.setUint32(4, 36 + len * 2, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, "data");
  v.setUint32(40, len * 2, true);
  let o = 44;
  for (const c of chunks)
    for (const x of c) {
      const s = Math.max(-1, Math.min(1, x));
      v.setInt16(o, s * (s < 0 ? 32768 : 32767), true);
      o += 2;
    }
  return new Blob([buf], { type: "audio/wav" });
}

type Rec = { stop: () => Blob; cancel: () => void };

async function startRecording(): Promise<Rec> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  // 16 kHz keeps a 4-minute dictation well under the upload limit.
  let ctx: AudioContext;
  try {
    ctx = new AudioContext({ sampleRate: 16000 });
  } catch {
    ctx = new AudioContext();
  }
  await ctx.resume();
  const src = ctx.createMediaStreamSource(stream);
  const node = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  node.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  src.connect(node);
  node.connect(ctx.destination);
  const teardown = () => {
    stream.getTracks().forEach((t) => t.stop());
    node.onaudioprocess = null;
    node.disconnect();
    src.disconnect();
    void ctx.close();
  };
  return {
    stop: () => {
      const rate = ctx.sampleRate;
      teardown();
      return encodeWav(chunks, rate);
    },
    cancel: teardown,
  };
}

export function MicButton({
  onText,
  disabled,
  className,
}: {
  onText: (text: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "recording" | "transcribing">("idle");
  const [secs, setSecs] = useState(0);
  const rec = useRef<Rec | null>(null);
  const abort = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const busy = useRef(false);

  useEffect(
    () => () => {
      rec.current?.cancel();
      abort.current?.abort();
      if (timer.current) clearInterval(timer.current);
    },
    [],
  );

  async function finish() {
    if (timer.current) clearInterval(timer.current);
    const r = rec.current;
    rec.current = null;
    if (!r) return;
    const blob = r.stop();
    if (blob.size < 4096) {
      setState("idle");
      toast.error("Recording was too short — try again.");
      return;
    }
    setState("transcribing");
    const ac = new AbortController();
    abort.current = ac;
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("Please sign in again.");
      const form = new FormData();
      form.append("file", new File([blob], "dictation.wav", { type: "audio/wav" }));
      const res = await fetch("/api/transcribe", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
        signal: ac.signal,
      });
      const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
      if (!res.ok || !body.text) throw new Error(body.error || "Transcription failed.");
      onText(body.text);
    } catch (e) {
      if (!ac.signal.aborted) toast.error(e instanceof Error ? e.message : "Transcription failed.");
    } finally {
      if (abort.current === ac) abort.current = null;
      setState("idle");
    }
  }

  async function click() {
    if (busy.current) return;
    if (state === "recording") return void finish();
    if (state !== "idle") return;
    busy.current = true;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser can't record audio.");
      rec.current = await startRecording();
      setSecs(0);
      setState("recording");
      const t0 = Date.now();
      timer.current = setInterval(() => {
        const s = Math.floor((Date.now() - t0) / 1000);
        setSecs(s);
        if (s >= MAX_SECONDS) void finish();
      }, 250);
    } catch (e) {
      const denied = e instanceof DOMException && e.name === "NotAllowedError";
      toast.error(
        denied
          ? "Microphone access was blocked. Allow it in your browser's site settings."
          : e instanceof Error
            ? e.message
            : "Couldn't start the microphone.",
      );
    } finally {
      busy.current = false;
    }
  }

  const recording = state === "recording";
  const label = recording
    ? "Stop and transcribe"
    : state === "transcribing"
      ? "Transcribing"
      : "Dictate";
  return (
    <div className="flex items-center gap-1">
      {recording && (
        <span className="flex items-center gap-1 font-mono text-[11px] tabular-nums text-destructive">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-destructive" />
          {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}
        </span>
      )}
      <Button
        type="button"
        size="icon"
        variant={recording ? "destructive" : "ghost"}
        className={cn("h-7 w-7", className)}
        onClick={click}
        disabled={(disabled && !recording) || state === "transcribing"}
        aria-label={label}
        title={label}
        aria-pressed={recording}
      >
        {state === "transcribing" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : recording ? (
          <Square className="h-3 w-3" />
        ) : (
          <Mic className="h-3.5 w-3.5" />
        )}
      </Button>
    </div>
  );
}
