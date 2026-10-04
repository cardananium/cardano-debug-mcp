import { describe, expect, it } from "vitest";

import { compactIndentation, INDENT_CAP, LISTING_DEFAULT_LINES } from "../../src/engine/indent.js";
import { textContent } from "../../src/resources.js";

describe("UPLC listing compaction", () => {
  it("removes the common indentation, caps the rest, keeps every line's content", () => {
    const lines = ["      (lam x", "        [", " ".repeat(400) + "(con integer 1)", "        ]", "", "      )"];
    const out = compactIndentation(lines);
    expect(out.dedent).toBe(6);
    expect(out.lines[0]).toBe("(lam x");
    expect(out.lines[1]).toBe("  [");
    expect(out.lines[2]).toBe(" ".repeat(INDENT_CAP) + "(con integer 1)");
    expect(out.lines[4]).toBe("");
    expect(out.capped).toBe(1);
  });

  it("a listing resource is windowed to 400 lines without a limit and reports the window", () => {
    const text = Array.from({ length: 1_000 }, (_, i) => `${" ".repeat(2 * (i % 300))}(term ${i})`).join("\n");
    const block = textContent(new URL("cardano-debug://session/dbg_x/uplc.txt"), text, "text/plain", { listing: true });
    expect(block.text.split("\n")).toHaveLength(LISTING_DEFAULT_LINES);
    expect(block._meta).toMatchObject({ offset: 0, limit: LISTING_DEFAULT_LINES, total_lines: 1_000, lines_returned: LISTING_DEFAULT_LINES, next_offset: LISTING_DEFAULT_LINES, dedent: 0, indent_capped_at: INDENT_CAP });
    expect(block.text.split("\n")[299]).toBe(" ".repeat(INDENT_CAP) + "(term 299)");
    const window = textContent(new URL("cardano-debug://session/dbg_x/uplc.txt?offset=950&limit=10"), text, "text/plain", { listing: true });
    expect(window.text.split("\n")[0]).toBe("(term 950)".padStart(0));
    // plain text resources are untouched without a query
    const plain = textContent(new URL("cardano-debug://docs/uplc-cek"), text, "text/markdown");
    expect(plain.text).toBe(text);
    expect(plain._meta).toBeUndefined();
  });
});
