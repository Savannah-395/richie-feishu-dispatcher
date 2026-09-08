import assert from "node:assert/strict";
import test from "node:test";

import {
  extractFeishuDocumentUrls,
  loadTaskIntakeDocumentContext,
} from "../src/document-context.js";

function fakeClient({ getNode, getDocument, listBlocks }) {
  return {
    wiki: {
      v2: {
        space: {
          getNode,
        },
      },
    },
    docx: {
      v1: {
        document: {
          get: getDocument,
        },
        documentBlock: {
          list: listBlocks,
        },
      },
    },
  };
}

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

test("task intake fetches Wiki-backed Docx blocks through the native bot client", async () => {
  const calls = [];
  const client = fakeClient({
    getNode: async (payload) => {
      calls.push(["wiki", payload]);
      return {
        code: 0,
        data: {
          node: {
            obj_token: "doc_1",
            obj_type: "docx",
            title: "会议纪要",
          },
        },
      };
    },
    getDocument: async (payload) => {
      calls.push(["document", payload]);
      return {
        code: 0,
        data: {
          document: {
            document_id: "doc_1",
            revision_id: 13,
            title: "会议纪要",
          },
        },
      };
    },
    listBlocks: async (payload) => {
      calls.push(["blocks", payload]);
      if (!payload.params.page_token) {
        return {
          code: 0,
          data: {
            has_more: true,
            page_token: "next-page",
            items: [{
              block_id: "heading",
              parent_id: "doc_1",
              block_type: 3,
              heading1: {
                elements: [{ text_run: { content: "九、待办" } }],
              },
            }],
          },
        };
      }
      return {
        code: 0,
        data: {
          has_more: false,
          items: [{
            block_id: "task",
            parent_id: "doc_1",
            block_type: 13,
            ordered: {
              elements: [
                { text_run: { content: "吃五颗糖" } },
                { mention_user: { user_id: "ou_owner" } },
              ],
            },
          }],
        },
      };
    },
  });

  const result = await loadTaskIntakeDocumentContext(
    "https://global-intco.feishu.cn/wiki/A5aQwuZvViriiskJmUlccSV1nEe?from=from_copylink @Richie",
    { client },
  );

  assert.equal(result.errors.length, 0);
  assert.equal(calls[0][0], "wiki");
  assert.equal(calls[0][1].params.token, "A5aQwuZvViriiskJmUlccSV1nEe");
  assert.equal(calls.filter(([kind]) => kind === "blocks").length, 2);
  assert.equal(calls[2][1].params.user_id_type, "open_id");
  assert.equal(calls[3][1].params.page_token, "next-page");
  assert.match(result.context, /dispatcher_fetched_feishu_documents/);
  assert.match(result.context, /identity="bot"/);
  assert.match(result.context, /title="会议纪要"/);
  assert.match(result.context, /<h1[^>]*>九、待办<\/h1>/);
  assert.match(result.context, /<li[^>]*kind="ordered">吃五颗糖<cite type="user" user-id="ou_owner"><\/cite><\/li>/);
});

test("direct Docx links do not require Wiki resolution", async () => {
  let wikiCalls = 0;
  const client = fakeClient({
    getNode: async () => {
      wikiCalls += 1;
      throw new Error("unexpected Wiki request");
    },
    getDocument: async ({ path }) => ({
      code: 0,
      data: {
        document: {
          document_id: path.document_id,
          revision_id: 7,
          title: "直接文档",
        },
      },
    }),
    listBlocks: async () => ({
      code: 0,
      data: {
        has_more: false,
        items: [{
          block_id: "paragraph",
          block_type: 2,
          text: { elements: [{ text_run: { content: "完成测试" } }] },
        }],
      },
    }),
  });

  const result = await loadTaskIntakeDocumentContext(
    "https://global-intco.feishu.cn/docx/DoxcnAbc_123",
    { client },
  );

  assert.equal(wikiCalls, 0);
  assert.equal(result.errors.length, 0);
  assert.equal(result.documents[0].documentId, "DoxcnAbc_123");
  assert.match(result.context, /完成测试/);
});

test("real native API errors are retained instead of being mislabeled as permission errors", async () => {
  const client = fakeClient({
    getNode: async () => ({
      code: 99991672,
      msg: "missing wiki scope",
      error: { log_id: "log_1" },
    }),
    getDocument: async () => {
      throw new Error("unexpected document request");
    },
    listBlocks: async () => {
      throw new Error("unexpected block request");
    },
  });

  const result = await loadTaskIntakeDocumentContext(
    "https://global-intco.feishu.cn/wiki/A5aQwuZvViriiskJmUlccSV1nEe",
    { client },
  );

  assert.equal(result.documents.length, 0);
  assert.equal(result.errors[0].code, 99991672);
  assert.match(result.errors[0].message, /解析 Wiki 节点/);
  assert.match(result.errors[0].message, /missing wiki scope/);
  assert.doesNotMatch(result.errors[0].message, /请授予 Richie 访问权限/);
  assert.doesNotMatch(result.errors[0].message, /spawn lark-cli/);
});
