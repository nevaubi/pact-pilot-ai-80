import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { addAuthority } from "@/lib/library.functions";
import { JURISDICTIONS, TOPICS, type Topic } from "@/lib/library";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** Add any public page or PDF (an ordinance, a county fee schedule, an agency bulletin) by link. */
export function AddLinkDialog({ open, onClose, matterId, defaultTopic = "real_estate" }: { open: boolean; onClose: () => void; matterId?: string; defaultTopic?: Topic }) {
  const [url, setUrl] = useState("");
  const [citation, setCitation] = useState("");
  const [title, setTitle] = useState("");
  const [jur, setJur] = useState("illinois");
  const [kind, setKind] = useState("guidance");
  const [topics, setTopics] = useState<string[]>([defaultTopic]);
  const [busy, setBusy] = useState(false);
  const add = useServerFn(addAuthority);
  const qc = useQueryClient();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const isPdf = /\.pdf(\?|$)/i.test(url);
      const r = await add({
        data: {
          url: url.trim(),
          citation: citation.trim() || title.trim().slice(0, 80),
          title: title.trim(),
          source: isPdf ? "pdf" : "html",
          jurisdiction: jur as never,
          kind,
          topics,
          ...(matterId ? { matterId } : {}),
        },
      });
      qc.invalidateQueries({ queryKey: ["authorities"] });
      if (matterId) qc.invalidateQueries({ queryKey: ["matter_authorities", matterId] });
      if (r.status === "ready") toast.success("Source added and indexed");
      else if (r.status === "stored") toast.success("PDF stored", { description: "Its text will be read on the next library update." });
      else toast.warning("Added, but the page couldn't be fetched", { description: `${"message" in r ? r.message : ""} You can attach a saved copy from the library.` });
      onClose();
    } catch (err) {
      toast.error("Couldn't add that link", { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="h-4 w-4 text-primary" /> Add a source by link
          </DialogTitle>
          <DialogDescription>Any public web page or PDF — a municipal ordinance, a county schedule, an agency bulletin. Mirza stores a copy and indexes its text.</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={submit}>
          <div className="space-y-1">
            <Label htmlFor="al-url">Link</Label>
            <Input id="al-url" type="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="al-cite">Citation / short name</Label>
              <Input id="al-cite" value={citation} onChange={(e) => setCitation(e.target.value)} placeholder="e.g. Evanston Code § 3-2-5" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="al-title">Title</Label>
              <Input id="al-title" required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What it is" />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Jurisdiction</Label>
              <Select value={jur} onValueChange={setJur}>
                <SelectTrigger aria-label="Jurisdiction">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {JURISDICTIONS.map(([v, l]) => (
                    <SelectItem key={v} value={v}>
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Type</Label>
              <Select value={kind} onValueChange={setKind}>
                <SelectTrigger aria-label="Type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["statute", "regulation", "ordinance", "guidance", "form", "case"].map((k) => (
                    <SelectItem key={k} value={k}>
                      {k[0]!.toUpperCase() + k.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1">
            <Label>Topics</Label>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
              {TOPICS.map(([v, l]) => (
                <label key={v} className="flex items-center gap-1.5">
                  <Checkbox checked={topics.includes(v)} onCheckedChange={(c) => setTopics((t) => (c ? [...t, v] : t.filter((x) => x !== v)))} aria-label={l} />
                  {l}
                </label>
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !url || !title || !topics.length}>
              {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {busy ? "Fetching…" : "Add and fetch"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
