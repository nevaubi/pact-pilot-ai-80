import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Plus, Mic, Pencil, X, Check } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import { Panel, ListState, DeleteButton } from "@/components/kit";
import { tableQ, matterContactsQ, contactsQ, fmtDate, fmtDateTime, dueLabel, logActivity } from "@/lib/data";
import { mut, tryAction } from "@/lib/mutate";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MeetingNotesDialog } from "./MeetingNotes";

function useInvalidate() {
  const qc = useQueryClient();
  return (...keys: unknown[][]) => keys.forEach((k) => qc.invalidateQueries({ queryKey: k }));
}

export const SourceTag = ({ source }: { source: string }) =>
  source === "assist" ? <span className="ml-1 rounded bg-ink-purple/10 px-1.5 text-[10px] font-medium text-ink-purple">from Assist</span> : null;

export const DEADLINE_KINDS = ["Contract", "Closing", "Filing", "Internal", "Client"];

// ---------------- Tasks ----------------

export function TasksTab({ matterId }: { matterId: string }) {
  const q = useQuery(tableQ("tasks", matterId));
  const inv = useInvalidate();
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState("");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = () => inv(["tasks", matterId], ["today-tasks"], ["activity", matterId]);

  async function add() {
    if (!title.trim() || busy) return;
    setBusy(true);
    await tryAction(async () => {
      await mut(supabase.from("tasks").insert({ matter_id: matterId, title: title.trim(), assignee: assignee.trim() || null, due_on: due || null }).select("id"), { success: "Task added" });
      setTitle(""); setAssignee(""); setDue("");
      refresh();
    });
    setBusy(false);
  }
  async function toggle(id: string, done: boolean, t: string) {
    await tryAction(async () => {
      await mut(supabase.from("tasks").update({ done }).eq("id", id).select("id"));
      if (done) await logActivity(matterId, `Completed task: ${t}`);
      refresh();
    });
  }
  async function del(id: string) {
    await tryAction(async () => {
      await mut(supabase.from("tasks").delete().eq("id", id).select("id"), { success: "Task deleted" });
      refresh();
    });
  }

  const open = q.data?.filter((t) => !t.done).length ?? 0;

  return (
    <Panel title={q.data ? `Tasks · ${open} open` : "Tasks"}>
      <form className="mb-4 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <Input className="min-w-[200px] flex-1" placeholder="New task" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Task title" />
        <Input className="w-36" placeholder="Assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Assignee" />
        <Input className="w-40" type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date" />
        <Button type="submit" disabled={!title.trim() || busy} aria-label="Add task"><Plus className="h-4 w-4" /></Button>
      </form>
      <ListState query={q} empty="No tasks yet. Add one above, or let Assist suggest some from a document or meeting notes.">
        {(rows) => (
          <ul className="divide-y">
            {[...rows].sort((a, b) => Number(a.done) - Number(b.done)).map((t) => {
              const d = t.due_on && !t.done ? dueLabel(t.due_on) : null;
              return (
                <li key={t.id} className="group flex items-center gap-3 py-2">
                  <Checkbox checked={t.done} onCheckedChange={(v) => toggle(t.id, !!v, t.title)} aria-label={`Mark ${t.title} ${t.done ? "open" : "done"}`} />
                  <div className="min-w-0 flex-1">
                    <p className={`text-sm ${t.done ? "text-muted-foreground line-through" : ""}`}>{t.title}<SourceTag source={t.source} /></p>
                    <p className="text-xs text-muted-foreground">
                      {t.assignee ?? "Unassigned"}
                      {t.due_on && <> · due {fmtDate(t.due_on)}{d && d.n < 0 && <span className="ml-1 font-medium text-ink-red">({d.label})</span>}</>}
                    </p>
                  </div>
                  <DeleteButton what="task" onConfirm={() => del(t.id)} className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100 sm:opacity-0 max-sm:opacity-100" />
                </li>
              );
            })}
          </ul>
        )}
      </ListState>
    </Panel>
  );
}

// ---------------- Deadlines ----------------

