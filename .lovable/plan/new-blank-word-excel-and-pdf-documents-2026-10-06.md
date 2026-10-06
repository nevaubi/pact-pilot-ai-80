# New blank Word, Excel and PDF documents

## Decision
Keep Files and House templates as separate pages. They do different jobs: Files holds working documents, and Templates holds the firm's standard forms. Add a compact **"New document"** strip at the top of the **Files** page, plus a smaller copy of the same buttons on the **Templates** page. Templates already has an upload; its new button creates a blank Word document that becomes a template.

## What the user sees
At the top of Files, three tiles in the existing compact style, each with a small file-type icon (blue W, green X, red PDF):
- **Word document**
- **Excel workbook**
- **PDF**

Clicking a tile opens a small dialog with:
- a name field, pre-filled as "Untitled document" / "Untitled workbook" / "Untitled PDF";
- an optional **Matter** picker. With no matter chosen, the file is saved firm-wide. The drafting assistant only appears when a matter is chosen, as it does today.

Then **Create & open** creates the file and opens it straight in the full-screen editor.

The same three tiles also appear as a "New document" button on each matter's Files tab, with the matter already chosen.

## Notes
- The new PDF is one blank Letter page. You can highlight and comment on it, but not type text into it, because the PDF tool annotates rather than authors. The tile says so in its tooltip. For drafting, Word is the right choice.
- New files start with an empty first version, so History and Save work as usual.

## Technical details
- New helper `createBlankFile(kind, name, matterId?)` in `src/lib/office.ts`:
  - **docx:** a minimal empty document built with the `docx` package.
  - **xlsx:** a basic new workbook from ExcelJS ("Sheet1"; new files are allowed this path).
  - **pdf:** one blank Letter page built with pdf-lib if it is installed, otherwise a fixed blank-page PDF.
  - Uploads to `matter-files` under `{matterId|firm}/{uuid}-{name}`, inserts the `files` row through `mut()`, then navigates to `/office/$fileId`.
- New component `NewDocumentStrip` (icons drawn in SVG with the existing colour tokens, low radius), used in `files.tsx`, the matter Files tab and `templates.tsx` (Word only, saved as a template).
- Editor code still loads only when the editor page opens, so the tiles add no heavy download.
- No database changes.
