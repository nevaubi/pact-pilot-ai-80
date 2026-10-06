import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, Panel, Empty } from "@/components/kit";
import { daysUntil, fmtDate } from "@/lib/data";
import { Checkbox } from "@/components/ui/checkbox";

export const Route = createFileRoute("/_authenticated/today")({
  head: () => ({
    meta: [
      { title: "Today — Mirza" },
      { name: "description", content: "Deadlines, open tasks and recent activity across your active matters." },
      { property: "og:title", content: "Today — Mirza" },
      { property: "og:description", content: "Your day across active matters." },
    ],
  }),
  component: Today,
});

function Today() {
  const qc = useQueryClient();
  const deadlines = useQuery({
    queryKey: ["today-deadlines"],
    queryFn: async () => (await supabase.from("deadlines").select("*, matters(id,title)").gte("due_on", new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)).order("due_on").limit(12)).data ?? [],
  });
  const tasks = useQuery({
    queryKey: ["today-tasks"],
    queryFn: async () => (await supabase.from("tasks").select("*, matters(id,title)").eq("done", false).order("due_on", { nullsFirst: false }).limit(15)).data ?? [],
  });
  const activity = useQuery({
    queryKey: ["today-activity"],
    queryFn: async () => (await supabase.from("activity").select("*, matters(id,title)").order("created_at", { ascending: false }).limit(12)).data ?? [],
  });

  async function toggle(id: string, done: boolean) {
    await supabase.from("tasks").update({ done }).eq("id", id);
    qc.invalidateQueries({ queryKey: ["today-tasks"] });
  }

  const today = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

  return (
    <div className="pb-10">
      <PageHeader title="Today" subtitle={today} />
      <div className="grid gap-4 px-4 md:px-8 lg:grid-cols-3">
        <Panel title="Deadlines" className="lg:col-span-1">
          {deadlines.data?.length ? (
            <ul className="space-y-2">
              {deadlines.data.map((d) => {
                const n = daysUntil(d.due_on);
                const tone = n < 0 ? "text-ink-red" : n <= 7 ? "text-ink-amber" : "text-muted-foreground";
                return (
                  <li key={d.id} className="flex items-start justify-between gap-2 rounded-lg bg-raised px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{d.title}</p>
                      {d.matters && (
                        <Link to="/matters/$id" params={{ id: d.matters.id }} className="truncate text-xs text-muted-foreground hover:text-primary">
                          {d.matters.title}
                        </Link>
                      )}
                    </div>
                    <div className={`shrink-0 text-right text-xs ${tone}`}>
                      <div className="font-semibold">{n < 0 ? `${-n}d overdue` : n === 0 ? "Today" : `${n}d`}</div>
                      <div>{fmtDate(d.due_on)}</div>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <Empty>No upcoming deadlines.</Empty>
          )}
        </Panel>
        <Panel title="Open tasks" className="lg:col-span-1">
          {tasks.data?.length ? (
            <ul className="divide-y">
              {tasks.data.map((t) => (
                <li key={t.id} className="flex items-start gap-3 py-2">
                  <Checkbox className="mt-0.5" checked={t.done} onCheckedChange={(v) => toggle(t.id, !!v)} aria-label={`Complete ${t.title}`} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">{t.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {t.matters?.title} · {t.assignee ?? "Unassigned"} {t.due_on && `· ${fmtDate(t.due_on)}`}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>All caught up.</Empty>
          )}
        </Panel>
        <Panel title="Recent activity" className="lg:col-span-1">
          {activity.data?.length ? (
            <ul className="space-y-2.5">
              {activity.data.map((a) => (
                <li key={a.id} className="text-sm">
                  <span className="font-medium">{a.actor}</span> <span className="text-muted-foreground">{a.message}</span>
                  {a.matters && <span className="block text-xs text-muted-foreground">{a.matters.title} · {new Date(a.created_at).toLocaleString()}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Nothing yet.</Empty>
          )}
        </Panel>
      </div>
    </div>
  );
}
