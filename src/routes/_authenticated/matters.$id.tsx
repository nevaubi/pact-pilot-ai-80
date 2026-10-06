import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ChevronLeft, Pencil, Sparkle } from "lucide-react";
import { matterQ, tableQ, matterContactsQ } from "@/lib/data";
import { PracticeChip, StatusDot, LoadError } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Overview } from "@/components/matter/Overview";
import { TasksTab, DeadlinesTab, NotesTab, ContactsTab, ActivityTab } from "@/components/matter/Lists";
import { FilesTab } from "@/components/matter/FilesTab";
import { ClosingTab } from "@/components/matter/ClosingTab";
import { DraftsTab } from "@/components/matter/DraftsTab";
import { AssistPanel } from "@/components/matter/AssistPanel";
import { EditMatterDialog } from "@/components/matter/EditMatterDialog";

const TABS = ["Overview", "Tasks", "Deadlines", "Closing", "Files", "Drafts", "Notes", "Contacts", "Activity"] as const;
type Tab = (typeof TABS)[number];

export const Route = createFileRoute("/_authenticated/matters/$id")({
  validateSearch: (s: Record<string, unknown>): { tab?: Tab } => {
    const t = typeof s["tab"] === "string" ? (s["tab"] as Tab) : undefined;
    return t && TABS.includes(t) && t !== "Overview" ? { tab: t } : {};
  },
  head: () => ({
    meta: [
      { title: "Matter — Mirza" },
      { name: "description", content: "Matter workspace: tasks, deadlines, files, closing and drafts." },
      { property: "og:title", content: "Matter — Mirza" },
      { property: "og:description", content: "Matter workspace in Mirza." },
    ],
  }),
  component: MatterPage,
  notFoundComponent: () => <p className="p-8">Matter not found.</p>,
  errorComponent: ({ error }) => <div className="p-8"><LoadError error={error} /></div>,
});

function MatterPage() {
  const { id } = Route.useParams();
  const { tab = "Overview" } = Route.useSearch();
  const navigate = Route.useNavigate();
  const qc = useQueryClient();
  const q = useQuery(matterQ(id));
  const m = q.data;
  const [assist, setAssist] = useState(false);
  const [edit, setEdit] = useState(false);

  // Warm every tab's list once so switching tabs is instant.
  useEffect(() => {
    if (!m) return;
    (["tasks", "deadlines", "notes", "files", "drafts", "closing_items", "activity"] as const).forEach((t) => qc.prefetchQuery(tableQ(t, id)));
    qc.prefetchQuery(matterContactsQ(id));
  }, [m, id, qc]);

  const setTab = (t: string) => navigate({ search: t === "Overview" ? {} : { tab: t as Tab }, replace: true });

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
  if (q.isError) return <div className="p-8"><LoadError error={q.error} retry={() => q.refetch()} /></div>;
  if (!m) {
    return (
      <div className="p-8 text-sm">
        <p className="font-medium">Matter not found.</p>
        <p className="text-muted-foreground">It may have been deleted. <Link to="/matters" className="text-primary underline">Back to matters</Link></p>
      </div>
    );
  }

  return (
    <div className="pb-10">
      <div className="border-b bg-card/60 px-4 pb-0 pt-4 md:px-8">
        <Link to="/matters" className="mb-2 inline-flex items-center text-xs text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-3.5 w-3.5" /> Matters
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <PracticeChip area={m.practice_area} />
              {m.number && <span className="font-mono text-xs text-muted-foreground">{m.number}</span>}
              <StatusDot status={m.status} />
            </div>
            <h1 className="text-2xl font-semibold leading-tight">{m.title}</h1>
            {m.client && <p className="text-sm text-muted-foreground">{m.client}</p>}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setEdit(true)} aria-label="Edit matter">
              <Pencil className="h-4 w-4 sm:mr-1.5" /><span className="hidden sm:inline">Edit</span>
            </Button>
            <Button onClick={() => setAssist(true)} className="bg-ink-purple text-primary-foreground hover:bg-ink-purple/90">
              <Sparkle className="mr-1.5 h-4 w-4" /> Assist
            </Button>
          </div>
        </div>
        <Tabs value={tab} onValueChange={setTab} className="mt-3">
          <TabsList className="h-auto w-full flex-nowrap justify-start gap-1 overflow-x-auto bg-transparent p-0 [scrollbar-width:none] sm:flex-wrap">
            {TABS.map((t) => (
              <TabsTrigger key={t} value={t} className="shrink-0 rounded-b-none rounded-t-lg border-b-2 border-transparent px-3 py-2 data-[state=active]:border-primary data-[state=active]:bg-card data-[state=active]:shadow-none">
                {t}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      <div className="px-4 pt-5 md:px-8">
        <Tabs value={tab}>
          <TabsContent value="Overview"><Overview matter={m} onTab={setTab} onEdit={() => setEdit(true)} /></TabsContent>
          <TabsContent value="Tasks"><TasksTab matterId={id} /></TabsContent>
          <TabsContent value="Deadlines"><DeadlinesTab matterId={id} /></TabsContent>
          <TabsContent value="Closing"><ClosingTab matterId={id} /></TabsContent>
          <TabsContent value="Files"><FilesTab matterId={id} /></TabsContent>
          <TabsContent value="Drafts"><DraftsTab matter={m} /></TabsContent>
          <TabsContent value="Notes"><NotesTab matterId={id} /></TabsContent>
          <TabsContent value="Contacts"><ContactsTab matterId={id} /></TabsContent>
          <TabsContent value="Activity"><ActivityTab matterId={id} /></TabsContent>
        </Tabs>
      </div>
      <AssistPanel matter={m} open={assist} onOpenChange={setAssist} />
      <EditMatterDialog matter={m} open={edit} onOpenChange={setEdit} />
    </div>
  );
}
