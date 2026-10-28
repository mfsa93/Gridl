import { describe, expect, it } from "vitest";
import { highlightTree, tagHighlighter, tags } from "@lezer/highlight";
import { sqlExtension } from "../editor/sqlLanguage";

describe("sqlExtension", () => {
  it("highlights a dollar-quoted body as SQL", () => {
    const { parser } = sqlExtension("postgres", {}).language;
    const doc = "DO $$\nBEGIN\n IF (SELECT data_type FROM c WHERE a = 'x') <> 'uuid' THEN\n ALTER TABLE t DROP COLUMN id;\n END IF;\nEND $$;\nselect 'plain'";
    const out: string[] = [];
    highlightTree(parser.parse(doc), tagHighlighter([{ tag: tags.keyword, class: "kw" }, { tag: tags.string, class: "str" }]), (from, to, cls) => out.push(`${cls}:${doc.slice(from, to)}`));
    expect(out).toContain("kw:ALTER");
    expect(out).toContain("kw:SELECT");
    expect(out).toContain("str:'x'");
    expect(out).toContain("str:'plain'");
    expect(out).not.toContain(expect.stringMatching(/^str:\$\$\nBEGIN/));
  });
});
