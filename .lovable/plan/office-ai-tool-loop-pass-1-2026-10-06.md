# Office AI capability pass 1 — scope and verification

Scope (Office drafting assistant only; normal Assist stays on its existing path):

1. Bounded server tool loop for `/api/assist` mode `draft` (`src/lib/office-agent.server.ts`): AI SDK `tool()` + `streamText` + `stepCountIs` (normal 4, advanced 8), per-tool and overall deadlines, aggregate tool-output budget, server-side output cap, usage summed over all steps, honest activity events only.
2. Deterministic tools on request snapshots (`src/lib/office-tools.ts`, pure + tested): outline, stable blocks, range reads, literal bounded search, ranked context from question+selection with explicit coverage; workbook cell/range reads; matter files list/search/read scoped by `matter_id` through the caller's authenticated client; transient attachments search/read; public-law search (eCFR / Federal Register / CourtListener) with query sanitising; `validate_proposal`.
3. Strict proposals: Word `replace`/`insert_after` with exact literal anchors (must occur exactly once); sheet ops pinned to sheet+cell with typed values; full-batch preflight (unknown sheet, Excel bounds, duplicates, type checks) before any write; native receipts checked.
4. Client: robust NDJSON decoder, in-flight ref lock, identity-guarded abort/cleanup, delta batching, debounced persistence, retry, attachments with progress/limits, near-bottom autoscroll, IME-safe Enter, resizable panel, proposal cards with apply state.

Out of scope (next pass): original-byte preservation, XLSX OOXML round-trip safeguards, atomic version saves.
General web search: not configured (no credentials); shown as unavailable.

Verification: vitest regression suites, tsgo, eslint on touched files, production build, browser smoke on a synthetic fixture.
