import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const inboundRoot = path.join(projectRoot, "logs", "inbound");

function sanitizePathPart(value, fallback) {
  const cleaned = String(value || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim();

  return (cleaned || fallback).slice(0, 160);
}

function detectExtension(buffer, fallback) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return ".png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return ".jpg";
  }
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) {
    return ".gif";
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return ".webp";
  }
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-") {
    return ".pdf";
  }
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    return ".zip";
  }

  return fallback;
}

function resourceFileName(resource, index, buffer) {
  const originalName = resource.fileName ? sanitizePathPart(resource.fileName, "") : "";
  if (originalName) {
    return `${String(index + 1).padStart(2, "0")}-${originalName}`;
  }

  const fallbackExtension = resource.type === "image" ? ".jpg" : ".bin";
  const extension = detectExtension(buffer, fallbackExtension);
  return `${String(index + 1).padStart(2, "0")}-${resource.type}-${resource.fileKey}${extension}`;
}

function parseResourcesFromContent(content) {
  const resources = [];
  const imagePattern = /!\[image\]\(([^)]+)\)/g;
  const filePattern = /<file\s+key="([^"]+)"(?:\s+name="([^"]*)")?\s*\/>/g;

  for (const match of content.matchAll(imagePattern)) {
    resources.push({ type: "image", fileKey: match[1] });
  }

  for (const match of content.matchAll(filePattern)) {
    resources.push({ type: "file", fileKey: match[1], fileName: match[2] });
  }

  return resources;
}

function getMessageResources(message) {
  const explicitResources = Array.isArray(message.resources) ? message.resources : [];
  const parsedResources = parseResourcesFromContent(message.content || "");
  const seen = new Set();
  const resources = [];

  for (const resource of [...explicitResources, ...parsedResources]) {
    if (!resource?.type || !resource?.fileKey) {
      continue;
    }

    const key = `${resource.type}:${resource.fileKey}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    resources.push({
      type: resource.type,
      fileKey: resource.fileKey,
      fileName: resource.fileName,
    });
  }

  return resources;
}

function readableToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    stream.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

async function downloadMessageResource(channel, message, resource) {
  if (!channel.rawClient?.im?.v1?.messageResource?.get) {
    throw new Error("Lark SDK messageResource.get is unavailable");
  }

  const response = await channel.rawClient.im.v1.messageResource.get({
    path: {
      message_id: message.messageId,
      file_key: resource.fileKey,
    },
    params: {
      type: resource.type,
    },
  });

  if (typeof response.getReadableStream !== "function") {
    throw new Error("messageResource.get returned no readable stream");
  }

  return readableToBuffer(response.getReadableStream());
}

function formatDownloadError(error) {
  const status = error.response?.status || error.status;
  const data = error.response?.data;
  const details = [];

  if (status) {
    details.push(`HTTP ${status}`);
  }

  if (data && typeof data === "object" && !Buffer.isBuffer(data)) {
    details.push(JSON.stringify(data).slice(0, 500));
  } else if (typeof data === "string") {
    details.push(data.slice(0, 500));
  }

  details.push(error.message);
  return details.filter(Boolean).join(" - ");
}

export async function downloadMessageAttachments(channel, message, topicId) {
  const resources = getMessageResources(message);
  if (resources.length === 0) {
    return { attachments: [], errors: [] };
  }

  const topicDir = sanitizePathPart(topicId, "unknown-topic");
  const messageDir = sanitizePathPart(message.messageId, "unknown-message");
  const targetDir = path.join(inboundRoot, topicDir, messageDir);
  await mkdir(targetDir, { recursive: true });

  const attachments = [];
  const errors = [];

  for (const [index, resource] of resources.entries()) {
    try {
      const buffer = await downloadMessageResource(channel, message, resource);
      const fileName = resourceFileName(resource, index, buffer);
      const filePath = path.join(targetDir, fileName);
      await writeFile(filePath, buffer);

      attachments.push({
        type: resource.type,
        fileKey: resource.fileKey,
        fileName,
        originalName: resource.fileName || fileName,
        path: filePath,
        size: buffer.length,
      });
    } catch (error) {
      errors.push({
        type: resource.type,
        fileKey: resource.fileKey,
        fileName: resource.fileName,
        message: formatDownloadError(error),
      });
    }
  }

  return { attachments, errors };
}

export function formatAttachmentSummary({ attachments, errors }) {
  const lines = [];

  for (const attachment of attachments) {
    lines.push(
      `- ${attachment.type}: ${attachment.originalName} (${attachment.size} bytes)`,
      `  local_path: ${attachment.path}`,
    );
  }

  for (const error of errors) {
    lines.push(`- failed: ${error.type} ${error.fileName || error.fileKey}: ${error.message}`);
  }

  if (lines.length === 0) {
    return "";
  }

  return ["[attachments]", ...lines].join("\n");
}

export function shouldUseAttachmentContext(content) {
  return /附件|文件|图片|图|截图|pdf|word|docx|excel|xlsx|表格|文档|会议纪要|记录|刚才|上面|这个|这张|收到|读取|阅读|分析|总结|根据/i.test(content);
}
