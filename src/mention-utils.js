function asText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function mentionOpenId(mention) {
  return asText(
    mention?.openId
      || mention?.open_id
      || mention?.id?.open_id
      || mention?.id?.openId,
  );
}

function rawMessageMentions(message) {
  const raw = message?.raw || {};
  return raw?.event?.message?.mentions
    || raw?.message?.mentions
    || [];
}

export function buildStructuredMentions(message, botOpenId = "") {
  const normalized = Array.isArray(message?.mentions) ? message.mentions : [];
  const raw = rawMessageMentions(message);
  const rawByKey = new Map(raw.map((mention) => [asText(mention?.key), mention]));
  const source = normalized.length > 0 ? normalized : raw;

  return source.map((mention) => {
    const rawMention = rawByKey.get(asText(mention?.key));
    const openId = mentionOpenId(mention) || mentionOpenId(rawMention);
    return {
      key: asText(mention?.key || rawMention?.key),
      name: asText(mention?.name || rawMention?.name),
      open_id: openId,
      is_bot: mention?.isBot === true || Boolean(openId && openId === botOpenId),
    };
  });
}

