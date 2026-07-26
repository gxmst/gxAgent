/**
 * Per-session attachment state and the whole attachment ingestion pipeline:
 * drag/drop + paste files, the native file picker, size/count budgets and
 * the user-facing warnings they produce.
 *
 * Extracted verbatim from App.tsx. Keyed by session id; the current session
 * comes from the zustand store so callers only supply what the pipeline
 * cannot know (storage readiness and language).
 */
import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";
import type { Attachment } from "../types";
import {
  MAX_ATTACHMENT_TEXT_PER_FILE,
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_IMAGE_ATTACHMENT_COUNT,
  MAX_IMAGE_ATTACHMENT_TOTAL_BYTES,
  estimateImageAttachmentBytes,
  fitAttachmentBudget,
  isSendableAttachment,
} from "../appDefaults";
import { useAppStore } from "../store/appStore";
import { addLog } from "../services/agentEvents";

export function useAttachments({
  sessionStorageReady,
  lang,
}: {
  sessionStorageReady: boolean;
  lang: string;
}) {
  const currentSessionId = useAppStore((s) => s.currentSessionId);

  const [attachmentsBySession, setAttachmentsBySession] = useState<Record<string, Attachment[]>>({});
  const attachments = attachmentsBySession[currentSessionId] || [];
  const [attachmentLoadingBySession, setAttachmentLoadingBySession] = useState<Record<string, boolean>>({});
  const isAttachmentLoading = Boolean(attachmentLoadingBySession[currentSessionId]);
  const hasAttachmentLoading = Object.values(attachmentLoadingBySession).some(Boolean);
  const setAttachments = useCallback((next: Attachment[] | ((previous: Attachment[]) => Attachment[])) => {
    setAttachmentsBySession((previous) => {
      const current = previous[currentSessionId] || [];
      const value = typeof next === "function" ? next(current) : next;
      return { ...previous, [currentSessionId]: value };
    });
  }, [currentSessionId]);

  const imageExtensionFromMime = (mimeType: string) => {
    const subtype = mimeType.split("/")[1]?.split(";")[0]?.toLowerCase();
    if (!subtype) return "png";
    return subtype === "jpeg" ? "jpg" : subtype.replace(/[^a-z0-9]/g, "") || "png";
  };

  const pastedImageName = (mimeType: string) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `pasted-image-${stamp}.${imageExtensionFromMime(mimeType)}`;
  };

  const readFileAsAttachment = async (file: File): Promise<Attachment> => {
    const name = file.name || (file.type.startsWith("image/") ? pastedImageName(file.type || "image/png") : "pasted-file.txt");
    if (file.type.startsWith("image/")) {
      if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
        throw new Error(t("ui.image-too-large", lang, { name }));
      }
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (ev) => resolve(String(ev.target?.result || ""));
        reader.onerror = () => reject(reader.error || new Error("Failed to read image"));
        reader.readAsDataURL(file);
      });
      return { name, type: "image", data, mimeType: file.type || "image/png", originalSize: file.size };
    }

    const extension = name.split(".").pop()?.toLowerCase() || "";
    const nativeDocuments = ["pdf", "docx", "xlsx", "pptx"];
    if (nativeDocuments.includes(extension)) {
      throw new Error(t("ui.binary-document", lang, { name }));
    }
    if (["doc", "xls", "ppt", "zip", "7z"].includes(extension)) {
      throw new Error(t("ui.unsupported-format", lang, { name }));
    }

    const textSlice = file.slice(0, MAX_ATTACHMENT_TEXT_PER_FILE * 4);
    const text = await textSlice.text();
    const data = text.substring(0, MAX_ATTACHMENT_TEXT_PER_FILE);
    return {
      name,
      type: "text",
      data,
      mimeType: file.type || "text/plain",
      truncated: file.size > textSlice.size || data.length < text.length,
      originalSize: file.size,
    };
  };

  const reportAttachmentFit = (
    fitted: ReturnType<typeof fitAttachmentBudget>,
    sessionId: string,
    warnedNames: Set<string> = new Set(),
  ) => {
    const unexplainedInvalid = fitted.invalid.filter((name) => !warnedNames.has(name));
    if (unexplainedInvalid.length > 0) {
      addLog(t("ui.nothing-sendable-not-added", lang, { names: unexplainedInvalid.join(lang === "zh" ? "、" : ", ") }), "error", true, sessionId);
    }
    if (fitted.overBudget.length > 0) {
      addLog(t("ui.attachment-limits-exceeded", lang, { names: fitted.overBudget.join(lang === "zh" ? "、" : ", ") }), "error", true, sessionId);
    }
  };

  const addFilesAsAttachments = async (files: File[], targetSessionId = currentSessionId) => {
    if (!sessionStorageReady || files.length === 0 || attachmentLoadingBySession[targetSessionId]) return;
    setAttachmentLoadingBySession((previous) => ({ ...previous, [targetSessionId]: true }));
    try {
      const existingAttachments = attachmentsBySession[targetSessionId] || [];
      let plannedImageCount = existingAttachments.filter((attachment) => attachment.type === "image" && isSendableAttachment(attachment)).length;
      let plannedImageBytes = existingAttachments
        .filter((attachment) => attachment.type === "image" && isSendableAttachment(attachment))
        .reduce((sum, attachment) => sum + estimateImageAttachmentBytes(attachment), 0);
      const preRejectedImages: string[] = [];
      const filesToRead = files.filter((file) => {
        if (!file.type.startsWith("image/")) return true;
        if (file.size > MAX_IMAGE_ATTACHMENT_BYTES
          || plannedImageCount >= MAX_IMAGE_ATTACHMENT_COUNT
          || plannedImageBytes + file.size > MAX_IMAGE_ATTACHMENT_TOTAL_BYTES) {
          preRejectedImages.push(file.name || pastedImageName(file.type || "image/png"));
          return false;
        }
        plannedImageCount += 1;
        plannedImageBytes += file.size;
        return true;
      });
      const results = await Promise.allSettled(filesToRead.map(readFileAsAttachment));
      const next = results
        .filter((result): result is PromiseFulfilledResult<Attachment> => result.status === "fulfilled")
        .map((result) => result.value);
      const fitted = fitAttachmentBudget(existingAttachments, next);
      fitted.overBudget.push(...preRejectedImages);
      if (fitted.accepted.length > 0) {
        setAttachmentsBySession((previous) => ({
          ...previous,
          [targetSessionId]: [...(previous[targetSessionId] || []), ...fitted.accepted],
        }));
      }
      reportAttachmentFit(fitted, targetSessionId);
      for (const result of results) {
        if (result.status === "rejected") {
          addLog(`${t("ui.failed-to-attach-file", lang)}: ${result.reason}`, "error", true, targetSessionId);
        }
      }
    } finally {
      setAttachmentLoadingBySession((previous) => ({ ...previous, [targetSessionId]: false }));
    }
  };

  const pickAndParseAttachments = async () => {
    type ParsedFile = {
      name: string;
      path: string;
      kind: string;
      content: string;
      mimeType: string;
      truncated: boolean;
      warning?: string | null;
    };
    const targetSessionId = currentSessionId;
    if (!sessionStorageReady || attachmentLoadingBySession[targetSessionId]) return;
    setAttachmentLoadingBySession((previous) => ({ ...previous, [targetSessionId]: true }));
    try {
      const parsed = await invoke<ParsedFile[]>("pick_and_parse_files");
      const next: Attachment[] = parsed.map((file) => {
        if (file.kind === "image") {
          return {
            name: file.name,
            path: file.path,
            type: "image",
            data: file.content ? `data:${file.mimeType};base64,${file.content}` : "",
            mimeType: file.mimeType,
            originalSize: Math.max(0, Math.floor(file.content.length * 3 / 4)),
            warning: file.warning || undefined,
          };
        }
        const data = file.content.slice(0, MAX_ATTACHMENT_TEXT_PER_FILE);
        const emptyWarning = !file.warning && !data.trim()
          ? (t("ui.no-sendable-text-was-extracted", lang))
          : undefined;
        return {
          name: file.name,
          path: file.path,
          type: "text",
          data,
          mimeType: file.mimeType,
          originalSize: file.content.length,
          truncated: file.truncated || data.length < file.content.length,
          warning: file.warning || emptyWarning,
        };
      });
      const fitted = fitAttachmentBudget(attachmentsBySession[targetSessionId] || [], next);
      if (fitted.accepted.length > 0) {
        setAttachmentsBySession((previous) => ({
          ...previous,
          [targetSessionId]: [...(previous[targetSessionId] || []), ...fitted.accepted],
        }));
      }
      const warnedNames = new Set(next.filter((file) => file.warning).map((file) => file.name));
      for (const file of next) {
        if (file.warning) addLog(`${file.name}: ${file.warning}`, "error", true, targetSessionId);
        else if (file.truncated) addLog(`${file.name}: ${t("ui.content-was-truncated", lang)}`, "info", true, targetSessionId);
      }
      reportAttachmentFit(fitted, targetSessionId, warnedNames);
    } catch (error) {
      addLog(`${t("ui.failed-to-attach-files", lang)}: ${error}`, "error", true, targetSessionId);
    } finally {
      setAttachmentLoadingBySession((previous) => ({ ...previous, [targetSessionId]: false }));
    }
  };

  return {
    attachments,
    setAttachments,
    attachmentsBySession,
    setAttachmentsBySession,
    attachmentLoadingBySession,
    setAttachmentLoadingBySession,
    isAttachmentLoading,
    hasAttachmentLoading,
    reportAttachmentFit,
    addFilesAsAttachments,
    pickAndParseAttachments,
  };
}
