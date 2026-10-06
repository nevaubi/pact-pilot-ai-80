<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Architecture rules
- Homepage social branding is repeated on its Today and sign-in redirect destinations; why: link-preview clients following redirects still receive the Mirza preview.
- AI calls live only in `src/lib/ai.functions.ts` (auth-protected server fns) and the streaming chat route `src/routes/api/assist.ts`, both using helpers in `src/lib/ai.server.ts` (provider, `matterContext`, `logRun`, `toAiError`); why: keeps the key server-side and logs every run to `ai_runs` for cost review.
- The Assist chat streams over a bearer-verified server route (`authFromRequest` in `src/lib/auth.server.ts`) as NDJSON events, not a buffered server fn; why: long Advanced answers must show progressively and be stoppable.
- `matterContext` is one embedded PostgREST select with per-file and per-effort total character caps; why: one round trip and bounded token cost.
- Gateway failures are mapped to plain messages in `ai.server.ts` (`describeStatus`/`toAiError`); only 429/5xx get a bounded backoff; everything else is terminal; why: gateway error semantics, no runaway retries.
- Every backend write goes through `mut()`/`tryAction()` in `src/lib/mutate.ts`; every list renders through `ListState` and every delete through `Confirm`/`DeleteButton` in `src/components/kit.tsx`; why: no silent failures, consistent loading/empty/error states and confirmations.
- Matter tab lives in the URL search param `?tab=`; Assist conversation persists per matter in sessionStorage; why: reload and tab switches don't lose the attorney's place.
- Template originals (.docx) are stored in the `matter-files` bucket under `templates/` with the path on `templates.path`; why: the firm keeps its formatted form while drafting works from extracted text.
- AI never writes data directly; it returns suggestions the user ticks/accepts in the UI; why: product principle "support, not primary".
- Drafts always derive from firm-uploaded house templates with `[[Field]]`/`{{Field}}` blanks filled deterministically; AI may only fill blanks or propose verbatim-anchored redlines; why: attorneys want consistent forms.
- Document text is extracted in the browser (`src/lib/extract.ts`) and stored on `files.extracted_text`; why: Worker runtime can't run pdf/docx parsers.
- Heavy matter tools load on demand and matter tabs prefetch only their active data; why: routine navigation should not download OCR/AI/editor code or fetch unused tabs.
- All firm data is shared to any signed-in user (RLS `to authenticated using (true)`); why: phase 1 has no roles.
- WebAssembly binaries (e.g. pdfium) are served from `public/wasm/` and loaded by URL in client-only code, never imported from source; why: imported .wasm lands in the Worker server bundle and breaks deploys.
- Office editors (`src/components/office/*`) share one `EditorHandle` (`insert()` returns an `InsertResult`, never a bare boolean) and load lazily on `/office/$fileId`; AI text enters a document only via the attorney clicking Insert/Replace/Apply cells; why: one shell for Word/PDF/sheet and AI stays supportive.
- Word proposals (replace / insert_after / inline format) are applied only through SuperDoc's native atomic `mutations.preview` → `mutations.apply` (tracked, `exactlyOne` literal selectors, previewed revision as precondition) after revalidating against live text, and success requires an explicit `success: true` receipt (`src/lib/office-apply.ts`); why: identity is the unique anchor, never an equal-text selection, and an unconfirmed edit is never reported as applied.
- Spreadsheet changes are typed `SheetOp`s preflighted as a whole batch, written with explicit cell types (text = FORCE_STRING), verified per write, and restored from exact snapshots on failure, with a failed restore reported as partial; legacy `A1 = value` fences must be all assignments and pin to the ask-time sheet; why: no partial or coerced writes, no false rollback claims.
- Browser errors are logged to `client_errors` via `logClientError`/`installErrorLogging` in `src/lib/error-log.ts` (wired into the root error boundary, `mut()`/`tryAction()`, the Office route boundary and editor catch blocks) and reviewed under Settings → Error log; messages and stacks only, never document content; why: production failures must be reviewable by the firm without developer tools.
- Clipboard writes go through `copyText()` in `src/lib/clipboard.ts`; why: clipboard access can be denied and must not surface as an unhandled rejection.
- Saves upload to a fresh object path, then call the SECURITY INVOKER RPC `save_file_version` with the path the editing session loaded; a conflict removes only the new upload (`src/lib/office.ts`); why: no fetch-then-overwrite races and history is never lost.
- Unchanged files are saved/downloaded as their exact stored bytes; edited XLSX is written by patching only changed cells/appended styles into the original ZIP (`src/lib/xlsx-package.ts`) and fails closed on structural or shared-formula edits; why: rebuilding a workbook silently drops charts, comments and custom parts.
- `/api/assist` caps the raw body and validates every aggregate before building context; the draft loop has per-tool abortable deadlines, call/parallel caps, a Responses `max_output_tokens` cap and a tool-free final round (`src/lib/office-agent.server.ts`); why: bounded cost and time per request.
- Public law for the assistant goes only through `src/lib/public-law.server.ts` (fixed host/path allowlist, re-checked redirects, one deadline incl. body, byte cap, per-provider status); why: no SSRF surface and no failure disguised as zero results.
- `/dev/office-harness` is a development-only synthetic test page (404 outside `vite dev`); why: browser verification of real editors without touching matter data or auth.
