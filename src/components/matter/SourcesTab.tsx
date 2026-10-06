import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Globe, Link2, Pin, PinOff, Search, ExternalLink } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import { logActivity } from "@/lib/data";
import { mut, tryAction } from "@/lib/mutate";
import { authoritiesQ, librarySearchQ, matterAuthoritiesQ, practiceTopic, topicLabel, type AuthorityRow } from "@/lib/library";
import { Panel, ListState, DeleteButton } from "@/components/kit";
import { StatusChip, JurChip, Snippet } from "@/components/library/SourceBits";
import { AuthoritySheet } from "@/components/library/AuthoritySheet";
import { PublicSearchDialog } from "@/components/library/PublicSearchDialog";
import { AddLinkDialog } from "@/components/library/AddLinkDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Sources pinned to the matter. Pinned authorities are read first by Assist, the tax checker and
 * the real-estate reviews, so the attorney controls what the AI leans on.
 */
export function SourcesTab({ matter }: { matter: Tables<"matters"> }) {
  const qc = useQueryClient();
  const pinned = useQuery(matterAuthoritiesQ(matter.id));
  const lib = useQuery(authoritiesQ);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState<AuthorityRow | null>(null);
  const [publicSearch, setPublicSearch] = useState(false);
  const [addLink, setAddLink] = useState(false);
  const topic = practiceTopic[matter.practice_area] ?? "compliance";

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);
  const search = useQuery(librarySearchQ(debounced));

  const pinnedIds = useMemo(() => new Set((pinned.data ?? []).map((p) => p.authorities?.id).filter(Boolean)), [pinned.data]);
  const byId = useMemo(() => new Map((lib.data ?? []).map((a) => [a.id, a])), [lib.data]);
  const suggested = useMemo(
    () => (lib.data ?? []).filter((a) => a.topics.includes(topic) && !pinnedIds.has(a.id) && a.status === "ready").slice(0, 8),
    [lib.data, topic, pinnedIds],
  );
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["matter_authorities", matter.id] });
    qc.invalidateQueries({ queryKey: ["activity", matter.id] });
  };

  async function pin(a: Pick<AuthorityRow, "id" | "citation">) {
    await tryAction(async () => {
      await mut(
        supabase.from("matter_authorities").upsert({ matter_id: matter.id, authority_id: a.id }, { onConflict: "matter_id,authority_id", ignoreDuplicates: true }).select("id"),
        { success: `${a.citation} pinned` },
      );
      await logActivity(matter.id, `Pinned source ${a.citation}`);
      refresh();
    });
  }
  async function unpin(rowId: string, citation: string) {
    await tryAction(async () => {
      await mut(supabase.from("matter_authorities").delete().eq("id", rowId).select("id"), { success: `${citation} unpinned` });
      await logActivity(matter.id, `Unpinned source ${citation}`);
      refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Pinned sources are read first by Assist, the tax check and the real-estate reviews. The rest of the library's{" "}
          <b>{topicLabel(topic)}</b> sources are used after them.
        </p>
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" onClick={() => setPublicSearch(true)}>
            <Globe className="mr-1.5 h-3.5 w-3.5" /> Search public sources
          </Button>
          <Button size="sm" variant="outline" onClick={() => setAddLink(true)}>
            <Link2 className="mr-1.5 h-3.5 w-3.5" /> Add by link
          </Button>
        </div>
      </div>

      <Panel title="Pinned to this matter">
        <ListState query={pinned} empty="Nothing pinned yet. Pin the statutes, regulations and guidance this deal turns on." rows={2}>
          {(rows) => (
            <ul className="divide-y">
              {rows.map((p) => {
                const a = p.authorities;
                if (!a) return null;
                return (
                  <li key={p.id} className="flex flex-wrap items-center gap-2 py-2">
                    <button className="flex min-w-0 flex-1 items-start gap-2 text-left" onClick={() => setOpen(a)}>
                      <JurChip j={a.jurisdiction} />
                      <span className="min-w-0">
                        <span className="font-mono text-xs font-medium">{a.citation}</span>
                        <span className="block truncate text-sm">{a.title}</span>
                      </span>
                    </button>
                    <StatusChip a={a} />
                    <Button size="icon" variant="ghost" asChild aria-label="Open source">
                      <a href={a.url} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    </Button>
                    <DeleteButton what="pin" description={`${a.citation} stays in the library; it just stops being pinned here.`} onConfirm={() => unpin(p.id, a.citation)} />
                  </li>
                );
              })}
            </ul>
          )}
        </ListState>
      </Panel>

      <Panel title="Find in the library">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search stored statutes, regulations and guidance…" className="pl-8" aria-label="Search library" />
        </div>
        {debounced.length >= 2 ? (
          <div className="mt-2">
            <ListState query={search} empty="No stored text matches." rows={3}>
              {(hits) => (
                <ul className="divide-y">
                  {hits.slice(0, 12).map((h) => {
                    const a = byId.get(h.authority_id);
                    const isPinned = pinnedIds.has(h.authority_id);
                    return (
                      <li key={`${h.authority_id}:${h.chunk_idx}`} className="flex items-start gap-2 py-2">
                        <button className="min-w-0 flex-1 text-left" onClick={() => a && setOpen(a)}>
                          <div className="flex flex-wrap items-center gap-1.5 text-xs">
                            <JurChip j={h.jurisdiction} />
                            <span className="font-mono font-medium">{h.citation}</span>
                            <span className="text-muted-foreground">· {h.title}</span>
                          </div>
                          <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed">
                            <Snippet text={h.snippet} />
                          </p>
                        </button>
                        <Button size="sm" variant={isPinned ? "ghost" : "outline"} disabled={isPinned} onClick={() => a && pin(a)}>
                          {isPinned ? <PinOff className="mr-1 h-3.5 w-3.5" /> : <Pin className="mr-1 h-3.5 w-3.5" />}
                          {isPinned ? "Pinned" : "Pin"}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </ListState>
          </div>
        ) : (
          suggested.length > 0 && (
            <div className="mt-2">
              <p className="mb-1 text-[11px] font-semibold uppercase text-muted-foreground">Suggested for {matter.practice_area}</p>
              <ul className="divide-y">
                {suggested.map((a) => (
                  <li key={a.id} className="flex items-center gap-2 py-1.5">
                    <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen(a)}>
                      <JurChip j={a.jurisdiction} />
                      <span className="font-mono text-xs">{a.citation}</span>
                      <span className="truncate text-xs text-muted-foreground">{a.title}</span>
                    </button>
                    <Button size="sm" variant="outline" onClick={() => pin(a)}>
                      <Pin className="mr-1 h-3.5 w-3.5" /> Pin
                    </Button>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Browse everything in the{" "}
                <Link to="/library" className="underline hover:text-foreground">
                  Law library
                </Link>
                .
              </p>
            </div>
          )
        )}
      </Panel>

      <AuthoritySheet a={open} onClose={() => setOpen(null)} matterId={matter.id} />
      {publicSearch && <PublicSearchDialog open onClose={() => setPublicSearch(false)} matterId={matter.id} defaultTopic={topic} />}
      {addLink && <AddLinkDialog open onClose={() => setAddLink(false)} matterId={matter.id} defaultTopic={topic} />}
    </div>
  );
}
