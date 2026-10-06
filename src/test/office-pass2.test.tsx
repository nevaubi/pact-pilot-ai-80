import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createNdjsonDecoder } from "@/lib/ndjson";

const session = vi.hoisted(() => ({ gate: null as null | Promise<void> }));
const rpc = vi.hoisted(() => ({
  result: { data: null as unknown, error: null as null | { code?: string; message: string } },
  calls: [] as unknown[],
  uploads: [] as string[],
  removed: [] as string[],
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: async () => {
        if (session.gate) await session.gate;
        return { data: { session: { access_token: "a.b.c" } } };
      },
    },
    rpc: async (name: string, args: unknown) => {
      rpc.calls.push({ name, args });
      return rpc.result;
    },
    storage: {
      from: () => ({
        upload: async (path: string) => (rpc.uploads.push(path), { error: null }),
        remove: async (paths: string[]) => (rpc.removed.push(...paths), { error: null }),
        download: async () => ({ data: new Blob(["old"]), error: null }),
      }),
    },
  },
}));
vi.mock("@/lib/error-log", () => ({ logClientError: vi.fn() }));

import { useAssist } from "@/hooks/use-assist";
import { saveNewVersion, restoreVersion, SaveConflict } from "@/lib/office";

const enc = new TextEncoder();
function controllable() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) });
  return { body, push: (s: string) => ctl.enqueue(enc.encode(s)), close: () => ctl.close() };
}
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);

describe("use-assist ownership (P0-4)", () => {
  beforeEach(() => {
    sessionStorage.clear();
    session.gate = null;
  });

  it("Stop during getSession prevents the fetch", async () => {
    let open!: () => void;
    session.gate = new Promise<void>((r) => (open = r));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useAssist({ matterId: "m", storeKey: "p1", effort: "normal" }), { wrapper });
    let p!: Promise<boolean>;
    act(() => void (p = result.current.send("q")));
    act(() => result.current.stop());
    open();
    await act(async () => void (await p));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.turns[0]).toMatchObject({ status: "error", error: "Stopped." });
  });

  it("an empty successful stream is not a successful answer; step exhaustion says so", async () => {
    const s = controllable();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(s.body)));
    const { result } = renderHook(() => useAssist({ matterId: "m", storeKey: "p2", effort: "normal", flushMs: 5 }), { wrapper });
    let p!: Promise<boolean>;
    act(() => void (p = result.current.send("q")));
    await waitFor(() => expect(result.current.busy).toBe(true));
    s.push('{"t":"done","usage":{},"runId":null,"exhausted":true}\n');
    s.close();
    await act(async () => void (await p));
    expect(result.current.turns[0]).toMatchObject({ status: "error", retryable: true });
    expect(result.current.turns[0]!.error).toMatch(/steps/);
  });

  it("a superseded request can never write into the next turn", async () => {
    const s1 = controllable();
    const s2 = controllable();
    const queue = [s1, s2];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(queue.shift()!.body)));
    const { result } = renderHook(() => useAssist({ matterId: "m", storeKey: "p3", effort: "normal", flushMs: 5 }), { wrapper });
    let p1!: Promise<boolean>;
    act(() => void (p1 = result.current.send("first")));
    await waitFor(() => expect(result.current.busy).toBe(true));
    s1.push('{"t":"delta","text":"old-"}\n');
    act(() => result.current.clear());
    let p2!: Promise<boolean>;
    act(() => void (p2 = result.current.send("second")));
    await waitFor(() => expect(result.current.busy).toBe(true));
    s2.push('{"t":"delta","text":"new"}\n{"t":"done","usage":{},"runId":null}\n');
    s2.close();
    await act(async () => void (await Promise.all([p1.catch(() => true), p2])));
    expect(result.current.turns).toHaveLength(1);
    expect(result.current.turns[0]).toMatchObject({ q: "second", a: "new", status: "done" });
  });

  it("caps the NDJSON line buffer", () => {
    const d = createNdjsonDecoder(100);
    expect(() => d.push(enc.encode("x".repeat(200)))).toThrow(/oversized/);
  });
});

