import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const managedMarkerName = ".richie-managed";
const managedManifestName = ".richie-managed.json";
const projectRepoManifestName = "richie-project-repos.json";

function resolveLocalPath(value) {
  return path.isAbsolute(value) ? value : path.join(projectRoot, value);
}

function isValidSkillTargetName(name) {
  return Boolean(name) && name !== "." && name !== ".." && !/[<>:"/\\|?*\x00-\x1F]/.test(name);
}

function isValidProjectDirectoryName(name) {
  return isValidSkillTargetName(name) && !name.startsWith(".") && !name.startsWith("_");
}

function assertInside(parent, child) {
  const parentPath = path.resolve(parent);
  const childPath = path.resolve(child);
  if (childPath !== parentPath && !childPath.startsWith(`${parentPath}${path.sep}`)) {
    throw new Error(`Refusing to write outside ${parentPath}: ${childPath}`);
  }
}

function runCommand(command, args, { cwd = projectRoot, timeoutMs = 120000, input = "" } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
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

    if (input) {
      child.stdin.write(input);
    }
    child.stdin.end();
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

function projectRepoManifestPath() {
  return path.join(projectRoot, "logs", projectRepoManifestName);
}

async function readProjectRepoManifest() {
  const manifest = await readJson(projectRepoManifestPath(), { repositories: [] });
  const repositories = Array.isArray(manifest.repositories) ? manifest.repositories : [];
  return { repositories };
}

async function writeProjectRepoManifest(repositories) {
  const manifestPath = projectRepoManifestPath();
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify({
    updatedAt: new Date().toISOString(),
    repositories,
  }, null, 2), "utf8");
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

async function scanSkillDirectory({ skillsRoot, projectName, projectPath, projectTitle }) {
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
    });
  }

  return skills;
}

function getProjectRoots(syncConfig) {
  const configured = Array.isArray(syncConfig.projectRoots) && syncConfig.projectRoots.length > 0
    ? syncConfig.projectRoots
    : [".."];
  return [...new Set(configured.map(resolveLocalPath).map((item) => path.resolve(item)))];
}

function getCloneRoot(syncConfig, projectRoots) {
  return path.resolve(resolveLocalPath(syncConfig.githubProjectCloneRoot || projectRoots[0] || ".."));
}

async function hasRichieProjectMarkers(projectPath) {
  return await pathExists(path.join(projectPath, "PROJECT.md"))
    || await pathExists(path.join(projectPath, "skills"));
}

function parseGitHubRepositorySpec(value, defaultOwner = "") {
  const raw = (value || "").trim();
  if (!raw) {
    return undefined;
  }

  let match = raw.match(/^https?:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/i)
    || raw.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i)
    || raw.match(/^([^/\s]+)\/([^/\s]+)$/);

  if (!match && defaultOwner && /^[A-Za-z0-9_.-]+$/.test(raw)) {
    match = [raw, defaultOwner, raw];
  }

  if (!match) {
    return undefined;
  }

  const owner = match[1].trim();
  const name = match[2].trim().replace(/\.git$/i, "");
  if (!owner || !name) {
    return undefined;
  }

  return {
    owner,
    name,
    fullName: `${owner}/${name}`,
    cloneUrl: `https://github.com/${owner}/${name}.git`,
  };
}

async function getCurrentRepository(syncConfig) {
  const remote = syncConfig.remote || "origin";
  const result = await runCommand("git", ["remote", "get-url", remote], { timeoutMs: 10000 });
  if (result.code !== 0) {
    return undefined;
  }
  return parseGitHubRepositorySpec(result.stdout.trim());
}

async function getGitHubTokenFromCredentialManager() {
  const result = await runCommand("git", ["credential", "fill"], {
    input: "protocol=https\nhost=github.com\n\n",
    timeoutMs: 10000,
  });
  if (result.code !== 0) {
    return "";
  }

  const passwordLine = result.stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith("password="));
  return passwordLine?.slice("password=".length).trim() || "";
}

