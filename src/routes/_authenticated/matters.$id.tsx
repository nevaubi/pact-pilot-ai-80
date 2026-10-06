import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ChevronLeft, Sparkle } from "lucide-react";
import { matterQ } from "@/lib/data";
import { PracticeChip, StatusDot } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Overview } from "@/components/matter/Overview";
import { TasksTab, DeadlinesTab, NotesTab, ContactsTab, ActivityTab } from "@/components/matter/Lists";
import { FilesTab } from "@/components/matter/FilesTab";
import { ClosingTab } from "@/components/matter/ClosingTab";
import { DraftsTab } from "@/components/matter/DraftsTab";
import { AssistPanel } from "@/components/matter/AssistPanel";

export const Route = createFileRoute("/_authenticated/matters/$id")({
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
  errorComponent: () => <p className="p-8">This matter couldn't load.</p>,
});

const TABS = ["Overview", "Tasks", "Deadlines", "Closing", "Files", "Drafts", "Notes", "Contacts", "Activity"];

function MatterPage() {
  const { id } = Route.useParams();
  const { data: m, isLoading } = useQuery(matterQ(id));
  const [assist, setAssist] = useState(false);
  const [tab, setTab] = useState("Overview");

  if (isLoading) return <p className="p-8 text-sm text-muted-foreground">Loading…</p>;
  if (!m) return <p className="p-8">Matter not found.</p>;

  return (
    <div className="pb-10">
      <div className="border-b bg-card/60 px-4 pb-0 pt-4 md:px-8">
        <Link to="/matters" className="mb-2 inline-flex items-center text-xs text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-3.5 w-3.5" /> Matters
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <PracticeChip area={m.practice_area} />
              <span className="font-mono text-xs text-muted-foreground">{m.number}</span>
              <StatusDot status={m.status} />
            </div>
            <h1 className="text-2xl font-semibold">{m.title}</h1>
            <p className="text-sm text-muted-foreground">{m.client}</p>
          </div>
          <Button onClick={() => setAssist(true)} className="bg-ink-purple text-primary-foreground hover:bg-ink-purple/90">
            <Sparkle className="mr-1.5 h-4 w-4" /> Assist
          </Button>
        </div>
        <Tabs value={tab} onValueChange={setTab} className="mt-3">
          <TabsList className="h-auto flex-wrap justify-start gap-1 bg-transparent p-0">
            {TABS.map((t) => (
              <TabsTrigger key={t} value={t} className="rounded-b-none rounded-t-lg border-b-2 border-transparent px-3 py-2 data-[state=active]:border-primary data-[state=active]:bg-card data-[state=active]:shadow-none">
                {t}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      <div className="px-4 pt-5 md:px-8">
        <Tabs value={tab}>
          <TabsContent value="Overview"><Overview matter={m} onTab={setTab} /></TabsContent>
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
    </div>
  );
}
