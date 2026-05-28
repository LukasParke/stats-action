import { ActionConfig, RateLimitInfo } from "./Types";

export class BudgetStoppedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetStoppedError";
  }
}

export type SchedulerState = {
  graphqlRateLimit: RateLimitInfo | null;
  restRateLimit: RateLimitInfo | null;
  warnings: string[];
};

export class RequestScheduler {
  private readonly startedAt: number;
  private graphqlRateLimit: RateLimitInfo | null = null;
  private restRateLimit: RateLimitInfo | null = null;
  private warnings: string[] = [];

  constructor(private readonly config: ActionConfig, startedAt = Date.now()) {
    this.startedAt = startedAt;
  }

  state(): SchedulerState {
    return {
      graphqlRateLimit: this.graphqlRateLimit,
      restRateLimit: this.restRateLimit,
      warnings: [...this.warnings],
    };
  }

  shouldStartOptional(kind: "graphql" | "rest"): boolean {
    if (this.isRuntimeExhausted()) return false;
    const rate = kind === "graphql" ? this.graphqlRateLimit : this.restRateLimit;
    const minimum =
      kind === "graphql"
        ? this.config.minGraphqlRemaining
        : this.config.minRestRemaining;
    return !rate || rate.remaining > minimum;
  }

  async graphql<T extends { rateLimit?: RateLimitInfo }>(
    label: string,
    request: () => Promise<T>,
    optional = false
  ): Promise<T> {
    if (optional && !this.shouldStartOptional("graphql")) {
      throw new BudgetStoppedError(`GraphQL budget exhausted before ${label}`);
    }

    const response = await request();
    if (response.rateLimit) {
      this.graphqlRateLimit = response.rateLimit;
      if (response.rateLimit.remaining <= this.config.minGraphqlRemaining) {
        this.warnings.push(
          `GraphQL budget near threshold after ${label}: ${response.rateLimit.remaining} remaining`
        );
      }
    }
    return response;
  }

  async rest<T extends { headers?: Record<string, string | number | undefined>; status?: number }>(
    label: string,
    request: () => Promise<T>,
    optional = true,
    retries = 3
  ): Promise<T> {
    if (optional && !this.shouldStartOptional("rest")) {
      throw new BudgetStoppedError(`REST budget exhausted before ${label}`);
    }

    let attempt = 0;
    while (true) {
      try {
        const response = await request();
        this.updateRestRateLimit(response.headers);
        return response;
      } catch (error) {
        const status = getErrorStatus(error);
        const retryAfterMs = getRetryAfterMs(error);
        if (attempt >= retries || !isRetryableStatus(status)) throw error;

        attempt++;
        const backoffMs =
          retryAfterMs ?? Math.min(30000, 1000 * Math.pow(2, attempt - 1));
        this.warnings.push(
          `${label} returned ${status}; retrying in ${Math.round(backoffMs)}ms`
        );
        await delay(backoffMs + Math.floor(Math.random() * 250));
      }
    }
  }

  private isRuntimeExhausted(): boolean {
    return Date.now() - this.startedAt >= this.config.maxRuntimeSeconds * 1000;
  }

  private updateRestRateLimit(
    headers: Record<string, string | number | undefined> | undefined
  ): void {
    if (!headers) return;

    const limit = readHeaderNumber(headers, "x-ratelimit-limit");
    const remaining = readHeaderNumber(headers, "x-ratelimit-remaining");
    const used = readHeaderNumber(headers, "x-ratelimit-used");
    const reset = readHeaderNumber(headers, "x-ratelimit-reset");

    if (limit === null || remaining === null || reset === null) return;

    this.restRateLimit = {
      limit,
      remaining,
      used: used ?? Math.max(0, limit - remaining),
      resetAt: new Date(reset * 1000).toISOString(),
    };

    if (remaining <= this.config.minRestRemaining) {
      this.warnings.push(`REST budget near threshold: ${remaining} remaining`);
    }
  }
}

export async function runLimited<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<Array<PromiseSettledResult<R>>> {
  const results: Array<PromiseSettledResult<R>> = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length || 1));

  async function runWorker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex++;
      if (currentIndex >= items.length) return;

      try {
        results[currentIndex] = {
          status: "fulfilled",
          value: await worker(items[currentIndex], currentIndex),
        };
      } catch (reason) {
        results[currentIndex] = { status: "rejected", reason };
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

export function isBudgetStopped(error: unknown): boolean {
  return error instanceof BudgetStoppedError;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readHeaderNumber(
  headers: Record<string, string | number | undefined>,
  name: string
): number | null {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (typeof value === "number") return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getErrorStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

function getRetryAfterMs(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const response = (error as { response?: { headers?: Record<string, string> } }).response;
  const retryAfter = response?.headers?.["retry-after"];
  if (!retryAfter) return null;
  const seconds = Number(retryAfter);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

function isRetryableStatus(status: number | null): boolean {
  return status === 403 || status === 429 || status === 500 || status === 502 || status === 503;
}
