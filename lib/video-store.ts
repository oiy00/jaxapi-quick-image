import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { JobBook, type VideoJob } from "./video-job.ts";

type Persisted = { version: 1; jobs: VideoJob[] };

export class FileJobStore {
  private chain: Promise<void> = Promise.resolve();
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  transact<T>(fn: (book: JobBook) => T): Promise<T> {
    const run = this.chain.then(() => this.withFileLock(async () => {
      const book = await this.read();
      const result = fn(book);
      await this.write(book);
      return result;
    }));
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async withFileLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockPath = `${this.filePath}.lock`;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const handle = await open(lockPath, "wx");
        try {
          return await fn();
        } finally {
          await handle.close();
          await unlink(lockPath).catch(() => undefined);
        }
      } catch (error) {
        const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : "";
        if (code !== "EEXIST") throw error;
        const info = await stat(lockPath).catch(() => null);
        if (info && Date.now() - info.mtimeMs > 30_000) {
          await unlink(lockPath).catch(() => undefined);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    throw new Error("视频任务文件正被占用");
  }

  private async read(): Promise<JobBook> {
    try {
      const text = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(text) as Persisted;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.jobs)) {
        throw new Error("视频任务文件无法读取");
      }
      return JobBook.fromJobs(parsed.jobs);
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return new JobBook();
      }
      throw error;
    }
  }

  private async write(book: JobBook): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const payload: Persisted = { version: 1, jobs: book.list() };
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(payload), "utf8");
    await rename(tmp, this.filePath);
  }
}
