export function activeSql(source: string, from: number, to: number): string {
  if (from !== to) return source.slice(Math.min(from, to), Math.max(from, to)).trim();
  const cuts = statementEnds(source);
  let start = 0;
  let end = source.length;
  for (const cut of cuts) {
    if (cut < from) start = cut + 1;
    else {
      end = cut;
      break;
    }
  }
  const current = source.slice(start, end).trim();
  if (current || start === 0) return current;
  let previous = 0;
  for (const cut of cuts) {
    if (cut + 1 >= start) break;
    previous = cut + 1;
  }
  const semicolon = cuts.find((cut) => cut + 1 === start);
  return source.slice(previous, semicolon ?? start).trim();
}

/** Splits a script on top-level semicolons, skipping quotes, comments, and dollar quotes. */
export function splitStatements(source: string): string[] {
  const statements: string[] = [];
  let start = 0;
  for (const cut of [...statementEnds(source), source.length]) {
    const statement = source.slice(start, cut).trim();
    if (statement && !isOnlyComments(statement)) statements.push(statement);
    start = cut + 1;
  }
  return statements;
}

export type StatementRange = { from: number; to: number; text: string };

/** Like {@link splitStatements}, keeping where each statement sits in the source. */
export function statementRanges(source: string): StatementRange[] {
  const ranges: StatementRange[] = [];
  let start = 0;
  for (const cut of [...statementEnds(source), source.length]) {
    const raw = source.slice(start, cut);
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text && !isOnlyComments(text)) ranges.push({ from: start + lead, to: start + lead + text.length, text });
    start = cut + 1;
  }
  return ranges;
}

function isOnlyComments(statement: string): boolean {
  return statement.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").trim() === "";
}

function statementEnds(source: string): number[] {
  const cuts: number[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "-" && next === "-") {
      const newline = source.indexOf("\n", index);
      index = newline === -1 ? source.length : newline + 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const close = source.indexOf("*/", index + 2);
      index = close === -1 ? source.length : close + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      index = skipQuote(source, index, char);
      continue;
    }
    if (char === "$") {
      const tag = /^\$[A-Za-z0-9_]*\$/.exec(source.slice(index));
      if (tag) {
        const close = source.indexOf(tag[0], index + tag[0].length);
        index = close === -1 ? source.length : close + tag[0].length;
        continue;
      }
    }
    if (char === ";") cuts.push(index);
    index += 1;
  }
  return cuts;
}

function skipQuote(source: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === quote) {
      if (source[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return source.length;
}