export function DeadlinesTab({ matterId }: { matterId: string }) {
  const q = useQuery(tableQ("deadlines", matterId));
  const inv = useInvalidate();
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [kind, setKind] = useState("Contract");
  const [busy, setBusy] = useState(false);
  const refresh = () => inv(["deadlines", matterId], ["today-deadlines"], ["activity", matterId]);

  async function add() {
    if (!title.trim() || !due || busy) return;
    setBusy(true);
    await tryAction(async () => {
      await mut(supabase.from("deadlines").insert({ matter_id: matterId, title: title.trim(), due_on: due, kind }).select("id"), { success: "Deadline added" });
      await logActivity(matterId, `Added deadline: ${title.trim()} (${fmtDate(due)})`);
      setTitle(""); setDue("");
      refresh();
    });
    setBusy(false);
  }
  async function del(id: string) {
    await tryAction(async () => {
      await mut(supabase.from("deadlines").delete().eq("id", id).select("id"), { success: "Deadline removed" });
      refresh();
    });
  }

  return (
    <Panel title="Deadlines">
      <form className="mb-4 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <Input className="min-w-[200px] flex-1" placeholder="Deadline" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Deadline title" />
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger className="w-36" aria-label="Kind"><SelectValue /></SelectTrigger>
          <SelectContent>{DEADLINE_KINDS.map((k) => <SelectItem key={k} value={k}>{k}</SelectItem>)}</SelectContent>
        </Select>
        <Input className="w-40" type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date" required />
        <Button type="submit" disabled={!title.trim() || !due || busy} aria-label="Add deadline"><Plus className="h-4 w-4" /></Button>
      </form>
      <ListState query={q} empty="No deadlines yet. Add key dates here, or map a document to pull them out automatically.">
        {(rows) => (
          <ul className="space-y-2">
            {rows.map((d) => {
              const { label, tone } = dueLabel(d.due_on);
              return (
                <li key={d.id} className="group flex items-center gap-3 rounded-lg bg-raised px-3 py-2">
                  <div className={`w-16 shrink-0 text-center text-xs font-semibold ${tone}`}>{label}</div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{d.title}<SourceTag source={d.source} /></p>
                    <p className="text-xs text-muted-foreground">{d.kind} · {fmtDate(d.due_on)}</p>
                  </div>
                  <DeleteButton what="deadline" onConfirm={() => del(d.id)} className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100 max-sm:opacity-100" />
                </li>
              );
            })}
          </ul>
        )}
      </ListState>
    </Panel>
  );
}

// ---------------- Notes ----------------

export function NotesTab({ matterId }: { matterId: string }) {
  const q = useQuery(tableQ("notes", matterId));
  const inv = useInvalidate();
  const [body, setBody] = useState("");
  const [meeting, setMeeting] = useState(false);
  const [busy, setBusy] = useState(false);
  const refresh = () => inv(["notes", matterId], ["activity", matterId]);

  async function add() {
    if (!body.trim() || busy) return;
    setBusy(true);
    await tryAction(async () => {
      await mut(supabase.from("notes").insert({ matter_id: matterId, body: body.trim() }).select("id"), { success: "Note added" });
      setBody("");
      refresh();
    });
    setBusy(false);
  }

  return (
    <div className="space-y-4">
      <Panel title="Notes" action={<Button size="sm" variant="outline" onClick={() => setMeeting(true)}><Mic className="mr-1.5 h-4 w-4" />Meeting notes</Button>}>
        <Textarea rows={3} placeholder="Write a note… (markdown is fine)" value={body} onChange={(e) => setBody(e.target.value)} />
        <Button size="sm" className="mt-2" onClick={add} disabled={!body.trim() || busy}>{busy ? "Saving…" : "Add note"}</Button>
      </Panel>
      <ListState query={q} empty="No notes yet. Notes and meeting memos filed here are what Assist reads when you ask it to catch you up.">
        {(rows) => <>{rows.map((n) => <NoteCard key={n.id} note={n} onChanged={refresh} />)}</>}
      </ListState>
      <MeetingNotesDialog matterId={matterId} open={meeting} onOpenChange={setMeeting} />
    </div>
  );
}

function NoteCard({ note, onChanged }: { note: Tables<"notes">; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.body);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    await tryAction(async () => {
      await mut(supabase.from("notes").update({ body: draft.trim() }).eq("id", note.id).select("id"), { success: "Note updated" });
      setEditing(false);
      onChanged();
    });
    setBusy(false);
  }
  async function del() {
    await tryAction(async () => {
      await mut(supabase.from("notes").delete().eq("id", note.id).select("id"), { success: "Note deleted" });
      onChanged();
    });
  }

  return (
    <article className="group rounded-xl border bg-card p-4">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {note.title ?? "Note"}
          {note.kind === "meeting" && <span className="ml-1.5 rounded bg-ink-teal/10 px-1.5 text-[10px] font-medium text-ink-teal">Meeting</span>}
        </h3>
        <div className="flex items-center gap-1">
          <span className="text-xs text-muted-foreground">{fmtDateTime(note.created_at)}</span>
          {!editing && (
            <button aria-label="Edit note" onClick={() => { setDraft(note.body); setEditing(true); }} className="rounded-md p-1 text-muted-foreground hover:bg-raised hover:text-foreground">
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
          <DeleteButton what="note" onConfirm={del} />
        </div>
      </div>
      {editing ? (
        <div className="space-y-2">
          <Textarea rows={6} value={draft} onChange={(e) => setDraft(e.target.value)} className="bg-raised" />
          <div className="flex gap-2">
            <Button size="sm" onClick={save} disabled={busy || !draft.trim()}><Check className="mr-1 h-3.5 w-3.5" />Save</Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}><X className="mr-1 h-3.5 w-3.5" />Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="md text-sm"><ReactMarkdown>{note.body}</ReactMarkdown></div>
      )}
    </article>
  );
}

