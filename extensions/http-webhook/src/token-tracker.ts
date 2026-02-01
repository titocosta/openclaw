import { promises as fs } from "node:fs";
import { onDiagnosticEvent } from "openclaw/plugin-sdk";
import type { DiagnosticUsageEvent } from "openclaw/plugin-sdk";

export type TokenUsageByModel = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  requestCount: number;
};

export type TokenUsageByProvider = {
  [model: string]: TokenUsageByModel;
};

export type TokenUsagePeriod = {
  providers: {
    [provider: string]: TokenUsageByProvider;
  };
  startedAt: number;
  lastUpdatedAt: number;
};

export type TokenUsageData = {
  allTime: TokenUsagePeriod;
  monthly: TokenUsagePeriod;
  weekly: TokenUsagePeriod;
  daily: TokenUsagePeriod;
};

export type TokenTrackerOptions = {
  dataPath: string;
  autosaveIntervalMs?: number;
};

export class TokenTracker {
  private data: TokenUsageData;
  private dataPath: string;
  private unsubscribe?: () => void;
  private autosaveTimer?: NodeJS.Timeout;
  private isDirty = false;

  constructor(options: TokenTrackerOptions) {
    this.dataPath = options.dataPath;
    const now = Date.now();

    this.data = {
      allTime: this.createEmptyPeriod(now),
      monthly: this.createEmptyPeriod(now),
      weekly: this.createEmptyPeriod(now),
      daily: this.createEmptyPeriod(now),
    };

    // Autosave every 30 seconds by default
    if (options.autosaveIntervalMs !== 0) {
      const interval = options.autosaveIntervalMs ?? 30000;
      this.autosaveTimer = setInterval(() => {
        if (this.isDirty) {
          this.save().catch((err) => {
            console.error(`[token-tracker] Autosave failed:`, err);
          });
        }
      }, interval);
    }
  }

  private createEmptyPeriod(startedAt: number): TokenUsagePeriod {
    return {
      providers: {},
      startedAt,
      lastUpdatedAt: startedAt,
    };
  }

  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.dataPath, "utf-8");
      const loaded = JSON.parse(content) as TokenUsageData;

      // Check if periods need to be reset based on time
      const now = Date.now();
      loaded.daily = this.shouldResetPeriod(loaded.daily, now, 86400000) // 24 hours
        ? this.createEmptyPeriod(now)
        : loaded.daily;
      loaded.weekly = this.shouldResetPeriod(loaded.weekly, now, 604800000) // 7 days
        ? this.createEmptyPeriod(now)
        : loaded.weekly;
      loaded.monthly = this.shouldResetPeriod(loaded.monthly, now, 2592000000) // 30 days
        ? this.createEmptyPeriod(now)
        : loaded.monthly;

      this.data = loaded;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[token-tracker] Failed to load:`, err);
      }
      // File doesn't exist or is invalid, start fresh
    }
  }

  private shouldResetPeriod(period: TokenUsagePeriod, now: number, durationMs: number): boolean {
    return now - period.startedAt >= durationMs;
  }

  async save(): Promise<void> {
    try {
      const content = JSON.stringify(this.data, null, 2);
      await fs.writeFile(this.dataPath, content, "utf-8");
      this.isDirty = false;
    } catch (err) {
      console.error(`[token-tracker] Failed to save:`, err);
      throw err;
    }
  }

  start(): void {
    if (this.unsubscribe) {
      return; // Already started
    }

    this.unsubscribe = onDiagnosticEvent((event) => {
      if (event.type === "model.usage") {
        this.handleUsageEvent(event);
      }
    });
  }

  stop(): void {
    if (this.autosaveTimer) {
      clearInterval(this.autosaveTimer);
      this.autosaveTimer = undefined;
    }

    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }

    // Final save on stop
    if (this.isDirty) {
      this.save().catch((err) => {
        console.error(`[token-tracker] Final save failed:`, err);
      });
    }
  }

  private handleUsageEvent(event: DiagnosticUsageEvent): void {
    const provider = event.provider ?? "unknown";
    const model = event.model ?? "unknown";
    const usage = event.usage;

    const input = usage.input ?? 0;
    const output = usage.output ?? 0;
    const cacheRead = usage.cacheRead ?? 0;
    const cacheWrite = usage.cacheWrite ?? 0;
    const total = usage.total ?? input + output + cacheRead + cacheWrite;

    const now = Date.now();

    // Check if periods need reset
    if (this.shouldResetPeriod(this.data.daily, now, 86400000)) {
      this.data.daily = this.createEmptyPeriod(now);
    }
    if (this.shouldResetPeriod(this.data.weekly, now, 604800000)) {
      this.data.weekly = this.createEmptyPeriod(now);
    }
    if (this.shouldResetPeriod(this.data.monthly, now, 2592000000)) {
      this.data.monthly = this.createEmptyPeriod(now);
    }

    // Update all periods
    this.updatePeriod(this.data.allTime, provider, model, {
      input,
      output,
      cacheRead,
      cacheWrite,
      total,
    });
    this.updatePeriod(this.data.monthly, provider, model, {
      input,
      output,
      cacheRead,
      cacheWrite,
      total,
    });
    this.updatePeriod(this.data.weekly, provider, model, {
      input,
      output,
      cacheRead,
      cacheWrite,
      total,
    });
    this.updatePeriod(this.data.daily, provider, model, {
      input,
      output,
      cacheRead,
      cacheWrite,
      total,
    });

    this.isDirty = true;
  }

  private updatePeriod(
    period: TokenUsagePeriod,
    provider: string,
    model: string,
    tokens: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    },
  ): void {
    if (!period.providers[provider]) {
      period.providers[provider] = {};
    }

    if (!period.providers[provider][model]) {
      period.providers[provider][model] = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        requestCount: 0,
      };
    }

    const modelUsage = period.providers[provider][model];
    modelUsage.input += tokens.input;
    modelUsage.output += tokens.output;
    modelUsage.cacheRead += tokens.cacheRead;
    modelUsage.cacheWrite += tokens.cacheWrite;
    modelUsage.total += tokens.total;
    modelUsage.requestCount += 1;
    period.lastUpdatedAt = Date.now();
  }

  getData(): TokenUsageData {
    return JSON.parse(JSON.stringify(this.data)); // Deep clone
  }

  async reset(period?: "daily" | "weekly" | "monthly" | "allTime"): Promise<void> {
    const now = Date.now();

    if (period) {
      this.data[period] = this.createEmptyPeriod(now);
    } else {
      // Reset all
      this.data = {
        allTime: this.createEmptyPeriod(now),
        monthly: this.createEmptyPeriod(now),
        weekly: this.createEmptyPeriod(now),
        daily: this.createEmptyPeriod(now),
      };
    }

    this.isDirty = true;
    await this.save();
  }
}
