import { AdeError } from "../../domain";

export class OutputBudget {
  private bytes = 0;
  constructor(private readonly limit = 32 * 1024 * 1024) {}
  consume = (text: string | Buffer) => {
    this.bytes += Buffer.byteLength(text);
    if (this.bytes > this.limit)
      throw new AdeError("output_limit", "Output exceeded the capture limit for this session.");
  };
}

export class BoundedWriter {
  private pending = Promise.resolve();
  private bytes = 0;
  private count = 0;
  private failure: Error | undefined;
  private budget = new OutputBudget();
  constructor(private readonly onFailure: (error: Error) => void) {}
  private fail = (error: unknown) => {
    if (this.failure) return;
    this.failure = error instanceof Error ? error : new Error(String(error));
    this.onFailure(this.failure);
  };
  write = (text: string, sink: (text: string) => Promise<unknown>) => {
    if (this.failure) throw this.failure;
    const bytes = Buffer.byteLength(text);
    this.budget.consume(text);
    if (this.bytes + bytes > 4 * 1024 * 1024 || this.count >= 4096)
      throw new AdeError("output_limit", "Output is arriving faster than its log can be saved.");
    this.bytes += bytes;
    this.count++;
    this.pending = this.pending.then(async () => {
      try {
        if (!this.failure) await sink(text);
      } catch (error) {
        this.fail(error);
      } finally {
        this.bytes -= bytes;
        this.count--;
      }
    });
  };
  drain = async () => {
    await this.pending;
    if (this.failure) throw this.failure;
  };
}