async function getGitHubToken() {
  return process.env.GITHUB_TOKEN?.trim()
    || process.env.GH_TOKEN?.trim()
    || await getGitHubTokenFromCredentialManager();
}

async function fetchGitHubJson(url, token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "richie-feishu-dispatcher",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`GitHub API ${response.status} ${response.statusText}: ${body.slice(0, 200)}`);
  }
  return response.json();
}

async function discoverGitHubRepositories(syncConfig, currentRepository) {
  const defaultOwner = syncConfig.githubProjectOwner || currentRepository?.owner || "";
  const explicitRepos = (syncConfig.githubProjectRepos || [])
    .map((item) => parseGitHubRepositorySpec(item, defaultOwner))
    .map((repo) => repo ? { ...repo, explicit: true } : repo)
    .filter(Boolean);
  const repos = [...explicitRepos];

  if (syncConfig.githubAutoDiscoverProjectRepos && defaultOwner) {
    const token = await getGitHubToken();
    const discovered = [];

    if (token) {
      for (let page = 1; page <= 10; page += 1) {
        const url = `https://api.github.com/user/repos?per_page=100&page=${page}&affiliation=owner,collaborator,organization_member&sort=updated`;
        const batch = await fetchGitHubJson(url, token);
        if (!Array.isArray(batch) || batch.length === 0) {
          break;
        }
        discovered.push(...batch);
      }
    } else {
      for (let page = 1; page <= 10; page += 1) {
        const url = `https://api.github.com/users/${encodeURIComponent(defaultOwner)}/repos?per_page=100&page=${page}&sort=updated`;
        const batch = await fetchGitHubJson(url, "");
        if (!Array.isArray(batch) || batch.length === 0) {
          break;
        }
        discovered.push(...batch);
      }
    }

    for (const repo of discovered) {
      const owner = repo.owner?.login || "";
      const name = repo.name || "";
      if (!owner || !name || owner.toLowerCase() !== defaultOwner.toLowerCase()) {
        continue;
      }
      repos.push({
        owner,
        name,
        fullName: `${owner}/${name}`,
        cloneUrl: repo.clone_url || `https://github.com/${owner}/${name}.git`,
        explicit: false,
      });
    }
  }

  const currentFullName = currentRepository?.fullName?.toLowerCase();
  const seen = new Set();
  return repos.filter((repo) => {
    const fullName = repo.fullName.toLowerCase();
    if (fullName === currentFullName || seen.has(fullName)) {
      return false;
    }
    seen.add(fullName);
    return true;
  });
}

