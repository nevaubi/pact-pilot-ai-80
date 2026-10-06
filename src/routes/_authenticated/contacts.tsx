import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Plus, Search, Pencil } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import { contactsQ } from "@/lib/data";
import { mut, tryAction } from "@/lib/mutate";
import { PageHeader, ListState, Confirm } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

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

type Contact = Tables<"contacts">;
const FIELDS = ["name", "organization", "role", "email", "phone"] as const;
const blank = { name: "", organization: "", role: "", email: "", phone: "" };

function Contacts() {
  const q = useQuery(contactsQ);
  const data = q.data ?? [];
  const [term, setTerm] = useState("");
  const [editing, setEditing] = useState<Contact | "new" | null>(null);
  const links = useQuery({
    queryKey: ["contact-matters"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("matter_contacts")
        .select("contact_id, relationship, matters(id,title)");
      if (error) throw new Error(error.message);
      return data;
    },
  });
  const rows = data.filter((c) =>
    `${c.name} ${c.organization ?? ""} ${c.role ?? ""} ${c.email ?? ""}`
      .toLowerCase()
      .includes(term.toLowerCase()),
  );
  const filtered = { ...q, data: q.data ? rows : undefined } as typeof q;

  return (
    <div className="pb-8">
      <PageHeader
        title="Contacts"
        subtitle={q.data ? `${data.length} people` : undefined}
        actions={
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus className="mr-1 h-4 w-4" />
            New contact
          </Button>
        }
      />
      <div className="p-4 md:p-6">
        <div className="relative mb-4 max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            className="bg-card pl-8"
            placeholder="Search"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            aria-label="Search contacts"
          />
        </div>
        <ListState
          query={filtered}
          rows={4}
          empty={
            data.length
              ? "No contacts match."
              : "No contacts yet. Add clients, counterparties and counsel so they can be linked to matters."
          }
        >
          {(list) => (
            <div className="overflow-hidden rounded border bg-card">
              {list.map((c) => {
                const on = (links.data ?? []).filter((l) => l.contact_id === c.id);
                return (
                  <div key={c.id} className="group flex gap-3 border-b p-3 last:border-b-0 hover:bg-raised/50">
                    <div className="grid h-8 w-8 shrink-0 place-items-center rounded bg-ink-blue/10 text-xs font-semibold text-ink-blue">
                      {c.name
                        .split(" ")
                        .map((s) => s[0])
                        .slice(0, 2)
                        .join("")
                        .toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <p className="font-medium">{c.name}</p>
                        <button
                          aria-label={`Edit ${c.name}`}
                          onClick={() => setEditing(c)}
                          className="rounded-md p-1 text-muted-foreground opacity-0 hover:bg-raised hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 max-sm:opacity-100"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {[c.role, c.organization].filter(Boolean).join(" · ")}
                      </p>
                      {c.email && (
                        <a
                          href={`mailto:${c.email}`}
                          className="block truncate text-xs text-primary"
                        >
                          {c.email}
                        </a>
                      )}
                      {c.phone && <p className="text-xs text-muted-foreground">{c.phone}</p>}
                      {on.length > 0 && (
                        <p className="mt-1.5 truncate text-[11px] text-muted-foreground">
                          {on.slice(0, 2).map((l, i) => (
                            <span key={i}>
                              {i > 0 && ", "}
                              {l.matters ? (
                                <Link
                                  to="/matters/$id"
                                  params={{ id: l.matters.id }}
                                  search={{ tab: "Contacts" }}
                                  className="hover:text-primary"
                                >
                                  {l.matters.title}
                                </Link>
                              ) : null}
                            </span>
                          ))}
                          {on.length > 2 && ` +${on.length - 2} more`}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </ListState>
      </div>
      <ContactDialog contact={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function ContactDialog({
  contact,
  onClose,
}: {
  contact: Contact | "new" | null;
  onClose: () => void;
}) {
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const isNew = contact === "new";
  useEffect(() => {
    if (!contact) return;
    setF(
      contact === "new"
        ? blank
        : {
            name: contact.name,
            organization: contact.organization ?? "",
            role: contact.role ?? "",
            email: contact.email ?? "",
            phone: contact.phone ?? "",
          },
    );
  }, [contact]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["contacts"] });
    qc.invalidateQueries({ queryKey: ["contact-matters"] });
    qc.invalidateQueries({ queryKey: ["matter_contacts"] });
  };

  async function save() {
    if (!f.name.trim() || busy) return;
    setBusy(true);
    await tryAction(async () => {
      const row = {
        name: f.name.trim(),
        organization: f.organization.trim() || null,
        role: f.role.trim() || null,
        email: f.email.trim() || null,
        phone: f.phone.trim() || null,
      };
      if (isNew)
        await mut(supabase.from("contacts").insert(row).select("id"), { success: "Contact added" });
      else if (contact)
        await mut(supabase.from("contacts").update(row).eq("id", contact.id).select("id"), {
          success: "Contact updated",
        });
      refresh();
      onClose();
    });
    setBusy(false);
  }
  async function remove() {
    if (!contact || contact === "new") return;
    await tryAction(async () => {
      await mut(supabase.from("contacts").delete().eq("id", contact.id).select("id"), {
        success: "Contact deleted",
      });
      refresh();
      onClose();
    });
  }

  return (
    <Dialog open={!!contact} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isNew ? "New contact" : "Edit contact"}</DialogTitle>
          <DialogDescription>
            Shared across the firm and available to link on any matter.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            {FIELDS.map((k) => (
              <div key={k} className={`space-y-1 ${k === "name" ? "col-span-2" : ""}`}>
                <Label htmlFor={`c-${k}`} className="capitalize">
                  {k}
                </Label>
                <Input
                  id={`c-${k}`}
                  type={k === "email" ? "email" : k === "phone" ? "tel" : "text"}
                  value={f[k]}
                  onChange={(e) => setF({ ...f, [k]: e.target.value })}
                  required={k === "name"}
                />
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between gap-2 pt-1">
            {!isNew && contact ? (
              <Confirm
                title={`Delete ${contact.name}?`}
                description="They'll be removed from every matter they're linked to."
                onConfirm={remove}
              >
                <Button
                  type="button"
                  variant="ghost"
                  className="text-ink-red hover:bg-ink-red/10 hover:text-ink-red"
                >
                  Delete
                </Button>
              </Confirm>
            ) : (
              <span />
            )}
            <Button type="submit" disabled={busy || !f.name.trim()}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
