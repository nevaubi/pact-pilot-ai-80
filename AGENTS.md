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
- AI calls live only in `src/lib/ai.functions.ts` (auth-protected server fns) using helpers in `src/lib/ai.server.ts`; why: keeps key server-side and logs every run to `ai_runs` for cost review.
- AI never writes data directly; it returns suggestions the user ticks/accepts in the UI; why: product principle "support, not primary".
- Drafts always derive from firm-uploaded house templates with `[[Field]]`/`{{Field}}` blanks filled deterministically; AI may only fill blanks or propose verbatim-anchored redlines; why: attorneys want consistent forms.
- Document text is extracted in the browser (`src/lib/extract.ts`) and stored on `files.extracted_text`; why: Worker runtime can't run pdf/docx parsers.
- All firm data is shared to any signed-in user (RLS `to authenticated using (true)`); why: phase 1 has no roles.
