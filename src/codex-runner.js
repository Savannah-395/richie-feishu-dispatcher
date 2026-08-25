import { spawn } from "node:child_process";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { listRepositorySkills } from "./skill-sync.js";
import { NATIVE_REPLY_MARKER_ENV, readNativeReplyMarker } from "./native-reply.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const codexScript = path.join(projectRoot, "node_modules", "@openai", "codex", "bin", "codex.js");
const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const fileExtensions = new Set([
  ".csv",
  ".doc",
  ".docx",
  ".html",
  ".md",
  ".pdf",
  ".ppt",
  ".pptx",
  ".txt",
  ".xls",
  ".xlsx",
  ".zip",
]);

function createTaskId() {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${suffix}`;
}

function terminateProcessTree(child) {
  if (!child.pid || child.exitCode != null) {
    return;
  }

  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", `${child.pid}`, "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("error", () => {
      child.kill("SIGTERM");
    });
    return;
  }

  child.kill("SIGTERM");
}

function formatSkillLine(skill) {
  const label = skill.title && skill.title !== skill.name ? `${skill.key} (${skill.title})` : skill.key;
  const projectLabel = skill.projectTitle && skill.projectTitle !== skill.projectName
    ? ` [project: ${skill.projectTitle}]`
    : "";
  return skill.description ? `- ${label}${projectLabel}: ${skill.description}` : `- ${label}${projectLabel}`;
}

async function buildSkillInstructions(config) {
  const { projectRoots, skills } = await listRepositorySkills({
    projectRoots: config.projectRoots,
    githubProjectOwner: config.githubProjectOwner,
    githubAutoDiscoverProjectRepos: config.githubAutoDiscoverProjectRepos,
    githubProjectRepos: config.githubProjectRepos,
    githubProjectCloneRoot: config.githubProjectCloneRoot,
  });
  const lines = [
    "Richie GitHub project skills:",
    `- Local sibling project root directories: ${projectRoots.join(", ")}`,
    "- richie-feishu-dispatcher is only the Feishu runner. Business projects live in separate GitHub repositories and are cloned beside it locally.",
    "- GitHub repository permissions are project boundaries. Do not assume a skill from one project can be used for another project unless the user asks for that project.",
  ];

  if (config.codexSkillsDir) {
    lines.push(`- Codex user skills mirror: ${config.codexSkillsDir}`);
  }

  lines.push(
    "- Skills are scoped by project as project/skill. Prefer an explicitly named project when choosing a skill.",
    "- If a requested skill name exists in multiple projects or the project is unclear, ask which project to use before acting.",
    "- When the user names a project/skill or the task matches a skill, inspect the matching directory and read SKILL.md completely before acting.",
    "- If SKILL.md references scripts, assets, or reference files, resolve them relative to that skill directory.",
  );

  if (skills.length === 0) {
    lines.push("- No repository skills are installed yet. You may still complete the task normally.");
  } else {
    lines.push("Available repository skills:", ...skills.map(formatSkillLine));
  }

  return lines.join("\n");
}

function buildPrompt({ userPrompt, taskId, runDir, artifactsDir, workingRoot, sandbox, fullAccess, attachments, skillInstructions }) {
  const artifactInstruction = fullAccess
    ? "In full-access mode, obey explicit local paths such as Desktop, Downloads, or project folders. If a deliverable should also be returned to Feishu, copy or save a returnable copy into the artifact directory."
    : "In workspace mode, save screenshots, generated images, Excel files, CSV files, PDFs, and other returnable deliverables into the artifact directory.";
  const attachmentLines = attachments.length === 0
    ? []
    : [
        "",
        "Local files downloaded from the Feishu message or topic context:",
        ...attachments.map((attachment) => `- ${attachment.type}: ${attachment.originalName || attachment.fileName} -> ${attachment.path}`),
      ];

  return [
    "You are Codex running locally on this Windows computer after being triggered from Feishu.",
    "The Feishu bot is only a relay. Do the real work on this local computer.",
    `Task id: ${taskId}`,
    `Working root: ${workingRoot}`,
    `Sandbox mode: ${sandbox}`,
    `Run directory: ${runDir}`,
    `Artifact directory: ${artifactsDir}`,
    artifactInstruction,
    "Only create artifacts explicitly requested by the user or required by the routed project skill.",
    "When a project skill defines a Feishu Card 2.0 candidate-confirmation step, use that project's card builder and topic-reply sender. Never substitute a PNG/JPG preview, HTML screenshot, Markdown table, Word file, PDF, CSV, or generic summary card for the native candidate card.",
    "When a project skill requires one Excel deliverable, return one validated XLSX and do not create a duplicate CSV.",
    "Keep the final response concise and include any important file paths or limitations.",
    "",
    skillInstructions,
    ...attachmentLines,
    "",
    "User task:",
    userPrompt,
  ].join("\n");
}

function collectOutput(child, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const settle = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      stderr += `${stderr ? "\n" : ""}${error.stack || error.message}`;
      settle({ code: null, stdout, stderr, timedOut, spawnError: error });
    });

    child.on("close", (code) => {
      settle({ code, stdout, stderr, timedOut, spawnError: null });
    });
  });
}

export function isCodexCommand(content, prefix) {
  return content.trim().toLowerCase().startsWith(prefix.toLowerCase());
}

export function extractCodexPrompt(content, prefix) {
  return content.trim().slice(prefix.length).trim();
}

export async function runCodexTask(config, userPrompt, options = {}) {
  const taskId = createTaskId();
  const runDir = path.join(projectRoot, "logs", "codex-runs", taskId);
  const artifactsDir = path.join(runDir, "artifacts");
  const finalMessagePath = path.join(runDir, "final.md");
  const nativeReplyMarkerPath = path.join(runDir, "native-reply.json");
  const workingRoot = options.workingRoot || projectRoot;
  const sandbox = options.sandbox || config.sandbox;
  const fullAccess = sandbox === "danger-full-access";
  const attachments = Array.isArray(options.attachments) ? options.attachments : [];

  await mkdir(artifactsDir, { recursive: true });

  const skillInstructions = await buildSkillInstructions(config);
  const prompt = buildPrompt({
    userPrompt,
    taskId,
    runDir,
    artifactsDir,
    workingRoot,
    sandbox,
    fullAccess,
    attachments,
    skillInstructions,
  });
  const args = [
    "--ask-for-approval",
    "never",
    "exec",
    "--cd",
    workingRoot,
    "--sandbox",
    sandbox,
    "--output-last-message",
    finalMessagePath,
  ];

  if (config.model) {
    args.push("--model", config.model);
  }

  for (const attachment of attachments.filter((item) => item.type === "image")) {
    args.push("--image", attachment.path);
  }

  args.push(prompt);

  if (typeof options.onStart === "function") {
    try {
      await options.onStart({
        taskId,
        runDir,
        artifactsDir,
        finalMessagePath,
        workingRoot,
        sandbox,
        fullAccess,
        attachments,
      });
    } catch (error) {
      console.warn(`Codex task ${taskId} onStart callback failed`, error);
    }
  }

  let result;
  try {
    const child = spawn(process.execPath, [codexScript, ...args], {
      cwd: workingRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
        NO_COLOR: "1",
        [NATIVE_REPLY_MARKER_ENV]: nativeReplyMarkerPath,
      },
    });

    result = await collectOutput(child, config.timeoutMs);
  } catch (error) {
    result = {
      code: null,
      stdout: "",
      stderr: error.stack || error.message,
      timedOut: false,
      spawnError: error,
    };
  }

  let finalMessage = "";

  try {
    finalMessage = (await readFile(finalMessagePath, "utf8")).trim();
  } catch {
    finalMessage = "";
  }

  const artifacts = await listArtifacts(artifactsDir);
  const nativeReply = await readNativeReplyMarker(nativeReplyMarkerPath);
  const fallback = result.timedOut
    ? `Codex task ${taskId} timed out after ${Math.round(config.timeoutMs / 1000)} seconds.`
    : result.spawnError
      ? `Codex task ${taskId} failed to start: ${result.spawnError.message}`
    : `Codex task ${taskId} exited with code ${result.code}.`;

  return {
    taskId,
    runDir,
    artifacts,
    finalMessage: finalMessage || fallback,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    exitCode: result.code,
    nativeReply,
  };
}

async function listArtifacts(artifactsDir) {
  const entries = await readdir(artifactsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const filePath = path.join(artifactsDir, entry.name);
      const extension = path.extname(entry.name).toLowerCase();
      return {
        path: filePath,
        fileName: entry.name,
        kind: imageExtensions.has(extension) ? "image" : "file",
      };
    })
    .filter((artifact) => {
      const extension = path.extname(artifact.fileName).toLowerCase();
      return imageExtensions.has(extension) || fileExtensions.has(extension);
    });
}
