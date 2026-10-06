import { supabase } from "@/integrations/supabase/client";
import { humanize } from "@/lib/mutate";

export type BlankKind = "docx" | "xlsx" | "pdf";

const MIME: Record<BlankKind, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
};

/** One blank US Letter page, with byte-exact xref offsets. */
function blankPdf(): Blob {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Blob([out], { type: MIME.pdf });
}

export async function blankBlob(kind: BlankKind): Promise<Blob> {
  if (kind === "pdf") return blankPdf();
  if (kind === "docx") {
    const { Document, Packer, Paragraph } = await import("docx");
    const doc = new Document({ sections: [{ children: [new Paragraph({ children: [] })] }] });
    const buf = await Packer.toBlob(doc);
    return new Blob([buf], { type: MIME.docx });
  }
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet("Sheet1");
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: MIME.xlsx });
}

/** Create an empty Word/Excel/PDF file (firm-wide when no matter) and return its row. */
export async function createBlankFile(kind: BlankKind, rawName: string, matterId: string | null) {
  const base = rawName.trim().replace(/\.(docx|xlsx|pdf)$/i, "") || "Untitled";
  const name = `${base}.${kind}`;
  const blob = await blankBlob(kind);
  const path = `${matterId ?? "firm"}/${crypto.randomUUID()}-${name.replace(/[^\w.-]+/g, "_")}`;
  const { error } = await supabase.storage
    .from("matter-files")
    .upload(path, blob, { contentType: MIME[kind] });
  if (error) throw new Error(humanize(error.message));
  const { data, error: e2 } = await supabase
    .from("files")
    .insert({ matter_id: matterId, name, path, size: blob.size, extracted_text: "" })
    .select("id")
    .single();
  if (e2) {
    await supabase.storage.from("matter-files").remove([path]);
    throw new Error(humanize(e2.message));
  }
  return data;
}
