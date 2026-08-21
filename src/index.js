import { createLarkChannel, LoggerLevel } from "@larksuiteoapi/node-sdk";
import path from "node:path";

import { config } from "./config.js";
import { downloadMessageAttachments, formatAttachmentSummary, shouldUseAttachmentContext } from "./attachment-manager.js";
import { extractCodexPrompt, isCodexCommand, runCodexTask } from "./codex-runner.js";
import { createOpenAIClient, generateThreadReply } from "./openai-client.js";
import { listRepositorySkillRoutes, listRepositorySkills, startGitSync } from "./skill-sync.js";
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

function isGroupChatId(chatId) {
  return /^oc_/i.test(chatId || "");
}

function truncateText(value, maxChars = 2000) {
  const text = `${value || ""}`.trim();
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n...[truncated]`;
}

function redactSensitiveText(value) {
  return `${value || ""}`
    .replace(/\b(Bearer\s+)(?!oc_)[A-Za-z0-9._~+/=-]{20,}\b/gi, "$1[redacted]")
    .replace(/\b(api[_ -]?key|token|secret|password|authorization)\s*[:=]\s*(?!oc_)[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\b(?!oc_)[A-Za-z0-9_-]{56,}\b/g, "[redacted-token]");
}

function auditPreview(value, maxChars = 600) {
  return truncateText(redactSensitiveText(value), maxChars) || "(empty)";
}

function formatQueueSnapshot(snapshot) {
  if (!snapshot) {
    return "unavailable";
  }

  const activeTopics = snapshot.activeTopics.length > 0
    ? snapshot.activeTopics.join(", ")
    : "none";
  const queuedTopics = snapshot.queuedTopics.length > 0
    ? snapshot.queuedTopics.map((item) => `${item.key} x${item.count}`).join(", ")
    : "none";

  return `active=${snapshot.activeCount} [${activeTopics}], queued=${snapshot.queuedCount} [${queuedTopics}], started=${snapshot.startedCount}, completed=${snapshot.completedCount}`;
}

function getSentMessageId(result) {
  if (!result) {
    return "";
  }
  if (typeof result === "string") {
    return result;
  }
  return result.messageId
    || result.message_id
    || result.id
    || result.data?.messageId
    || result.data?.message_id
    || result.chunkIds?.[0]
    || result.chunk_ids?.[0]
    || "";
}

function getSkillRouteLabel(skillRoute, executionKind) {
  if (skillRoute?.skillKey) {
    return skillRoute.skillKey;
  }
  if (skillRoute?.projectName) {
    return skillRoute.projectName;
  }
  return executionKind || "ordinary-reply";
}

function getExecutionPlan({ skillRoute, executionKind }) {
  if (skillRoute) {
    return "Validate the chat route, read the routed SKILL.md, run the project-specific workflow locally, then send the result back to the Feishu topic.";
  }
  if (executionKind === "full-access") {
    return "Run the requested local-computer task with full access, collect returnable artifacts, then send the result back to the Feishu topic.";
  }
  if (executionKind === "forced-codex") {
    return "Run the explicit Codex task locally, collect returnable artifacts, then send the result back to the Feishu topic.";
  }
  if (executionKind === "auto-codex") {
    return "Use Codex because the request needs local files, attachments, skills, or command execution, then send the result back to the Feishu topic.";
  }
  return "Use the ordinary reply fallback with the current Feishu topic context.";
}

async function sendAuditMessage(markdown, { replyTo = "" } = {}) {
  if (!config.audit.enabled || !config.audit.chatId) {
    return undefined;
  }

  const safeMarkdown = truncateText(redactSensitiveText(markdown), config.audit.maxMessageChars);
  const options = replyTo
    ? { replyTo, replyInThread: true }
    : {};

  try {
    const result = await channel.send(config.audit.chatId, { markdown: safeMarkdown }, options);
    return {
      messageId: getSentMessageId(result),
      result,
    };
  } catch (error) {
    console.warn("Failed to send audit message", error);
    return undefined;
  }
}

async function sendAuditStart({ message, topicId, userEntry, skillRoute, executionKind, task, queueSnapshot }) {
  return sendAuditMessage([
    "Richie audit: started",
    `- Task: ${task?.taskId || executionKind || "unknown"}`,
    `- Source chat: ${message.chatId}`,
    `- Topic: ${topicId}`,
    `- Source message: ${message.messageId}`,
    `- User: ${auditPreview(getAuthorName(message), 120)}`,
    `- Request: ${auditPreview(userEntry?.content || message.content, 500)}`,
    `- Route: ${getSkillRouteLabel(skillRoute, executionKind)}`,
    `- Route source: ${skillRoute?.source || "fallback"}`,
    `- Route reason: ${skillRoute?.reason || "no project skill matched"}`,
    `- Plan: ${getExecutionPlan({ skillRoute, executionKind })}`,
    task?.runDir ? `- Run dir: ${task.runDir}` : "",
    `- Queue: ${formatQueueSnapshot(queueSnapshot)}`,
  ].filter(Boolean).join("\n"));
}

async function sendAuditFinish(auditStart, { message, skillRoute, executionKind, result, finalMessage, error, queueSnapshot }) {
  const status = error
    ? `failed: ${error.message}`
    : result?.timedOut
      ? "timed out"
      : result?.exitCode == null || result.exitCode === 0
        ? "completed"
        : `exited with code ${result.exitCode}`;
  const artifacts = result?.artifacts?.length > 0
    ? result.artifacts.map((artifact) => artifact.fileName || path.basename(artifact.path)).join(", ")
    : "none";

  return sendAuditMessage([
    "Richie audit: finished",
    `- Task: ${result?.taskId || executionKind || "unknown"}`,
    `- Status: ${status}`,
    `- Source chat: ${message.chatId}`,
    `- Source message: ${message.messageId}`,
    `- Route: ${getSkillRouteLabel(skillRoute, executionKind)}`,
    result?.runDir ? `- Run dir: ${result.runDir}` : "",
    `- Artifacts: ${artifacts}`,
    `- Final reply preview: ${auditPreview(finalMessage || result?.finalMessage || "", 700)}`,
    `- Queue: ${formatQueueSnapshot(queueSnapshot)}`,
  ].filter(Boolean).join("\n"), {
    replyTo: auditStart?.messageId || "",
  });
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
    /(调研|研究|选品|竞品|市场|热销|爆款|排名|榜单|销量|价格|bsr|asin|keepa|amazon|top\s*\d*)/i,
    /(墙板|格栅墙板|吸音板|平面墙板|弯曲墙板|柔性墙板|墙裙|收边条|spc|wall\s*panel|slat\s*wall|acoustic\s*panel|wainscot|trim\s*strip)/i,
    /(^|\s)\/skills?\b/i,
    /(使用|调用|运行|加载).{0,20}(skill|技能)/i,
    /(skill|技能).{0,20}(执行|调用|运行|帮我|处理)/i,
  ];

  return localActionPatterns.some((pattern) => pattern.test(normalized));
}

function isSkillListCommand(content) {
  const trimmed = (content || "").trim();
  const normalized = trimmed.toLowerCase();
  return ["/skill", "/skills", "/skill list", "/skills list"].includes(normalized)
    || /^(技能列表|列出技能|查看技能|有哪些技能)$/.test(trimmed);
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

function normalizeForRouteMatch(value) {
  return (value || "").trim().toLowerCase();
}

function contentMentionsSkill(content, skill) {
  const normalized = normalizeForRouteMatch(content);
  if (!normalized) {
    return false;
  }

  const candidates = [
    skill.key,
    skill.name,
    skill.projectName,
    `${skill.projectName}--${skill.name}`,
    skill.title,
  ]
    .map(normalizeForRouteMatch)
    .filter((item) => item.length >= 3);

  return candidates.some((candidate) => normalized.includes(candidate));
}

async function resolveRepositorySkillRoute(message, content) {
  const { skills, routes } = await listRepositorySkillRoutes(config.sync);
  const chatRoutes = routes.filter((route) => route.chatIds.includes(message.chatId));

  if (chatRoutes.length === 1) {
    return { ...chatRoutes[0], reason: `chat ${message.chatId} is mapped to this project skill` };
  }

  if (chatRoutes.length > 1) {
    const mentionedRoute = chatRoutes.find((route) => contentMentionsSkill(content, {
      key: route.skillKey,
      name: route.skillName,
      projectName: route.projectName,
      title: route.skillTitle,
    }));
    if (mentionedRoute) {
      return { ...mentionedRoute, reason: `chat ${message.chatId} and message text matched this skill` };
    }

    return {
      ...chatRoutes[0],
      reason: `chat ${message.chatId} has ${chatRoutes.length} skill routes; routing to the first configured route`,
      ambiguousRoutes: chatRoutes.map((route) => route.skillKey || route.projectName),
    };
  }

  const mentionedSkill = skills.find((skill) => contentMentionsSkill(content, skill));
  if (mentionedSkill) {
    return {
      source: "message-skill-mention",
      chatIds: [],
      projectName: mentionedSkill.projectName,
      projectTitle: mentionedSkill.projectTitle,
      projectPath: mentionedSkill.projectPath,
      skillName: mentionedSkill.name,
      skillKey: mentionedSkill.key,
      skillTitle: mentionedSkill.title,
      skillDescription: mentionedSkill.description,
      skillPath: mentionedSkill.path,
      skillMdPath: mentionedSkill.skillMdPath,
      reason: "message text explicitly matched a synced project skill",
    };
  }

  return undefined;
}

function formatSkillRoutePrompt(skillRoute) {
  if (!skillRoute) {
    return [];
  }

  const lines = [
    "",
    "Resolved richie project skill route:",
    `- Reason: ${skillRoute.reason}`,
    `- Project: ${skillRoute.projectName}${skillRoute.projectTitle ? ` (${skillRoute.projectTitle})` : ""}`,
  ];

  if (skillRoute.skillKey) {
    lines.push(`- Skill: ${skillRoute.skillKey}${skillRoute.skillTitle ? ` (${skillRoute.skillTitle})` : ""}`);
  }
  if (skillRoute.projectPath) {
    lines.push(`- Project path: ${skillRoute.projectPath}`);
  }
  if (skillRoute.skillPath) {
    lines.push(`- Skill path: ${skillRoute.skillPath}`);
  }
  if (skillRoute.skillMdPath) {
    lines.push(`- Read this SKILL.md completely before acting: ${skillRoute.skillMdPath}`);
  }
  if (skillRoute.ambiguousRoutes?.length > 0) {
    lines.push(`- Other routes configured for this chat: ${skillRoute.ambiguousRoutes.join(", ")}`);
  }

  lines.push(
    "- Treat this route as authoritative for the current Feishu chat unless the user explicitly asks for another project/skill.",
    "- If the user request is incomplete, ask a project-specific clarification instead of falling back to ordinary chat.",
  );

  return lines;
}

function buildCodexPrompt({ latestMessage, threadTranscript, skillRoute }) {
  return [
    "Only use the current Feishu topic context below. Read any local file paths listed in the context when they are relevant.",
    ...formatSkillRoutePrompt(skillRoute),
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

  if (config.audit.chatId && message.chatId === config.audit.chatId) {
    return "audit chat is output-only";
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
    console.warn(`Failed to add ${config.bot.doneEmojiType} reaction`, error);
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
  const { projectRoots, skills } = await listRepositorySkills(config.sync);
  const owner = config.sync.githubProjectOwner || "origin 所属账号/组织";
  const lines = [
    `richie 当前本机同级项目根目录：${projectRoots.join(", ")}`,
    config.sync.githubAutoDiscoverProjectRepos
      ? `GitHub 自动发现：${owner} 下 richie 可读的项目 repo 会自动同步到同级目录。`
      : "GitHub 自动发现未开启；当前只扫描本机已存在的同级项目目录。",
    "`richie-feishu-dispatcher` 只是后台 runner，不作为业务项目扫描。",
    "",
    skills.length === 0
      ? "当前还没有可用 skill。项目 repo 需要包含 `PROJECT.md` 或 `skills/<skill>/SKILL.md`；richie 会在同步后加载。"
      : "当前可用 project/skill：",
  ];

  for (const skill of skills) {
    const label = skill.title && skill.title !== skill.name ? `${skill.key}（${skill.title}）` : skill.key;
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
  let initialSkillRoute;
  if (config.codex.enabled && message.chatId) {
    try {
      initialSkillRoute = await resolveRepositorySkillRoute(message, message.content || "");
    } catch (error) {
      console.warn(`Failed to resolve repository skill route for message ${message.messageId}`, error);
    }
  }

  const groupMessage = isGroupChatId(message.chatId);
  const topicActive = store.isActive(topicId);
  const shouldReply = groupMessage
    || (config.feishu.requireMentionToReply
      ? message.mentionedBot
      : topicActive || !config.feishu.requireMentionToStart || message.mentionedBot);

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
      const skillRoute = config.codex.enabled ? initialSkillRoute : undefined;
      const routedCodex = config.codex.enabled && (
        fullAccessPrefix ||
        forcedCodex ||
        skillRoute ||
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

        const executionKind = skillRoute
          ? "skill-routed"
          : fullAccessPrefix
            ? "full-access"
            : forcedCodex
              ? "forced-codex"
              : "auto-codex";
        let auditStart;
        const codexOptions = fullAccessPrefix
          ? {
              sandbox: config.codex.fullAccessSandbox,
              workingRoot: config.codex.fullAccessRoot,
              attachments: attachmentResult.attachments,
            }
          : {
              attachments: attachmentResult.attachments,
            };
        codexOptions.onStart = async (task) => {
          auditStart = await sendAuditStart({
            message,
            topicId,
            userEntry,
            skillRoute,
            executionKind,
            task,
            queueSnapshot: queue.snapshot(),
          });
        };
        console.log(
          `Running ${skillRoute ? `skill-routed ${skillRoute.skillKey || skillRoute.projectName}` : fullAccessPrefix ? "full-access" : forcedCodex ? "forced" : "auto-routed"} Codex task for message ${message.messageId} in topic ${topicId}`,
        );
        let result;
        try {
          result = await runCodexTask(config.codex, buildCodexPrompt({
            latestMessage: codexPrompt || userEntry.content,
            threadTranscript,
            skillRoute,
          }), codexOptions);
          await sendCodexResult(message, result);
          await sendAuditFinish(auditStart, {
            message,
            skillRoute,
            executionKind,
            result,
            queueSnapshot: queue.snapshot(),
          });
          console.log(`Sent Codex task ${result.taskId} result for message ${message.messageId}`);
          await markComplete();
          store.append(topicId, {
            role: "assistant",
            author: "bot",
            content: result.finalMessage,
          });
        } catch (error) {
          await sendAuditFinish(auditStart, {
            message,
            skillRoute,
            executionKind,
            result,
            error,
            queueSnapshot: queue.snapshot(),
          });
          throw error;
        }
        return;
      }

      console.log(`Generating reply for message ${message.messageId} in topic ${topicId}`);
      const executionKind = "ordinary-reply";
      const auditStart = await sendAuditStart({
        message,
        topicId,
        userEntry,
        skillRoute: undefined,
        executionKind,
        task: { taskId: `reply-${message.messageId}` },
        queueSnapshot: queue.snapshot(),
      });
      let reply = "";
      try {
        reply = await generateThreadReply(openai, config.openai, {
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

        await sendAuditFinish(auditStart, {
          message,
          executionKind,
          finalMessage: reply,
          queueSnapshot: queue.snapshot(),
        });
        console.log(`Sent reply for message ${message.messageId} in topic ${topicId}`);
        await markComplete();

        store.append(topicId, {
          role: "assistant",
          author: "bot",
          content: reply,
        });
      } catch (error) {
        await sendAuditFinish(auditStart, {
          message,
          executionKind,
          finalMessage: reply,
          error,
          queueSnapshot: queue.snapshot(),
        });
        throw error;
      }
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
