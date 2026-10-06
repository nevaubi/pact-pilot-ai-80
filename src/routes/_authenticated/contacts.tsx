import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Plus, Search } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { contactsQ } from "@/lib/data";
import { PageHeader, Empty } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/contacts")({
  head: () => ({
    meta: [
      { title: "Contacts — Mirza" },
      { name: "description", content: "Clients, counterparties and counsel across the firm." },
      { property: "og:title", content: "Contacts — Mirza" },
      { property: "og:description", content: "Firm contacts directory." },
    ],
  }),
  component: Contacts,
});

function Contacts() {
  const { data = [] } = useQuery(contactsQ);
  const [term, setTerm] = useState("");
  const rows = data.filter((c) => `${c.name} ${c.organization} ${c.email}`.toLowerCase().includes(term.toLowerCase()));
  return (
    <div className="pb-10">
      <PageHeader title="Contacts" subtitle={`${data.length} people`} actions={<NewContact />} />
      <div className="px-4 md:px-8">
        <div className="relative mb-4 max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input className="bg-card pl-8" placeholder="Search" value={term} onChange={(e) => setTerm(e.target.value)} />
        </div>
        {!rows.length ? <Empty>No contacts.</Empty> : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {rows.map((c) => (
              <div key={c.id} className="flex gap-3 rounded-xl border bg-card p-4">
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-ink-blue/10 text-sm font-semibold text-ink-blue">{c.name.split(" ").map((s) => s[0]).slice(0, 2).join("")}</div>
                <div className="min-w-0">
                  <p className="font-medium">{c.name}</p>
                  <p className="text-xs text-muted-foreground">{[c.role, c.organization].filter(Boolean).join(" · ")}</p>
                  {c.email && <a href={`mailto:${c.email}`} className="block truncate text-xs text-primary">{c.email}</a>}
                  {c.phone && <p className="text-xs text-muted-foreground">{c.phone}</p>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function NewContact() {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: "", organization: "", role: "", email: "", phone: "" });
  const qc = useQueryClient();
  async function save() {
    if (!f.name.trim()) return;
    const { error } = await supabase.from("contacts").insert(f);
    if (error) { toast.error(error.message); return; }
    qc.invalidateQueries({ queryKey: ["contacts"] });
    setOpen(false);
    setF({ name: "", organization: "", role: "", email: "", phone: "" });
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm"><Plus className="mr-1 h-4 w-4" />New contact</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>New contact</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          {(["name", "organization", "role", "email", "phone"] as const).map((k) => (
            <div key={k} className={`space-y-1 ${k === "name" ? "col-span-2" : ""}`}>
              <Label className="capitalize">{k}</Label>
              <Input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
            </div>
          ))}
        </div>
        <Button onClick={save}>Save</Button>
      </DialogContent>
    </Dialog>
  );
}
