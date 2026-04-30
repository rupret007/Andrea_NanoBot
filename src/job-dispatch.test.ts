import { describe, expect, it } from 'vitest';

import {
  dispatchUnifiedJob,
  type JobDispatchAdapters,
  type JobLaneAdapter,
  type UnifiedJobView,
} from './job-dispatch.js';
import type { SendMessageResult } from './types.js';

interface CapturedSend {
  jid: string;
  text: string;
  messageId: string;
}

function makeChannel(): {
  channel: { sendMessage: (jid: string, text: string) => Promise<SendMessageResult>; editMessage: (jid: string, id: string, text: string) => Promise<SendMessageResult> };
  sends: CapturedSend[];
  edits: { messageId: string; text: string }[];
} {
  const sends: CapturedSend[] = [];
  const edits: { messageId: string; text: string }[] = [];
  let counter = 0;
  return {
    channel: {
      async sendMessage(jid, text) {
        counter += 1;
        const id = `m-${counter}`;
        sends.push({ jid, text, messageId: id });
        return { platformMessageId: id };
      },
      async editMessage(_jid, messageId, text) {
        edits.push({ messageId, text });
        return { platformMessageId: messageId };
      },
    },
    sends,
    edits,
  };
}

function makeAdapter(
  label: string,
  scriptedSnapshots: UnifiedJobView[],
): JobLaneAdapter {
  let index = 0;
  return {
    label,
    async createJob() {
      const initial = scriptedSnapshots[0];
      if (!initial) throw new Error('test: createJob with no scripted snapshots');
      index = 1;
      return initial;
    },
    async fetchJob() {
      const next = scriptedSnapshots[index];
      if (next) {
        index += 1;
        return next;
      }
      // Stay on the last scripted snapshot — covers cases where the test
      // schedules fewer snapshots than the loop will poll for.
      return scriptedSnapshots[scriptedSnapshots.length - 1];
    },
  };
}

function buildAdapters(
  cursor: UnifiedJobView[],
  codex: UnifiedJobView[],
): JobDispatchAdapters {
  return {
    cursor: makeAdapter('Cursor', cursor),
    codex: makeAdapter('Codex', codex),
  };
}

describe('dispatchUnifiedJob — clarification path', () => {
  it('returns clarification_required for ambiguous prompts and posts the help message', async () => {
    const { channel, sends } = makeChannel();
    const adapters = buildAdapters([], []);
    const result = await dispatchUnifiedJob({
      channel,
      input: {
        chatJid: 'tg:1',
        prompt: 'hey what time is it',
        laneOverride: null,
      },
      adapters,
    });
    expect(result.outcome).toBe('clarification_required');
    expect(result.lane).toBeNull();
    expect(sends).toHaveLength(1);
    expect(sends[0].text).toMatch(/--lane=cursor/);
    expect(sends[0].text).toMatch(/--lane=codex/);
  });

  it('respects lane override even when prompt is ambiguous', async () => {
    const { channel, sends } = makeChannel();
    const completed: UnifiedJobView = {
      jobId: 'cursor-1',
      status: 'completed',
      lastUpdate: 'done',
      outputTail: null,
      errorText: null,
      finalOutput: 'final result',
      pctComplete: 100,
    };
    const adapters = buildAdapters([completed], []);
    const result = await dispatchUnifiedJob({
      channel,
      input: {
        chatJid: 'tg:1',
        prompt: 'do it',
        laneOverride: 'cursor',
      },
      adapters,
    });
    expect(result.outcome).toBe('dispatched');
    expect(result.lane).toBe('cursor');
    expect(result.jobId).toBe('cursor-1');
    // Initial card + final output message.
    expect(sends.length).toBeGreaterThanOrEqual(2);
    expect(sends[sends.length - 1].text).toContain('final result');
  });
});

