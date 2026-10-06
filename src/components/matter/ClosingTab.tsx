import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Plus, Trash2, ListChecks } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { draftClosingChecklist } from "@/lib/ai.functions";
import { tableQ, logActivity } from "@/lib/data";
import { useEffort } from "@/hooks/use-effort";
import { Panel, Empty, EffortToggle, ReviewBanner, Why } from "@/components/kit";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";

const STATUS = ["Open", "Drafting", "In review", "Agreed form", "Final", "Executed", "Received", "N/A"];
const tone = (s: string) =>
  ["Final", "Executed", "Received"].includes(s) ? "text-ink-green" : s === "N/A" ? "text-muted-foreground" : s === "Open" ? "text-ink-red" : "text-ink-amber";

type Suggest = Awaited<ReturnType<typeof draftClosingChecklist>>["items"];

export function ClosingTab({ matterId }: { matterId: string }) {
  const { data = [] } = useQuery(tableQ("closing_items", matterId));
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ["closing_items", matterId] });
  const [d, setD] = useState("");
  const [r, setR] = useState("");
  const [effort, setEffort] = useEffort();
  const [busy, setBusy] = useState(false);
  const [sugg, setSugg] = useState<Suggest | null>(null);
  const [pick, setPick] = useState<Set<number>>(new Set());
  const run = useServerFn(draftClosingChecklist);

  async function add() {
    if (!d.trim()) return;
    await supabase.from("closing_items").insert({ matter_id: matterId, deliverable: d, responsible: r || null, position: data.length + 1 });
    setD(""); setR(""); inv();
  }
  async function patch(id: string, p: Record<string, unknown>) {
    await supabase.from("closing_items").update(p).eq("id", id);
    inv();
  }
  async function suggest() {
    setBusy(true);
    try {
      const res = await run({ data: { matterId, effort } });
      setSugg(res.items);
      setPick(new Set(res.items.map((_, i) => i)));
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  async function addSugg() {
    if (!sugg) return;
    const rows = sugg.filter((_, i) => pick.has(i)).map((s, i) => ({ matter_id: matterId, deliverable: s.deliverable, responsible: s.responsible, position: data.length + i + 1 }));
    if (rows.length) await supabase.from("closing_items").insert(rows);
    await logActivity(matterId, `Added ${rows.length} closing items from Assist`);
    setSugg(null); inv();
  }

  const done = data.filter((x) => ["Final", "Executed", "Received", "N/A"].includes(x.status)).length;
  const pct = data.length ? Math.round((done / data.length) * 100) : 0;

  return (
    <div className="space-y-4">
      <Panel
        title={`Closing checklist · ${done}/${data.length}`}
        action={
          <div className="flex items-center gap-2">
            <EffortToggle value={effort} onChange={setEffort} />
            <Button size="sm" variant="outline" onClick={suggest} disabled={busy}><ListChecks className="mr-1.5 h-3.5 w-3.5" />{busy ? "Preparing…" : "Suggest items"}</Button>
          </div>
        }
      >
        <div className="mb-4 h-1.5 overflow-hidden rounded-full bg-raised"><div className="h-full bg-ink-green transition-all" style={{ width: `${pct}%` }} /></div>
        <div className="mb-4 flex flex-wrap gap-2">
          <Input className="min-w-[220px] flex-1" placeholder="Deliverable" value={d} onChange={(e) => setD(e.target.value)} />
          <Input className="w-44" placeholder="Responsible" value={r} onChange={(e) => setR(e.target.value)} />
          <Button onClick={add}><Plus className="h-4 w-4" /></Button>
        </div>
        {!data.length ? <Empty>No closing items yet. Add them, or ask for suggestions.</Empty> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground"><tr><th className="py-1.5 pr-2">#</th><th className="pr-2">Deliverable</th><th className="pr-2">Responsible</th><th className="pr-2">Status</th><th className="pr-2">Due</th><th className="pr-2">Notes</th><th /></tr></thead>
              <tbody className="divide-y">
                {data.map((x, i) => (
                  <tr key={x.id} className="group align-top">
                    <td className="py-2 pr-2 text-xs text-muted-foreground">{i + 1}</td>
                    <td className="py-2 pr-2 font-medium">{x.deliverable}</td>
                    <td className="py-1 pr-2"><Input className="h-8 w-36 bg-transparent" defaultValue={x.responsible ?? ""} onBlur={(e) => e.target.value !== (x.responsible ?? "") && patch(x.id, { responsible: e.target.value })} /></td>
                    <td className="py-1 pr-2">
                      <Select value={x.status} onValueChange={(v) => patch(x.id, { status: v })}>
                        <SelectTrigger className={`h-8 w-32 ${tone(x.status)}`}><SelectValue /></SelectTrigger>
                        <SelectContent>{STATUS.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
                      </Select>
                    </td>
                    <td className="py-1 pr-2"><Input type="date" className="h-8 w-36" defaultValue={x.due_on ?? ""} onBlur={(e) => patch(x.id, { due_on: e.target.value || null })} /></td>
                    <td className="py-1 pr-2"><Input className="h-8 min-w-[140px] bg-transparent" defaultValue={x.notes ?? ""} onBlur={(e) => e.target.value !== (x.notes ?? "") && patch(x.id, { notes: e.target.value })} /></td>
                    <td className="py-2"><button aria-label="Delete" className="opacity-0 group-hover:opacity-100" onClick={async () => { await supabase.from("closing_items").delete().eq("id", x.id); inv(); }}><Trash2 className="h-4 w-4 text-muted-foreground" /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {sugg && (
        <Panel title="Suggested closing items">
          <div className="space-y-3">
            <ReviewBanner />
            <ul className="space-y-2">
              {sugg.map((s, i) => (
                <li key={i} className="flex gap-2 rounded-lg border p-2">
                  <Checkbox checked={pick.has(i)} onCheckedChange={(v) => { const n = new Set(pick); if (v) n.add(i); else n.delete(i); setPick(n); }} />
                  <div className="text-sm">{s.deliverable} <span className="text-xs text-muted-foreground">· {s.responsible}</span><Why text={s.why} /></div>
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setSugg(null)}>Discard</Button><Button onClick={addSugg}>Add selected</Button></div>
          </div>
        </Panel>
      )}
    </div>
  );
}