describe("DraftPanel (P0-5)", () => {
  it("keeps text typed during a request and only clears what was sent", async () => {
    const s = controllable();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(s.body)));
    const { DraftPanel } = await import("@/components/office/DraftPanel");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const editor = { current: { getText: async () => "", getSelection: async () => "", insert: vi.fn(), export: vi.fn() } } as never;
    render(
      <DraftPanel
        matterId="m"
        fileId="k1"
        fileName="x.docx"
        kind="docx"
        canInsert
        editor={editor}
        getDoc={async () => (await gate, { name: "x.docx", kind: "docx" as const, text: "t" })}
      />,
      { wrapper },
    );
    const box = screen.getByLabelText("Drafting request");
    fireEvent.change(box, { target: { value: "first request" } });
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.keyDown(box, { key: "Enter" }); // second Enter before render: ignored by the sync lock
    fireEvent.change(box, { target: { value: "next idea" } });
    release();
    await waitFor(() => expect(screen.getByText("first request")).toBeInTheDocument());
    expect(box).toHaveValue("next idea");
    s.close();
  });

  it("rejects an oversized batch of references up front", async () => {
    const { DraftPanel } = await import("@/components/office/DraftPanel");
    const editor = { current: { getText: async () => "", getSelection: async () => "", insert: vi.fn(), export: vi.fn() } } as never;
    const { container } = render(
      <DraftPanel matterId="m" fileId="k2" fileName="x.docx" kind="docx" canInsert editor={editor} getDoc={async () => ({ name: "x", kind: "docx" as const, text: "" })} />,
      { wrapper },
    );
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const files = Array.from({ length: 6 }, (_, i) => new File(["hello"], `r${i}.txt`, { type: "text/plain" }));
    fireEvent.change(input, { target: { files } });
    expect(await screen.findByRole("alert")).toHaveTextContent(/at most 5 references/);
    expect(screen.queryByLabelText("Attached references")).toBeNull();
  });
});

describe("conflict-safe save (11)", () => {
  const file = { id: "f1", name: "APA.docx", matter_id: "m1" };
  beforeEach(() => {
    rpc.calls = [];
    rpc.uploads = [];
    rpc.removed = [];
  });
  it("uploads first, then one RPC with the session's expected path", async () => {
    rpc.result = { data: null, error: null };
    rpc.result.data = [{ path: "PLACEHOLDER", version_id: "v" }];
    const blob = new Blob(["x"], { type: "text/plain" });
    // The RPC echoes the path it was given.
    rpc.result = { data: null, error: null };
    const origRpc = rpc.result;
    void origRpc;
    const p = saveNewVersion(file, "m1/old.docx", blob, { text: "t" });
    await waitFor(() => expect(rpc.uploads).toHaveLength(1));
    // Fill the response with the uploaded path before the promise resolves.
    rpc.result.data = [{ path: rpc.uploads[0], version_id: "v" }];
    await expect(p).resolves.toBe(rpc.uploads[0]);
    expect((rpc.calls[0] as { args: Record<string, unknown> }).args).toMatchObject({
      p_file_id: "f1",
      p_expected_path: "m1/old.docx",
      p_new_path: rpc.uploads[0],
      p_update_text: true,
    });
  });
  it("a conflict removes only the just-uploaded object and raises SaveConflict", async () => {
    rpc.result = { data: null, error: { code: "40001", message: "conflict: file changed since it was opened" } };
    await expect(saveNewVersion(file, "m1/old.docx", new Blob(["x"]))).rejects.toBeInstanceOf(SaveConflict);
    expect(rpc.removed).toEqual(rpc.uploads);
    expect(rpc.removed).not.toContain("m1/old.docx");
  });
  it("restore refuses a version from another file", async () => {
    await expect(
      restoreVersion(file, "m1/old.docx", {
        id: "v",
        file_id: "OTHER",
        path: "m1/x",
        size: 1,
        note: null,
        created_by: null,
        created_at: new Date().toISOString(),
      }),
    ).rejects.toThrow(/different file/);
  });
});
