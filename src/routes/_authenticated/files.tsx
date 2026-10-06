import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { FileText, Download, Search } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, Empty } from "@/components/kit";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { downloadFile } from "@/components/matter/FilesTab";

export const Route = createFileRoute("/_authenticated/files")({
  head: () => ({
    meta: [
      { title: "Files — Mirza" },
      { name: "description", content: "Every document filed across firm matters." },
      { property: "og:title", content: "Files — Mirza" },
      { property: "og:description", content: "Firm-wide files hub." },
    ],
  }),
  component: FilesHub,
});

function FilesHub() {
  const { data = [] } = useQuery({
    queryKey: ["files-hub"],
    queryFn: async () => (await supabase.from("files").select("id,name,path,size,created_at,matters(id,title)").order("created_at", { ascending: false })).data ?? [],
  });
  const [term, setTerm] = useState("");
  const rows = data.filter((f) => `${f.name} ${f.matters?.title ?? ""}`.toLowerCase().includes(term.toLowerCase()));
  return (
    <div className="pb-10">
      <PageHeader title="Files" subtitle="Add files from inside a matter so they stay organized." />
      <div className="px-4 md:px-8">
        <div className="relative mb-4 max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input className="bg-card pl-8" placeholder="Search files" value={term} onChange={(e) => setTerm(e.target.value)} />
        </div>
        <div className="rounded-xl border bg-card">
          {!rows.length ? <Empty>No files yet.</Empty> : (
            <ul className="divide-y">
              {rows.map((f) => (
                <li key={f.id} className="flex items-center gap-3 px-4 py-2.5">
                  <FileText className="h-5 w-5 text-ink-blue" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{f.name}</p>
                    {f.matters && <Link to="/matters/$id" params={{ id: f.matters.id }} className="text-xs text-muted-foreground hover:text-primary">{f.matters.title}</Link>}
                  </div>
                  <span className="hidden text-xs text-muted-foreground sm:block">{new Date(f.created_at).toLocaleDateString()}</span>
                  <Button size="icon" variant="ghost" aria-label="Download" onClick={() => downloadFile(f.path)}><Download className="h-4 w-4" /></Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