async function syncGitHubProjectRepositories(syncConfig) {
  const projectRoots = getProjectRoots(syncConfig);
  const cloneRoot = getCloneRoot(syncConfig, projectRoots);
  const currentRepository = await getCurrentRepository(syncConfig);
  const manifest = await readProjectRepoManifest();
  const managedRepositories = new Map(manifest.repositories.map((repo) => [repo.fullName?.toLowerCase(), repo]));
  const managedPaths = new Set(manifest.repositories
    .map((repo) => repo.targetPath ? path.resolve(repo.targetPath) : "")
    .filter(Boolean));
  const results = [];

  if (!syncConfig.githubAutoDiscoverProjectRepos && (!syncConfig.githubProjectRepos || syncConfig.githubProjectRepos.length === 0)) {
    return { cloneRoot, repositories: [], results };
  }

  await mkdir(cloneRoot, { recursive: true });

  let repositories = [];
  try {
    repositories = await discoverGitHubRepositories(syncConfig, currentRepository);
  } catch (error) {
    results.push({
      repository: syncConfig.githubProjectOwner || currentRepository?.owner || "GitHub",
      action: "discover",
      ok: false,
      message: error.message,
    });
    return { cloneRoot, repositories: [], results };
  }

  for (const repo of repositories) {
    if (!isValidProjectDirectoryName(repo.name)) {
      results.push({
        repository: repo.fullName,
        action: "skip",
        skipped: true,
        message: `invalid local directory name '${repo.name}'`,
      });
      continue;
    }

    const targetPath = path.join(cloneRoot, repo.name);
    assertInside(cloneRoot, targetPath);

    if (path.resolve(targetPath) === projectRoot) {
      results.push({
        repository: repo.fullName,
        targetPath,
        action: "skip",
        skipped: true,
        message: "target path is dispatcher root",
      });
      continue;
    }

    if (!(await pathExists(targetPath))) {
      const clone = await runCommand("git", ["clone", "--depth", "1", "--filter=blob:none", repo.cloneUrl, targetPath], {
        cwd: cloneRoot,
        timeoutMs: 300000,
      });
      if (clone.code !== 0) {
        results.push({
          repository: repo.fullName,
          targetPath,
          action: "clone",
          ok: false,
          message: (clone.stderr || clone.stdout || "git clone failed").trim(),
        });
        continue;
      }
      results.push({
        repository: repo.fullName,
        targetPath,
        action: "clone",
        ok: true,
        message: (clone.stdout || "cloned").trim(),
      });
      managedRepositories.set(repo.fullName.toLowerCase(), {
        fullName: repo.fullName,
        targetPath,
        clonedAt: new Date().toISOString(),
      });
      continue;
    }

    if (!existsSync(path.join(targetPath, ".git"))) {
      results.push({
        repository: repo.fullName,
        targetPath,
        action: "skip",
        skipped: true,
        message: "local path exists but is not a git repository",
      });
      continue;
    }

    const targetIsManaged = managedRepositories.has(repo.fullName.toLowerCase()) || managedPaths.has(path.resolve(targetPath));
    if (!repo.explicit && !targetIsManaged && !(await hasRichieProjectMarkers(targetPath))) {
      results.push({
        repository: repo.fullName,
        targetPath,
        action: "skip",
        skipped: true,
        message: "local repo exists but has no richie project markers; leaving it untouched",
      });
      continue;
    }

    const pull = await runCommand("git", ["pull", "--ff-only"], {
      cwd: targetPath,
      timeoutMs: 120000,
    });
    if (pull.code !== 0) {
      results.push({
        repository: repo.fullName,
        targetPath,
        action: "pull",
        ok: false,
        message: (pull.stderr || pull.stdout || "git pull failed").trim(),
      });
      continue;
    }
    results.push({
      repository: repo.fullName,
      targetPath,
      action: "pull",
      ok: true,
      message: (pull.stdout || "Already up to date.").trim(),
    });
    managedRepositories.set(repo.fullName.toLowerCase(), {
      fullName: repo.fullName,
      targetPath,
      clonedAt: managedRepositories.get(repo.fullName.toLowerCase())?.clonedAt,
      updatedAt: new Date().toISOString(),
    });
  }

  await writeProjectRepoManifest([...managedRepositories.values()]);

  return { cloneRoot, repositories, results };
}

async function listSiblingProjects(syncConfig) {
  const projectRoots = getProjectRoots(syncConfig);
  const projects = [];
  const dispatcherRoot = path.resolve(projectRoot);
  const seen = new Set();

  for (const projectRootPath of projectRoots) {
    await mkdir(projectRootPath, { recursive: true });
    const entries = await readdir(projectRootPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() || !isValidProjectDirectoryName(entry.name)) {
        continue;
      }

      const projectPath = path.resolve(projectRootPath, entry.name);
      if (projectPath === dispatcherRoot || seen.has(projectPath)) {
        continue;
      }

      const projectMdPath = path.join(projectPath, "PROJECT.md");
      const skillsRoot = path.join(projectPath, "skills");
      if (!(await pathExists(projectMdPath)) && !(await pathExists(skillsRoot))) {
        continue;
      }

      seen.add(projectPath);
      const projectSummary = await summarizeMarkdownFile(projectMdPath);
      projects.push({
        name: entry.name,
        path: projectPath,
        title: projectSummary.title || entry.name,
        skillsRoot,
      });
    }
  }

  return { projectRoots, projects };
}

