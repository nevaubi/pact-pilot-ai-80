import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { FileText, Download, Search } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, ListState, DeleteButton } from "@/components/kit";
import { fmtDate } from "@/lib/data";
import { tryAction } from "@/lib/mutate";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { NewDocumentStrip } from "@/components/NewDocumentStrip";
import { downloadFile, deleteFile } from "@/components/matter/FilesTab";

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
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["files-hub"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("files")
        .select("id,name,path,size,created_at,extracted_text,matter_id,matters(id,title)")
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return data.map((f) => ({ ...f, readable: !!f.extracted_text, extracted_text: undefined }));
    },
  });
  const [term, setTerm] = useState("");
  const data = q.data ?? [];
  const rows = data.filter((f) =>
    `${f.name} ${f.matters?.title ?? ""}`.toLowerCase().includes(term.toLowerCase()),
  );
  const filtered = { ...q, data: q.data ? rows : undefined } as typeof q;

  return (
    <div className="pb-8">
      <PageHeader
        title="Files"
        subtitle={
          q.data
            ? `${data.length} documents · add files from inside a matter so they stay organized`
            : "Add files from inside a matter so they stay organized."
        }
      />
      <div className="p-4 md:p-6">
        <div className="mb-5">
          <NewDocumentStrip />
        </div>
        <div className="relative mb-4 max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            className="bg-card pl-8"
            placeholder="Search files"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            aria-label="Search files"
          />
        </div>
        <div className="rounded border bg-card px-3 py-1">
          <ListState
            query={filtered}
            rows={4}
            empty={
              data.length ? (
                "No files match."
              ) : (
                <>
                  No files yet. Open a matter and drop documents on its <b>Files</b> tab.
                </>
              )
            }
          >
            {(list) => (
              <ul className="divide-y">
                {list.map((f) => (
                  <li key={f.id} className="flex items-center gap-3 py-2.5">
                    <FileText className="h-5 w-5 shrink-0 text-ink-blue" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{f.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {f.matters ? (
                          <Link
                            to="/matters/$id"
                            params={{ id: f.matters.id }}
                            search={{ tab: "Files" }}
                            className="hover:text-primary"
                          >
                            {f.matters.title}
                          </Link>
                        ) : (
                          "Firm"
                        )}
                        {f.size ? ` · ${Math.max(1, Math.round(f.size / 1024))} KB` : ""}
                        {!f.readable && <span className="text-ink-amber"> · no readable text</span>}
                      </p>
                    </div>
                    <span className="hidden text-xs text-muted-foreground sm:block">
                      {fmtDate(f.created_at.slice(0, 10))}
                    </span>
                    <Button asChild size="sm" variant="ghost" className="h-7 text-xs">
                      <Link to="/office/$fileId" params={{ fileId: f.id }} aria-label={`Open ${f.name} in editor`}>Open</Link>
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Download ${f.name}`}
                      onClick={() => downloadFile(f.path, f.name)}
                    >
                      <Download className="h-4 w-4" />
                    </Button>
                    <DeleteButton
                      what="file"
                      description={`${f.name} will be removed from its matter and from storage.`}
                      onConfirm={() =>
                        tryAction(async () => {
                          await deleteFile(f);
                          qc.invalidateQueries({ queryKey: ["files-hub"] });
                          if (f.matter_id)
                            qc.invalidateQueries({ queryKey: ["files", f.matter_id] });
                        })
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
          </ListState>
        </div>
      </div>
    </div>
  );
}
