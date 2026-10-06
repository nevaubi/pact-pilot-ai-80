# Cleaner file-type icons

The "New document" buttons on the Files page (and matter Files tab) currently use flat colored squares with a plain letter (W / X / PDF). They look crude next to the rest of the polished UI. The file list rows also use a generic document glyph for every file type.

## What changes

1. **New file-type icon set** (inline SVG, no image files, so they stay crisp at any size):
   - Document shape with a folded corner — the universal "file" silhouette — in the app's existing token palette.
   - Word: slate/blue document with a refined "W" letterform; Excel: green document with "X"; PDF: red document with "PDF".
   - Consistent geometry, stroke weight and corner radius across all three; subtle two-tone shading (folded corner slightly lighter) instead of flat fills.
   - Built as one small `FileTypeIcon` component with a `type` prop, using existing CSS tokens (no hardcoded hex in components beyond the brand-consistent type colors, defined once).

2. **Use the same icons in the file list** so each row shows its real type (Word/Excel/PDF/text) instead of one generic glyph — ties the page together.

3. **Button strip polish**: keep the compact layout, align icon and text baseline, consistent hover state.

## What does not change

- No new pages, no behavior changes, no AI/editor changes.
- Sidebar icons, favicon and branding stay as they are.

## Verification

- Screenshot the Files page and a matter Files tab at desktop and mobile widths; check crispness and alignment.
- `tsgo --noEmit` and production build.