export async function listRepositorySkills(syncConfig) {
  const { projectRoots, projects } = await listSiblingProjects(syncConfig);
  const skills = [];

  for (const project of projects) {
    skills.push(...await scanSkillDirectory({
      skillsRoot: project.skillsRoot,
      projectName: project.name,
      projectPath: project.path,
      projectTitle: project.title,
    }));
  }

  return { projectRoots, projects, skills };
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

async function pullSiblingProjects(syncConfig, excludedPaths = new Set()) {
  const { projects } = await listSiblingProjects(syncConfig);
  const results = [];

  for (const project of projects) {
    if (excludedPaths.has(path.resolve(project.path))) {
      continue;
    }

    if (!existsSync(path.join(project.path, ".git"))) {
      results.push({ project: project.name, skipped: true, message: "not a git repository" });
      continue;
    }

    const result = await runCommand("git", ["pull", "--ff-only"], {
      cwd: project.path,
      timeoutMs: 120000,
    });

    if (result.code !== 0) {
      results.push({
        project: project.name,
        skipped: false,
        ok: false,
        message: (result.stderr || result.stdout || "git pull failed").trim(),
      });
      continue;
    }

    results.push({
      project: project.name,
      skipped: false,
      ok: true,
      message: (result.stdout || "Already up to date.").trim(),
    });
  }

  return results;
}

async function installCodexSkills(syncConfig) {
  if (!syncConfig.installCodexSkills) {
    return { installed: [], skipped: [], removed: [], message: "Codex skill install disabled" };
  }

  const targetRoot = resolveLocalPath(syncConfig.codexSkillsDir);
  await mkdir(targetRoot, { recursive: true });

  const { projectRoots, skills } = await listRepositorySkills(syncConfig);
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
    projectRoots,
    updatedAt: new Date().toISOString(),
    managedTargets: installed.map((item) => item.targetName),
  }, null, 2), "utf8");

  return { installed, skipped, removed };
}

export async function runSyncOnce(syncConfig, reason = "manual") {
  console.log(`[richie-sync] start (${reason})`);

  const pull = await pullLatest(syncConfig);
  if (pull.skipped) {
    console.log(`[richie-sync] dispatcher git pull skipped: ${pull.message}`);
  } else if (pull.ok) {
    console.log(`[richie-sync] dispatcher git pull ok: ${pull.message}`);
  } else {
    console.warn(`[richie-sync] dispatcher git pull failed: ${pull.message}`);
  }

  const githubProjectSync = await syncGitHubProjectRepositories(syncConfig);
  const githubSyncedPaths = new Set();
  for (const item of githubProjectSync.results) {
    if (item.targetPath) {
      githubSyncedPaths.add(path.resolve(item.targetPath));
    }
    const label = item.repository || item.project || "project repo";
    if (item.skipped) {
      console.log(`[richie-sync] GitHub ${label} ${item.action} skipped: ${item.message}`);
    } else if (item.ok) {
      console.log(`[richie-sync] GitHub ${label} ${item.action} ok: ${item.message}`);
    } else {
      console.warn(`[richie-sync] GitHub ${label} ${item.action} failed: ${item.message}`);
    }
  }

  const projectPulls = await pullSiblingProjects(syncConfig, githubSyncedPaths);
  for (const projectPull of projectPulls) {
    if (projectPull.skipped) {
      console.log(`[richie-sync] project ${projectPull.project} pull skipped: ${projectPull.message}`);
    } else if (projectPull.ok) {
      console.log(`[richie-sync] project ${projectPull.project} pull ok: ${projectPull.message}`);
    } else {
      console.warn(`[richie-sync] project ${projectPull.project} pull failed: ${projectPull.message}`);
    }
  }

  const install = await installCodexSkills(syncConfig);
  console.log(
    `[richie-sync] skills installed=${install.installed.length} skipped=${install.skipped.length} removed=${install.removed.length}`,
  );

  for (const item of install.skipped) {
    console.warn(`[richie-sync] skipped skill ${item.name}: ${item.reason}`);
  }

  return { pull, githubProjectSync, projectPulls, install };
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
