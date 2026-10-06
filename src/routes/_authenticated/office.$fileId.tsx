import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Download, Save, History, PanelRight } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { tryAction } from "@/lib/mutate";
import { downloadBlob, officeKind, KIND_LABEL, saveBlobLocally, saveNewVersion, restoreVersion } from "@/lib/office";
import type { DocMode, EditorHandle } from "@/components/office/DocxEditor";
import type { DocContext } from "@/hooks/use-assist";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

const DocxEditor = lazy(() => import("@/components/office/DocxEditor").then((m) => ({ default: m.DocxEditor })));
const PdfViewer = lazy(() => import("@/components/office/PdfViewer").then((m) => ({ default: m.PdfViewer })));
const SheetEditor = lazy(() => import("@/components/office/SheetEditor").then((m) => ({ default: m.SheetEditor })));
const DraftPanel = lazy(() => import("@/components/office/DraftPanel").then((m) => ({ default: m.DraftPanel })));

export const Route = createFileRoute("/_authenticated/office/$fileId")({
  head: () => ({
    meta: [
      { title: "Document editor — Mirza" },
      { name: "description", content: "Edit Word, PDF and spreadsheet files on a matter with a drafting assistant grounded in the matter's sources." },
      { property: "og:title", content: "Document editor — Mirza" },
      { property: "og:description", content: "Edit matter documents with an attorney-reviewed drafting assistant." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: OfficePage,
});

function OfficePage() {
  const { fileId } = Route.useParams();
  const qc = useQueryClient();
  const fileQ = useQuery({
    queryKey: ["office-file", fileId],
    queryFn: async () => {
      const { data, error } = await supabase.from("files").select("*, matters(id, title)").eq("id", fileId).maybeSingle();
      if (error) throw error;
      if (!data) throw new Error("This file no longer exists.");
      const blob = await downloadBlob(data.path);
      return { file: data, blob };
    },
    staleTime: Infinity,
    gcTime: 0,
  });
  const versionsQ = useQuery({
    queryKey: ["file-versions", fileId],
    queryFn: async () => {
      const { data, error } = await supabase.from("file_versions").select("*").eq("file_id", fileId).order("created_at", { ascending: false }).limit(20);
      if (error) throw error;
      return data;
    },
  });
  const [user, setUser] = useState<{ id: string | null; name: string; email?: string }>({ id: null, name: "Attorney" });
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      const u = data.user;
      if (u) setUser({ id: u.id, name: (u.user_metadata?.full_name as string) || u.email?.split("@")[0] || "Attorney", ...(u.email ? { email: u.email } : {}) });
    });
  }, []);

  const editor = useRef<EditorHandle | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<DocMode>("editing");
  const [panel, setPanel] = useState(true);
  const [showVersions, setShowVersions] = useState(false);
  const onDirty = useCallback(() => setDirty(true), []);

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  if (fileQ.isLoading)
    return (
      <div className="space-y-3 p-6">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-[60vh] w-full" />
      </div>
    );
  if (fileQ.error || !fileQ.data)
    return (
      <div className="p-6 text-sm">
        <p className="font-medium">Couldn't open this document</p>
        <p className="text-muted-foreground">{(fileQ.error as Error)?.message}</p>
      </div>
    );

  const { file, blob } = fileQ.data;
  const kind = officeKind(file.name);
  const matter = file.matters as { id: string; title: string } | null;

  async function save() {
    if (!editor.current) return;
    setSaving(true);
    await tryAction(async () => {
      const out = await editor.current!.export();
      const text = kind === "pdf" ? undefined : (await editor.current!.getText()).slice(0, 300000) || null;
      await saveNewVersion(file, out, { ...(text !== undefined ? { text } : {}), editedBy: user.id });
      setDirty(false);
      qc.invalidateQueries({ queryKey: ["file-versions", fileId] });
      toast.success("Saved. The previous version is kept in history.");
    });
    setSaving(false);
  }

  const getDoc = async (): Promise<DocContext> => ({
    name: file.name,
    kind: kind ?? "text",
    text: (await editor.current?.getText()) || file.extracted_text || "",
    selection: (await editor.current?.getSelection()) || undefined,
  });

  return (
    <div className="flex h-[calc(100vh-3rem)] min-h-0 flex-col md:h-screen">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-card px-3 py-1.5">
        <Button asChild size="icon" variant="ghost" className="h-7 w-7" aria-label="Back">
          {matter ? (
            <Link to="/matters/$id" params={{ id: matter.id }} search={{ tab: "files" } as never}><ArrowLeft className="h-4 w-4" /></Link>
          ) : (
            <Link to="/files"><ArrowLeft className="h-4 w-4" /></Link>
          )}
        </Button>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{file.name}</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {kind ? KIND_LABEL[kind] : "File"}{matter ? ` · ${matter.title}` : " · Firm"}{dirty ? " · Unsaved changes" : ""}
          </p>
        </div>
        <span className="flex-1" />
        {kind === "docx" && (
          <div className="inline-flex rounded border bg-raised p-0.5 text-xs" role="radiogroup" aria-label="Document mode">
            {(["editing", "suggesting", "viewing"] as const).map((m) => (
              <button key={m} role="radio" aria-checked={mode === m} onClick={() => setMode(m)} className={`rounded-sm px-2 py-0.5 capitalize ${mode === m ? "bg-card shadow-sm" : "text-muted-foreground"}`}>
                {m}
              </button>
            ))}
          </div>
        )}
        {kind === "docx" && (
          <>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => editor.current?.acceptAllChanges?.()}>Accept all</Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => editor.current?.rejectAllChanges?.()}>Reject all</Button>
          </>
        )}
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setShowVersions((v) => !v)}>
          <History className="mr-1 h-3.5 w-3.5" />History ({versionsQ.data?.length ?? 0})
        </Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={async () => saveBlobLocally(editor.current ? await editor.current.export().catch(() => blob) : blob, file.name)}>
          <Download className="mr-1 h-3.5 w-3.5" />Download
        </Button>
        <Button size="sm" className="h-7 text-xs" disabled={saving || kind === "text" || !kind} onClick={save}>
          <Save className="mr-1 h-3.5 w-3.5" />{saving ? "Saving…" : "Save"}
        </Button>
        {matter && (
          <Button size="icon" variant={panel ? "secondary" : "ghost"} className="h-7 w-7" aria-label="Toggle drafting assistant" onClick={() => setPanel((p) => !p)}>
            <PanelRight className="h-4 w-4" />
          </Button>
        )}
      </header>
      {showVersions && (
        <div className="max-h-48 shrink-0 overflow-y-auto border-b bg-raised px-3 py-2 text-xs">
          {!versionsQ.data?.length ? (
            <p className="text-muted-foreground">No earlier versions yet. Each save keeps the previous copy here.</p>
          ) : (
            <ul className="divide-y">
              {versionsQ.data.map((v) => (
                <li key={v.id} className="flex items-center gap-2 py-1">
                  <span>{new Date(v.created_at).toLocaleString()}</span>
                  {v.note && <span className="truncate text-muted-foreground">{v.note}</span>}
                  <span className="flex-1" />
                  <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => tryAction(async () => {
                    await restoreVersion(file, v, user.id);
                    toast.success("Version restored.");
                    qc.invalidateQueries({ queryKey: ["office-file", fileId] });
                    qc.invalidateQueries({ queryKey: ["file-versions", fileId] });
                    setDirty(false);
                  })}>Restore</Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className={`grid min-h-0 flex-1 ${panel && matter ? "grid-cols-[1fr_22rem]" : "grid-cols-1"}`}>
        <div className="min-h-0 min-w-0">
          <Suspense fallback={<Skeleton className="m-6 h-[60vh]" />}>
            {kind === "docx" && <DocxEditor blob={blob} name={file.name} user={user} mode={mode} onDirty={onDirty} handle={editor} onError={(m) => toast.error(m)} />}
            {kind === "pdf" && <PdfViewer blob={blob} name={file.name} text={file.extracted_text ?? ""} author={user.name} dark={document.documentElement.classList.contains("dark")} onDirty={onDirty} handle={editor} onError={(m) => toast.error(m)} />}
            {kind === "xlsx" && <SheetEditor blob={blob} name={file.name} onDirty={onDirty} handle={editor} onError={(m) => toast.error(m)} />}
            {(kind === "text" || !kind) && (
              <pre className="h-full overflow-auto whitespace-pre-wrap p-6 text-sm">{file.extracted_text ?? "This file type can't be opened in the editor. Download it instead."}</pre>
            )}
          </Suspense>
        </div>
        {panel && matter && (
          <Suspense fallback={<div className="border-l" />}>
            <DraftPanel matterId={matter.id} fileId={file.id} canInsert={kind === "docx" || kind === "xlsx"} getDoc={getDoc} editor={editor} />
          </Suspense>
        )}
      </div>
    </div>
  );
}
