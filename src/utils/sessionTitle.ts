const stripTitleDecoration = (value: string) => value
  .replace(/^\s*(?:title|标题|題名)\s*[:：]\s*/i, "")
  .replace(/^[\s"'“”‘’`#*_]+|[\s"'“”‘’`#*_]+$/g, "")
  .replace(/\s+/g, " ")
  .trim();

export function fallbackSessionTitle(source: string, attachmentName = "Attachment") {
  const sourceLine = source.split(/[\r\n]/, 1)[0];
  const firstLine = stripTitleDecoration(sourceLine) || attachmentName.trim() || "Attachment";
  const limit = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(firstLine) ? 18 : 42;
  return firstLine.length > limit ? `${firstLine.slice(0, limit).trimEnd()}...` : firstLine;
}

export function normalizeGeneratedTitle(value: string) {
  const firstLine = stripTitleDecoration(value.split(/[\r\n]/, 1)[0]);
  if (!firstLine) return "";
  const limit = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(firstLine) ? 18 : 54;
  return firstLine.length > limit ? firstLine.slice(0, limit).trimEnd() : firstLine;
}
