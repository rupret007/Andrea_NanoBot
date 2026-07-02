/**
 * Cost & rate budget meter.
 *
 * Tracks tokens, dollars, and per-tool call rates across rolling windows.
 * The policy gate consults this before allowing tool calls, and the model
 * router consults it before picking expensive models.
 */

export interface BudgetWindow {
  /** Window length in ms. */
  windowMs: number;
  /** Max USD allowed in window. */
  maxUsd?: number;
  /** Max tool calls allowed in window. */
  maxCalls?: number;
}

export interface BudgetEntry {
  at: number;
  usd: number;
  toolName?: string;
  kind: 'model' | 'tool';
}

export class BudgetMeter {
  private entries: BudgetEntry[] = [];
  constructor(private readonly windows: Record<string, BudgetWindow>) {}

  charge(usd: number, toolName?: string): void {
    this.entries.push({ at: Date.now(), usd, toolName, kind: 'model' });
    this.gc();
  }

  chargeToolCall(toolName: string): void {
    this.entries.push({ at: Date.now(), usd: 0, toolName, kind: 'tool' });
    this.gc();
  }

  snapshot(): Record<
    string,
    { usd: number; calls: number; window: BudgetWindow }
  > {
    const now = Date.now();
    const out: Record<
      string,
      { usd: number; calls: number; window: BudgetWindow }
    > = {};
    for (const [name, win] of Object.entries(this.windows)) {
      const cutoff = now - win.windowMs;
      const inside = this.entries.filter((e) => e.at >= cutoff);
      out[name] = {
        usd: inside.reduce((a, b) => a + b.usd, 0),
        calls: inside.filter((entry) => entry.kind === 'tool').length,
        window: win,
      };
    }
    return out;
  }

  exceeded(): { window: string; reason: string } | null {
    const s = this.snapshot();
    for (const [name, info] of Object.entries(s)) {
      if (info.window.maxUsd && info.usd >= info.window.maxUsd) {
        return {
          window: name,
          reason: `USD budget hit: ${info.usd.toFixed(4)}`,
        };
      }
      if (info.window.maxCalls && info.calls >= info.window.maxCalls) {
        return { window: name, reason: `Call budget hit: ${info.calls}` };
      }
    }
    return null;
  }

  private gc() {
    const longest = Math.max(
      ...Object.values(this.windows).map((w) => w.windowMs),
    );
    const cutoff = Date.now() - longest;
    this.entries = this.entries.filter((e) => e.at >= cutoff);
  }
}
