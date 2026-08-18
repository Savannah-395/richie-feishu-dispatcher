export class ThreadQueue {
  constructor() {
    this.pending = new Map();
  }

  run(key, task) {
    const previous = this.pending.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(task)
      .finally(() => {
        if (this.pending.get(key) === current) {
          this.pending.delete(key);
        }
      });

    this.pending.set(key, current);
    return current;
  }
}
