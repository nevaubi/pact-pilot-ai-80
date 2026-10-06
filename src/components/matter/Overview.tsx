import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Pencil } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import { Panel } from "@/components/kit";
import { STATUSES, tableQ, fmtDate, daysUntil, logActivity } from "@/lib/data";
import { mut, tryAction } from "@/lib/mutate";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

export const CLOSING_DONE = ["Final", "Executed", "Received", "N/A"];

export function Overview({ matter, onTab, onEdit }: { matter: Tables<"matters">; onTab: (t: string) => void; onEdit: () => void }) {
  const qc = useQueryClient();
  const tasks = useQuery(tableQ("tasks", matter.id));
  const deadlines = useQuery(tableQ("deadlines", matter.id));
  const closing = useQuery(tableQ("closing_items", matter.id));
  const [summary, setSummary] = useState(matter.summary ?? "");
  const [saving, setSaving] = useState(false);
  useEffect(() => setSummary(matter.summary ?? ""), [matter.summary]);

  async function update(patch: Partial<Tables<"matters">>, msg: string) {
    setSaving(true);
    await tryAction(async () => {
      await mut(supabase.from("matters").update(patch).eq("id", matter.id).select("id"), { success: msg });
      if (patch.status) await logActivity(matter.id, `Status changed to ${patch.status}`);
      qc.invalidateQueries({ queryKey: ["matter", matter.id] });
      qc.invalidateQueries({ queryKey: ["matters"] });
      qc.invalidateQueries({ queryKey: ["activity", matter.id] });
    });
    setSaving(false);
  }

  const openTasks = tasks.data?.filter((t) => !t.done) ?? [];
  const overdue = tasks.data?.filter((t) => !t.done && t.due_on && daysUntil(t.due_on) < 0).length ?? 0;
  const next = deadlines.data?.filter((d) => daysUntil(d.due_on) >= 0).sort((a, b) => a.due_on.localeCompare(b.due_on))[0];
  const closed = closing.data?.filter((c) => CLOSING_DONE.includes(c.status)).length ?? 0;
  const total = closing.data?.length ?? 0;
  const dirty = summary !== (matter.summary ?? "");

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <Panel title="Summary">
          <Textarea rows={4} value={summary} onChange={(e) => setSummary(e.target.value)} className="bg-raised" placeholder="What is this matter, and where does it stand?" />
          {dirty && (
            <div className="mt-2 flex gap-2">
              <Button size="sm" disabled={saving} onClick={() => update({ summary: summary.trim() || null }, "Summary saved")}>{saving ? "Saving…" : "Save summary"}</Button>
              <Button size="sm" variant="ghost" onClick={() => setSummary(matter.summary ?? "")}>Discard</Button>
            </div>
          )}
        </Panel>
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label="Open tasks" value={tasks.isPending ? "…" : String(openTasks.length)} sub={overdue ? `${overdue} overdue` : undefined} onClick={() => onTab("Tasks")} tone={overdue ? "text-ink-red" : "text-ink-blue"} />
          <Stat label="Next deadline" value={deadlines.isPending ? "…" : next ? (daysUntil(next.due_on) === 0 ? "Today" : `${daysUntil(next.due_on)}d`) : "—"} sub={next?.title ?? "Nothing scheduled"} onClick={() => onTab("Deadlines")} tone="text-ink-amber" />
          <Stat label="Closing" value={closing.isPending ? "…" : total ? `${closed}/${total}` : "—"} sub={total ? "deliverables final" : "No checklist yet"} onClick={() => onTab("Closing")} tone="text-ink-green" />
        </div>
      </div>
      <Panel title="Details" action={<Button size="sm" variant="ghost" onClick={onEdit}><Pencil className="mr-1 h-3.5 w-3.5" />Edit</Button>}>
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">Status</dt>
            <dd>
              <Select value={matter.status} onValueChange={(v) => update({ status: v }, `Status set to ${v}`)} disabled={saving}>
                <SelectTrigger className="mt-1 h-8"><SelectValue /></SelectTrigger>
                <SelectContent>{STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
              </Select>
            </dd>
          </div>
          <div><dt className="text-xs text-muted-foreground">Client</dt><dd>{matter.client ?? "—"}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Responsible</dt><dd>{matter.responsible ?? "—"}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Practice area</dt><dd>{matter.practice_area}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Opened</dt><dd>{fmtDate(matter.opened_on)}</dd></div>
        </dl>
      </Panel>
    </div>
  );
}

function Stat({ label, value, sub, onClick, tone }: { label: string; value: string; sub?: string | null | undefined; onClick: () => void; tone: string }) {
  return (
    <button onClick={onClick} className="rounded-xl border bg-card p-4 text-left transition-shadow hover:shadow-sm">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-2xl font-semibold ${tone}`}>{value}</p>
      {sub && <p className="truncate text-xs text-muted-foreground">{sub}</p>}
    </button>
  );
}
