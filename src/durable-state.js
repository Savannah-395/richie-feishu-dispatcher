import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function fileKey(value) {
  return createHash("sha256").update(`${value}`).digest("hex");
}

export class DurableStateStore {
  constructor(rootDir) {
    this.rootDir = path.resolve(rootDir);
    this.locks = new Map();
  }

  filePath(key) {
    return path.join(this.rootDir, `${fileKey(key)}.json`);
  }

  async read(key) {
    try {
      return JSON.parse(await readFile(this.filePath(key), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) {
        return undefined;
      }
      throw error;
    }
  }

  async write(key, value) {
    await mkdir(this.rootDir, { recursive: true });
    const target = this.filePath(key);
    const temporary = path.join(this.rootDir, `.${path.basename(target)}.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
    await rename(temporary, target);
    return value;
  }

  async withLock(key, operation) {
    const prior = this.locks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    this.locks.set(key, current);
    await prior;

    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === current) {
        this.locks.delete(key);
      }
    }
  }

  async runOnce(key, operation, { leaseMs = 15 * 60 * 1000 } = {}) {
    return this.withLock(key, async () => {
      const prior = await this.read(key);
      const priorStartedAt = Date.parse(prior?.startedAt || "");
      const hasLiveLease = prior?.status === "processing"
        && Number.isFinite(priorStartedAt)
        && Date.now() - priorStartedAt < leaseMs;
      if (prior?.status === "completed" || hasLiveLease) {
        return { duplicate: true, value: prior?.value };
      }

      await this.write(key, {
        status: "processing",
        startedAt: new Date().toISOString(),
      });

      try {
        const value = await operation();
        await this.write(key, {
          status: "completed",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          value,
        });
        return { duplicate: false, value };
      } catch (error) {
        await this.write(key, {
          status: "failed",
          failedAt: new Date().toISOString(),
          error: `${error?.message || error}`.slice(0, 1000),
        });
        throw error;
      }
    });
  }
}
