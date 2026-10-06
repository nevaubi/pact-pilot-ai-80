export type FileType = "docx" | "xlsx" | "pdf" | "text";

const TONES: Record<FileType, { base: string; fold: string; label: string }> = {
  docx: { base: "var(--ink-blue)", fold: "color-mix(in oklch, var(--ink-blue) 55%, white)", label: "W" },
  xlsx: { base: "var(--ink-green)", fold: "color-mix(in oklch, var(--ink-green) 55%, white)", label: "X" },
  pdf: { base: "var(--destructive)", fold: "color-mix(in oklch, var(--destructive) 55%, white)", label: "PDF" },
  text: { base: "var(--muted-foreground)", fold: "color-mix(in oklch, var(--muted-foreground) 45%, white)", label: "TXT" },
};

export function fileTypeFromName(name: string): FileType {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "docx" || ext === "doc") return "docx";
  if (ext === "xlsx" || ext === "xls" || ext === "csv") return "xlsx";
  if (ext === "pdf") return "pdf";
  return "text";
}

/** Crisp document-with-folded-corner icon, tinted per file type. */
export function FileTypeIcon({ type, className = "h-8 w-7" }: { type: FileType; className?: string }) {
  const t = TONES[type];
  const small = t.label.length > 1;
  return (
    <svg viewBox="0 0 28 32" className={`shrink-0 ${className}`} aria-hidden focusable="false">
      {/* page */}
      <path
        d="M4 1.5h13.5L26 10v19a1.5 1.5 0 0 1-1.5 1.5h-20A1.5 1.5 0 0 1 3 29V3A1.5 1.5 0 0 1 4 1.5Z"
        fill={t.base}
      />
      {/* folded corner */}
      <path d="M17.5 1.5 26 10h-7a1.5 1.5 0 0 1-1.5-1.5V1.5Z" fill={t.fold} />
      {/* type mark */}
      <text
        x="14.5"
        y={small ? 22.5 : 23.5}
        textAnchor="middle"
        fill="white"
        fontSize={small ? 7 : 11}
        fontWeight={700}
        fontFamily="inherit"
        letterSpacing={small ? 0.2 : 0}
      >
        {t.label}
      </text>
    </svg>
  );
}
