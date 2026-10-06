import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useState } from "react";
import { ChevronLeft, Download, Pencil, Sparkle } from "lucide-react";
import { matterQ, tableQ, matterContactsQ } from "@/lib/data";
import { PracticeChip, StatusDot, LoadError } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  TasksTab,
  DeadlinesTab,
  NotesTab,
  ContactsTab,
  ActivityTab,
} from "@/components/matter/Lists";
import { EditMatterDialog } from "@/components/matter/EditMatterDialog";

const Overview = lazy(() => import("@/components/matter/Overview").then((m) => ({ default: m.Overview })));
const FilesTab = lazy(() => import("@/components/matter/FilesTab").then((m) => ({ default: m.FilesTab })));
const ClosingTab = lazy(() => import("@/components/matter/ClosingTab").then((m) => ({ default: m.ClosingTab })));
const DraftsTab = lazy(() => import("@/components/matter/DraftsTab").then((m) => ({ default: m.DraftsTab })));
const AssistPanel = lazy(() => import("@/components/matter/AssistPanel").then((m) => ({ default: m.AssistPanel })));

const TABS = [
  "Overview",
  "Tasks",
  "Deadlines",
  "Closing",
  "Files",
  "Drafts",
  "Notes",
  "Contacts",
  "Activity",
] as const;
type Tab = (typeof TABS)[number];

export const Route = createFileRoute("/_authenticated/matters/$id")({
  validateSearch: (s: Record<string, unknown>): { tab?: Tab } => {
    const t = typeof s["tab"] === "string" ? (s["tab"] as Tab) : undefined;
    return t && TABS.includes(t) && t !== "Overview" ? { tab: t } : {};
  },
  head: () => ({
    meta: [
      { title: "Matter — Mirza" },
      {
        name: "description",
        content: "Matter workspace: tasks, deadlines, files, closing and drafts.",
      },
      { property: "og:title", content: "Matter — Mirza" },
      { property: "og:description", content: "Matter workspace in Mirza." },
    ],
  }),
  component: MatterPage,
  notFoundComponent: () => <p className="p-8">Matter not found.</p>,
  errorComponent: ({ error }) => (
    <div className="p-8">
      <LoadError error={error} />
    </div>
  ),
});

