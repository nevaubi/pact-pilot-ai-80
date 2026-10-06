import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { Mic, Square, Wand2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { supabase } from "@/integrations/supabase/client";
import { processMeetingNotes } from "@/lib/ai.functions";
import { logActivity } from "@/lib/data";
import { mut, tryAction } from "@/lib/mutate";
import { useEffort } from "@/hooks/use-effort";
import { EffortToggle, UsageNote, ReviewBanner, Why } from "@/components/kit";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

type Result = Awaited<ReturnType<typeof processMeetingNotes>>;
type Rec = {
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: (e: {
    resultIndex: number;
    results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
  }) => void;
  onend: () => void;
  onerror: (e: { error?: string }) => void;
};

export function MeetingNotesDialog({
  matterId,
  open,
  onOpenChange,
}: {
  matterId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [notes, setNotes] = useState("");
  const [effort, setEffort] = useEffort();
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [res, setRes] = useState<(Result & { effort: typeof effort }) | null>(null);
  const [title, setTitle] = useState("");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [listening, setListening] = useState(false);
  const recRef = useRef<Rec | null>(null);
  const run = useServerFn(processMeetingNotes);
  const qc = useQueryClient();

  useEffect(() => () => recRef.current?.stop(), []);

  function dictate() {
    const W = window as unknown as {
      SpeechRecognition?: new () => Rec;
      webkitSpeechRecognition?: new () => Rec;
    };
    const SR = W.SpeechRecognition ?? W.webkitSpeechRecognition;
    if (!SR) {
      toast.error("Dictation isn't supported in this browser.", {
        description: "Chrome, Edge and Safari support it. You can still type your notes.",
      });
      return;
    }
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (e) => {
      let t = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r?.isFinal) t += r[0].transcript + " ";
      }
      if (t) setNotes((n) => (n ? n + " " : "") + t.trim());
    };
    rec.onerror = (e) => {
      setListening(false);
      if (e.error === "not-allowed")
        toast.error("Microphone access was blocked.", {
          description: "Allow the microphone in your browser settings to dictate.",
        });
    };
    rec.onend = () => setListening(false);
    rec.start();
    recRef.current = rec;
    setListening(true);
  }

  async function process() {
    setBusy(true);
    setError(null);
    try {
      const r = await run({ data: { matterId, effort, notes } });
      setRes({ ...r, effort });
      setTitle(r.title);
      setPicked(new Set(r.tasks.map((_, i) => i)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveRaw() {
    setSaving(true);
    await tryAction(async () => {
      await mut(
        supabase
          .from("notes")
          .insert({
            matter_id: matterId,
            title: "Meeting notes",
            body: notes.trim(),
            kind: "meeting",
          })
          .select("id"),
      );
      await logActivity(matterId, "Filed meeting notes");
      done("Meeting notes saved");
    });
    setSaving(false);
  }

  async function saveProcessed() {
    if (!res) return;
    setSaving(true);
    await tryAction(async () => {
      await mut(
        supabase
          .from("notes")
          .insert({
            matter_id: matterId,
            title: title.trim() || res.title,
            body: res.summary,
            kind: "meeting",
          })
          .select("id"),
      );
      const tasks = res.tasks
        .filter((_, i) => picked.has(i))
        .map((t) => ({
          matter_id: matterId,
          title: t.title,
          assignee: t.assignee || null,
          source: "assist",
        }));
      if (tasks.length) await mut(supabase.from("tasks").insert(tasks).select("id"));
      await logActivity(
        matterId,
        `Filed meeting memo "${title.trim() || res.title}"${tasks.length ? ` with ${tasks.length} tasks` : ""}`,
      );
      done(tasks.length ? `Memo saved with ${tasks.length} tasks` : "Memo saved");
    });
    setSaving(false);
  }

  function done(msg: string) {
    ["notes", "tasks", "activity"].forEach((k) =>
      qc.invalidateQueries({ queryKey: [k, matterId] }),
    );
    qc.invalidateQueries({ queryKey: ["today-tasks"] });
    setNotes("");
    setRes(null);
    setError(null);
    onOpenChange(false);
    toast.success(msg);
  }

  function close(o: boolean) {
    if (!o && (busy || saving)) return;
    if (!o) recRef.current?.stop();
    onOpenChange(o);
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Meeting notes</DialogTitle>
          <DialogDescription>
            Type or dictate rough notes. Save them as they are, or let Assist tidy them into a memo
            with follow-up tasks you can tick.
          </DialogDescription>
        </DialogHeader>
        {!res ? (
          <div className="space-y-3">
            <Textarea
              rows={10}
              placeholder="e.g. call w/ seller's counsel — closing moved to Dec 15, landlord consent still open, they owe financials Friday…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              aria-label="Rough notes"
            />
            {error && (
              <p className="rounded border border-ink-red/30 bg-ink-red/5 px-3 py-2 text-sm">
                {error}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={dictate} type="button">
                {listening ? (
                  <>
                    <Square className="mr-1.5 h-3.5 w-3.5 text-ink-red" />
                    Stop
                  </>
                ) : (
                  <>
                    <Mic className="mr-1.5 h-3.5 w-3.5" />
                    Dictate
                  </>
                )}
              </Button>
              {listening && <span className="text-xs text-ink-red">Listening…</span>}
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <EffortToggle value={effort} onChange={setEffort} />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!notes.trim() || saving || busy}
                  onClick={saveRaw}
                >
                  {saving ? "Saving…" : "Save as is"}
                </Button>
                <Button
                  size="sm"
                  disabled={busy || saving || notes.trim().length < 5}
                  onClick={process}
                >
                  <Wand2 className="mr-1.5 h-3.5 w-3.5" />
                  {busy ? "Tidying…" : error ? "Try again" : "Tidy up"}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <ReviewBanner />
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="h-8 flex-1 font-semibold"
                aria-label="Memo title"
              />
              <UsageNote effort={res.effort} usage={res.usage} />
            </div>
            <div className="md rounded bg-raised p-3 text-sm">
              <ReactMarkdown>{res.summary}</ReactMarkdown>
            </div>
            {res.tasks.length > 0 && (
              <div>
                <p className="mb-1 text-xs font-semibold text-muted-foreground">
                  Suggested tasks — tick the ones to add
                </p>
                <ul className="space-y-2">
                  {res.tasks.map((t, i) => (
                    <li key={i} className="flex gap-2 rounded border p-2">
                      <Checkbox
                        className="mt-0.5"
                        checked={picked.has(i)}
                        onCheckedChange={(v) => {
                          const s = new Set(picked);
                          if (v) s.add(i);
                          else s.delete(i);
                          setPicked(s);
                        }}
                        aria-label={t.title}
                      />
                      <div className="text-sm">
                        {t.title}{" "}
                        {t.assignee && (
                          <span className="text-xs text-muted-foreground">· {t.assignee}</span>
                        )}
                        <Why text={t.why} />
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none">Your original notes</summary>
              <p className="mt-1 whitespace-pre-wrap border-l-2 pl-2">{notes}</p>
            </details>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={() => setRes(null)} disabled={saving}>
                Back
              </Button>
              <Button onClick={saveProcessed} disabled={saving}>
                {saving ? "Saving…" : `Save memo${picked.size ? ` + ${picked.size} tasks` : ""}`}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
