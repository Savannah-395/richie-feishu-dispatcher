const DEFAULT_MAX_CONTENT_BYTES = 18_000;

const CARD_THEMES = {
  info: { template: "blue", tag: "回复", tagColor: "blue" },
  success: { template: "green", tag: "已完成", tagColor: "green" },
  warning: { template: "orange", tag: "待确认", tagColor: "orange" },
  error: { template: "red", tag: "未完成", tagColor: "red" },
  audit: { template: "grey", tag: "审计", tagColor: "grey" },
};

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function splitOversizedSegment(segment, maxBytes) {
  const chunks = [];
  let current = "";
  let currentBytes = 0;

  for (const character of segment) {
    const characterBytes = byteLength(character);
    if (current && currentBytes + characterBytes > maxBytes) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += character;
    currentBytes += characterBytes;
  }

  if (current) {
    chunks.push(current);
  }
  return chunks;
}

export function splitCardContent(value, maxBytes = DEFAULT_MAX_CONTENT_BYTES) {
  const text = `${value || ""}`.trim() || "已收到。";
  if (byteLength(text) <= maxBytes) {
    return [text];
  }

  const chunks = [];
  let current = "";
  const segments = text.split(/(\n{2,})/);

  const flush = () => {
    const normalized = current.trim();
    if (normalized) {
      chunks.push(normalized);
    }
    current = "";
  };

  for (const segment of segments) {
    if (byteLength(segment) > maxBytes) {
      flush();
      chunks.push(...splitOversizedSegment(segment, maxBytes).map((item) => item.trim()).filter(Boolean));
      continue;
    }

    if (current && byteLength(current + segment) > maxBytes) {
      flush();
    }
    current += segment;
  }
  flush();

  return chunks.length > 0 ? chunks : ["已收到。"];
}

function unwrapJsonFence(value) {
  const trimmed = `${value || ""}`.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

export function parseInteractiveCard(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value.schema === "2.0" && value.body?.elements ? value : undefined;
  }

  const text = unwrapJsonFence(value);
  if (!text.startsWith("{")) {
    return undefined;
  }

  try {
    const card = JSON.parse(text);
    return card?.schema === "2.0" && card?.body?.elements ? card : undefined;
  } catch {
    return undefined;
  }
}

export function extractSourceSection(value, fallbackSource = "") {
  const text = `${value || ""}`.trim();
  const sourceHeading = /^(?:#{1,6}\s*)?(?:来源与口径|来源及口径|来源口径|数据来源|来源路径)\s*[:：]\s*/gimu;
  const matches = [...text.matchAll(sourceHeading)];
  const lastMatch = matches.at(-1);

  if (!lastMatch || lastMatch.index == null) {
    return {
      content: text || "已收到。",
      source: `${fallbackSource || "未调用外部数据源。"}`.trim(),
    };
  }

  const sourceStart = lastMatch.index + lastMatch[0].length;
  const source = text.slice(sourceStart).trim();
  const content = text.slice(0, lastMatch.index).trim();
  return {
    content: content || "已收到。",
    source: source || `${fallbackSource || "未调用外部数据源。"}`.trim(),
  };
}

export function buildMessageCard({
  title = "Richie 回复",
  input = "",
  content,
  source = "未调用外部数据源。",
  tone = "info",
  page = 1,
  pageCount = 1,
} = {}) {
  const theme = CARD_THEMES[tone] || CARD_THEMES.info;
  const pageLabel = pageCount > 1 ? ` · ${page}/${pageCount}` : "";
  const summary = `${title}${pageLabel}`.slice(0, 120);

  const inputElements = `${input || ""}`.trim()
    ? [
        {
          tag: "markdown",
          element_id: `richie_input_${page}`,
          text_size: "caption",
          content: `<font color=\"grey-600\">**本次输入**\n${`${input}`.trim()}</font>`,
        },
      ]
    : [];

  return {
    schema: "2.0",
    config: {
      update_multi: true,
      width_mode: "default",
      summary: { content: summary },
      style: {
        text_size: {
          body: { default: "normal", pc: "normal", mobile: "normal" },
          caption: { default: "notation", pc: "notation", mobile: "notation" },
        },
      },
    },
    header: {
      title: { tag: "plain_text", content: summary },
      subtitle: { tag: "plain_text", content: "Richie · 智能调研助手" },
      template: theme.template,
      text_tag_list: [
        {
          tag: "text_tag",
          text: { tag: "plain_text", content: theme.tag },
          color: theme.tagColor,
        },
      ],
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 14px 12px",
      vertical_spacing: "10px",
      elements: [
        ...inputElements,
        {
          tag: "markdown",
          element_id: `richie_content_${page}`,
          text_size: "body",
          content: `**Richie 回复**\n${`${content || "已收到。"}`.trim() || "已收到。"}`,
        },
        {
          tag: "hr",
          element_id: `richie_divider_${page}`,
        },
        {
          tag: "markdown",
          element_id: `richie_source_${page}`,
          text_size: "caption",
          content: `<font color=\"grey-500\">**来源与口径**\n${`${source || "未调用外部数据源。"}`.trim()}${pageLabel}</font>`,
        },
      ],
    },
  };
}

export function buildMessageCards(options = {}) {
  const existingCard = parseInteractiveCard(options.content);
  if (existingCard) {
    return [existingCard];
  }

  const chunks = splitCardContent(options.content, options.maxContentBytes);
  return chunks.map((content, index) => buildMessageCard({
    ...options,
    content,
    page: index + 1,
    pageCount: chunks.length,
  }));
}