function MatterPage() {
  const { id } = Route.useParams();
  const { tab = "Overview" } = Route.useSearch();
  const navigate = Route.useNavigate();
  const qc = useQueryClient();
  const q = useQuery(matterQ(id));
  const m = q.data;
  const [assist, setAssist] = useState(false);
  const [assistPrompt, setAssistPrompt] = useState<string | undefined>();
  const [edit, setEdit] = useState(false);

  // Warm only the active tab; intent preloading handles the rest of navigation.
  useEffect(() => {
    if (!m) return;
    const tables = { Tasks: "tasks", Deadlines: "deadlines", Notes: "notes", Files: "files", Drafts: "drafts", Closing: "closing_items", Activity: "activity" } as const;
    const table = tables[tab as keyof typeof tables];
    if (table) qc.prefetchQuery(tableQ(table, id));
    if (tab === "Contacts") qc.prefetchQuery(matterContactsQ(id));
    if (tab === "Overview") {
      qc.prefetchQuery(tableQ("tasks", id));
      qc.prefetchQuery(tableQ("deadlines", id));
      qc.prefetchQuery(tableQ("closing_items", id));
    }
  }, [m, id, qc, tab]);

  async function exportSummary() {
    const [tasks, deadlines, closing] = await Promise.all([
      qc.ensureQueryData(tableQ("tasks", id)),
      qc.ensureQueryData(tableQ("deadlines", id)),
      qc.ensureQueryData(tableQ("closing_items", id)),
    ]);
    const esc = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const list = (title: string, rows: string[]) => `<h2>${title}</h2>${rows.length ? `<ul>${rows.map((row) => `<li>${esc(row)}</li>`).join("")}</ul>` : "<p>None.</p>"}`;
    const html = `<html><head><meta charset="utf-8"><title>${esc(m.title)}</title></head><body><h1>${esc(m.title)}</h1><p>${esc([m.number, m.client, m.status].filter(Boolean).join(" · "))}</p>${m.summary ? `<p>${esc(m.summary)}</p>` : ""}${list("Open tasks", tasks.filter((x) => !x.done).map((x) => `${x.title}${x.assignee ? ` — ${x.assignee}` : ""}${x.due_on ? ` — due ${x.due_on}` : ""}`))}${list("Deadlines", deadlines.map((x) => `${x.due_on} — ${x.title}`))}${list("Closing checklist", closing.map((x) => `${x.status} — ${x.deliverable}${x.responsible ? ` — ${x.responsible}` : ""}`))}</body></html>`;
    const url = URL.createObjectURL(new Blob([html], { type: "application/msword" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${m.number ?? "matter"}-summary.doc`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const setTab = (t: string) =>
    navigate({ search: t === "Overview" ? {} : { tab: t as Tab }, replace: true });

  if (q.isPending) {
    return (
      <div className="space-y-3 p-4 md:p-8">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="mt-6 h-40 w-full rounded-xl" />
      </div>
    );
  }
  if (q.isError)
    return (
      <div className="p-8">
        <LoadError error={q.error} retry={() => q.refetch()} />
      </div>
    );
  if (!m) {
    return (
      <div className="p-8 text-sm">
        <p className="font-medium">Matter not found.</p>
        <p className="text-muted-foreground">
          It may have been deleted.{" "}
          <Link to="/matters" className="text-primary underline">
            Back to matters
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="pb-8">
      <div className="border-b bg-card px-4 pb-0 pt-3 md:px-6">
        <Link
          to="/matters"
          className="mb-2 inline-flex items-center text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3.5 w-3.5" /> Matters
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <PracticeChip area={m.practice_area} />
              {m.number && (
                <span className="font-mono text-xs text-muted-foreground">{m.number}</span>
              )}
              <StatusDot status={m.status} />
            </div>
            <h1 className="text-xl font-semibold leading-tight">{m.title}</h1>
            {m.client && <p className="text-sm text-muted-foreground">{m.client}</p>}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button variant="outline" onClick={exportSummary} aria-label="Export matter summary">
              <Download className="h-4 w-4 sm:mr-1.5" />
              <span className="hidden sm:inline">Export</span>
            </Button>
            <Button variant="outline" onClick={() => { setAssistPrompt("Catch me up on this matter. Summarize the current status, immediate priorities, upcoming deadlines, open questions, and the next actions for the responsible attorney."); setAssist(true); }}>
              <Sparkle className="h-4 w-4 sm:mr-1.5" />
              <span className="hidden sm:inline">Catch me up</span>
            </Button>
            <Button variant="outline" onClick={() => setEdit(true)} aria-label="Edit matter">
              <Pencil className="h-4 w-4 sm:mr-1.5" />
              <span className="hidden sm:inline">Edit</span>
            </Button>
            <Button
              onClick={() => setAssist(true)}
              className="bg-ink-purple text-primary-foreground hover:bg-ink-purple/90"
            >
              <Sparkle className="mr-1.5 h-4 w-4" /> Assist
            </Button>
          </div>
        </div>
        <Tabs value={tab} onValueChange={setTab} className="mt-2">
          <TabsList className="h-auto w-full flex-nowrap justify-start gap-1 overflow-x-auto bg-transparent p-0 [scrollbar-width:none] sm:flex-wrap">
            {TABS.map((t) => (
              <TabsTrigger
                key={t}
                value={t}
                className="shrink-0 rounded-none border-b-2 border-transparent px-2.5 py-2 data-[state=active]:border-primary data-[state=active]:bg-transparent"
              >
                {t}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      <div className="p-4 md:p-6">
        <Tabs value={tab}>
          <Suspense fallback={<Skeleton className="h-48 w-full rounded" />}>
          <TabsContent value="Overview">
            <Overview matter={m} onTab={setTab} onEdit={() => setEdit(true)} />
          </TabsContent>
          <TabsContent value="Tasks">
            <TasksTab matterId={id} />
          </TabsContent>
          <TabsContent value="Deadlines">
            <DeadlinesTab matterId={id} />
          </TabsContent>
          <TabsContent value="Closing">
            <ClosingTab matterId={id} />
          </TabsContent>
          <TabsContent value="Files">
            <FilesTab matterId={id} />
          </TabsContent>
          <TabsContent value="Drafts">
            <DraftsTab matter={m} />
          </TabsContent>
          <TabsContent value="Notes">
            <NotesTab matterId={id} />
          </TabsContent>
          <TabsContent value="Contacts">
            <ContactsTab matterId={id} />
          </TabsContent>
          <TabsContent value="Activity">
            <ActivityTab matterId={id} />
          </TabsContent>
          </Suspense>
        </Tabs>
      </div>
      {assist && <Suspense fallback={null}><AssistPanel matter={m} open={assist} onOpenChange={setAssist} initialPrompt={assistPrompt} /></Suspense>}
      <EditMatterDialog matter={m} open={edit} onOpenChange={setEdit} />
    </div>
  );
}
