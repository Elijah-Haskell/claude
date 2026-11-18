// A small CSV reader following RFC 4180 (https://www.rfc-editor.org/rfc/rfc4180), plus the
// things real exports do that the RFC doesn't cover:
//   - a UTF-8 byte-order mark at the start (Excel writes one)
//   - CRLF, LF or lone CR line endings, mixed in one file
//   - line breaks and doubled quotes inside quoted cells
//   - a missing final line break, and blank lines (skipped)
// It never throws on bad input: problems come back as warnings with the line number.

export interface CsvTable {
  headers: string[];
  /** One entry per data row: the cells and the line (1-based, in the file) where the row starts. */
  rows: { line: number; cells: string[] }[];
  warnings: string[];
}

/** Split CSV text into records (arrays of cells). Each record carries the line it starts on. */
export function parseCsvRecords(text: string): { records: { line: number; cells: string[] }[]; warnings: string[] } {
  const warnings: string[] = [];
  const records: { line: number; cells: string[] }[] = [];
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  let cells: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldQuoted = false; // the current cell opened with a quote
  let closed = false; // the current cell's quoted section has closed
  let recordQuoted = false; // any cell in this record was quoted
  let line = 1;
  let recordLine = 1;

  const endField = () => {
    cells.push(field);
    field = "";
    fieldQuoted = false;
    closed = false;
  };
  const endRecord = () => {
    endField();
    const blank = !recordQuoted && cells.length === 1 && cells[0].trim() === "";
    if (!blank) records.push({ line: recordLine, cells });
    cells = [];
    recordQuoted = false;
  };

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
          closed = true;
        }
      } else if (c === "\r" || c === "\n") {
        // A line break inside quotes is part of the cell; CRLF is kept as one "\n".
        if (c === "\r" && s[i + 1] === "\n") i++;
        field += "\n";
        line++;
      } else field += c;
      continue;
    }
    if (c === ",") {
      endField();
      continue;
    }
    if (c === "\r" || c === "\n") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      endRecord();
      line++;
      recordLine = line;
      continue;
    }
    if (c === '"' && !fieldQuoted && field.trim() === "") {
      // Opening quote (spaces before it are dropped).
      field = "";
      inQuotes = true;
      fieldQuoted = true;
      recordQuoted = true;
      continue;
    }
    if (closed) {
      if (c === " " || c === "\t") continue; // spaces after a closing quote are dropped
      warnings.push(`Line ${line}: text after a closing quote was kept`);
      closed = false;
    }
    field += c; // includes a stray quote inside an unquoted cell, as spreadsheet programs do
  }
  if (inQuotes) warnings.push(`Line ${recordLine}: a quoted cell is never closed, so the rest of the file was read into it`);
  if (field !== "" || cells.length || fieldQuoted) endRecord();
  return { records, warnings };
}

/** Parse CSV with a header row. Rows shorter than the header are padded; longer ones are flagged. */
export function parseCsv(text: string): CsvTable {
  const { records, warnings } = parseCsvRecords(text);
  if (!records.length) return { headers: [], rows: [], warnings: [...warnings, "The file is empty"] };
  const headers = records[0].cells.map((h) => h.trim());
  // Rows with every cell empty (",,,,," that spreadsheets leave at the end) are not data.
  const data = records.slice(1).filter((r) => r.cells.some((c) => c.trim() !== ""));
  const rows = data.map((r) => {
    if (r.cells.length > headers.length && r.cells.slice(headers.length).some((c) => c.trim() !== "")) {
      warnings.push(`Line ${r.line}: ${r.cells.length} cells but only ${headers.length} column headings; the extra cells were ignored`);
    }
    const cells = r.cells.slice(0, headers.length);
    while (cells.length < headers.length) cells.push("");
    return { line: r.line, cells };
  });
  return { headers, rows, warnings };
}

/** Quote one cell for CSV output. */
export function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: unknown[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
