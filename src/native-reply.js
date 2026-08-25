import { readFile } from "node:fs/promises";

export const NATIVE_REPLY_MARKER_ENV = "RICHIE_NATIVE_REPLY_MARKER";

export async function readNativeReplyMarker(markerPath) {
  if (!markerPath) {
    return undefined;
  }

  try {
    const payload = JSON.parse(await readFile(markerPath, "utf8"));
    if (payload?.version !== 1 || payload?.sent !== true) {
      return undefined;
    }
    return {
      version: 1,
      sent: true,
      sender: `${payload.sender || "project-sender"}`,
      sourceMessageId: `${payload.source_message_id || ""}`,
      replyInThread: payload.reply_in_thread === true,
      messageCount: Math.max(1, Number(payload.message_count) || 1),
    };
  } catch {
    return undefined;
  }
}

export function shouldSuppressDispatcherReply(result) {
  return result?.nativeReply?.sent === true;
}
