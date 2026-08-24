import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registryPath = path.join(projectRoot, "data", "product-information-channels.json");
const supportedRegions = new Set(["europe", "us"]);
const supportedFormats = new Set(["json", "markdown"]);

async function loadRegistry() {
  return JSON.parse(await readFile(registryPath, "utf8"));
}

function validateRegistry(registry) {
  const errors = [];
  const methodIds = new Set(Object.keys(registry.access_methods || {}));
  const platformIds = new Set();
  const channelIds = new Set();

  if (!Array.isArray(registry.platforms) || registry.platforms.length === 0) {
    errors.push("platforms must be a non-empty array");
  }
  if (!Array.isArray(registry.channels) || registry.channels.length === 0) {
    errors.push("channels must be a non-empty array");
  }

  for (const platform of registry.platforms || []) {
    if (!platform.id || platformIds.has(platform.id)) {
      errors.push(`platform id must be present and unique: ${platform.id || "<missing>"}`);
    }
    platformIds.add(platform.id);
    if (!methodIds.has(platform.access_method)) {
      errors.push(`platform ${platform.id} has unknown access method: ${platform.access_method}`);
    }
    if (!Array.isArray(platform.evidence) || platform.evidence.length === 0) {
      errors.push(`platform ${platform.id} must have evidence`);
    }
    for (const evidence of platform.evidence || []) {
      try {
        const url = new URL(evidence.url);
        if (url.protocol !== "https:") {
          errors.push(`platform ${platform.id} evidence must use https: ${evidence.url}`);
        }
      } catch {
        errors.push(`platform ${platform.id} has invalid evidence URL: ${evidence.url || "<missing>"}`);
      }
    }
  }

  for (const channel of registry.channels || []) {
    if (!channel.id || channelIds.has(channel.id)) {
      errors.push(`channel id must be present and unique: ${channel.id || "<missing>"}`);
    }
    channelIds.add(channel.id);
    if (!platformIds.has(channel.platform_id)) {
      errors.push(`channel ${channel.id} references unknown platform: ${channel.platform_id}`);
    }
    if (!supportedRegions.has(channel.region)) {
      errors.push(`channel ${channel.id} has unsupported region: ${channel.region}`);
    }
    if (!channel.domain || !Array.isArray(channel.country_codes) || channel.country_codes.length === 0) {
      errors.push(`channel ${channel.id} must include domain and country_codes`);
    }
  }

  return errors;
}

function queryChannels(registry, { region, channel }) {
  const platforms = new Map(registry.platforms.map((item) => [item.id, item]));
  const channels = registry.channels
    .filter((item) => !region || item.region === region)
    .filter((item) => !channel || item.id === channel)
    .map((item) => ({ ...item, platform: platforms.get(item.platform_id) }));

  return {
    schema_version: registry.schema_version,
    researched_at: registry.researched_at,
    filters: { region: region || null, channel: channel || null },
    scope: registry.scope,
    normalized_product_fields: registry.normalized_product_fields,
    access_methods: registry.access_methods,
    channel_count: channels.length,
    channels,
  };
}

function escapeMarkdown(value) {
  return `${value}`.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function renderMarkdown(result) {
  const lines = [
    "# Product information channel research",
    "",
    `Research date: ${result.researched_at}`,
    "",
    `Channels: ${result.channel_count}`,
    "",
    "| Channel | Region | Domain | Recommended access | API status | SPC wall panel relevance |",
    "| --- | --- | --- | --- | --- | --- |",
  ];

  for (const channel of result.channels) {
    lines.push(`| ${escapeMarkdown(channel.display_name)} | ${channel.region} | ${channel.domain} | ${channel.platform.access_method} | ${channel.platform.api_status} | ${channel.spc_wall_panel_relevance} |`);
  }

  for (const channel of result.channels) {
    lines.push(
      "",
      `## ${channel.display_name}`,
      "",
      `- Channel ID: \`${channel.id}\``,
      `- Access requirements: ${channel.platform.access_requirements}`,
      `- Catalog scope: ${channel.platform.catalog_scope.join("; ")}`,
      `- Limitations: ${channel.platform.limitations.join("; ")}`,
      "- Evidence:",
      ...channel.platform.evidence.map((item) => `  - [${item.kind}](${item.url}) (${item.verification}): ${item.note}`),
    );
  }

  return `${lines.join("\n")}\n`;
}

function parseArgs(args) {
  const options = { format: "json" };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (!["--region", "--channel", "--format"].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${argument}`);
    }
    index += 1;
    options[argument.slice(2)] = value.toLowerCase();
  }

  if (options.region && !supportedRegions.has(options.region)) {
    throw new Error(`Unsupported region: ${options.region}. Expected europe or us.`);
  }
  if (!supportedFormats.has(options.format)) {
    throw new Error(`Unsupported format: ${options.format}. Expected json or markdown.`);
  }
  return options;
}

function printHelp() {
  console.log([
    "Usage: node src/product-channel-research.js [options]",
    "",
    "Options:",
    "  --region europe|us       Filter by region",
    "  --channel <channel-id>   Filter by exact channel ID",
    "  --format json|markdown   Output format (default: json)",
    "  --help                   Show this help",
  ].join("\n"));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const registry = await loadRegistry();
  const errors = validateRegistry(registry);
  if (errors.length > 0) {
    throw new Error(`Invalid product channel registry:\n- ${errors.join("\n- ")}`);
  }

  const result = queryChannels(registry, options);
  if (result.channel_count === 0) {
    throw new Error("No product information channels matched the supplied filters.");
  }

  process.stdout.write(options.format === "markdown"
    ? renderMarkdown(result)
    : `${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 2;
});
