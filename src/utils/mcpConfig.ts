export function parseMcpArguments(text: string): string[] {
  if (!text.trim()) return [];
  if (text.trim().startsWith("[")) {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new Error("Arguments must be a JSON string array");
    return value;
  }
  return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}
export function parseMcpEnvironment(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const separator = line.indexOf("=");
    const key = line.slice(0, separator).trim();
    if (separator <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error("Environment variables must use NAME=value, one per line");
    if (names.has(key.toUpperCase())) throw new Error(`Duplicate environment variable: ${key}`);
    names.add(key.toUpperCase());
    env[key] = line.slice(separator + 1);
  }
  return env;
}
