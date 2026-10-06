import { createFileRoute, notFound } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { EditorHandle } from "@/components/office/DocxEditor";

/**
 * DEVELOPMENT-ONLY synthetic harness for browser verification of the Office editors. It generates
 * its own DOCX/XLSX in the browser, touches no matter data and is a 404 outside `vite dev`.
 */
export const Route = createFileRoute("/dev/office-harness")({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound();
  },
  head: () => ({
    meta: [
      { title: "Office harness (dev only) — Mirza" },
      { name: "description", content: "Development-only synthetic harness for the Office editors." },
      { property: "og:title", content: "Office harness (dev only) — Mirza" },
      { property: "og:description", content: "Development-only synthetic harness." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: Harness,
});

const DocxEditor = lazy(() => import("@/components/office/DocxEditor").then((m) => ({ default: m.DocxEditor })));
const SheetEditor = lazy(() => import("@/components/office/SheetEditor").then((m) => ({ default: m.SheetEditor })));
const DraftPanel = lazy(() => import("@/components/office/DraftPanel").then((m) => ({ default: m.DraftPanel })));

async function makeDocx() {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import("docx");
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("ARTICLE 1 DEFINITIONS")] }),
          new Paragraph({ children: [new TextRun("Seller shall deliver audited financial statements within ten (10) business days.")] }),
          new Paragraph({ children: [new TextRun("Buyer pays the fee.")] }),
          new Paragraph({ children: [new TextRun("Buyer pays the fee.")] }),
          new Paragraph({ children: [new TextRun("Closing shall occur on [[Closing Date]].")] }),
        ],
      },
    ],
  });
  return Packer.toBlob(doc);
}
async function makeXlsx() {
  const ExcelJS = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  const a = wb.addWorksheet("Deal");
  a.getCell("A1").value = "Item";
  a.getCell("B1").value = "Amount";
  a.getCell("A2").value = "Price";
  a.getCell("B2").value = 1000;
  a.getCell("A3").value = "Fee";
  a.getCell("B3").value = 50;
  a.getCell("B4").value = { formula: "SUM(B2:B3)", result: 1050 } as never;
  const b = wb.addWorksheet("Parcels");
  b.getCell("A1").value = "PIN";
  const out = await wb.xlsx.writeBuffer();
  return new Blob([out as ArrayBuffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

function Harness() {
  const docx = useRef<EditorHandle | null>(null);
  const sheet = useRef<EditorHandle | null>(null);
  const [blobs, setBlobs] = useState<{ docx: Blob; xlsx: Blob } | null>(null);
  const [dirty, setDirty] = useState({ docx: 0, xlsx: 0 });
  useEffect(() => {
    void Promise.all([makeDocx(), makeXlsx()]).then(([d, x]) => setBlobs({ docx: d, xlsx: x }));
  }, []);
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w["__harness"] = {
      docx: () => docx.current,
      sheet: () => sheet.current,
      dirty: () => dirty,
      reopenDocx: async (b: Blob) => setBlobs((p) => (p ? { ...p, docx: b } : p)),
      reopenXlsx: async (b: Blob) => setBlobs((p) => (p ? { ...p, xlsx: b } : p)),
      originals: () => blobs,
      office: () => import("@/lib/office"),
      xlsxPkg: () => import("@/lib/xlsx-package"),
    };
  }, [dirty, blobs]);
  if (!blobs) return <p className="p-6 text-sm">Generating synthetic files…</p>;
  return (
    <div className="grid h-screen grid-cols-[1fr_1fr_22rem] grid-rows-1">
      <div className="min-h-0 border-r" data-testid="docx-pane">
        <Suspense fallback={null}>
          <DocxEditor
            blob={blobs.docx}
            name="synthetic.docx"
            user={{ name: "Harness" }}
            mode="suggesting"
            onDirty={() => setDirty((d) => ({ ...d, docx: d.docx + 1 }))}
            handle={docx}
          />
        </Suspense>
      </div>
      <div className="min-h-0 border-r" data-testid="xlsx-pane">
        <Suspense fallback={null}>
          <SheetEditor
            blob={blobs.xlsx}
            name="synthetic.xlsx"
            onDirty={() => setDirty((d) => ({ ...d, xlsx: d.xlsx + 1 }))}
            handle={sheet}
          />
        </Suspense>
      </div>
      <Suspense fallback={null}>
        <DraftPanel
          matterId="00000000-0000-0000-0000-000000000000"
          fileId="harness-docx"
          fileName="synthetic.docx"
          kind="docx"
          canInsert
          editor={docx}
          getDoc={async () => ({
            name: "synthetic.docx",
            kind: "docx",
            text: (await docx.current?.getText()) ?? "",
            selection: (await docx.current?.getSelection()) || undefined,
          })}
        />
      </Suspense>
    </div>
  );
}
