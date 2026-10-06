import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Send, Sparkle } from "lucide-react";
import ReactMarkdown from "react-markdown";
import type { Tables } from "@/integrations/supabase/types";
import { askMatter } from "@/lib/ai.functions";
import { useEffort } from "@/hooks/use-effort";
import { EffortToggle, EffortBadge, ReviewBanner, type Effort } from "@/components/kit";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

type Turn = { q: string; a?: string; effort: Effort; tokens?: number };

const VERBS: Record<string, string[]> = {
  common: ["Catch me up", "What's due in the next two weeks?", "Draft a status email to the client"],
  Corporate: ["List customary diligence items still open", "Flag tax points to raise with the client's CPA"],
  "Real Estate": ["What title and survey items should I check?", "Outline the path to closing"],
  "Estate Planning": ["Summarize the client's goals", "Which documents does this plan need?"],
  Finance: ["Which terms look off-market for a deal this size?", "Where does the closing stand?"],
  Compliance: ["List upcoming filings and notices", "What obligations should we calendar?"],
};

export function AssistPanel({ matter, open, onOpenChange }: { matter: Tables<"matters">; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [effort, setEffort] = useEffort();
  const [q, setQ] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const ask = useServerFn(askMatter);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 50); }, [open, busy]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [turns]);

  async function send(text: string) {
    if (!text.trim() || busy) return;
    const turn: Turn = { q: text, effort };
    setTurns((t) => [...t, turn]);
    setQ("");
    setBusy(true);
    try {
      const r = await ask({ data: { matterId: matter.id, effort, question: text } });
      setTurns((t) => t.map((x) => (x === turn ? { ...x, a: r.text, tokens: (r.usage.inputTokens ?? 0) + (r.usage.outputTokens ?? 0) } : x)));
    } catch (e) {
      toast.error((e as Error).message);
      setTurns((t) => t.filter((x) => x !== turn));
      setQ(text);
    } finally {
      setBusy(false);
    }
  }

  const verbs = [...VERBS.common, ...(VERBS[matter.practice_area] ?? [])];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-lg">
        <SheetHeader className="border-b p-4">
          <SheetTitle className="flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-ink-purple text-primary-foreground"><Sparkle className="h-4 w-4" /></span>
            Assist · <span className="truncate font-normal text-muted-foreground">{matter.title}</span>
          </SheetTitle>
          <div className="flex items-center justify-between pt-2">
            <EffortToggle value={effort} onChange={setEffort} />
            <span className="text-[11px] text-muted-foreground">{effort === "normal" ? "Case management & drafting help" : "Deeper analysis, issue-spotting"}</span>
          </div>
        </SheetHeader>
        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {!turns.length && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">Assist only looks at this matter. It prepares — you review and decide.</p>
              <div className="flex flex-wrap gap-2">
                {verbs.map((v) => (
                  <button key={v} onClick={() => send(v)} className="rounded-full border bg-raised px-3 py-1.5 text-xs hover:border-ink-purple hover:text-ink-purple">{v}</button>
                ))}
              </div>
            </div>
          )}
          {turns.map((t, i) => (
            <div key={i} className="space-y-2">
              <div className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-foreground px-3 py-2 text-sm text-background">{t.q}</div>
              {t.a ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground"><EffortBadge effort={t.effort} />{t.tokens ? `${t.tokens.toLocaleString()} tokens` : null}</div>
                  <div className="md text-sm"><ReactMarkdown>{t.a}</ReactMarkdown></div>
                  {i === turns.length - 1 && <ReviewBanner />}
                </div>
              ) : (
                <div className="flex gap-1 py-2"><span className="h-2 w-2 animate-bounce rounded-full bg-ink-purple" /><span className="h-2 w-2 animate-bounce rounded-full bg-ink-purple [animation-delay:120ms]" /><span className="h-2 w-2 animate-bounce rounded-full bg-ink-purple [animation-delay:240ms]" /></div>
              )}
            </div>
          ))}
          <div ref={endRef} />
        </div>
        <form className="border-t p-3" onSubmit={(e) => { e.preventDefault(); send(q); }}>
          <div className="flex items-end gap-2 rounded-xl border bg-card p-2">
            <Textarea
              ref={inputRef}
              rows={2}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(q); } }}
              placeholder="Ask about this matter…"
              className="min-h-0 resize-none border-0 p-1 shadow-none focus-visible:ring-0"
            />
            <Button type="submit" size="icon" disabled={busy || !q.trim()} aria-label="Send"><Send className="h-4 w-4" /></Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
