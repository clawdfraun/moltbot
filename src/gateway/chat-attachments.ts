import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { detectMime } from "../media/mime.js";

export type ChatAttachment = {
  type?: string;
  mimeType?: string;
  fileName?: string;
  content?: unknown;
};

export type ChatImageContent = {
  type: "image";
  data: string;
  mimeType: string;
};

export type SavedFileAttachment = {
  filePath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
};

export type ParsedMessageWithImages = {
  message: string;
  images: ChatImageContent[];
  files: SavedFileAttachment[];
};

type AttachmentLog = {
  warn: (message: string) => void;
};

function normalizeMime(mime?: string): string | undefined {
  if (!mime) return undefined;
  const cleaned = mime.split(";")[0]?.trim().toLowerCase();
  return cleaned || undefined;
}

async function sniffMimeFromBase64(base64: string): Promise<string | undefined> {
  const trimmed = base64.trim();
  if (!trimmed) return undefined;

  const take = Math.min(256, trimmed.length);
  const sliceLen = take - (take % 4);
  if (sliceLen < 8) return undefined;

  try {
    const head = Buffer.from(trimmed.slice(0, sliceLen), "base64");
    return await detectMime({ buffer: head });
  } catch {
    return undefined;
  }
}

function isImageMime(mime?: string): boolean {
  return typeof mime === "string" && mime.startsWith("image/");
}

/**
 * Parse attachments and extract images as structured content blocks.
 * Returns the message text and an array of image content blocks
 * compatible with Claude API's image format.
 */
/**
 * Sanitize a filename to prevent path traversal and invalid characters.
 */
function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
}

/**
 * Save a non-image file attachment to the agent workspace.
 * Returns the saved file path relative to the workspace.
 */
function saveFileToWorkspace(params: {
  b64: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  workspacePath: string;
}): SavedFileAttachment {
  const inboundDir = path.join(params.workspacePath, "media", "inbound");
  fs.mkdirSync(inboundDir, { recursive: true });

  const uniquePrefix = randomUUID().slice(0, 8);
  const safeName = sanitizeFileName(params.fileName);
  const destName = `${uniquePrefix}-${safeName}`;
  const destPath = path.join(inboundDir, destName);

  const buffer = Buffer.from(params.b64, "base64");
  fs.writeFileSync(destPath, buffer);

  return {
    filePath: destPath,
    fileName: params.fileName,
    mimeType: params.mimeType,
    sizeBytes: params.sizeBytes,
  };
}

/**
 * Parse attachments and extract images as structured content blocks.
 * Non-image files are saved to the agent workspace and referenced in the message.
 * Returns the message text, an array of image content blocks, and saved file references.
 */
