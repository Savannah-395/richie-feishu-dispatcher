export class ThreadStore {
  constructor({ maxMessages, maxInputChars }) {
    this.maxMessages = maxMessages;
    this.maxInputChars = maxInputChars;
    this.threads = new Map();
    this.activeTopics = new Set();
  }

  append(topicId, message) {
    const thread = this.threads.get(topicId) ?? [];
    thread.push(message);

    while (thread.length > this.maxMessages) {
      thread.shift();
    }

    this.threads.set(topicId, thread);
  }

  get(topicId) {
    return [...(this.threads.get(topicId) ?? [])];
  }

  activate(topicId) {
    this.activeTopics.add(topicId);
  }

  isActive(topicId) {
    return this.activeTopics.has(topicId);
  }

  hasAttachments(topicId) {
    return this.get(topicId).some((item) => Array.isArray(item.attachments) && item.attachments.length > 0);
  }

  toModelInput(topicId) {
    const messages = this.get(topicId);
    const lines = [];
    let totalChars = 0;

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const item = messages[index];
      const line = `[${item.role}] ${item.author}: ${item.content}`.trim();
      totalChars += line.length;
      if (totalChars > this.maxInputChars) {
        break;
      }
      lines.unshift(line);
    }

    return lines.join("\n");
  }
}
