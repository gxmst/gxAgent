// Trust-pattern suggestion for the "Approve & Trust" flow.
//
// The backend (policy.rs) matches execute_command whitelist patterns per
// chained segment, so these helpers mirror its splitter and produce one
// Claude Code-style pattern per segment: a `git commit`-level prefix for
// subcommand launchers, the bare executable otherwise.

// Commands whose first argument selects a subcommand — trusting only the
// first token would be far too broad (`npm` would also cover `npm exec`).
const MULTI_COMMAND_LAUNCHERS = new Set([
  "git", "npm", "pnpm", "yarn", "bun", "deno", "cargo", "rustup", "pip", "pip3",
  "python", "python3", "py", "node", "dotnet", "go", "docker", "kubectl", "gh",
  "mvn", "gradle", "composer", "uv",
]);

/** Split a command on unquoted `;`, `&&`, `||`, `|` and newlines. */
export const splitCommandSegments = (command: string): string[] => {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      current += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; current += c; continue; }
    if (c === ";" || c === "\n" || c === "\r") { segments.push(current); current = ""; continue; }
    if (c === "|") { segments.push(current); current = ""; if (command[i + 1] === "|") i++; continue; }
    if (c === "&" && command[i + 1] === "&") { segments.push(current); current = ""; i++; continue; }
    current += c;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter(Boolean);
};

/** Suggested whitelist pattern for a single (already split) command segment. */
export const suggestCommandTrustPattern = (segment: string): string => {
  const tokens = segment.trim().split(/\s+/);
  while (tokens.length && (tokens[0] === "&" || tokens[0] === ".")) tokens.shift();
  const first = tokens[0] || "";
  const second = tokens[1];
  if (MULTI_COMMAND_LAUNCHERS.has(first.toLowerCase()) && second && !second.startsWith("-")) {
    return `${first} ${second}`;
  }
  return first || segment.trim();
};

/** Whitelist patterns that "Approve & Trust" would add for a tool call. */
export const suggestTrustPatterns = (toolName: string, argumentsJson: string): string[] => {
  try {
    const args = JSON.parse(argumentsJson);
    if (toolName === "execute_command") {
      const cmd = String(args.command || "").trim();
      if (!cmd) return [toolName];
      return [...new Set(splitCommandSegments(cmd).map(suggestCommandTrustPattern).filter(Boolean))];
    }
    if (toolName === "write_file" || toolName === "edit_file") {
      const path = String(args.path || "").trim();
      const dir = path.replace(/[^/\\]+$/, "");
      return [dir || path || toolName];
    }
  } catch { /* malformed arguments: fall back to trusting the tool name */ }
  return [toolName];
};
