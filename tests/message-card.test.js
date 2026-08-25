import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildMessageCards,
  extractSourceSection,
  parseInteractiveCard,
  splitCardContent,
} from "../src/message-card.js";

test("generic Richie cards keep the stable input, reply and source structure", () => {
  const [card] = buildMessageCards({
    title: "Richie · 需要确认",
    input: "调研 Walmart US SPC 墙板 Top20",
    content: "请确认严格只要 SPC，还是允许相关材质参照。",
    source: "尚未调用 API；基于用户输入与 INTCO 产品图谱整理。",
    tone: "warning",
  });

  assert.equal(card.schema, "2.0");
  assert.equal(card.header.template, "orange");
  assert.equal(card.header.subtitle.content, "Richie · 智能调研助手");
  const elements = card.body.elements;
  assert.match(elements[0].content, /本次输入/);
  assert.match(elements[1].content, /Richie 回复/);
  assert.equal(elements.at(-2).tag, "hr");
  assert.equal(elements.at(-1).text_size, "caption");
  assert.match(elements.at(-1).content, /grey-500/);
  assert.match(elements.at(-1).content, /来源与口径/);
});

test("dispatcher prompt cannot replace a native candidate card with a preview image", async () => {
  const source = await readFile(new URL("../src/codex-runner.js", import.meta.url), "utf8");
  assert.match(source, /Never substitute a PNG\/JPG preview/);
  assert.match(source, /use that project's card builder and topic-reply sender/);
  assert.doesNotMatch(source, /Use PNG\/JPG for screenshots or image previews/);
});

test("a trailing source section is separated from the reply body", () => {
  const parsed = extractSourceSection(
    "候选已整理完成。\n\n来源口径：OpenWeb Ninja Walmart 专用 API；Best Seller 位次，不代表销量。",
    "fallback",
  );
  assert.equal(parsed.content, "候选已整理完成。");
  assert.match(parsed.source, /Walmart 专用 API/);
});

test("complete Card 2.0 payloads pass through without being flattened", () => {
  const card = {
    schema: "2.0",
    body: { elements: [{ tag: "markdown", content: "candidate" }] },
  };
  assert.deepEqual(parseInteractiveCard(JSON.stringify(card)), card);
  assert.deepEqual(buildMessageCards({ content: JSON.stringify(card) }), [card]);
});

test("long replies are split below the card byte budget", () => {
  const chunks = splitCardContent("墙板".repeat(10_000), 1_000);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 1_000));
});

test("dispatcher has no direct text or markdown response payload", async () => {
  const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\{\s*text\s*:/);
  assert.doesNotMatch(source, /\{\s*markdown\s*:/);
  assert.doesNotMatch(source, /\{\s*file\s*:/);
  assert.doesNotMatch(source, /\{\s*image\s*:/);
  assert.match(source, /rawClient\.im\.v1\.message\.reply/);
  assert.match(source, /msg_type: "interactive"/);
  assert.match(source, /reply_in_thread: replyInThread/);
});

test("independent topics in the same chat are not serialized by the SDK", async () => {
  const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
  assert.match(source, /safety:\s*\{\s*chatQueue:\s*\{\s*enabled:\s*false\s*\}/);
});
