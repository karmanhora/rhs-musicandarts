/**
 * CSV writing for attendance reports.
 *
 * Two jobs, both about not trusting a value:
 *
 * 1. **RFC 4180 quoting.** A field containing a comma, a double quote, CR or LF
 *    is wrapped in double quotes and its quotes doubled, so a student name like
 *    `Ada "Addie" Vance` or a location with a newline survives a spreadsheet.
 *
 * 2. **Formula injection.** Excel/Sheets/LibreOffice execute a cell that starts
 *    with `=`, `+`, `-`, `@`, a tab or a CR, even when it arrived in a .csv. An
 *    event named `=HYPERLINK(...)` would therefore run on the computer of
 *    whoever opens the export. Prefixing the field with a single apostrophe
 *    makes it literal text in every one of those programs. The quote is added
 *    *before* RFC quoting, and the cell is then quoted only if the (prefixed)
 *    value needs it.
 *
 * The report RPC already restricts which fields exist (no email, no excuse
 * text), so this is defence in depth rather than the only guard.
 */

const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/** One field, safe to place between commas. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";

  let text: string;
  if (value instanceof Date) {
    text = Number.isNaN(value.getTime()) ? "" : value.toISOString();
  } else {
    text = String(value);
  }

  if (FORMULA_TRIGGER.test(text)) text = `'${text}`;

  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** A full document: header row, then one line per row, CRLF endings. */
export function toCsv(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  // A trailing newline keeps some tools from dropping the last record.
  return `${lines.join("\r\n")}\r\n`;
}

/** A filename that cannot escape the download directory or annoy a shell. */
export function csvFilename(parts: { program?: string | null; from?: string | null; to?: string | null }): string {
  const slug = (value: string | null | undefined, fallback: string) =>
    (value ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || fallback;

  const stamp = new Date().toISOString().slice(0, 10);
  const from = parts.from ? new Date(parts.from).toISOString().slice(0, 10) : null;
  const to = parts.to ? new Date(parts.to).toISOString().slice(0, 10) : null;
  const range = from && to ? `${from}-to-${to}` : stamp;

  return `attendance-${slug(parts.program, "program")}-${range}.csv`;
}

/**
 * Hand the file to the browser. A UTF-8 BOM is included so Excel on Windows
 * reads accented names correctly instead of mojibake.
 */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the click a tick to start before the URL goes away.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
