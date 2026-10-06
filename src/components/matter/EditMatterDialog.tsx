import { cloneElement, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import { PRACTICE_AREAS, STATUSES, logActivity } from "@/lib/data";
import { mut, tryAction } from "@/lib/mutate";
import { Confirm } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type M = Tables<"matters">;

export function EditMatterDialog({
  matter,
  open,
  onOpenChange,
}: {
  matter: M;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [f, setF] = useState(pick(matter));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setF(pick(matter));
  }, [open, matter]);

  async function save() {
    if (!f.title.trim()) return;
    setBusy(true);
    await tryAction(async () => {
      const patch = {
        title: f.title.trim(),
        client: f.client.trim() || null,
        number: f.number.trim() || null,
        practice_area: f.practice_area,
        status: f.status,
        responsible: f.responsible.trim() || null,
        opened_on: f.opened_on || null,
        summary: f.summary.trim() || null,
      };
      await mut(supabase.from("matters").update(patch).eq("id", matter.id).select().single(), {
        success: "Matter updated",
      });
      if (patch.status !== matter.status)
        await logActivity(matter.id, `Status changed to ${patch.status}`);
      else await logActivity(matter.id, "Matter details updated");
      qc.invalidateQueries({ queryKey: ["matter", matter.id] });
      qc.invalidateQueries({ queryKey: ["matters"] });
      qc.invalidateQueries({ queryKey: ["activity", matter.id] });
      onOpenChange(false);
    });
    setBusy(false);
  }

  async function remove() {
    await tryAction(async () => {
      // Files live in storage; remove them first so nothing is orphaned.
      const { data: files } = await supabase
        .from("files")
        .select("path")
        .eq("matter_id", matter.id);
      if (files?.length)
        await supabase.storage.from("matter-files").remove(files.map((x) => x.path));
      await mut(supabase.from("matters").delete().eq("id", matter.id).select("id"), {
        success: "Matter deleted",
      });
      onOpenChange(false);
      await navigate({ to: "/matters" });
      // Drop this matter's cached queries, then refresh the lists that referenced it.
      qc.removeQueries({ queryKey: ["matter", matter.id] });
      qc.removeQueries({ predicate: (query) => query.queryKey[1] === matter.id });
      [
        "matters",
        "today-deadlines",
        "today-tasks",
        "today-activity",
        "files-hub",
        "contact-matters",
        "ai-usage",
      ].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    }, "Couldn't delete the matter");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit matter</DialogTitle>
          <DialogDescription>Changes apply for everyone at the firm.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <Field label="Title">
            <Input
              value={f.title}
              onChange={(e) => setF({ ...f, title: e.target.value })}
              required
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Client">
              <Input value={f.client} onChange={(e) => setF({ ...f, client: e.target.value })} />
            </Field>
            <Field label="Matter no.">
              <Input value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Practice area">
              <Select
                value={f.practice_area}
                onValueChange={(v) => setF({ ...f, practice_area: v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRACTICE_AREAS.map((a) => (
                    <SelectItem key={a} value={a}>
                      {a}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Status">
              <Select value={f.status} onValueChange={(v) => setF({ ...f, status: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Responsible attorney">
              <Input
                value={f.responsible}
                onChange={(e) => setF({ ...f, responsible: e.target.value })}
              />
            </Field>
            <Field label="Opened">
              <Input
                type="date"
                value={f.opened_on}
                onChange={(e) => setF({ ...f, opened_on: e.target.value })}
              />
            </Field>
          </div>
          <Field label="Summary">
            <Textarea
              rows={3}
              value={f.summary}
              onChange={(e) => setF({ ...f, summary: e.target.value })}
            />
          </Field>
          <div className="flex items-center justify-between gap-2 pt-1">
            <Confirm
              title="Delete this matter?"
              description="Its tasks, deadlines, notes, files, drafts and closing checklist are deleted with it. This can't be undone."
              action="Delete matter"
              onConfirm={remove}
            >
              <Button
                type="button"
                variant="ghost"
                className="text-ink-red hover:bg-ink-red/10 hover:text-ink-red"
              >
                Delete matter
              </Button>
            </Confirm>
            <Button type="submit" disabled={busy || !f.title.trim()}>
              {busy ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function pick(m: M) {
  return {
    title: m.title,
    client: m.client ?? "",
    number: m.number ?? "",
    practice_area: m.practice_area,
    status: m.status,
    responsible: m.responsible ?? "",
    opened_on: m.opened_on ?? "",
    summary: m.summary ?? "",
  };
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactElement<{ id?: string }>;
}) {
  const id = `em-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      {cloneElement(children, { id })}
    </div>
  );
}
