import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createNdjsonDecoder, readNdjson } from "@/lib/ndjson";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { access_token: "a.b.c" } } }) },
  },
}));
vi.mock("@/lib/error-log", () => ({ logClientError: vi.fn() }));

import { useAssist, budgetHistory, type Turn } from "@/hooks/use-assist";

const enc = new TextEncoder();
function controllable() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) });
  return {
    body,
    push: (s: string) => ctl.enqueue(enc.encode(s)),
    close: () => ctl.close(),
    error: (e: unknown) => ctl.error(e),
  };
}

describe("NDJSON decoding", () => {
  it("handles UTF-8 split across chunks and lines split across chunks", () => {
    const d = createNdjsonDecoder<{ t: string; text?: string }>();
    const bytes = enc.encode(JSON.stringify({ t: "delta", text: "§ café — 契約" }) + "\n");
    const out = [];
    for (let i = 0; i < bytes.length; i += 3) out.push(...d.push(bytes.slice(i, i + 3)));
    expect(out).toEqual([{ t: "delta", text: "§ café — 契約" }]);
  });
  it("processes a final line with no trailing newline and detects a missing terminal event", async () => {
    const s1 = controllable();
    const seen: string[] = [];
    const p1 = readNdjson<{ t: string }>(s1.body, (e) => seen.push(e.t));
    s1.push('{"t":"delta","text":"a"}\n{"t":"do');
    s1.push('ne","usage":{}}');
    s1.close();
    expect((await p1).terminal).toBe(true);
    expect(seen).toEqual(["delta", "done"]);
    const s2 = controllable();
    const p2 = readNdjson<{ t: string }>(s2.body, () => {});
    s2.push('{"t":"delta","text":"a"}\nnot json\n');
    s2.close();
    expect(await p2).toEqual({ terminal: false, malformed: 1 });
  });
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);

describe("useAssist request lifecycle", () => {
  beforeEach(() => sessionStorage.clear());

  it("ignores a double submit (synchronous lock) and batches deltas", async () => {
    const s = controllable();
    const fetchMock = vi.fn(async () => new Response(s.body, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(
      () =>
        useAssist({ matterId: "m", storeKey: "k1", effort: "normal", mode: "draft", flushMs: 10 }),
      { wrapper },
    );
    let a!: Promise<boolean>, b!: Promise<boolean>;
    act(() => {
      a = result.current.send("one");
      b = result.current.send("two");
    });
    expect(await b).toBe(false);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    s.push('{"t":"delta","text":"Hel"}\n{"t":"delta","text":"lo"}\n');
    s.push('{"t":"done","usage":{"inputTokens":5},"runId":null}');
    s.close();
    await act(async () => void (await a));
    expect(result.current.turns).toHaveLength(1);
    expect(result.current.turns[0]).toMatchObject({ a: "Hello", status: "done" });
    expect(result.current.busy).toBe(false);
  });

  it("marks an interrupted stream stopped with partial text kept and retryable", async () => {
    const s = controllable();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(s.body)),
    );
    const { result } = renderHook(
      () => useAssist({ matterId: "m", storeKey: "k2", effort: "normal", flushMs: 5 }),
      { wrapper },
    );
    let p!: Promise<boolean>;
    act(() => void (p = result.current.send("q")));
    await waitFor(() => expect(result.current.busy).toBe(true));
    s.push('{"t":"delta","text":"partial"}\n');
    s.close();
    await act(async () => void (await p));
    expect(result.current.turns[0]).toMatchObject({
      a: "partial",
      status: "stopped",
      retryable: true,
    });
  });

  it("clear aborts the in-flight request and a stale request can't touch the new state", async () => {
    let signal: AbortSignal | undefined;
    const s = controllable();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_u: string, init: RequestInit) => ((signal = init.signal!), new Response(s.body)),
      ),
    );
    const { result } = renderHook(
      () => useAssist({ matterId: "m", storeKey: "k3", effort: "normal", flushMs: 5 }),
      { wrapper },
    );
    let p!: Promise<boolean>;
    act(() => void (p = result.current.send("first")));
    await waitFor(() => expect(signal).toBeDefined());
    act(() => result.current.clear());
    expect(signal!.aborted).toBe(true);
    expect(result.current.busy).toBe(false);
    try {
      s.push('{"t":"delta","text":"late"}\n');
      s.close();
    } catch {
      /* stream errored by abort */
    }
    await act(async () => void (await p));
    expect(result.current.turns).toEqual([]);
    // A new request may start immediately.
    const s2 = controllable();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(s2.body)),
    );
    let p2!: Promise<boolean>;
    act(() => void (p2 = result.current.send("second")));
    s2.push('{"t":"done","usage":{},"runId":null}\n');
    s2.close();
    await act(async () => void (await p2));
    expect(result.current.turns.map((t) => t.q)).toEqual(["second"]);
  });

  it("switching files aborts the old request and loads the new file's conversation", async () => {
    let signal: AbortSignal | undefined;
    const s = controllable();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_u: string, init: RequestInit) => ((signal = init.signal!), new Response(s.body)),
      ),
    );
    sessionStorage.setItem(
      "fileB",
      JSON.stringify([{ id: "x", q: "old B", a: "ans", effort: "normal", status: "done" }]),
    );
    const { result, rerender } = renderHook(
      (p: { k: string }) =>
        useAssist({ matterId: "m", storeKey: p.k, effort: "normal", flushMs: 5 }),
      { wrapper, initialProps: { k: "fileA" } },
    );
    let p!: Promise<boolean>;
    act(() => void (p = result.current.send("on A")));
    await waitFor(() => expect(signal).toBeDefined());
    rerender({ k: "fileB" });
    expect(signal!.aborted).toBe(true);
    await act(async () => void (await p.catch(() => true)));
    expect(result.current.turns.map((t) => t.q)).toEqual(["old B"]);
    expect(result.current.busy).toBe(false);
  });

  it("surfaces server errors with retryable flag", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { message: "Rate limited. Try again shortly.", retryable: true },
          { status: 429 },
        ),
      ),
    );
    const { result } = renderHook(
      () => useAssist({ matterId: "m", storeKey: "k5", effort: "normal" }),
      { wrapper },
    );
    await act(async () => void (await result.current.send("q")));
    expect(result.current.turns[0]).toMatchObject({
      status: "error",
      error: "Rate limited. Try again shortly.",
      retryable: true,
    });
  });

  it("budgets history", () => {
    const t = (i: number): Turn => ({
      id: String(i),
      q: "q".repeat(100),
      a: "a".repeat(9000),
      effort: "normal",
      status: "done",
    });
    const h = budgetHistory([1, 2, 3, 4, 5, 6, 7].map(t));
    expect(h.length).toBe(3); // 3 × (100 + 6000 clipped) under 24k; a 4th would exceed
    expect(h[0]!.a.length).toBe(6000);
  });
});

