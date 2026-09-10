import assert from "node:assert/strict";
import test from "node:test";

import { parseResourcesFromContent } from "../src/attachment-manager.js";

test("Feishu image placeholders are detected regardless of label casing", () => {
  assert.deepEqual(parseResourcesFromContent([
    "![Image](img_uppercase)",
    "![image](img_lowercase)",
    '<FILE key="file_1" name="任务清单.xlsx"/>',
  ].join("\n")), [
    { type: "image", fileKey: "img_uppercase" },
    { type: "image", fileKey: "img_lowercase" },
    { type: "file", fileKey: "file_1", fileName: "任务清单.xlsx" },
  ]);
});
