// dehosk prefixes its output with a header block of `//` comment lines: `// Info:` / `// Warning:` /
// `// Note:` diagnostics (version assumed, purpose ambiguous, church-bool polarity heuristic, …)
// followed by the applied-parameter surface (`// Outer Apply chain …`, `// Applied compile-time
// params …`). The block ends at the first blank or non-comment line. The lines stay in `code`
// (line numbers must match the raw output for source maps); `notes[]` is an extracted copy.

export type NoteKind = "info" | "warning" | "note" | "comment";

export interface DecompileNote {
  kind: NoteKind;
  text: string;
}

export interface ExtractedNotes {
  notes: DecompileNote[];
  /** Number of leading lines that form the header block. */
  headerLines: number;
}

const TAGGED = /^\/\/\s*(Info|Warning|Note):\s*(.*)$/;
const MAX_NOTES = 40;
const MAX_NOTE_CHARS = 600;

export function extractNotes(text: string): ExtractedNotes {
  const lines = text.split("\n");
  const notes: DecompileNote[] = [];
  let headerLines = 0;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.startsWith("//")) break;
    headerLines++;
    const tagged = TAGGED.exec(line);
    if (tagged) {
      notes.push({ kind: tagged[1]!.toLowerCase() as NoteKind, text: tagged[2]!.trim() });
      continue;
    }
    const body = line.replace(/^\/\/\s?/, "").trimEnd();
    const previous = notes[notes.length - 1];
    // A wrapped sentence continues the previous plain comment unless that one ended a clause.
    if (previous && previous.kind === "comment" && !/[.:"')\]]$/.test(previous.text) && /^[a-z]/.test(body)) {
      previous.text = `${previous.text} ${body}`.trim();
    } else {
      notes.push({ kind: "comment", text: body });
    }
  }
  const capped = notes.slice(0, MAX_NOTES).map((n) => ({ kind: n.kind, text: n.text.length > MAX_NOTE_CHARS ? `${n.text.slice(0, MAX_NOTE_CHARS - 1)}…` : n.text }));
  if (notes.length > MAX_NOTES) capped.push({ kind: "comment", text: `[${notes.length - MAX_NOTES} more header lines in the code]` });
  return { notes: capped, headerLines };
}

/** Numbered text: right-aligned 1-based line numbers, two spaces, the line. */
export function numberLines(lines: readonly string[], fromLine: number, width?: number): string {
  const w = width ?? String(fromLine + lines.length - 1).length;
  return lines.map((line, i) => `${String(fromLine + i).padStart(w)}  ${line}`).join("\n");
}
