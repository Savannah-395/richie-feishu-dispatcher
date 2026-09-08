import assert from "node:assert/strict";
import test from "node:test";

import {
  extractFeishuDocumentUrls,
  loadTaskIntakeDocumentContext,
} from "../src/document-context.js";

test("Feishu document URLs are canonicalized without mention text or tracking query", () => {
  assert.deepEqual(extractFeishuDocumentUrls([
    "https://global-intco.feishu.cn/wiki/A5aQwuZvViriiskJmUlccSV1nEe?from=from_copylink@Richie",
    "https://global-intco.feishu.cn/docx/DoxcnAbc_123#share-x",
    "https://example.com/wiki/not-trusted",
  ].join("\n")), [
    "https://global-intco.feishu.cn/wiki/A5aQwuZvViriiskJmUlccSV1nEe",
    "https://global-intco.feishu.cn/docx/DoxcnAbc_123",
  ]);
});

test("task intake fetches linked docs as the Richie bot and preserves user cite metadata", async () => {
  const calls = [];
  const result = await loadTaskIntakeDocumentContext(
    "https://global-intco.feishu.cn/wiki/A5aQwuZvViriiskJmUlccSV1nEe?from=from_copylink @Richie",
    {
      runCli: async (args) => {
        calls.push(args);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            identity: "bot",
            data: {
              document: {
                document_id: "doc_1",
                revision_id: 13,
                content: "<h1>九、待办</h1><li>吃五颗糖<cite type=\"user\" user-id=\"ou_owner\"></cite></li>",
              },
            },
          }),
          stderr: "",
          timedOut: false,
          outputTooLarge: false,
          spawnError: null,
        };
      },
    },
  );

  assert.deepEqual(calls, [[
    "docs",
    "+fetch",
    "--as",
    "bot",
    "--doc",
    "https://global-intco.feishu.cn/wiki/A5aQwuZvViriiskJmUlccSV1nEe",
    "--detail",
    "full",
  ]]);
  assert.equal(result.errors.length, 0);
  assert.match(result.context, /dispatcher_fetched_feishu_documents/);
  assert.match(result.context, /identity="bot"/);
  assert.match(result.context, /九、待办/);
  assert.match(result.context, /user-id="ou_owner"/);
});

test("real document fetch errors are retained instead of being mislabeled as permission errors", async () => {
  const result = await loadTaskIntakeDocumentContext(
    "https://global-intco.feishu.cn/wiki/A5aQwuZvViriiskJmUlccSV1nEe",
    {
      runCli: async () => ({
        exitCode: 3,
        stdout: JSON.stringify({
          ok: false,
          identity: "bot",
          error: { code: 99991672, subtype: "app_scope_not_applied", message: "missing docs scope" },
        }),
        stderr: "",
        timedOut: false,
        outputTooLarge: false,
        spawnError: null,
      }),
    },
  );

  assert.equal(result.documents.length, 0);
  assert.equal(result.errors[0].code, 99991672);
  assert.match(result.errors[0].message, /missing docs scope/);
  assert.doesNotMatch(result.errors[0].message, /请授予 Richie 访问权限/);
});
