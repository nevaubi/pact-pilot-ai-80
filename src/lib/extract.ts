// Browser-side text extraction for uploaded documents (text only — no layout processing).

/** pdf.js 6 prefers Math.sumPrecise and warns on every page when the browser lacks it. */
function polyfillSumPrecise() {
  const m = Math as unknown as { sumPrecise?: (xs: Iterable<number>) => number };
  if (typeof m.sumPrecise === "function") return;
  m.sumPrecise = (xs) => {
    let sum = 0;
    let c = 0;
    for (const x of xs) {
      const t = sum + x;
      c += Math.abs(sum) >= Math.abs(x) ? sum - t + x : x - t + sum;
      sum = t;
    }
    return sum + c;
  };
}

export async function extractText(file: File, maxPages = 80): Promise<string> {
  polyfillSumPrecise();
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
    for (let i = 1; i <= Math.min(doc.numPages, maxPages); i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      // Keep line structure: pdf.js marks end-of-line items, which lets headings stand on their own.
      let line = "";
      const lines: string[] = [];
      for (const it of content.items) {
        if (!("str" in it)) continue;
        line += it.str;
        if (it.hasEOL) {
          lines.push(line.trim());
          line = "";
        } else if (!it.str.endsWith(" ")) line += " ";
      }
      if (line.trim()) lines.push(line.trim());
      pages.push(lines.join("\n"));
    }
    return pages.join("\n\n");
  }
  if (name.endsWith(".html") || name.endsWith(".htm")) {
    const doc = new DOMParser().parseFromString(await file.text(), "text/html");
    doc.querySelectorAll("script,style,noscript,nav,header,footer").forEach((n) => n.remove());
    return (doc.body?.innerText ?? doc.body?.textContent ?? "").replace(/\n{3,}/g, "\n\n");
  }
  if (name.endsWith(".xlsx")) {
    const { workbookText } = await import("./office");
    return workbookText(await file.arrayBuffer());
  }
  return await file.text();
}

/** OCR a scanned/image-only PDF in the browser (no AI, no tokens). Renders each page and reads it with Tesseract. */
export async function ocrPdf(
  data: Blob,
  onProgress?: (page: number, total: number) => void,
  maxPages = 40,
): Promise<string> {
  polyfillSumPrecise();
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await data.arrayBuffer()) }).promise;
  const { createWorker } = await import("tesseract.js");
  const ocr = await createWorker("eng");
  const total = Math.min(doc.numPages, maxPages);
  const pages: string[] = [];
  try {
    for (let i = 1; i <= total; i++) {
      onProgress?.(i, total);
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport } as never)
        .promise;
      const { data: r } = await ocr.recognize(canvas);
      pages.push(r.text);
      canvas.width = canvas.height = 0;
    }
  } finally {
    await ocr.terminate();
  }
  return pages.join("\n\n").replace(/[ \t]+\n/g, "\n").trim();
}

/** Template blanks: [[Field Name]] or {{Field Name}} */
export function templateFields(body: string): string[] {
  const set = new Set<string>();
  for (const m of body.matchAll(/\[\[([^\]]+)\]\]|\{\{([^}]+)\}\}/g))
    set.add((m[1] ?? m[2] ?? "").trim());
  return [...set];
}

export function fillTemplate(body: string, answers: Record<string, string>) {
  return body.replace(/\[\[([^\]]+)\]\]|\{\{([^}]+)\}\}/g, (all, a, b) => {
    const v = answers[(a ?? b).trim()];
    return v && v.trim() ? v : all;
  });
}
