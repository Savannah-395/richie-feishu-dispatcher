import OpenAI from "openai";

export function createOpenAIClient(config) {
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });
}

export async function generateThreadReply(client, config, payload) {
  const response = await client.responses.create({
    model: config.model,
    instructions: config.systemPrompt,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: [
              `当前飞书群话题 ID: ${payload.topicId}`,
              `当前发言人: ${payload.senderName}`,
              "以下是当前话题内最近的上下文，只能基于这些内容回答：",
              payload.threadTranscript || "(当前话题暂无历史上下文)",
              "请直接回答最后一条用户消息。如果信息不足，明确说明需要用户补充什么。",
              `最后一条用户消息: ${payload.latestMessage}`,
            ].join("\n\n"),
          },
        ],
      },
    ],
  });

  return response.output_text?.trim() || "我暂时没有生成有效回复，请稍后再试。";
}
