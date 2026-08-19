import dotenv from "dotenv";
import path from "node:path";

dotenv.config();

const richieSkillsDir = (process.env.RICHIE_SKILLS_DIR || "skills").trim();
const defaultCodexSkillsDir = path.join(process.env.USERPROFILE || process.cwd(), ".codex", "skills");
const requireMentionToStart = readBoolean("BOT_REQUIRE_MENTION_TO_START", true);

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function readBoolean(name, defaultValue) {
  const raw = process.env[name];
  if (raw == null || raw === "") {
    return defaultValue;
  }
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function readNumber(name, defaultValue) {
  const raw = process.env[name];
  if (raw == null || raw === "") {
    return defaultValue;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer for ${name}: ${raw}`);
  }
  return parsed;
}

function readCsv(name, defaultValue = []) {
  const raw = process.env[name];
  if (!raw) {
    return defaultValue;
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export const config = {
  feishu: {
    appId: requireEnv("FEISHU_APP_ID"),
    appSecret: requireEnv("FEISHU_APP_SECRET"),
    encryptKey: process.env.FEISHU_ENCRYPT_KEY?.trim() || undefined,
    displayName: process.env.BOT_DISPLAY_NAME?.trim() || "richie",
    requireMentionToStart,
    requireMentionToReply: readBoolean("BOT_REQUIRE_MENTION_TO_REPLY", requireMentionToStart),
  },
  openai: {
    apiKey: requireEnv("OPENAI_API_KEY"),
    baseURL: (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").trim(),
    model: (process.env.OPENAI_MODEL || "gpt-5.5").trim(),
    systemPrompt: (
      process.env.BOT_SYSTEM_PROMPT ||
      "你是 richie，是一个在飞书群话题内回复问题的助手。只基于当前话题的上下文回答，不要引用其他话题。回答要直接、准确、简洁。"
    ).trim(),
  },
  bot: {
    allowedChatIds: readCsv("BOT_ALLOWED_CHAT_IDS"),
    ackEmojiType: (process.env.BOT_ACK_EMOJI_TYPE || "OnIt").trim(),
    doneEmojiType: (process.env.BOT_DONE_EMOJI_TYPE || "DONE").trim(),
    maxThreadMessages: readNumber("BOT_MAX_THREAD_MESSAGES", 20),
    maxInputChars: readNumber("BOT_MAX_INPUT_CHARS", 12000),
  },
  codex: {
    enabled: readBoolean("BOT_CODEX_ENABLED", true),
    prefix: (process.env.BOT_CODEX_PREFIX || "/codex").trim(),
    fullAccessPrefixes: readCsv("BOT_CODEX_FULL_ACCESS_PREFIXES", ["/电脑", "/full"]),
    fullAccessAllowedSenderIds: readCsv("BOT_CODEX_FULL_ACCESS_ALLOWED_SENDER_IDS"),
    fullAccessRoot: (process.env.BOT_CODEX_FULL_ACCESS_ROOT || process.env.USERPROFILE || process.cwd()).trim(),
    fullAccessSandbox: (process.env.BOT_CODEX_FULL_ACCESS_SANDBOX || "danger-full-access").trim(),
    model: process.env.BOT_CODEX_MODEL?.trim() || "",
    sandbox: (process.env.BOT_CODEX_SANDBOX || "workspace-write").trim(),
    timeoutMs: readNumber("BOT_CODEX_TIMEOUT_SECONDS", 600) * 1000,
    skillsDir: richieSkillsDir,
    codexSkillsDir: (process.env.RICHIE_CODEX_SKILLS_DIR || defaultCodexSkillsDir).trim(),
  },
  sync: {
    enabled: readBoolean("RICHIE_GIT_SYNC_ENABLED", true),
    intervalMs: readNumber("RICHIE_GIT_SYNC_INTERVAL_SECONDS", 600) * 1000,
    remote: (process.env.RICHIE_GIT_REMOTE || "origin").trim(),
    branch: process.env.RICHIE_GIT_BRANCH?.trim() || "",
    skillsDir: richieSkillsDir,
    installCodexSkills: readBoolean("RICHIE_INSTALL_CODEX_SKILLS", true),
    codexSkillsDir: (process.env.RICHIE_CODEX_SKILLS_DIR || defaultCodexSkillsDir).trim(),
    skillPrefix: process.env.RICHIE_SKILL_PREFIX?.trim() || "",
  },
};