describe('dispatchUnifiedJob — auto routing', () => {
  it('routes code-edit prompts to cursor', async () => {
    const { channel } = makeChannel();
    const cursorJob: UnifiedJobView = {
      jobId: 'cursor-2',
      status: 'completed',
      lastUpdate: null,
      outputTail: null,
      errorText: null,
      finalOutput: null,
      pctComplete: null,
    };
    const adapters = buildAdapters([cursorJob], []);
    const result = await dispatchUnifiedJob({
      channel,
      input: {
        chatJid: 'tg:1',
        prompt: 'refactor handlers.ts to remove the deprecated calls',
        laneOverride: null,
      },
      adapters,
    });
    expect(result.lane).toBe('cursor');
    expect(result.jobId).toBe('cursor-2');
  });

  it('routes execution-shaped prompts to codex', async () => {
    const { channel } = makeChannel();
    const codexJob: UnifiedJobView = {
      jobId: 'codex-1',
      status: 'completed',
      lastUpdate: null,
      outputTail: null,
      errorText: null,
      finalOutput: null,
      pctComplete: null,
    };
    const adapters = buildAdapters([], [codexJob]);
    const result = await dispatchUnifiedJob({
      channel,
      input: {
        chatJid: 'tg:1',
        prompt: 'run npm test on the main branch',
        laneOverride: null,
      },
      adapters,
    });
    expect(result.lane).toBe('codex');
    expect(result.jobId).toBe('codex-1');
  });
});

describe('dispatchUnifiedJob — streaming through completion', () => {
  it('posts card, polls, edits on transitions, sends final output, returns dispatched', async () => {
    const { channel, sends, edits } = makeChannel();
    const snapshots: UnifiedJobView[] = [
      // create() returns this
      {
        jobId: 'cursor-3',
        status: 'queued',
        lastUpdate: null,
        outputTail: null,
        errorText: null,
        finalOutput: null,
        pctComplete: null,
      },
      // poll 1
      {
        jobId: 'cursor-3',
        status: 'running',
        lastUpdate: 'applied 2 edits',
        outputTail: null,
        errorText: null,
        finalOutput: null,
        pctComplete: 30,
      },
      // poll 2 — terminal
      {
        jobId: 'cursor-3',
        status: 'completed',
        lastUpdate: 'finished',
        outputTail: null,
        errorText: null,
        finalOutput: 'PR opened: https://example/pr/1',
        pctComplete: 100,
      },
    ];
    const adapters = buildAdapters(snapshots, []);
    const sleepCalls: number[] = [];
    let now = 0;
    const result = await dispatchUnifiedJob({
      channel,
      input: {
        chatJid: 'tg:1',
        prompt: 'edit auth.ts and open a PR',
        laneOverride: null,
      },
      adapters,
      config: {
        pollIntervalMs: 100,
        sleep: async (ms: number) => {
          sleepCalls.push(ms);
          now += ms;
        },
        now: () => now,
        cardConfig: { now: () => now, minEditIntervalMs: 0 },
      },
    });
    expect(result.outcome).toBe('dispatched');
    expect(result.lane).toBe('cursor');
    expect(sleepCalls.length).toBeGreaterThanOrEqual(2); // at least two polls
    // edits should have fired on the running and completed transitions
    expect(edits.some((e) => e.text.includes('Status: running'))).toBe(true);
    expect(edits.some((e) => e.text.includes('Status: completed'))).toBe(true);
    // Final output sent as a fresh message, not an edit
    expect(sends[sends.length - 1].text).toBe('PR opened: https://example/pr/1');
  });

  it('returns dispatched immediately when create returns terminal status', async () => {
    const { channel } = makeChannel();
    const adapters = buildAdapters(
      [
        {
          jobId: 'cursor-fail',
          status: 'failed',
          lastUpdate: 'invalid prompt',
          outputTail: null,
          errorText: 'invalid prompt',
          finalOutput: null,
          pctComplete: null,
        },
      ],
      [],
    );
    const sleepCalls: number[] = [];
    const result = await dispatchUnifiedJob({
      channel,
      input: {
        chatJid: 'tg:1',
        prompt: 'refactor missing.ts',
        laneOverride: 'cursor',
      },
      adapters,
      config: {
        sleep: async (ms: number) => {
          sleepCalls.push(ms);
        },
      },
    });
    expect(result.outcome).toBe('dispatched');
    expect(sleepCalls.length).toBe(0); // never entered the poll loop
  });
});

