import { toast } from "sonner";
import { logClientError } from "@/lib/error-log";

type Result = { data: unknown; error: { message: string } | null };

class ToastedError extends Error {
  toasted = true;
}

/**
 * Await a backend write, surface failures as a toast, and throw so callers stop.
 * Every mutation in the app goes through here so no write can fail silently.
 */
export async function mut<R extends Result>(
  p: PromiseLike<R>,
  opts: { success?: string; failure?: string } = {},
): Promise<NonNullable<R["data"]>> {
  const { data, error } = await p;
  if (error) {
    toast.error(opts.failure ?? "That didn't save", { description: humanize(error.message) });
    logClientError(new Error(error.message), "save", { action: opts.failure ?? opts.success ?? "write" });
    throw new ToastedError(error.message);
  }
  if (opts.success) toast.success(opts.success);
  return data as NonNullable<R["data"]>;
}

/** Map raw backend messages to something an attorney can act on. */
export function humanize(message: string) {
  const m = message.toLowerCase();
  if (m.includes("jwt") || m.includes("not authenticated") || m.includes("unauthorized"))
    return "Your session has expired. Please sign in again.";
  if (m.includes("permission") || m.includes("row-level security") || m.includes("policy"))
    return "You don't have access to do that.";
  if (m.includes("duplicate key")) return "That already exists.";
  if (m.includes("violates foreign key"))
    return "Something this depends on was removed. Refresh and try again.";
  if (m.includes("failed to fetch") || m.includes("network"))
    return "Couldn't reach the server. Check your connection and try again.";
  if (m.includes("payload too large") || m.includes("exceeded the maximum allowed size"))
    return "That file is too large (25 MB limit).";
  return message;
}

/** Run an async UI action; toast unknown failures (mut() already toasted its own) and never throw into React. */
export async function tryAction(fn: () => Promise<unknown>, failure = "That didn't work") {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ToastedError) return;
    toast.error(failure, { description: humanize(e instanceof Error ? e.message : String(e)) });
    logClientError(e, "save", { action: failure });
  }
}
