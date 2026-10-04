// Display compaction for UPLC listings. The canonical one-term-per-line listing indents two columns
// per nesting level without bound, so a deep script is mostly leading spaces (a 12 KB script renders
// to megabytes). Windows of it (resources, script_decompile UPLC pages) are shown compacted: the
// window's common indentation is removed and what remains is capped. Line numbers never change;
// only leading whitespace does, and each line keeps its content in full.

/** Columns of indentation a compacted line keeps at most (deeper lines sit at this column). */
export const INDENT_CAP = 64;
/** Lines a listing resource returns when the URI names no `limit`. */
export const LISTING_DEFAULT_LINES = 400;

export interface CompactedLines {
  lines: string[];
  /** Columns removed from every line (the window's common indentation). */
  dedent: number;
  /** Lines whose remaining indentation was cut down to `INDENT_CAP`. */
  capped: number;
}

export function compactIndentation(lines: readonly string[], cap = INDENT_CAP): CompactedLines {
  let dedent = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    if (indent < dedent) dedent = indent;
  }
  if (!Number.isFinite(dedent)) dedent = 0;
  let capped = 0;
  const out = lines.map((line) => {
    const body = line.trimStart();
    if (body === "") return "";
    const indent = line.length - body.length - dedent;
    if (indent > cap) {
      capped++;
      return " ".repeat(cap) + body;
    }
    return " ".repeat(Math.max(0, indent)) + body;
  });
  return { lines: out, dedent, capped };
}
