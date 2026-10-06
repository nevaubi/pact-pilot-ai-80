// Browser-side text extraction for uploaded documents (text only — no layout processing).
export async function extractText(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".docx")) {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return value;
  }
  if (name.endsWith(".pdf")) {
    const pdfjs = await import("pdfjs-dist");
    const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pages: string[] = [];
    for (let i = 1; i <= Math.min(doc.numPages, 80); i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map((it) => ("str" in it ? it.str : "")).join(" "));
    }
    return pages.join("\n\n");
  }
  return await file.text();
}

/** Template blanks: [[Field Name]] or {{Field Name}} */
export function templateFields(body: string): string[] {
  const set = new Set<string>();
  for (const m of body.matchAll(/\[\[([^\]]+)\]\]|\{\{([^}]+)\}\}/g)) set.add((m[1] ?? m[2] ?? "").trim());
  return [...set];
}

export function fillTemplate(body: string, answers: Record<string, string>) {
  return body.replace(/\[\[([^\]]+)\]\]|\{\{([^}]+)\}\}/g, (all, a, b) => {
    const v = answers[(a ?? b).trim()];
    return v && v.trim() ? v : all;
  });
}
