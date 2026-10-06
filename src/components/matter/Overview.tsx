import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import { Panel } from "@/components/kit";
import { STATUSES, tableQ, fmtDate, daysUntil, logActivity } from "@/lib/data";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

export function Overview({ matter, onTab }: { matter: Tables<"matters">; onTab: (t: string) => void }) {
  const qc = useQueryClient();
  const tasks = useQuery(tableQ("tasks", matter.id));
  const deadlines = useQuery(tableQ("deadlines", matter.id));
  const closing = useQuery(tableQ("closing_items", matter.id));
  const [summary, setSummary] = useState(matter.summary ?? "");

  async function update(patch: Partial<Tables<"matters">>) {
    await supabase.from("matters").update(patch).eq("id", matter.id);
    if (patch.status) await logActivity(matter.id, `Status changed to ${patch.status}`);
    qc.invalidateQueries({ queryKey: ["matter", matter.id] });
    qc.invalidateQueries({ queryKey: ["matters"] });
  }

  const openTasks = tasks.data?.filter((t) => !t.done) ?? [];
  const next = deadlines.data?.filter((d) => daysUntil(d.due_on) >= 0)[0];
  const closed = closing.data?.filter((c) => ["Final", "Executed", "Received", "Done"].includes(c.status)).length ?? 0;
  const total = closing.data?.length ?? 0;

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <Panel title="Summary">
          <Textarea rows={4} value={summary} onChange={(e) => setSummary(e.target.value)} className="bg-raised" />
          {summary !== (matter.summary ?? "") && (
            <Button size="sm" className="mt-2" onClick={() => update({ summary })}>Save summary</Button>
          )}
        </Panel>
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label="Open tasks" value={String(openTasks.length)} onClick={() => onTab("Tasks")} tone="text-ink-blue" />
          <Stat label="Next deadline" value={next ? `${daysUntil(next.due_on)}d` : "—"} sub={next?.title} onClick={() => onTab("Deadlines")} tone="text-ink-amber" />
          <Stat label="Closing" value={total ? `${closed}/${total}` : "—"} sub="deliverables final" onClick={() => onTab("Closing")} tone="text-ink-green" />
        </div>
      </div>
      <Panel title="Details">
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">Status</dt>
            <dd>
              <Select value={matter.status} onValueChange={(v) => update({ status: v })}>
                <SelectTrigger className="mt-1 h-8"><SelectValue /></SelectTrigger>
                <SelectContent>{STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
              </Select>
            </dd>
          </div>
          <div><dt className="text-xs text-muted-foreground">Responsible</dt><dd>{matter.responsible ?? "—"}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Opened</dt><dd>{fmtDate(matter.opened_on)}</dd></div>
        </dl>
      </Panel>
    </div>
  );
}

function Stat({ label, value, sub, onClick, tone }: { label: string; value: string; sub?: string | null | undefined; onClick: () => void; tone: string }) {
  return (
    <button onClick={onClick} className="rounded-xl border bg-card p-4 text-left hover:shadow-sm">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-2xl font-semibold ${tone}`}>{value}</p>
      {sub && <p className="truncate text-xs text-muted-foreground">{sub}</p>}
    </button>
  );
}
