import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(projectRoot, "src", "product-channel-research.js");

async function runCli(args = []) {
  return execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
  });
}

test("outputs all supplied Europe and US channels as structured JSON", async () => {
  const { stdout, stderr } = await runCli();
  const result = JSON.parse(stdout);

  assert.equal(stderr, "");
  assert.equal(result.channel_count, 33);
  assert.equal(result.channels.filter((item) => item.region === "europe").length, 17);
  assert.equal(result.channels.filter((item) => item.region === "us").length, 16);
  assert.ok(result.normalized_product_fields.includes("dimensions"));
  assert.ok(result.normalized_product_fields.includes("images"));
  assert.ok(result.normalized_product_fields.includes("raw_attributes"));
});

test("filters Europe and joins platform access research into every channel", async () => {
  const { stdout } = await runCli(["--region", "EUROPE"]);
  const result = JSON.parse(stdout);

  assert.equal(result.channel_count, 17);
  assert.ok(result.channels.every((item) => item.region === "europe"));
  assert.ok(result.channels.every((item) => item.platform?.access_method));
  assert.ok(result.channels.every((item) => item.platform?.evidence?.[0]?.url.startsWith("https://")));
});

test("returns one exact channel with its evidence and access restrictions", async () => {
  const { stdout } = await runCli(["--channel", "amazon-us"]);
  const result = JSON.parse(stdout);

  assert.equal(result.channel_count, 1);
  assert.equal(result.channels[0].id, "amazon-us");
  assert.equal(result.channels[0].platform.access_method, "affiliate_catalog_api");
  assert.match(result.channels[0].platform.access_requirements, /Amazon Associates/);
  assert.match(result.channels[0].platform.evidence[0].url, /affiliate-program\.amazon\.com/);
});

test("renders Markdown with access decisions and evidence links", async () => {
  const { stdout } = await runCli(["--channel", "ebay-us", "--format", "markdown"]);

  assert.match(stdout, /# Product information channel research/);
  assert.match(stdout, /developer_catalog_api/);
  assert.match(stdout, /developer\.ebay\.com/);
  assert.match(stdout, /SPC wall panel relevance/);
});

test("rejects unsupported filters and empty results with exit code 2", async () => {
  await assert.rejects(
    runCli(["--region", "asia"]),
    (error) => error.code === 2 && /Unsupported region/.test(error.stderr),
  );
  await assert.rejects(
    runCli(["--format", "csv"]),
    (error) => error.code === 2 && /Unsupported format/.test(error.stderr),
  );
  await assert.rejects(
    runCli(["--channel", "missing-channel"]),
    (error) => error.code === 2 && /No product information channels matched/.test(error.stderr),
  );
});
