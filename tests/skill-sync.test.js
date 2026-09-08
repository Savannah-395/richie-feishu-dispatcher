import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isGitHubProjectExcluded,
  isRouteActionAllowed,
  listRepositorySkillRoutes,
} from "../src/skill-sync.js";

const syncConfig = {
  githubProjectOwner: "Savannah-395",
  githubExcludedProjectRepos: [
    "spc-wall-panel-research",
    "another-owner/archived-project",
  ],
};

test("excluded GitHub projects match repository name and owner/name", () => {
  assert.equal(isGitHubProjectExcluded(syncConfig, {
    name: "spc-wall-panel-research",
    fullName: "Savannah-395/spc-wall-panel-research",
  }), true);
  assert.equal(isGitHubProjectExcluded(syncConfig, {
    name: "archived-project",
    fullName: "another-owner/archived-project",
  }), true);
});

test("non-excluded GitHub projects remain discoverable", () => {
  assert.equal(isGitHubProjectExcluded(syncConfig, {
    name: "recycled-product-research",
    fullName: "Savannah-395/recycled-product-research",
  }), false);
});

test("deployed route metadata enables the resident task-intake workflow and mention gate", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "richie-routes-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "richie-business");
  const skillDir = path.join(project, "skills", "lark-workflow-task-intake");
  const deployDir = path.join(project, "deploy", "richie");
  await mkdir(skillDir, { recursive: true });
  await mkdir(deployDir, { recursive: true });
  await writeFile(path.join(project, "PROJECT.md"), "# Richie Business\n", "utf8");
  await writeFile(path.join(skillDir, "SKILL.md"), [
    "---",
    "name: lark-workflow-task-intake",
    "description: task intake",
    "---",
  ].join("\n"), "utf8");
  await writeFile(path.join(deployDir, "allowed-chats.json"), JSON.stringify({
    routes: [{
      skill: "lark-workflow-task-intake",
      chat_ids: ["oc_test"],
      require_mention: true,
      allow_all_chat_members: true,
      authorized_actions: ["invoke", "confirm", "read", "write"],
      workflow: "task-intake",
      workflow_config: "deploy/richie/task-intake.json",
    }],
  }), "utf8");

  const { routes } = await listRepositorySkillRoutes({ projectRoots: [root] });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].requireMention, true);
  assert.equal(routes[0].workflow, "task-intake");
  assert.equal(routes[0].workflowConfigPath, path.join(deployDir, "task-intake.json"));
  assert.equal(isRouteActionAllowed(routes[0], "invoke", { chatId: "oc_test" }), true);
  assert.equal(isRouteActionAllowed(routes[0], "delete", { chatId: "oc_test" }), false);
  assert.equal(isRouteActionAllowed(routes[0], "confirm", { chatId: "oc_other" }), false);
});
