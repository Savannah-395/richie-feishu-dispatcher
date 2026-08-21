export class ThreadQueue {
  constructor() {
    this.pending = new Map();
    this.active = new Set();
    this.queued = new Map();
    this.startedCount = 0;
    this.completedCount = 0;
  }

  snapshot() {
    const queuedTopics = [...this.queued.entries()]
      .filter(([, count]) => count > 0)
      .map(([key, count]) => ({ key, count }));

    return {
      pendingTopics: this.pending.size,
      activeCount: this.active.size,
      activeTopics: [...this.active],
      queuedCount: queuedTopics.reduce((total, item) => total + item.count, 0),
      queuedTopics,
      startedCount: this.startedCount,
      completedCount: this.completedCount,
    };
  }

  run(key, task) {
    const queueKey = `${key}`;
    this.queued.set(queueKey, (this.queued.get(queueKey) || 0) + 1);

    const previous = this.pending.get(queueKey) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        const nextQueuedCount = (this.queued.get(queueKey) || 1) - 1;
        if (nextQueuedCount > 0) {
          this.queued.set(queueKey, nextQueuedCount);
        } else {
          this.queued.delete(queueKey);
        }

        this.active.add(queueKey);
        this.startedCount += 1;
        try {
          return await task();
        } finally {
          this.active.delete(queueKey);
          this.completedCount += 1;
        }
      })
      .finally(() => {
        if (this.pending.get(queueKey) === current) {
          this.pending.delete(queueKey);
        }
      });

    this.pending.set(queueKey, current);
    return current;
  }
}
