import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const managedMarkerName = ".richie-managed";
const managedManifestName = ".richie-managed.json";

function resolveLocalPath(value) {
  return path.isAbsolute(value) ? value : path.join(projectRoot, value);
}

function isValidSkillTargetName(name) {
  return Boolean(name) && name !== "." && name !== ".." && !/[<>:"/\\|?*\x00-\x1F]/.test(name);
}

function assertInside(parent, child) {
  const parentPath = path.resolve(parent);
  const childPath = path.resolve(child);
  if (childPath !== parentPath && !childPath.startsWith(`${parentPath}${path.sep}`)) {
    throw new Error(`Refusing to write outside ${parentPath}: ${childPath}`);
  }
}

function runCommand(command, args, { cwd = projectRoot, timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${stderr ? "\n" : ""}${error.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function summarizeSkill(skillMd) {
  const lines = skillMd.split(/\r?\n/);
  const title = lines.find((line) => line.startsWith("# "))?.replace(/^#\s+/, "").trim() || "";
  const descriptionLine = lines.find((line) => /^description\s*:/i.test(line));
  const description = descriptionLine?.replace(/^description\s*:\s*/i, "").trim() || "";
  return { title, description };
}

async function summarizeMarkdownFile(filePath) {
  try {
    return summarizeSkill(await readFile(filePath, "utf8"));
  } catch {
    return { title: "", description: "" };
  }
}

async function scanSkillDirectory({ skillsRoot, projectName, projectPath, projectTitle, legacy = false }) {
  if (!(await pathExists(skillsRoot))) {
    return [];
  }

  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const skills = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.startsWith("_")) {
      continue;
    }

    const skillPath = path.join(skillsRoot, entry.name);
    const skillMdPath = path.join(skillPath, "SKILL.md");
    if (!(await pathExists(skillMdPath))) {
      continue;
    }

    const { title, description } = await summarizeMarkdownFile(skillMdPath);

    skills.push({
      name: entry.name,
      projectName,
      projectTitle,
      key: `${projectName}/${entry.name}`,
      title,
      description,
      path: skillPath,
      skillMdPath,
      projectPath,
      legacy,
    });
  }

  return skills;
}

export async function listRepositorySkills(syncConfig) {
  const projectsRoot = resolveLocalPath(syncConfig.projectsDir || "projects");
  const legacySkillsRoot = resolveLocalPath(syncConfig.skillsDir || "skills");
  await mkdir(projectsRoot, { recursive: true });
  await mkdir(legacySkillsRoot, { recursive: true });

  const skills = [];
  const projectEntries = await readdir(projectsRoot, { withFileTypes: true });

  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory() || projectEntry.name.startsWith(".") || projectEntry.name.startsWith("_")) {
      continue;
    }

    const projectPath = path.join(projectsRoot, projectEntry.name);
    const projectMdPath = path.join(projectPath, "PROJECT.md");
    const projectSummary = await summarizeMarkdownFile(projectMdPath);
    skills.push(...await scanSkillDirectory({
      skillsRoot: path.join(projectPath, "skills"),
      projectName: projectEntry.name,
      projectPath,
      projectTitle: projectSummary.title || projectEntry.name,
    }));
  }

  skills.push(...await scanSkillDirectory({
    skillsRoot: legacySkillsRoot,
    projectName: "legacy",
    projectPath: legacySkillsRoot,
    projectTitle: "legacy",
    legacy: true,
  }));

  return { projectsRoot, legacySkillsRoot, skillsRoot: projectsRoot, skills };
}

async function pullLatest(syncConfig) {
  if (!existsSync(path.join(projectRoot, ".git"))) {
    return { skipped: true, message: "not a git repository" };
  }

  const remote = syncConfig.remote || "origin";
  const remoteCheck = await runCommand("git", ["remote", "get-url", remote], { timeoutMs: 10000 });
  if (remoteCheck.code !== 0) {
    return { skipped: true, message: `remote '${remote}' is not configured` };
  }

  const args = syncConfig.branch
    ? ["pull", "--ff-only", remote, syncConfig.branch]
    : ["pull", "--ff-only"];
  const result = await runCommand("git", args, { timeoutMs: 120000 });

  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || "git pull failed").trim();
    return { skipped: false, ok: false, message: detail };
  }

  return { skipped: false, ok: true, message: (result.stdout || "Already up to date.").trim() };
}