// ---------------- Contacts on matter ----------------

export const RELATIONSHIPS = ["Client", "Counterparty", "Opposing counsel", "Lender", "Title / escrow", "Accountant", "Broker", "Other"];

export function ContactsTab({ matterId }: { matterId: string }) {
  const q = useQuery(matterContactsQ(matterId));
  const all = useQuery(contactsQ);
  const inv = useInvalidate();
  const [pick, setPick] = useState("");
  const [rel, setRel] = useState("Client");
  const [busy, setBusy] = useState(false);
  const linked = new Set((q.data ?? []).map((mc) => mc.contacts?.id));
  const choices = (all.data ?? []).filter((c) => !linked.has(c.id));

  async function link() {
    if (!pick || busy) return;
    setBusy(true);
    await tryAction(async () => {
      await mut(supabase.from("matter_contacts").insert({ matter_id: matterId, contact_id: pick, relationship: rel }).select("id"), { success: "Contact added to matter" });
      setPick("");
      inv(["matter_contacts", matterId]);
    });
    setBusy(false);
  }
  async function unlink(id: string) {
    await tryAction(async () => {
      await mut(supabase.from("matter_contacts").delete().eq("id", id).select("id"), { success: "Removed from matter" });
      inv(["matter_contacts", matterId]);
    });
  }

  return (
    <Panel title="People on this matter">
      <form className="mb-4 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); link(); }}>
        <Select value={pick} onValueChange={setPick}>
          <SelectTrigger className="w-64" aria-label="Contact"><SelectValue placeholder={all.isPending ? "Loading contacts…" : choices.length ? "Add a contact" : "All contacts already added"} /></SelectTrigger>
          <SelectContent>{choices.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}{c.organization ? ` — ${c.organization}` : ""}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={rel} onValueChange={setRel}>
          <SelectTrigger className="w-44" aria-label="Relationship"><SelectValue /></SelectTrigger>
          <SelectContent>{RELATIONSHIPS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
        </Select>
        <Button type="submit" disabled={!pick || busy} aria-label="Add contact"><Plus className="h-4 w-4" /></Button>
      </form>
      <ListState query={q} empty="No contacts linked yet. Add people from the firm directory so everyone knows who's who on this deal.">
        {(rows) => (
          <ul className="grid gap-2 sm:grid-cols-2">
            {rows.map((mc) => (
              <li key={mc.id} className="group flex items-start justify-between gap-2 rounded-lg bg-raised p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{mc.contacts?.name}</p>
                  <p className="text-xs text-muted-foreground">{[mc.relationship, mc.contacts?.organization].filter(Boolean).join(" · ")}</p>
                  {mc.contacts?.email && <a href={`mailto:${mc.contacts.email}`} className="block truncate text-xs text-primary">{mc.contacts.email}</a>}
                  {mc.contacts?.phone && <p className="text-xs text-muted-foreground">{mc.contacts.phone}</p>}
                </div>
                <button aria-label={`Remove ${mc.contacts?.name ?? "contact"} from matter`} onClick={() => unlink(mc.id)} className="rounded-md p-1 text-muted-foreground opacity-0 hover:bg-card hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 max-sm:opacity-100">
                  <X className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </ListState>
    </Panel>
  );
}

// ---------------- Activity ----------------

export function ActivityTab({ matterId }: { matterId: string }) {
  const q = useQuery(tableQ("activity", matterId));
  return (
    <Panel title="Activity">
      <ListState query={q} empty="No activity yet.">
        {(rows) => (
          <ul className="space-y-2">
            {rows.map((a) => (
              <li key={a.id} className="flex justify-between gap-3 text-sm">
                <span><b className="font-medium">{a.actor}</b> <span className="text-muted-foreground">{a.message}</span></span>
                <span className="shrink-0 text-xs text-muted-foreground">{fmtDateTime(a.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </ListState>
    </Panel>
  );
}
