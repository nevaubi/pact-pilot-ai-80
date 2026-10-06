import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Plus, Trash2, Mic } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { supabase } from "@/integrations/supabase/client";
import { Panel, Empty } from "@/components/kit";
import { tableQ, matterContactsQ, contactsQ, fmtDate, daysUntil, logActivity } from "@/lib/data";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MeetingNotesDialog } from "./MeetingNotes";
import { toast } from "sonner";

function useInvalidate() {
  const qc = useQueryClient();
  return (...keys: unknown[][]) => keys.forEach((k) => qc.invalidateQueries({ queryKey: k }));
}

const SourceTag = ({ source }: { source: string }) =>
  source === "assist" ? <span className="rounded bg-ink-purple/10 px-1.5 text-[10px] font-medium text-ink-purple">from Assist</span> : null;

export function TasksTab({ matterId }: { matterId: string }) {
  const { data = [] } = useQuery(tableQ("tasks", matterId));
  const inv = useInvalidate();
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState("");
  const [due, setDue] = useState("");
  async function add() {
    if (!title.trim()) return;
    await supabase.from("tasks").insert({ matter_id: matterId, title, assignee: assignee || null, due_on: due || null });
    setTitle(""); setAssignee(""); setDue("");
    inv(["tasks", matterId], ["today-tasks"]);
  }
  async function toggle(id: string, done: boolean, t: string) {
    await supabase.from("tasks").update({ done }).eq("id", id);
    if (done) await logActivity(matterId, `Completed task: ${t}`);
    inv(["tasks", matterId], ["today-tasks"]);
  }
  async function del(id: string) {
    await supabase.from("tasks").delete().eq("id", id);
    inv(["tasks", matterId]);
  }
  return (
    <Panel title="Tasks">
      <div className="mb-4 flex flex-wrap gap-2">
        <Input className="min-w-[200px] flex-1" placeholder="New task" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        <Input className="w-36" placeholder="Assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)} />
        <Input className="w-40" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        <Button onClick={add}><Plus className="h-4 w-4" /></Button>
      </div>
      {!data.length ? <Empty>No tasks yet.</Empty> : (
        <ul className="divide-y">
          {data.map((t) => (
            <li key={t.id} className="group flex items-center gap-3 py-2">
              <Checkbox checked={t.done} onCheckedChange={(v) => toggle(t.id, !!v, t.title)} aria-label="Done" />
              <div className="min-w-0 flex-1">
                <p className={`text-sm ${t.done ? "text-muted-foreground line-through" : ""}`}>{t.title} <SourceTag source={t.source} /></p>
                <p className="text-xs text-muted-foreground">{t.assignee ?? "Unassigned"}{t.due_on && ` · due ${fmtDate(t.due_on)}`}</p>
              </div>
              <button aria-label="Delete" onClick={() => del(t.id)} className="opacity-0 group-hover:opacity-100"><Trash2 className="h-4 w-4 text-muted-foreground" /></button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function DeadlinesTab({ matterId }: { matterId: string }) {
  const { data = [] } = useQuery(tableQ("deadlines", matterId));
  const inv = useInvalidate();
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [kind, setKind] = useState("Contract");
  async function add() {
    if (!title.trim() || !due) return;
    await supabase.from("deadlines").insert({ matter_id: matterId, title, due_on: due, kind });
    setTitle(""); setDue("");
    inv(["deadlines", matterId], ["today-deadlines"]);
  }
  return (
    <Panel title="Deadlines">
      <div className="mb-4 flex flex-wrap gap-2">
        <Input className="min-w-[200px] flex-1" placeholder="Deadline" value={title} onChange={(e) => setTitle(e.target.value)} />
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>{["Contract", "Closing", "Filing", "Internal", "Client"].map((k) => <SelectItem key={k} value={k}>{k}</SelectItem>)}</SelectContent>
        </Select>
        <Input className="w-40" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        <Button onClick={add}><Plus className="h-4 w-4" /></Button>
      </div>
      {!data.length ? <Empty>No deadlines yet.</Empty> : (
        <ul className="space-y-2">
          {data.map((d) => {
            const n = daysUntil(d.due_on);
            return (
              <li key={d.id} className="group flex items-center gap-3 rounded-lg bg-raised px-3 py-2">
                <div className={`w-16 text-center text-xs font-semibold ${n < 0 ? "text-ink-red" : n <= 7 ? "text-ink-amber" : "text-muted-foreground"}`}>{n < 0 ? `${-n}d late` : n === 0 ? "Today" : `${n}d`}</div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{d.title} <SourceTag source={d.source} /></p>
                  <p className="text-xs text-muted-foreground">{d.kind} · {fmtDate(d.due_on)}</p>
                </div>
                <button aria-label="Delete" onClick={async () => { await supabase.from("deadlines").delete().eq("id", d.id); inv(["deadlines", matterId]); }} className="opacity-0 group-hover:opacity-100"><Trash2 className="h-4 w-4 text-muted-foreground" /></button>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

export function NotesTab({ matterId }: { matterId: string }) {
  const { data = [] } = useQuery(tableQ("notes", matterId));
  const inv = useInvalidate();
  const [body, setBody] = useState("");
  const [meeting, setMeeting] = useState(false);
  async function add() {
    if (!body.trim()) return;
    await supabase.from("notes").insert({ matter_id: matterId, body });
    setBody("");
    inv(["notes", matterId]);
  }
  return (
    <div className="space-y-4">
      <Panel title="Notes" action={<Button size="sm" variant="outline" onClick={() => setMeeting(true)}><Mic className="mr-1.5 h-4 w-4" />Meeting notes</Button>}>
        <Textarea rows={3} placeholder="Write a note…" value={body} onChange={(e) => setBody(e.target.value)} />
        <Button size="sm" className="mt-2" onClick={add}>Add note</Button>
      </Panel>
      {data.map((n) => (
        <article key={n.id} className="rounded-xl border bg-card p-4">
          <div className="mb-1 flex items-center justify-between">
            <h3 className="text-sm font-semibold">{n.title ?? "Note"} {n.kind === "meeting" && <span className="ml-1 rounded bg-ink-teal/10 px-1.5 text-[10px] text-ink-teal">Meeting</span>}</h3>
            <span className="text-xs text-muted-foreground">{new Date(n.created_at).toLocaleString()}</span>
          </div>
          <div className="prose prose-sm max-w-none text-sm text-foreground dark:prose-invert"><ReactMarkdown>{n.body}</ReactMarkdown></div>
        </article>
      ))}
      <MeetingNotesDialog matterId={matterId} open={meeting} onOpenChange={setMeeting} />
    </div>
  );
}

export function ContactsTab({ matterId }: { matterId: string }) {
  const { data = [] } = useQuery(matterContactsQ(matterId));
  const all = useQuery(contactsQ);
  const inv = useInvalidate();
  const [pick, setPick] = useState("");
  const [rel, setRel] = useState("Client");
  async function link() {
    if (!pick) return;
    const { error } = await supabase.from("matter_contacts").insert({ matter_id: matterId, contact_id: pick, relationship: rel });
    if (error) toast.error(error.message);
    inv(["matter_contacts", matterId]);
  }
  return (
    <Panel title="People on this matter">
      <div className="mb-4 flex flex-wrap gap-2">
        <Select value={pick} onValueChange={setPick}>
          <SelectTrigger className="w-64"><SelectValue placeholder="Add a contact" /></SelectTrigger>
          <SelectContent>{all.data?.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}{c.organization ? ` — ${c.organization}` : ""}</SelectItem>)}</SelectContent>
        </Select>
        <Input className="w-44" value={rel} onChange={(e) => setRel(e.target.value)} placeholder="Relationship" />
        <Button onClick={link}><Plus className="h-4 w-4" /></Button>
      </div>
      {!data.length ? <Empty>No contacts linked.</Empty> : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {data.map((mc) => (
            <li key={mc.id} className="rounded-lg bg-raised p-3">
              <p className="text-sm font-medium">{mc.contacts?.name}</p>
              <p className="text-xs text-muted-foreground">{mc.relationship} · {mc.contacts?.organization}</p>
              {mc.contacts?.email && <p className="text-xs text-primary">{mc.contacts.email}</p>}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function ActivityTab({ matterId }: { matterId: string }) {
  const { data = [] } = useQuery(tableQ("activity", matterId));
  return (
    <Panel title="Activity">
      {!data.length ? <Empty>No activity yet.</Empty> : (
        <ul className="space-y-2">
          {data.map((a) => (
            <li key={a.id} className="flex justify-between gap-3 text-sm">
              <span><b className="font-medium">{a.actor}</b> <span className="text-muted-foreground">{a.message}</span></span>
              <span className="shrink-0 text-xs text-muted-foreground">{new Date(a.created_at).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