export async function parseMessageWithAttachments(
  message: string,
  attachments: ChatAttachment[] | undefined,
  opts?: { maxBytes?: number; log?: AttachmentLog; workspacePath?: string },
): Promise<ParsedMessageWithImages> {
  const maxBytes = opts?.maxBytes ?? 5_000_000; // 5 MB
  const log = opts?.log;
  if (!attachments || attachments.length === 0) {
    return { message, images: [], files: [] };
  }

  const images: ChatImageContent[] = [];
  const files: SavedFileAttachment[] = [];

  for (const [idx, att] of attachments.entries()) {
    if (!att) continue;
    const mime = att.mimeType ?? "";
    const content = att.content;
    const label = att.fileName || att.type || `attachment-${idx + 1}`;

    if (typeof content !== "string") {
      throw new Error(`attachment ${label}: content must be base64 string`);
    }

    let sizeBytes = 0;
    let b64 = content.trim();
    // Strip data URL prefix if present (e.g., "data:image/jpeg;base64,...")
    const dataUrlMatch = /^data:[^;]+;base64,(.*)$/.exec(b64);
    if (dataUrlMatch) {
      b64 = dataUrlMatch[1];
    }
    // Basic base64 sanity: length multiple of 4 and charset check.
    if (b64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(b64)) {
      throw new Error(`attachment ${label}: invalid base64 content`);
    }
    try {
      sizeBytes = Buffer.from(b64, "base64").byteLength;
    } catch {
      throw new Error(`attachment ${label}: invalid base64 content`);
    }
    if (sizeBytes <= 0 || sizeBytes > maxBytes) {
      throw new Error(`attachment ${label}: exceeds size limit (${sizeBytes} > ${maxBytes} bytes)`);
    }

    const providedMime = normalizeMime(mime);
    const sniffedMime = normalizeMime(await sniffMimeFromBase64(b64));

    // Determine if this is an image
    const effectiveMime = sniffedMime ?? providedMime ?? mime;
    const isImage = isImageMime(sniffedMime) || (!sniffedMime && isImageMime(providedMime));

    if (isImage) {
      if (sniffedMime && providedMime && sniffedMime !== providedMime) {
        log?.warn(
          `attachment ${label}: mime mismatch (${providedMime} -> ${sniffedMime}), using sniffed`,
        );
      }
      images.push({
        type: "image",
        data: b64,
        mimeType: effectiveMime,
      });
    } else {
      // Non-image file: save to workspace if path provided
      if (!opts?.workspacePath) {
        log?.warn(
          `attachment ${label}: non-image file (${effectiveMime}), no workspace configured — dropping`,
        );
        continue;
      }

      try {
        const saved = saveFileToWorkspace({
          b64,
          fileName: label,
          mimeType: effectiveMime,
          sizeBytes,
          workspacePath: opts.workspacePath,
        });
        files.push(saved);
        log?.warn(`attachment ${label}: saved non-image file to ${saved.filePath}`);
      } catch (err) {
        log?.warn(
          `attachment ${label}: failed to save file — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // Append file references to the message so the agent knows about them
  if (files.length > 0) {
    const fileRefs = files
      .map(
        (f) =>
          `[Attached file: ${f.fileName} (${f.mimeType}, ${f.sizeBytes} bytes) → ${f.filePath}]`,
      )
      .join("\n");
    const separator = message.trim().length > 0 ? "\n\n" : "";
    message = `${message}${separator}${fileRefs}`;
  }

  return { message, images, files };
}

/**
 * @deprecated Use parseMessageWithAttachments instead.
 * This function converts images to markdown data URLs which Claude API cannot process as images.
 */
export function buildMessageWithAttachments(
  message: string,
  attachments: ChatAttachment[] | undefined,
  opts?: { maxBytes?: number },
): string {
  const maxBytes = opts?.maxBytes ?? 2_000_000; // 2 MB
  if (!attachments || attachments.length === 0) return message;

  const blocks: string[] = [];

  for (const [idx, att] of attachments.entries()) {
    if (!att) continue;
    const mime = att.mimeType ?? "";
    const content = att.content;
    const label = att.fileName || att.type || `attachment-${idx + 1}`;

    if (typeof content !== "string") {
      throw new Error(`attachment ${label}: content must be base64 string`);
    }
    if (!mime.startsWith("image/")) {
      throw new Error(`attachment ${label}: only image/* supported`);
    }

    let sizeBytes = 0;
    const b64 = content.trim();
    // Basic base64 sanity: length multiple of 4 and charset check.
    if (b64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(b64)) {
      throw new Error(`attachment ${label}: invalid base64 content`);
    }
    try {
      sizeBytes = Buffer.from(b64, "base64").byteLength;
    } catch {
      throw new Error(`attachment ${label}: invalid base64 content`);
    }
    if (sizeBytes <= 0 || sizeBytes > maxBytes) {
      throw new Error(`attachment ${label}: exceeds size limit (${sizeBytes} > ${maxBytes} bytes)`);
    }

    const safeLabel = label.replace(/\s+/g, "_");
    const dataUrl = `![${safeLabel}](data:${mime};base64,${content})`;
    blocks.push(dataUrl);
  }

  if (blocks.length === 0) return message;
  const separator = message.trim().length > 0 ? "\n\n" : "";
  return `${message}${separator}${blocks.join("\n\n")}`;
}
