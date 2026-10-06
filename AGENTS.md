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
