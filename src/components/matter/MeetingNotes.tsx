import { useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { Mic, Square, Wand2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { supabase } from "@/integrations/supabase/client";
import { processMeetingNotes } from "@/lib/ai.functions";
import { logActivity } from "@/lib/data";
import { useEffort } from "@/hooks/use-effort";
import { EffortToggle, EffortBadge, ReviewBanner, Why } from "@/components/kit";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";

type Result = Awaited<ReturnType<typeof processMeetingNotes>>;

export function MeetingNotesDialog({ matterId, open, onOpenChange }: { matterId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [notes, setNotes] = useState("");
  const [effort, setEffort] = useEffort();
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<(Result & { effort: typeof effort }) | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [listening, setListening] = useState(false);
  const recRef = useRef<{ stop: () => void } | null>(null);
  const run = useServerFn(processMeetingNotes);
  const qc = useQueryClient();

  function dictate() {
    const W = window as unknown as { SpeechRecognition?: new () => never; webkitSpeechRecognition?: new () => never };
    const SR = W.SpeechRecognition ?? W.webkitSpeechRecognition;
    if (!SR) { toast.error("Dictation isn't supported in this browser."); return; }
    if (listening) { recRef.current?.stop(); return; }
    const rec = new SR() as unknown as {
      continuous: boolean; interimResults: boolean; start: () => void; stop: () => void;
      onresult: (e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void;
      onend: () => void;
    };
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (e) => {
      let t = "";
      for (let i = e.resultIndex; i < e.results.length; i++) { const r = e.results[i]; if (r?.isFinal) t += r[0].transcript + " "; }
      if (t) setNotes((n) => (n ? n + " " : "") + t.trim());
    };
    rec.onend = () => setListening(false);
    rec.start();
    recRef.current = rec;
    setListening(true);
  }

  async function process() {
    setBusy(true);
    try {
      const r = await run({ data: { matterId, effort, notes } });
      setRes({ ...r, effort });
      setPicked(new Set(r.tasks.map((_, i) => i)));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveRaw() {
    await supabase.from("notes").insert({ matter_id: matterId, title: "Meeting notes", body: notes, kind: "meeting" });
    done();
  }

  async function saveProcessed() {
    if (!res) return;
    await supabase.from("notes").insert({ matter_id: matterId, title: res.title, body: res.summary, kind: "meeting" });
    const tasks = res.tasks.filter((_, i) => picked.has(i)).map((t) => ({ matter_id: matterId, title: t.title, assignee: t.assignee, source: "assist" }));
    if (tasks.length) await supabase.from("tasks").insert(tasks);
    await logActivity(matterId, `Filed meeting memo "${res.title}"${tasks.length ? ` with ${tasks.length} tasks` : ""}`);
    done();
  }

  function done() {
    ["notes", "tasks", "activity"].forEach((k) => qc.invalidateQueries({ queryKey: [k, matterId] }));
    setNotes(""); setRes(null);
    onOpenChange(false);
    toast.success("Saved to the matter");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader><DialogTitle>Meeting notes</DialogTitle></DialogHeader>
        {!res ? (
          <div className="space-y-3">
            <Textarea rows={10} placeholder="Type or dictate rough notes from the call or meeting…" value={notes} onChange={(e) => setNotes(e.target.value)} />
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={dictate}>
                {listening ? <><Square className="mr-1.5 h-3.5 w-3.5 text-ink-red" />Stop</> : <><Mic className="mr-1.5 h-3.5 w-3.5" />Dictate</>}
              </Button>
              <div className="ml-auto flex items-center gap-2">
                <EffortToggle value={effort} onChange={setEffort} />
                <Button variant="outline" size="sm" disabled={!notes.trim()} onClick={saveRaw}>Save as is</Button>
                <Button size="sm" disabled={busy || notes.trim().length < 5} onClick={process}>
                  <Wand2 className="mr-1.5 h-3.5 w-3.5" />{busy ? "Tidying…" : "Tidy up"}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <ReviewBanner />
            <div className="flex items-center gap-2"><h3 className="font-semibold">{res.title}</h3><EffortBadge effort={res.effort} /></div>
            <div className="md rounded-lg bg-raised p-3 text-sm"><ReactMarkdown>{res.summary}</ReactMarkdown></div>
            {res.tasks.length > 0 && (
              <div>
                <p className="mb-1 text-xs font-semibold text-muted-foreground">Suggested tasks — tick the ones to add</p>
                <ul className="space-y-2">
                  {res.tasks.map((t, i) => (
                    <li key={i} className="flex gap-2 rounded-lg border p-2">
                      <Checkbox checked={picked.has(i)} onCheckedChange={(v) => { const s = new Set(picked); if (v) s.add(i); else s.delete(i); setPicked(s); }} />
                      <div className="text-sm">{t.title} <span className="text-xs text-muted-foreground">· {t.assignee}</span><Why text={t.why} /></div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setRes(null)}>Back</Button>
              <Button onClick={saveProcessed}>Save to matter</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
