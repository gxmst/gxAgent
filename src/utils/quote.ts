/**
 * Quote-reply helpers: build the per-session quote draft excerpt and fold it
 * into the outgoing user message as a markdown blockquote. Pure functions so
 * the excerpt/formatting rules are unit-testable.
 */

export interface QuoteDraft {
  messageId: string;
  excerpt: string;
}

export const QUOTE_EXCERPT_MAX = 200;

/** The text to quote: the user's selection when one exists inside the source
 *  message, otherwise the first ~200 chars of the message content. */
export const quoteExcerpt = (content: string, selection?: string) => {
  const source = (selection || "").trim() || (content || "").trim();
  return source.length > QUOTE_EXCERPT_MAX
    ? `${source.slice(0, QUOTE_EXCERPT_MAX).trimEnd()}…`
    : source;
};

/** Split a leading markdown blockquote off `content` for presentation: user
 *  bubbles render plain text, so without this the `> ` markers would show
 *  literally. Returns quote=null when the content does not start with one. */
export const splitLeadingQuote = (content: string): { quote: string | null; rest: string } => {
  if (!content.startsWith("> ") && !content.startsWith(">\n")) return { quote: null, rest: content };
  const lines = content.split("\n");
  let index = 0;
  while (index < lines.length && (lines[index].startsWith("> ") || lines[index] === ">")) index += 1;
  const quote = lines.slice(0, index)
    .map((line) => (line === ">" ? "" : line.slice(2)))
    .join("\n");
  const rest = lines.slice(index).join("\n").replace(/^\n+/, "");
  return { quote, rest };
};

/** Prepend `excerpt` to `message` as a markdown blockquote. Multi-line
 *  excerpts get a `> ` prefix per line so the whole quote stays one block. */
export const formatQuoteReply = (excerpt: string, message: string) => {
  const quoted = excerpt
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
  const trimmed = message.trim();
  return trimmed ? `${quoted}\n\n${trimmed}` : quoted;
};
