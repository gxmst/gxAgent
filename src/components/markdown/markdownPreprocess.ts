const DELIMITER_CELL = /^:?-+:?$/;
const MAX_CANDIDATE_COLUMNS = 32;
const MAX_CANDIDATE_LINE_LENGTH = 20_000;

interface PipeRow {
  cells: string[];
}

interface Fence {
  marker: "`" | "~";
  length: number;
}

/**
 * Split a GFM-style row using the same important boundary rule as remark-gfm:
 * every unescaped pipe separates cells, including pipes inside code spans.
 */
function parsePipeRow(line: string): PipeRow | null {
  if (!line.includes("|") || line.length > MAX_CANDIDATE_LINE_LENGTH) return null;

  const cells: string[] = [];
  let cell = "";
  let consecutiveBackslashes = 0;
  let firstPipeIndex = -1;
  let lastPipeIndex = -1;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === "\\") {
      cell += character;
      consecutiveBackslashes += 1;
      continue;
    }

    if (character === "|" && consecutiveBackslashes % 2 === 0) {
      if (firstPipeIndex < 0) firstPipeIndex = index;
      lastPipeIndex = index;
      cells.push(cell);
      cell = "";
    } else {
      cell += character;
    }
    consecutiveBackslashes = 0;
  }

  if (firstPipeIndex < 0) return null;
  cells.push(cell);

  const hasLeadingPipe = line.slice(0, firstPipeIndex).trim().length === 0;
  const hasTrailingPipe = line.slice(lastPipeIndex + 1).trim().length === 0;
  if (hasLeadingPipe) cells.shift();
  if (hasTrailingPipe) cells.pop();

  if (cells.length < 2 || cells.length > MAX_CANDIDATE_COLUMNS) return null;
  return { cells };
}

function parseDelimiterRow(line: string): PipeRow | null {
  const row = parsePipeRow(line);
  if (!row || !row.cells.every((cell) => DELIMITER_CELL.test(cell.trim()))) return null;
  return row;
}

function openingFence(line: string): Fence | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;

  const run = match[1];
  // A backtick fence cannot have a backtick in its info string.
  if (run[0] === "`" && match[2].includes("`")) return null;
  return { marker: run[0] as Fence["marker"], length: run.length };
}

function closesFence(line: string, fence: Fence): boolean {
  const trimmed = line.trimStart();
  if (line.length - trimmed.length > 3 || trimmed[0] !== fence.marker) return false;

  let markerLength = 0;
  while (trimmed[markerLength] === fence.marker) markerLength += 1;
  return markerLength >= fence.length && trimmed.slice(markerLength).trim().length === 0;
}

function isIndentedCode(line: string): boolean {
  return line.startsWith("\t") || line.startsWith("    ");
}

function appendMissingDelimiter(line: string): string {
  const trailingWhitespace = /[ \t]*$/.exec(line)?.[0] ?? "";
  const body = line.slice(0, line.length - trailingWhitespace.length);
  if (body.endsWith("|")) return `${body}---|${trailingWhitespace}`;
  return `${body} | ---${trailingWhitespace}`;
}

/**
 * Repair one narrow, common model-output mistake for display only: a table
 * header has N cells, its delimiter has N - 1 cells, and the first data row
 * confirms N cells. Everything else is left untouched rather than guessed.
 *
 * The original message remains unchanged in session storage and exports.
 */
export function repairMalformedGfmTables(content: string): string {
  if (!content.includes("|") || !/[\r\n]/.test(content)) return content;

  // Keep captured line endings so valid Markdown is byte-for-byte unchanged.
  const parts = content.split(/(\r\n|\n|\r)/);
  const lines: string[] = [];
  for (let index = 0; index < parts.length; index += 2) lines.push(parts[index]);

  let fence: Fence | null = null;
  let changed = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }

    const nextFence = openingFence(line);
    if (nextFence) {
      fence = nextFence;
      continue;
    }

    if (index + 2 >= lines.length) continue;
    const delimiterLine = lines[index + 1];
    const firstDataLine = lines[index + 2];
    if (
      isIndentedCode(line)
      || isIndentedCode(delimiterLine)
      || isIndentedCode(firstDataLine)
    ) {
      continue;
    }

    const header = parsePipeRow(line);
    const delimiter = parseDelimiterRow(delimiterLine);
    const firstDataRow = parsePipeRow(firstDataLine);
    if (
      !header
      || !delimiter
      || !firstDataRow
      || delimiter.cells.length + 1 !== header.cells.length
      || firstDataRow.cells.length !== header.cells.length
    ) {
      continue;
    }

    const repaired = appendMissingDelimiter(delimiterLine);
    parts[(index + 1) * 2] = repaired;
    lines[index + 1] = repaired;
    changed = true;
  }

  return changed ? parts.join("") : content;
}
