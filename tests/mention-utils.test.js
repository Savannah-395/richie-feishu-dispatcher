import assert from "node:assert/strict";
import test from "node:test";

import { buildStructuredMentions } from "../src/mention-utils.js";

test("structured mentions recover open_id from the trusted raw Feishu event", () => {
  const mentions = buildStructuredMentions({
    mentions: [
      { key: "@_user_1", name: "段星岚" },
      { key: "@_user_2", name: "Richie", isBot: true },
    ],
    raw: {
      message: {
        mentions: [
          { key: "@_user_1", name: "段星岚", id: { open_id: "ou_owner" } },
          { key: "@_user_2", name: "Richie", id: { open_id: "ou_bot" } },
        ],
      },
    },
  }, "ou_bot");

  assert.deepEqual(mentions, [
    { key: "@_user_1", name: "段星岚", open_id: "ou_owner", is_bot: false },
    { key: "@_user_2", name: "Richie", open_id: "ou_bot", is_bot: true },
  ]);
});

test("raw mentions remain available when the SDK normalized list is absent", () => {
  const mentions = buildStructuredMentions({
    raw: {
      event: {
        message: {
          mentions: [{ key: "@_user_1", name: "颜宇", id: { open_id: "ou_second" } }],
        },
      },
    },
  });

  assert.equal(mentions[0].open_id, "ou_second");
  assert.equal(mentions[0].name, "颜宇");
});
