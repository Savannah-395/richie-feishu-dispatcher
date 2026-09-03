import assert from "node:assert/strict";
import test from "node:test";

import { isGitHubProjectExcluded } from "../src/skill-sync.js";

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