describe('dispatchUnifiedJob — failure paths', () => {
  it('returns failed when createJob throws', async () => {
    const { channel, sends } = makeChannel();
    const adapter: JobLaneAdapter = {
      label: 'Cursor',
      async createJob() {
        throw new Error('quota exhausted');
      },
      async fetchJob() {
        throw new Error('not reached');
      },
    };
    const result = await dispatchUnifiedJob({
      channel,
      input: {
        chatJid: 'tg:1',
        prompt: 'edit something.ts',
        laneOverride: 'cursor',
      },
      adapters: { cursor: adapter, codex: adapter },
    });
    expect(result.outcome).toBe('failed');
    expect(sends.some((s) => s.text.includes('quota exhausted'))).toBe(true);
  });

  it('keeps polling on transient fetch failures', async () => {
    const { channel } = makeChannel();
    let call = 0;
    const adapter: JobLaneAdapter = {
      label: 'Codex',
      async createJob() {
        return {
          jobId: 'codex-flaky',
          status: 'queued',
          lastUpdate: null,
          outputTail: null,
          errorText: null,
          finalOutput: null,
          pctComplete: null,
        };
      },
      async fetchJob() {
        call += 1;
        if (call === 1) throw new Error('transient 503');
        return {
          jobId: 'codex-flaky',
          status: 'completed',
          lastUpdate: 'recovered',
          outputTail: null,
          errorText: null,
          finalOutput: 'done',
          pctComplete: 100,
        };
      },
    };
    let now = 0;
    const result = await dispatchUnifiedJob({
      channel,
      input: {
        chatJid: 'tg:1',
        prompt: 'run npm test',
        laneOverride: null,
      },
      adapters: { cursor: adapter, codex: adapter },
      config: {
        pollIntervalMs: 100,
        sleep: async (ms: number) => {
          now += ms;
        },
        now: () => now,
        cardConfig: { now: () => now, minEditIntervalMs: 0 },
      },
    });
    expect(result.outcome).toBe('dispatched');
    expect(call).toBe(2); // first throw, second succeeded
  });

  it('respects the watch budget and exits with watch_timeout summary', async () => {
    const { channel } = makeChannel();
    const adapter: JobLaneAdapter = {
      label: 'Cursor',
      async createJob() {
        return {
          jobId: 'cursor-slow',
          status: 'running',
          lastUpdate: null,
          outputTail: null,
          errorText: null,
          finalOutput: null,
          pctComplete: null,
        };
      },
      async fetchJob() {
        // Never reaches a terminal state.
        return {
          jobId: 'cursor-slow',
          status: 'running',
          lastUpdate: 'still working',
          outputTail: null,
          errorText: null,
          finalOutput: null,
          pctComplete: null,
        };
      },
    };
    let now = 0;
    const result = await dispatchUnifiedJob({
      channel,
      input: {
        chatJid: 'tg:1',
        prompt: 'edit foo.ts',
        laneOverride: 'cursor',
      },
      adapters: { cursor: adapter, codex: adapter },
      config: {
        pollIntervalMs: 1000,
        maxPollMs: 5000,
        sleep: async (ms: number) => {
          now += ms;
        },
        now: () => now,
        cardConfig: { now: () => now, minEditIntervalMs: 0 },
      },
    });
    expect(result.outcome).toBe('dispatched');
    expect(result.summary).toContain('watch_timeout');
  });
});
