import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { LayoutGrid, List, Plus, Search } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, PracticeChip, StatusDot, Empty } from "@/components/kit";
import { mattersQ, PRACTICE_AREAS, STATUSES, fmtDate, logActivity } from "@/lib/data";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/matters/")({
  head: () => ({
    meta: [
      { title: "Matters — Mirza" },
      { name: "description", content: "All firm matters by practice area and status." },
      { property: "og:title", content: "Matters — Mirza" },
      { property: "og:description", content: "All firm matters by practice area and status." },
    ],
  }),
  component: Matters,
});

function Matters() {
  const { data = [] } = useQuery(mattersQ);
  const [view, setView] = useState<"cards" | "list">("cards");
  const [area, setArea] = useState<string>("All");
  const [status, setStatus] = useState<string>("Open");
  const [term, setTerm] = useState("");
  const rows = useMemo(
    () =>
      data.filter(
        (m) =>
          (area === "All" || m.practice_area === area) &&
          (status === "All" || (status === "Open" ? m.status !== "Closed" : m.status === status)) &&
          (!term || `${m.title} ${m.client} ${m.number}`.toLowerCase().includes(term.toLowerCase())),
      ),
    [data, area, status, term],
  );

  return (
    <div className="pb-10">
      <PageHeader title="Matters" subtitle={`${rows.length} shown`} actions={<NewMatter />} />
      <div className="flex flex-wrap items-center gap-2 px-4 pb-4 md:px-8">
        <div className="relative w-full max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input className="bg-card pl-8" placeholder="Search matters" value={term} onChange={(e) => setTerm(e.target.value)} />
        </div>
        <div className="flex flex-wrap gap-1">
          {["All", ...PRACTICE_AREAS].map((a) => (
            <button key={a} onClick={() => setArea(a)} className={`rounded-full px-3 py-1 text-xs font-medium ${area === a ? "bg-foreground text-background" : "bg-card text-muted-foreground hover:text-foreground"}`}>
              {a}
            </button>
          ))}
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="h-8 w-32 bg-card text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {["Open", "All", ...STATUSES].map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="ml-auto inline-flex rounded-lg border bg-card p-0.5">
          <button aria-label="Card view" onClick={() => setView("cards")} className={`rounded-md p-1.5 ${view === "cards" ? "bg-raised" : ""}`}><LayoutGrid className="h-4 w-4" /></button>
          <button aria-label="List view" onClick={() => setView("list")} className={`rounded-md p-1.5 ${view === "list" ? "bg-raised" : ""}`}><List className="h-4 w-4" /></button>
        </div>
      </div>
      <div className="px-4 md:px-8">
        {!rows.length ? (
          <Empty>No matters match.</Empty>
        ) : view === "cards" ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {rows.map((m) => (
              <Link key={m.id} to="/matters/$id" params={{ id: m.id }} className="group rounded-xl border bg-card p-4 transition-shadow hover:shadow-md">
                <div className="mb-2 flex items-center justify-between">
                  <PracticeChip area={m.practice_area} />
                  <span className="font-mono text-[11px] text-muted-foreground">{m.number}</span>
                </div>
                <h3 className="font-semibold leading-snug group-hover:text-primary">{m.title}</h3>
                <p className="text-sm text-muted-foreground">{m.client}</p>
                {m.summary && <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{m.summary}</p>}
                <div className="mt-3 flex items-center justify-between">
                  <StatusDot status={m.status} />
                  <span className="text-[11px] text-muted-foreground">Opened {fmtDate(m.opened_on)}</span>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border bg-card">
            <table className="w-full text-sm">
              <thead className="bg-raised text-left text-xs text-muted-foreground">
                <tr><th className="px-4 py-2">No.</th><th className="px-4 py-2">Matter</th><th className="px-4 py-2">Client</th><th className="px-4 py-2">Practice</th><th className="px-4 py-2">Status</th></tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((m) => (
                  <tr key={m.id} className="hover:bg-raised/60">
                    <td className="px-4 py-2 font-mono text-xs">{m.number}</td>
                    <td className="px-4 py-2"><Link to="/matters/$id" params={{ id: m.id }} className="font-medium hover:text-primary">{m.title}</Link></td>
                    <td className="px-4 py-2 text-muted-foreground">{m.client}</td>
                    <td className="px-4 py-2"><PracticeChip area={m.practice_area} /></td>
                    <td className="px-4 py-2"><StatusDot status={m.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function NewMatter() {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ title: "", client: "", practice_area: "Corporate", summary: "", number: "" });
  const qc = useQueryClient();
  const navigate = useNavigate();
  async function save() {
    if (!f.title.trim()) return;
    const { data, error } = await supabase.from("matters").insert({ ...f, number: f.number || `${new Date().getFullYear()}-${String(Math.floor(Math.random() * 900) + 100)}` }).select().single();
    if (error) { toast.error(error.message); return; }
    await logActivity(data.id, "Matter opened");
    qc.invalidateQueries({ queryKey: ["matters"] });
    setOpen(false);
    navigate({ to: "/matters/$id", params: { id: data.id } });
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm"><Plus className="mr-1 h-4 w-4" />New matter</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>New matter</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1"><Label>Title</Label><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><Label>Client</Label><Input value={f.client} onChange={(e) => setF({ ...f, client: e.target.value })} /></div>
            <div className="space-y-1"><Label>Matter no.</Label><Input placeholder="Auto" value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} /></div>
          </div>
          <div className="space-y-1">
            <Label>Practice area</Label>
            <Select value={f.practice_area} onValueChange={(v) => setF({ ...f, practice_area: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{PRACTICE_AREAS.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1"><Label>Summary</Label><Textarea value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} /></div>
          <Button className="w-full" onClick={save}>Open matter</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