describe("DraftPanel UI", () => {
  it("shows empty state, error with Retry, and never applies a proposal twice", async () => {
    const { DraftPanel } = await import("@/components/office/DraftPanel");
    sessionStorage.setItem(
      "mirza-draft-f1",
      JSON.stringify([
        {
          id: "e1",
          q: "fails",
          a: "",
          effort: "normal",
          status: "error",
          error: "Gateway busy.",
          retryable: true,
        },
      ]),
    );
    sessionStorage.setItem(
      "mirza-draft-f2",
      JSON.stringify([
        {
          id: "p1",
          q: "tighten",
          a: "Shortened.",
          effort: "normal",
          status: "done",
          proposal: {
            proposal: {
              kind: "word",
              summary: "s",
              edits: [{ op: "replace", find: "ten", replace: "five" }],
            },
            validation: { ok: true, errors: [] },
          },
        },
      ]),
    );
    const applyProposal = vi.fn(async () => ({
      ok: true as const,
      applied: 1,
      detail: "1 tracked change added",
    }));
    const editor = {
      current: {
        getText: async () => "",
        getSelection: async () => "",
        insert: vi.fn(),
        export: vi.fn(),
        applyProposal,
      },
    } as never;
    const props = {
      matterId: "m",
      fileName: "APA.docx",
      kind: "docx" as const,
      canInsert: true,
      getDoc: async () => ({ name: "APA.docx", kind: "docx" as const, text: "ten" }),
      editor,
    };

    const { unmount } = render(<DraftPanel {...props} fileId="f0" />, { wrapper });
    expect(await screen.findByText("Fill blanks")).toBeInTheDocument();
    unmount();

    const r1 = render(<DraftPanel {...props} fileId="f1" />, { wrapper });
    expect(await screen.findByText("Gateway busy.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeEnabled();
    r1.unmount();

    render(<DraftPanel {...props} fileId="f2" />, { wrapper });
    const btn = await screen.findByRole("button", { name: /apply as tracked changes/i });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await screen.findByText(/1 tracked change added/);
    expect(applyProposal).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /applied/i })).toBeDisabled();
  });

  it("keeps the typed request when reading the document fails", async () => {
    const { DraftPanel } = await import("@/components/office/DraftPanel");
    const editor = {
      current: {
        getText: async () => "",
        getSelection: async () => "",
        insert: vi.fn(),
        export: vi.fn(),
      },
    } as never;
    render(
      <DraftPanel
        matterId="m"
        fileId="f9"
        fileName="x.docx"
        kind="docx"
        canInsert
        editor={editor}
        getDoc={async () => {
          throw new Error("boom");
        }}
      />,
      { wrapper },
    );
    const box = screen.getByLabelText("Drafting request");
    fireEvent.change(box, { target: { value: "Draft a notice clause" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent(/request is kept/);
    expect(box).toHaveValue("Draft a notice clause");
  });
});