async function installCodexSkills(syncConfig) {
  if (!syncConfig.installCodexSkills) {
    return { installed: [], skipped: [], removed: [], message: "Codex skill install disabled" };
  }

  const targetRoot = resolveLocalPath(syncConfig.codexSkillsDir);
  await mkdir(targetRoot, { recursive: true });

  const { projectsRoot, legacySkillsRoot, skills } = await listRepositorySkills(syncConfig);
  const manifestPath = path.join(targetRoot, managedManifestName);
  const previousManifest = await readJson(manifestPath, { managedTargets: [] });
  const previousTargets = new Set(Array.isArray(previousManifest.managedTargets) ? previousManifest.managedTargets : []);
  const targetNames = new Set();
  const installed = [];
  const skipped = [];
  const removed = [];

  for (const skill of skills) {
    const targetName = `${syncConfig.skillPrefix || ""}${skill.projectName}--${skill.name}`;
    if (!isValidSkillTargetName(targetName)) {
      skipped.push({ name: skill.key, reason: `invalid target name '${targetName}'` });
      continue;
    }
    targetNames.add(targetName);
  }

  for (const previousTarget of previousTargets) {
    if (targetNames.has(previousTarget) || !isValidSkillTargetName(previousTarget)) {
      continue;
    }

    const targetPath = path.join(targetRoot, previousTarget);
    assertInside(targetRoot, targetPath);
    const markerPath = path.join(targetPath, managedMarkerName);
    if (await pathExists(markerPath)) {
      await rm(targetPath, { recursive: true, force: true });
      removed.push(previousTarget);
    }
  }

  for (const skill of skills) {
    const targetName = `${syncConfig.skillPrefix || ""}${skill.projectName}--${skill.name}`;
    if (!targetNames.has(targetName)) {
      continue;
    }

    const targetPath = path.join(targetRoot, targetName);
    assertInside(targetRoot, targetPath);
    const markerPath = path.join(targetPath, managedMarkerName);

    if (await pathExists(targetPath)) {
      if (!(await pathExists(markerPath)) && !previousTargets.has(targetName)) {
        skipped.push({
          name: skill.key,
          reason: `${targetPath} already exists and is not managed by richie`,
        });
        continue;
      }
      await rm(targetPath, { recursive: true, force: true });
    }

    await cp(skill.path, targetPath, { recursive: true });
    await writeFile(markerPath, JSON.stringify({
      source: skill.path,
      project: skill.projectName,
      skill: skill.name,
      installedAt: new Date().toISOString(),
    }, null, 2), "utf8");
    installed.push({ name: skill.name, projectName: skill.projectName, key: skill.key, targetName, targetPath });
  }

  await writeFile(manifestPath, JSON.stringify({
    projectsRoot,
    legacySkillsRoot,
    updatedAt: new Date().toISOString(),
    managedTargets: installed.map((item) => item.targetName),
  }, null, 2), "utf8");

  return { installed, skipped, removed };
}

export async function runSyncOnce(syncConfig, reason = "manual") {
  console.log(`[richie-sync] start (${reason})`);

  const pull = await pullLatest(syncConfig);
  if (pull.skipped) {
    console.log(`[richie-sync] git pull skipped: ${pull.message}`);
  } else if (pull.ok) {
    console.log(`[richie-sync] git pull ok: ${pull.message}`);
  } else {
    console.warn(`[richie-sync] git pull failed: ${pull.message}`);
  }

  const install = await installCodexSkills(syncConfig);
  console.log(
    `[richie-sync] skills installed=${install.installed.length} skipped=${install.skipped.length} removed=${install.removed.length}`,
  );

  for (const item of install.skipped) {
    console.warn(`[richie-sync] skipped skill ${item.name}: ${item.reason}`);
  }

  return { pull, install };
}

export function startGitSync(syncConfig) {
  if (!syncConfig.enabled) {
    console.log("[richie-sync] disabled");
    return { stop() {} };
  }

  let inFlight = false;
  let stopped = false;
  const run = async (reason) => {
    if (inFlight || stopped) {
      return;
    }
    inFlight = true;
    try {
      await runSyncOnce(syncConfig, reason);
    } catch (error) {
      console.warn("[richie-sync] unexpected failure", error);
    } finally {
      inFlight = false;
    }
  };

  void run("startup");
  const timer = setInterval(() => {
    void run("interval");
  }, syncConfig.intervalMs);

  console.log(`[richie-sync] scheduled every ${Math.round(syncConfig.intervalMs / 1000)} seconds`);

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
