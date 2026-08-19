import { createLarkChannel, LoggerLevel } from "@larksuiteoapi/node-sdk";
import path from "node:path";

import { config } from "./config.js";
import { downloadMessageAttachments, formatAttachmentSummary, shouldUseAttachmentContext } from "./attachment-manager.js";
import { extractCodexPrompt, isCodexCommand, runCodexTask } from "./codex-runner.js";
import { createOpenAIClient, generateThreadReply } from "./openai-client.js";
import { listRepositorySkills, startGitSync } from "./skill-sync.js";
import { ThreadQueue } from "./thread-queue.js";
import { ThreadStore } from "./thread-store.js";

function configureNoProxy() {
  const bypassHosts = ["open.feishu.cn", "10.135.136.21", "127.0.0.1", "localhost"];
  const existing = (process.env.NO_PROXY || process.env.no_proxy || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const merged = [...new Set([...existing, ...bypassHosts])].join(",");

  process.env.NO_PROXY = merged;
  process.env.no_proxy = merged;
}

configureNoProxy();

const channel = createLarkChannel({
  appId: config.feishu.appId,
  appSecret: config.feishu.appSecret,
  loggerLevel: LoggerLevel.info,
  policy: {
    requireMention: config.feishu.requireMentionToReply,
    dmMode: "ignore",
  },
  includeRawInMessage: false,
});

const openai = createOpenAIClient(config.openai);
const queue = new ThreadQueue();
const store = new ThreadStore({
  maxMessages: config.bot.maxThreadMessages,
  maxInputChars: config.bot.maxInputChars,
});
let syncController;

function getTopicId(message) {
  return message.threadId || message.rootId || message.messageId;
}

function getAuthorName(message) {
  return message.senderName || message.senderId || "unknown";
}

function shouldUseCodex(content) {
  const normalized = (content || "").trim();
  const localActionPatterns = [
    /截图|截屏|屏幕截图|拍屏|当前屏幕|桌面截图|窗口截图/,
    /(生成|创建|制作|整理|导出|保存|回传|返回|发送|上传|下载).*(文件|文档|表格|excel|xlsx|csv|pdf|ppt|pptx|word|docx|图片|截图)/i,
    /(文件|文档|表格|excel|xlsx|csv|pdf|ppt|pptx|word|docx|图片|截图).*(生成|创建|制作|导出|保存|回传|返回|发给我|发回来|上传|下载|截图|预览)/i,
    /保存到本地|这台电脑|本机|本地电脑|电脑上|本地文件|文件夹|目录|工作区|workspace|repo|项目目录/i,
    /(运行|执行).*(命令|脚本|测试|构建|npm|node|python|powershell|cmd|git)/i,
    /(修改|编辑|修复|实现|检查).*(代码|项目|仓库|repo|bug|脚本|文件)/i,
    /(^|\s)\/skills?\b/i,
    /(使用|调用|运行|加载).{0,20}(skill|技能)/i,
    /(skill|技能).{0,20}(执行|调用|运行|帮我|处理)/i,
  ];

  return localActionPatterns.some((pattern) => pattern.test(normalized));
}

function isSkillListCommand(content) {
  const normalized = (content || "").trim().toLowerCase();
  return ["/skill", "/skills", "/skill list", "/skills list"].includes(normalized)
    || /^(技能列表|列出技能|查看技能|有哪些技能)$/.test((content || "").trim());
}

function getMatchedPrefix(content, prefixes) {
  const normalized = (content || "").trim().toLowerCase();
  return prefixes.find((prefix) => normalized.startsWith(prefix.toLowerCase())) || "";
}

function canUseFullAccess(message) {
  return config.codex.fullAccessAllowedSenderIds.includes(message.senderId);
}

function hasSupportedResourceType(message) {
  return ["image", "file"].includes(message.rawContentType) || (Array.isArray(message.resources) && message.resources.length > 0);
}

function buildCodexPrompt({ latestMessage, threadTranscript }) {
  return [
    "Only use the current Feishu topic context below. Read any local file paths listed in the context when they are relevant.",
    "",
    "Current Feishu topic context:",
    threadTranscript || "(no prior context)",
    "",
    "Latest user message:",
    latestMessage || "(the user uploaded attachments without extra text)",
  ].join("\n");
}

function getIgnoreReason(message) {
  if (!message.content?.trim() && !hasSupportedResourceType(message)) {
    return "empty content";
  }

  if (config.bot.allowedChatIds.length > 0 && !config.bot.allowedChatIds.includes(message.chatId)) {
    return `chat ${message.chatId} is not in BOT_ALLOWED_CHAT_IDS`;
  }

  if (message.senderName && config.feishu.displayName && message.senderName.toLowerCase() === config.feishu.displayName.toLowerCase()) {
    return "sender name matches bot display name";
  }

  if (message.senderId && channel.botIdentity?.openId && message.senderId === channel.botIdentity.openId) {
    return "sender id matches bot open id";
  }

  if (message.rawContentType && !["text", "post", "image", "file"].includes(message.rawContentType)) {
    return `unsupported content type ${message.rawContentType}`;
  }

  return "";
}

async function acknowledgeMessage(message) {
  if (!config.bot.ackEmojiType) {
    return undefined;
  }

  try {
    const reactionId = await channel.addReaction(message.messageId, config.bot.ackEmojiType);
    console.log(`Added ${config.bot.ackEmojiType} reaction to ${message.messageId}`);
    return reactionId;
  } catch (error) {
    console.warn(`Failed to add ${config.bot.ackEmojiType} reaction to ${message.messageId}`, error);
    return undefined;
  }
}

async function markMessageDone(message, ackReactionId) {
  if (ackReactionId) {
    try {
      await channel.removeReaction(message.messageId, ackReactionId);
      console.log(`Removed ${config.bot.ackEmojiType} reaction from ${message.messageId}`);
    } catch (error) {
      console.warn(`Failed to remove ${config.bot.ackEmojiType} reaction from ${message.messageId}`, error);
    }
  }

  if (!config.bot.doneEmojiType) {
    return;
  }

  try {
    await channel.addReaction(message.messageId, config.bot.doneEmojiType);
    console.log(`Added ${config.bot.doneEmojiType} reaction to ${message.messageId}`);
  } catch (error) {
    console.warn(`Failed to add ${config.bot.doneEmojiType} reaction to ${message.messageId}`, error);
  }
}

async function sendCodexResult(message, result) {
  await channel.send(
    message.chatId,
    { markdown: result.finalMessage },
    {
      replyTo: message.messageId,
      replyInThread: true,
    },
  );

  for (const artifact of result.artifacts) {
    const payload = artifact.kind === "image"
      ? { image: { source: artifact.path } }
      : { file: { source: artifact.path, fileName: artifact.fileName || path.basename(artifact.path) } };

    await channel.send(message.chatId, payload, {
      replyTo: message.messageId,
      replyInThread: true,
    });
  }
}

async function sendSkillList(message) {
  const { skillsRoot, skills } = await listRepositorySkills(config.sync);
  const lines = [
    `richie 当前同步目录：${skillsRoot}`,
    "",
    skills.length === 0
      ? "当前还没有可用 skill。把包含 `SKILL.md` 的目录推到 `skills/` 后，richie 会在下一次同步时加载。"
      : "当前可用 skill：",
  ];

  for (const skill of skills) {
    const label = skill.title && skill.title !== skill.name ? `${skill.name}（${skill.title}）` : skill.name;
    lines.push(skill.description ? `- ${label}: ${skill.description}` : `- ${label}`);
  }

  await channel.send(
    message.chatId,
    { markdown: lines.join("\n") },
    {
      replyTo: message.messageId,
      replyInThread: true,
    },
  );
}

async function handleMessage(message) {
  console.log(
    "Received message",
    JSON.stringify({
      messageId: message.messageId,
      chatId: message.chatId,
      threadId: message.threadId,
      rootId: message.rootId,
      senderName: message.senderName,
      senderId: message.senderId,
      rawContentType: message.rawContentType,
      mentionedBot: message.mentionedBot,
      resourceCount: message.resources?.length ?? 0,
      contentPreview: message.content?.slice(0, 80),
    }),
  );

  const ignoreReason = getIgnoreReason(message);
  if (ignoreReason) {
    console.log(`Ignored message ${message.messageId}: ${ignoreReason}`);
    return;
  }

  const topicId = getTopicId(message);
  const topicActive = store.isActive(topicId);
  const shouldReply = config.feishu.requireMentionToReply
    ? message.mentionedBot
    : topicActive || !config.feishu.requireMentionToStart || message.mentionedBot;

  if (!shouldReply) {
    const reason = config.feishu.requireMentionToReply
      ? "bot was not mentioned"
      : `topic ${topicId} is inactive and bot was not mentioned`;
    console.log(`Ignored message ${message.messageId}: ${reason}`);
    return;
  }

  const ackReactionId = await acknowledgeMessage(message);
  let completionMarked = false;
  const markComplete = async () => {
    if (completionMarked) {
      return;
    }
    completionMarked = true;
    await markMessageDone(message, ackReactionId);
  };

  try {
    if (isSkillListCommand(message.content)) {
      await sendSkillList(message);
      await markComplete();
      return;
    }

    await queue.run(topicId, async () => {
    store.activate(topicId);
    const attachmentResult = await downloadMessageAttachments(channel, message, topicId);
    const attachmentSummary = formatAttachmentSummary(attachmentResult);
    const hasCurrentAttachments = attachmentResult.attachments.length > 0;
    const hasTopicAttachments = hasCurrentAttachments || store.hasAttachments(topicId);

    const messageContent = message.content || "";
    const fullAccessPrefix = config.codex.enabled
      ? getMatchedPrefix(messageContent, config.codex.fullAccessPrefixes)
      : "";
    const forcedCodex = config.codex.enabled && isCodexCommand(messageContent, config.codex.prefix);
    const routedCodex = config.codex.enabled && (
      fullAccessPrefix ||
      forcedCodex ||
      shouldUseCodex(messageContent) ||
      hasCurrentAttachments ||
      (hasTopicAttachments && shouldUseAttachmentContext(messageContent))
    );

    const userEntry = {
      role: "user",
      author: getAuthorName(message),
      content: [messageContent.trim(), attachmentSummary].filter(Boolean).join("\n\n"),
      attachments: attachmentResult.attachments,
    };

    store.append(topicId, userEntry);
    const threadTranscript = store.toModelInput(topicId);

    if (routedCodex) {
      if (fullAccessPrefix && !canUseFullAccess(message)) {
        await channel.send(
          message.chatId,
          { text: `当前发送者未被允许使用全电脑模式。senderId: ${message.senderId}` },
          {
            replyTo: message.messageId,
            replyInThread: true,
          },
        );
        await markComplete();
        return;
      }

      const codexPrompt = fullAccessPrefix
        ? extractCodexPrompt(messageContent, fullAccessPrefix)
        : forcedCodex
        ? extractCodexPrompt(messageContent, config.codex.prefix)
        : messageContent.trim();
      if (!codexPrompt && !hasCurrentAttachments) {
        const expectedPrefix = fullAccessPrefix || config.codex.prefix;
        await channel.send(
          message.chatId,
          { text: `请在 ${expectedPrefix} 后面写清楚要 Codex 执行的任务。` },
          {
            replyTo: message.messageId,
            replyInThread: true,
          },
        );
        await markComplete();
        return;
      }

      const codexOptions = fullAccessPrefix
        ? {
            sandbox: config.codex.fullAccessSandbox,
            workingRoot: config.codex.fullAccessRoot,
            attachments: attachmentResult.attachments,
          }
        : {
            attachments: attachmentResult.attachments,
          };
      console.log(
        `Running ${fullAccessPrefix ? "full-access" : forcedCodex ? "forced" : "auto-routed"} Codex task for message ${message.messageId} in topic ${topicId}`,
      );
      const result = await runCodexTask(config.codex, buildCodexPrompt({
        latestMessage: codexPrompt || userEntry.content,
        threadTranscript,
      }), codexOptions);
      await sendCodexResult(message, result);
      console.log(`Sent Codex task ${result.taskId} result for message ${message.messageId}`);
      await markComplete();
      store.append(topicId, {
        role: "assistant",
        author: "bot",
        content: result.finalMessage,
      });
      return;
    }

    console.log(`Generating reply for message ${message.messageId} in topic ${topicId}`);
    const reply = await generateThreadReply(openai, config.openai, {
      topicId,
      senderName: userEntry.author,
      latestMessage: userEntry.content,
      threadTranscript,
    });

    await channel.send(
      message.chatId,
      { markdown: reply },
      {
        replyTo: message.messageId,
        replyInThread: true,
      },
    );

    console.log(`Sent reply for message ${message.messageId} in topic ${topicId}`);
    await markComplete();

    store.append(topicId, {
      role: "assistant",
      author: "bot",
      content: reply,
    });
    });
  } catch (error) {
    console.error("Failed to process message", error);

    try {
      await channel.send(
        message.chatId,
        { text: "处理这条消息时出错了，请稍后重试。" },
        {
          replyTo: message.messageId,
          replyInThread: true,
        },
      );
    } catch (sendError) {
      console.error("Failed to send fallback message", sendError);
    }

    await markComplete();
  }
}

channel.on("message", async (message) => {
  try {
    await handleMessage(message);
  } catch (error) {
    console.error("Failed to process message", error);

    try {
      await channel.send(
        message.chatId,
        { text: "处理这条消息时出错了，请稍后重试。" },
        {
          replyTo: message.messageId,
          replyInThread: true,
        },
      );
    } catch (sendError) {
      console.error("Failed to send fallback message", sendError);
    }
  }
});

channel.on("reject", (event) => {
  console.warn("Message rejected by policy", event);
});

channel.on("error", (error) => {
  console.error("Inbound channel error", error);
});

async function main() {
  syncController = startGitSync(config.sync);
  await channel.connect();
  console.log(`Feishu bot connected as ${channel.botIdentity?.name ?? "unknown-bot"}; richie sync is ${config.sync.enabled ? "enabled" : "disabled"}`);
}

main().catch((error) => {
  console.error("Startup failed", error);
  process.exitCode = 1;
});

process.on("SIGINT", async () => {
  syncController?.stop();
  await channel.disconnect();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  syncController?.stop();
  await channel.disconnect();
  process.exit(0);
});
