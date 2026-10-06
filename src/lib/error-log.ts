import { supabase } from "@/integrations/supabase/client";
import { reportLovableError } from "@/lib/lovable-error-reporting";

/**
 * Firm-visible error log. Records what broke (message, stack, page, a little context) to
 * `client_errors` so problems in production can be reviewed from Settings → Error log.
 * Never pass document text, file contents or credentials in `context`.
 */

export type ErrorSource = "boundary" | "window" | "promise" | "office" | "save" | "ai" | "manual";

type Entry = {
  route: string;
  source: ErrorSource;
  message: string;
  stack: string | null;
  context: Record<string, unknown>;
};

const RECENT_WINDOW_MS = 15_000;
const MAX_PER_MINUTE = 20;
const recent = new Map<string, number>();
const minute: number[] = [];
let installed = false;

const NOISE = [
  /ResizeObserver loop/i,
  /Loading chunk [\d]+ failed/i,
  /Failed to fetch dynamically imported module/i, // handled by the router's reload-on-stale-build path
  /AbortError/i,
  /The user aborted a request/i,
  /signal is aborted/i,
];

function describe(error: unknown): { message: string; stack: string | null } {
  if (error instanceof Response)
    return {
      message: `Response ${error.status}${error.url ? ` at ${error.url}` : ""}`,
      stack: null,
    };
  if (error instanceof Error)
    return { message: error.message || error.name || "Error", stack: error.stack ?? null };
  if (typeof error === "string") return { message: error, stack: null };
  try {
    return { message: JSON.stringify(error).slice(0, 500), stack: null };
  } catch {
    return { message: String(error), stack: null };
  }
}

function allowed(key: string) {
  const now = Date.now();
  const last = recent.get(key);
  if (last && now - last < RECENT_WINDOW_MS) return false;
  recent.set(key, now);
  while (minute.length && now - minute[0]! > 60_000) minute.shift();
  if (minute.length >= MAX_PER_MINUTE) return false;
  minute.push(now);
  return true;
}

function sanitizeContext(context: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(context)) {
    if (v == null) continue;
    if (typeof v === "string") out[k] = v.slice(0, 300);
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else {
      try {
        out[k] = JSON.parse(JSON.stringify(v).slice(0, 600));
      } catch {
        /* unserializable: skip */
      }
    }
  }
  return out;
}

async function persist(entry: Entry) {
  try {
    const { data } = await supabase.auth.getSession();
    if (!data.session) return; // signed-out pages: nothing to attribute the error to
    await supabase.from("client_errors").insert({
      route: entry.route.slice(0, 300),
      source: entry.source,
      message: entry.message.slice(0, 2000),
      stack: entry.stack ? entry.stack.slice(0, 8000) : null,
      context: entry.context as never,
      user_agent: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 300) : null,
    });
  } catch {
    /* the log must never cause a second failure */
  }
}

/** Record an error. Safe to call anywhere in the browser; no-op during SSR. */
export function logClientError(
  error: unknown,
  source: ErrorSource = "manual",
  context: Record<string, unknown> = {},
) {
  if (typeof window === "undefined") return;
  const { message, stack } = describe(error);
  if (!message || NOISE.some((re) => re.test(message))) return;
  const route = window.location.pathname;
  if (!allowed(`${source}|${route}|${message.slice(0, 120)}`)) return;
  const entry: Entry = { route, source, message, stack, context: sanitizeContext(context) };
  // Keep the console useful in development and for support screenshots.
  if (import.meta.env.DEV) console.warn(`[error-log:${source}]`, message, entry.context);
  void persist(entry);
}

/** Install once: uncaught errors and unhandled promise rejections go to the log. */
export function installErrorLogging() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (ev) => {
    // Resource load failures (img/script) have no error object and are noise here.
    if (!ev.error && !ev.message) return;
    logClientError(ev.error ?? ev.message, "window", {
      filename: ev.filename,
      line: ev.lineno,
      col: ev.colno,
    });
  });
  window.addEventListener("unhandledrejection", (ev) => {
    logClientError(ev.reason, "promise");
  });
}

/** Error boundaries: log to the firm's error log and to the Lovable preview reporter. */
export function logBoundaryError(
  error: unknown,
  boundary: string,
  context: Record<string, unknown> = {},
) {
  reportLovableError(error, { boundary, ...context });
  logClientError(error, "boundary", { boundary, ...context });
}
