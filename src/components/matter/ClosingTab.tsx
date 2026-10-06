import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Plus, ListChecks } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { draftClosingChecklist } from "@/lib/ai.functions";
import { tableQ, logActivity } from "@/lib/data";
import { mut, tryAction } from "@/lib/mutate";
import { useEffort } from "@/hooks/use-effort";
import { Panel, ListState, DeleteButton, EffortToggle, UsageNote, ReviewBanner, Why } from "@/components/kit";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { CLOSING_DONE } from "./Overview";

export const CLOSING_STATUS = ["Open", "Drafting", "In review", "Agreed form", "Final", "Executed", "Received", "N/A"];
const tone = (s: string) =>
  ["Final", "Executed", "Received"].includes(s) ? "text-ink-green" : s === "N/A" ? "text-muted-foreground" : s === "Open" ? "text-ink-red" : "text-ink-amber";

type Result = Awaited<ReturnType<typeof draftClosingChecklist>>;

export function ClosingTab({ matterId }: { matterId: string }) {
  const q = useQuery(tableQ("closing_items", matterId));
  const data = q.data ?? [];
  const qc = useQueryClient();
  const inv = () => { qc.invalidateQueries({ queryKey: ["closing_items", matterId] }); qc.invalidateQueries({ queryKey: ["activity", matterId] }); };
  const [d, setD] = useState("");
  const [r, setR] = useState("");
  const [effort, setEffort] = useEffort();
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sugg, setSugg] = useState<(Result & { effort: typeof effort }) | null>(null);
  const [pick, setPick] = useState<Set<number>>(new Set());
  const run = useServerFn(draftClosingChecklist);

  async function add() {
    if (!d.trim() || adding) return;
    setAdding(true);
    await tryAction(async () => {
      await mut(supabase.from("closing_items").insert({ matter_id: matterId, deliverable: d.trim(), responsible: r.trim() || null, position: (data.at(-1)?.position ?? 0) + 1 }).select("id"), { success: "Item added" });
      setD(""); setR(""); inv();
    });
    setAdding(false);
  }
  async function patch(id: string, p: { responsible?: string | null; status?: string; due_on?: string | null; notes?: string | null }) {
    await tryAction(async () => {
      await mut(supabase.from("closing_items").update(p).eq("id", id).select("id"));
      if (p.status) await logActivity(matterId, `Closing item marked ${p.status}`);
      inv();
    });
  }
  async function del(id: string) {
    await tryAction(async () => {
      await mut(supabase.from("closing_items").delete().eq("id", id).select("id"), { success: "Item removed" });
      inv();
    });
  }
  async function suggest() {
    setBusy(true); setError(null);
    try {
      const res = await run({ data: { matterId, effort } });
      setSugg({ ...res, effort });
      setPick(new Set(res.items.map((_, i) => i)));
      if (!res.items.length) toast("Nothing to add — the checklist already covers the customary items.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function addSugg() {
    if (!sugg || adding) return;
    setAdding(true);
    await tryAction(async () => {
      const base = data.at(-1)?.position ?? 0;
      const rows = sugg.items.filter((_, i) => pick.has(i)).map((s, i) => ({ matter_id: matterId, deliverable: s.deliverable, responsible: s.responsible || null, position: base + i + 1 }));
      if (rows.length) await mut(supabase.from("closing_items").insert(rows).select("id"), { success: `${rows.length} items added to the checklist` });
      await logActivity(matterId, `Added ${rows.length} closing items from Assist`);
      setSugg(null); inv();
    });
    setAdding(false);
  }

  const done = data.filter((x) => CLOSING_DONE.includes(x.status)).length;
  const pct = data.length ? Math.round((done / data.length) * 100) : 0;

  return (
    <div className="space-y-4">
      <Panel
        title={q.data ? `Closing checklist · ${done}/${data.length}` : "Closing checklist"}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <EffortToggle value={effort} onChange={setEffort} />
            <Button size="sm" variant="outline" onClick={suggest} disabled={busy}><ListChecks className="mr-1.5 h-3.5 w-3.5" />{busy ? "Preparing…" : "Suggest items"}</Button>
          </div>
        }
      >
        {data.length > 0 && <div className="mb-4 h-1.5 overflow-hidden rounded-full bg-raised" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><div className="h-full bg-ink-green transition-all" style={{ width: `${pct}%` }} /></div>}
        {error && <p className="mb-3 rounded-lg border border-ink-red/30 bg-ink-red/5 px-3 py-2 text-sm">{error}</p>}
        <form className="mb-4 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <Input className="min-w-[220px] flex-1" placeholder="Deliverable" value={d} onChange={(e) => setD(e.target.value)} aria-label="Deliverable" />
          <Input className="w-44" placeholder="Responsible" value={r} onChange={(e) => setR(e.target.value)} aria-label="Responsible" />
          <Button type="submit" disabled={!d.trim() || adding} aria-label="Add item"><Plus className="h-4 w-4" /></Button>
        </form>
        <ListState query={q} empty="No closing items yet. Add them one by one, or ask Assist to suggest the customary list for this kind of deal.">
          {(rows) => (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="text-left text-xs text-muted-foreground"><tr><th className="py-1.5 pr-2">#</th><th className="pr-2">Deliverable</th><th className="pr-2">Responsible</th><th className="pr-2">Status</th><th className="pr-2">Due</th><th className="pr-2">Notes</th><th /></tr></thead>
                <tbody className="divide-y">
                  {rows.map((x, i) => (
                    <tr key={x.id} className="group align-top">
                      <td className="py-2 pr-2 text-xs text-muted-foreground">{i + 1}</td>
                      <td className="py-2 pr-2 font-medium">{x.deliverable}</td>
                      <td className="py-1 pr-2"><Input className="h-8 w-36 bg-transparent" defaultValue={x.responsible ?? ""} aria-label="Responsible" onBlur={(e) => e.target.value !== (x.responsible ?? "") && patch(x.id, { responsible: e.target.value || null })} /></td>
                      <td className="py-1 pr-2">
                        <Select value={x.status} onValueChange={(v) => patch(x.id, { status: v })}>
                          <SelectTrigger className={`h-8 w-32 ${tone(x.status)}`} aria-label="Status"><SelectValue /></SelectTrigger>
                          <SelectContent>{CLOSING_STATUS.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
                        </Select>
                      </td>
                      <td className="py-1 pr-2"><Input type="date" className="h-8 w-36" defaultValue={x.due_on ?? ""} aria-label="Due" onBlur={(e) => (e.target.value || null) !== x.due_on && patch(x.id, { due_on: e.target.value || null })} /></td>
                      <td className="py-1 pr-2"><Input className="h-8 min-w-[140px] bg-transparent" defaultValue={x.notes ?? ""} aria-label="Notes" onBlur={(e) => e.target.value !== (x.notes ?? "") && patch(x.id, { notes: e.target.value || null })} /></td>
                      <td className="py-1.5"><DeleteButton what="closing item" onConfirm={() => del(x.id)} className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100 max-sm:opacity-100" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </ListState>
      </Panel>
      {sugg && sugg.items.length > 0 && (
        <Panel title="Suggested closing items" action={<UsageNote effort={sugg.effort} usage={sugg.usage} />}>
          <div className="space-y-3">
            <ReviewBanner />
            <ul className="space-y-2">
              {sugg.items.map((s, i) => (
                <li key={i} className="flex gap-2 rounded-lg border p-2">
                  <Checkbox className="mt-0.5" checked={pick.has(i)} onCheckedChange={(v) => { const n = new Set(pick); if (v) n.add(i); else n.delete(i); setPick(n); }} aria-label={s.deliverable} />
                  <div className="text-sm">{s.deliverable} {s.responsible && <span className="text-xs text-muted-foreground">· {s.responsible}</span>}<Why text={s.why} /></div>
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setSugg(null)} disabled={adding}>Discard</Button>
              <Button onClick={addSugg} disabled={adding || pick.size === 0}>{adding ? "Adding…" : `Add ${pick.size} selected`}</Button>
            </div>
          </div>
        </Panel>
      )}
    </div>
  );
}
