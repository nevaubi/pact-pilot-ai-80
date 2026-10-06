import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, Panel, ListState } from "@/components/kit";
import { dueLabel, fmtDate, fmtDateTime, logActivity } from "@/lib/data";
import { mut, tryAction } from "@/lib/mutate";
import { Checkbox } from "@/components/ui/checkbox";

export const Route = createFileRoute("/_authenticated/today")({
  head: () => ({
    meta: [
      { title: "Today — Mirza" },
      {
        name: "description",
        content: "Track deadlines, open tasks and recent activity in Mirza, the matter-management workspace for boutique law firms.",
      },
      { property: "og:title", content: "Today — Mirza" },
      { property: "og:description", content: "Your day across active matters." },
      { property: "og:type", content: "website" },
      { property: "og:image", content: "https://pact-pilot-ai-80.lovable.app/mirza-social.jpg" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:image", content: "https://pact-pilot-ai-80.lovable.app/mirza-social.jpg" },
    ],
  }),
  component: Today,
  loader: ({ context }) => Promise.all([
    context.queryClient.ensureQueryData({ queryKey: ["today-deadlines"], queryFn: () => q(supabase.from("deadlines").select("*, matters!inner(id,title,status)").neq("matters.status", "Closed").gte("due_on", new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10)).lte("due_on", new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10)).order("due_on").limit(15)) }),
    context.queryClient.ensureQueryData({ queryKey: ["today-tasks"], queryFn: () => q(supabase.from("tasks").select("*, matters!inner(id,title,status)").eq("done", false).neq("matters.status", "Closed").order("due_on", { nullsFirst: false }).limit(20)) }),
    context.queryClient.ensureQueryData({ queryKey: ["today-activity"], queryFn: () => q(supabase.from("activity").select("*, matters(id,title)").order("created_at", { ascending: false }).limit(15)) }),
  ]),
});

async function q<T>(
  p: PromiseLike<{ data: T | null; error: { message: string } | null }>,
): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data as T;
}

function Today() {
  const qc = useQueryClient();
  const deadlines = useQuery({
    queryKey: ["today-deadlines"],
    queryFn: () =>
      q(
        supabase
          .from("deadlines")
          .select("*, matters!inner(id,title,status)")
          .neq("matters.status", "Closed")
          .gte("due_on", new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10))
          .lte("due_on", new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10))
          .order("due_on")
          .limit(15),
      ),
  });
  const tasks = useQuery({
    queryKey: ["today-tasks"],
    queryFn: () =>
      q(
        supabase
          .from("tasks")
          .select("*, matters!inner(id,title,status)")
          .eq("done", false)
          .neq("matters.status", "Closed")
          .order("due_on", { nullsFirst: false })
          .limit(20),
      ),
  });
  const activity = useQuery({
    queryKey: ["today-activity"],
    queryFn: () =>
      q(
        supabase
          .from("activity")
          .select("*, matters(id,title)")
          .order("created_at", { ascending: false })
          .limit(15),
      ),
  });

  async function toggle(id: string, done: boolean, matterId: string, title: string) {
    await tryAction(async () => {
      await mut(supabase.from("tasks").update({ done }).eq("id", id).select("id"), {
        success: done ? "Task completed" : "Task reopened",
      });
      if (done) await logActivity(matterId, `Completed task: ${title}`);
      qc.invalidateQueries({ queryKey: ["today-tasks"] });
      qc.invalidateQueries({ queryKey: ["today-activity"] });
      qc.invalidateQueries({ queryKey: ["tasks", matterId] });
    });
  }

  const today = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="pb-8">
      <PageHeader title="Today" subtitle={today} />
      <div className="grid gap-5 p-4 md:p-6 lg:grid-cols-3">
        <Panel title="Deadlines" className="lg:col-span-1">
          <ListState query={deadlines} empty="No upcoming deadlines on open matters.">
            {(rows) => (
              <ul className="divide-y">
                {rows.map((d) => {
                  const { label, tone } = dueLabel(d.due_on);
                  return (
                    <li
                      key={d.id}
                      className="flex items-start justify-between gap-3 px-1 py-2.5 transition-colors hover:bg-raised/70"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{d.title}</p>
                        <Link
                          to="/matters/$id"
                          params={{ id: d.matters.id }}
                          search={{ tab: "Deadlines" }}
                          className="block truncate text-xs text-muted-foreground hover:text-primary"
                        >
                          {d.matters.title}
                        </Link>
                      </div>
                      <div className={`shrink-0 text-right text-xs ${tone}`}>
                        <div className="font-semibold">{label}</div>
                        <div>{fmtDate(d.due_on)}</div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </ListState>
        </Panel>
        <Panel title="Open tasks" className="lg:col-span-1">
          <ListState query={tasks} empty="All caught up — no open tasks.">
            {(rows) => (
              <ul className="divide-y">
                {rows.map((t) => {
                  const d = t.due_on ? dueLabel(t.due_on) : null;
                  return (
                    <li key={t.id} className="flex items-start gap-3 py-2">
                      <Checkbox
                        className="mt-0.5"
                        checked={t.done}
                        onCheckedChange={(v) => toggle(t.id, !!v, t.matter_id, t.title)}
                        aria-label={`Complete ${t.title}`}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm">{t.title}</p>
                        <p className="text-xs text-muted-foreground">
                          <Link
                            to="/matters/$id"
                            params={{ id: t.matters.id }}
                            search={{ tab: "Tasks" }}
                            className="hover:text-primary"
                          >
                            {t.matters.title}
                          </Link>
                          {" · "}
                          {t.assignee ?? "Unassigned"}
                          {t.due_on && (
                            <>
                              {" "}
                              ·{" "}
                              <span className={d && d.n < 0 ? "font-medium text-ink-red" : ""}>
                                {fmtDate(t.due_on)}
                                {d && d.n < 0 ? ` (${d.label})` : ""}
                              </span>
                            </>
                          )}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </ListState>
        </Panel>
        <Panel title="Recent activity" className="lg:col-span-1">
          <ListState
            query={activity}
            empty="Nothing yet. Activity across all matters shows up here."
          >
            {(rows) => (
              <ul className="divide-y">
                {rows.map((a) => (
                  <li key={a.id} className="py-2.5 text-sm first:pt-0 last:pb-0">
                    <span className="font-medium">{a.actor}</span>{" "}
                    <span className="text-muted-foreground">{a.message}</span>
                    <span className="block text-xs text-muted-foreground">
                      {a.matters ? (
                        <Link
                          to="/matters/$id"
                          params={{ id: a.matters.id }}
                          search={{ tab: "Activity" }}
                          className="hover:text-primary"
                        >
                          {a.matters.title}
                        </Link>
                      ) : (
                        "Firm"
                      )}{" "}
                      · {fmtDateTime(a.created_at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </ListState>
        </Panel>
      </div>
    </div>
  );
}
