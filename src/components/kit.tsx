import { useState, type ReactNode } from "react";
import { ShieldCheck, Gauge, Zap, AlertTriangle, RefreshCw, Trash2 } from "lucide-react";
import { practiceInk } from "@/lib/data";
import { humanize } from "@/lib/mutate";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string | undefined;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 px-4 pb-4 pt-6 md:px-8">
      <div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Panel({
  title,
  action,
  children,
  className = "",
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-xl border bg-card ${className}`}>
      {title && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          {action}
        </div>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function PracticeChip({ area }: { area: string }) {
  return (
    <span
      className={`inline-flex rounded-md px-2 py-0.5 text-[11px] font-medium ${practiceInk[area] ?? "bg-muted text-muted-foreground"}`}
    >
      {area}
    </span>
  );
}

export function StatusDot({ status }: { status: string }) {
  const c: Record<string, string> = {
    Intake: "bg-ink-purple",
    Active: "bg-ink-green",
    Closing: "bg-ink-amber",
    "On hold": "bg-ink-slate",
    Closed: "bg-muted-foreground",
  };
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className={`h-2 w-2 rounded-full ${c[status] ?? "bg-ink-slate"}`} />
      {status}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{children}</p>;
}

/** Skeleton rows shown while a list loads. */
export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2 py-1" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-9 w-full rounded-lg" style={{ opacity: 1 - i * 0.2 }} />
      ))}
    </div>
  );
}

/** Error state with a retry button. */
export function LoadError({ error, retry }: { error: unknown; retry?: () => void }) {
  const msg =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error && "message" in error
        ? String((error as { message: unknown }).message)
        : "Unknown error";
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-ink-red/30 bg-ink-red/5 px-3 py-2.5 text-sm">
      <AlertTriangle className="h-4 w-4 shrink-0 text-ink-red" />
      <span className="min-w-0 flex-1">Couldn't load this. {humanize(msg)}</span>
      {retry && (
        <Button size="sm" variant="outline" onClick={retry}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          Retry
        </Button>
      )}
    </div>
  );
}

/**
 * One place that decides what a list shows: skeleton while loading, error with retry,
 * the empty message when there are no rows, otherwise the rows.
 */
export type QueryLike<T> = {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  data: T[] | undefined;
  refetch: () => unknown;
};

export function ListState<T>({
  query,
  empty,
  rows = 3,
  children,
}: {
  query: QueryLike<T>;
  empty: ReactNode;
  rows?: number;
  children: (data: T[]) => ReactNode;
}) {
  if (query.isPending) return <Loading rows={rows} />;
  if (query.isError) return <LoadError error={query.error} retry={() => query.refetch()} />;
  if (!query.data?.length) return <Empty>{empty}</Empty>;
  return <>{children(query.data)}</>;
}

/** Confirmation for destructive actions. Renders its trigger; asks before calling onConfirm. */
export function Confirm({
  title,
  description,
  action = "Delete",
  onConfirm,
  children,
}: {
  title: string;
  description?: string;
  action?: string;
  onConfirm: () => void | Promise<void>;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <span
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
        className="contents"
      >
        {children}
      </span>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async (e) => {
                e.preventDefault();
                setBusy(true);
                try {
                  await onConfirm();
                  setOpen(false);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Working…" : action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** Icon-only delete button that always asks first. */
export function DeleteButton({
  what,
  onConfirm,
  className = "",
  description,
}: {
  what: string;
  onConfirm: () => void | Promise<void>;
  className?: string;
  description?: string;
}) {
  return (
    <Confirm
      title={`Delete ${what}?`}
      description={description ?? "This can't be undone."}
      onConfirm={onConfirm}
    >
      <button
        type="button"
        aria-label={`Delete ${what}`}
        className={`rounded-md p-1 text-muted-foreground transition-colors hover:bg-ink-red/10 hover:text-ink-red ${className}`}
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </Confirm>
  );
}

/** Effort + token note shown on every AI result. */
export function UsageNote({
  effort,
  usage,
}: {
  effort: Effort;
  usage?: { inputTokens?: number | undefined; outputTokens?: number | undefined } | undefined;
}) {
  const total = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
  return (
    <span className="inline-flex items-center gap-2 text-[11px] text-muted-foreground">
      <EffortBadge effort={effort} />
      {total > 0 && (
        <span
          title={`${(usage?.inputTokens ?? 0).toLocaleString()} in · ${(usage?.outputTokens ?? 0).toLocaleString()} out`}
        >
          {total.toLocaleString()} tokens
        </span>
      )}
    </span>
  );
}

export type Effort = "normal" | "advanced";

export function EffortToggle({
  value,
  onChange,
}: {
  value: Effort;
  onChange: (e: Effort) => void;
}) {
  return (
    <div
      className="inline-flex rounded-lg border bg-raised p-0.5 text-xs"
      role="radiogroup"
      aria-label="AI effort"
    >
      {(["normal", "advanced"] as const).map((e) => (
        <button
          key={e}
          role="radio"
          aria-checked={value === e}
          onClick={() => onChange(e)}
          className={`flex items-center gap-1 rounded-md px-2.5 py-1 font-medium transition-colors ${
            value === e
              ? e === "advanced"
                ? "bg-ink-purple text-primary-foreground"
                : "bg-card text-foreground shadow-sm"
              : "text-muted-foreground"
          }`}
        >
          {e === "normal" ? <Gauge className="h-3.5 w-3.5" /> : <Zap className="h-3.5 w-3.5" />}
          {e === "normal" ? "Normal" : "Advanced"}
        </button>
      ))}
    </div>
  );
}

export function EffortBadge({ effort }: { effort: Effort }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${effort === "advanced" ? "bg-ink-purple/15 text-ink-purple" : "bg-ink-blue/10 text-ink-blue"}`}
    >
      {effort}
    </span>
  );
}

export function ReviewBanner() {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-ink-amber/30 bg-ink-amber/10 px-3 py-2 text-xs text-foreground">
      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ink-amber" />
      <span>
        <b>Review before use.</b> This is a suggestion prepared for you — read it, check the
        sources, and decide what to keep. Nothing is saved until you choose.
      </span>
    </div>
  );
}

export function Why({ text }: { text: string }) {
  return (
    <details className="mt-1 text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none hover:text-foreground">Why</summary>
      <p className="mt-1 border-l-2 pl-2">{text}</p>
    </details>
  );
}
