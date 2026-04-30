import { describe, expect, it } from 'vitest';

import {
  JobStatusCard,
  type JobStatusCardChannel,
  type JobStatusCardState,
  renderJobStatusCard,
} from './job-status-card.js';
import type { SendMessageResult } from './types.js';

interface CapturedSend {
  jid: string;
  text: string;
  messageId: string;
}
interface CapturedEdit {
  jid: string;
  messageId: string;
  text: string;
}

function makeChannel(
  options: { editMessage?: boolean; failNthEdit?: number } = {},
): {
  channel: JobStatusCardChannel;
  sends: CapturedSend[];
  edits: CapturedEdit[];
} {
  const sends: CapturedSend[] = [];
  const edits: CapturedEdit[] = [];
  let editAttempts = 0;
  let messageCounter = 0;
  const channel: JobStatusCardChannel = {
    async sendMessage(jid, text): Promise<SendMessageResult> {
      messageCounter += 1;
      const messageId = `msg-${messageCounter}`;
      sends.push({ jid, text, messageId });
      return { platformMessageId: messageId };
    },
  };
  if (options.editMessage !== false) {
    channel.editMessage = async (
      jid,
      messageId,
      text,
    ): Promise<SendMessageResult> => {
      editAttempts += 1;
      if (
        options.failNthEdit !== undefined &&
        editAttempts === options.failNthEdit
      ) {
        throw new Error('simulated edit failure');
      }
      edits.push({ jid, messageId, text });
      return { platformMessageId: messageId };
    };
  }
  return { channel, sends, edits };
}

function baseState(): JobStatusCardState {
  return {
    jobId: 'job-1',
    lane: 'cursor',
    laneLabel: 'Cursor',
    promptSnippet: 'refactor the auth module',
    status: 'queued',
    startedAt: 0,
    updatedAt: 0,
    lastUpdate: null,
    outputTail: null,
    errorText: null,
    pctComplete: null,
  };
}

describe('renderJobStatusCard', () => {
  it('renders a complete card with status icon and prompt snippet', () => {
    const text = renderJobStatusCard({
      ...baseState(),
      status: 'running',
      updatedAt: 5_000,
      lastUpdate: 'applied 3 edits',
      outputTail: 'function authenticate() { ... }',
    });
    expect(text).toContain('🔄 Job [Cursor] · job-1');
    expect(text).toContain('Status: running (5s)');
    expect(text).toContain('Last update: applied 3 edits');
    expect(text).toContain('Output:');
    expect(text).toContain('Prompt: refactor the auth module');
  });

  it('shows error block only on failed status', () => {
    const failed = renderJobStatusCard({
      ...baseState(),
      status: 'failed',
      errorText: 'auth provider timeout',
    });
    expect(failed).toContain('Error: auth provider timeout');
    const running = renderJobStatusCard({
      ...baseState(),
      status: 'running',
      errorText: 'auth provider timeout',
    });
    expect(running).not.toContain('Error:');
  });
});

describe('JobStatusCard streaming', () => {
  it('debounces edits within minEditIntervalMs and flushes when the window passes', async () => {
    const { channel, sends, edits } = makeChannel();
    let now = 0;
    const card = new JobStatusCard({
      channel,
      chatJid: 'tg:1',
      initialState: baseState(),
      config: { now: () => now, minEditIntervalMs: 4000 },
    });
    await card.post();
    expect(sends).toHaveLength(1);

    now = 1000;
    await card.update({ lastUpdate: 'still queued' });
    // Within the debounce window — no edit yet.
    expect(edits).toHaveLength(0);

    now = 5500;
    await card.update({ lastUpdate: 'now running', status: 'running' });
    expect(edits).toHaveLength(1);
    expect(edits[0].text).toContain('Status: running');
  });

  it('always flushes on terminal status regardless of debounce window', async () => {
    const { channel, edits } = makeChannel();
    let now = 0;
    const card = new JobStatusCard({
      channel,
      chatJid: 'tg:1',
      initialState: baseState(),
      config: { now: () => now, minEditIntervalMs: 4000 },
    });
    await card.post();

    now = 100; // Well within debounce window.
    await card.update({ status: 'completed', outputTail: 'done' });
    expect(edits).toHaveLength(1);
    expect(edits[0].text).toContain('Status: completed');
  });

  it('drops further updates after a terminal flush', async () => {
    const { channel, edits, sends } = makeChannel();
    let now = 0;
    const card = new JobStatusCard({
      channel,
      chatJid: 'tg:1',
      initialState: baseState(),
      config: { now: () => now, minEditIntervalMs: 100 },
    });
    await card.post();
    now = 200;
    await card.update({ status: 'completed' });
    expect(edits).toHaveLength(1);

    now = 1000;
    await card.update({ status: 'running', lastUpdate: 'no longer relevant' });
    // No additional edit/send for post-terminal updates.
    expect(edits).toHaveLength(1);
    expect(sends).toHaveLength(1);
  });

  it('skips a second edit when the rendered text matches the previous edit', async () => {
    const { channel, edits } = makeChannel();
    let now = 0;
    const card = new JobStatusCard({
      channel,
      chatJid: 'tg:1',
      initialState: baseState(),
      config: { now: () => now, minEditIntervalMs: 100 },
    });
    await card.post();

    // First update: substantive change → edits once.
    now = 1000;
    await card.update({ status: 'running', lastUpdate: 'started' });
    expect(edits.length).toBe(1);

    // Second update with no field changes BUT same wall-clock → text would
    // be identical to the just-rendered text → must skip.
    await card.update({});
    expect(edits.length).toBe(1);
  });

  it('caps edits at maxEditsPerCard then sends a fresh card', async () => {
    const { channel, sends, edits } = makeChannel();
    let now = 0;
    const card = new JobStatusCard({
      channel,
      chatJid: 'tg:1',
      initialState: baseState(),
      config: { now: () => now, minEditIntervalMs: 0, maxEditsPerCard: 3 },
    });
    await card.post();
    expect(sends).toHaveLength(1);

    for (let i = 0; i < 5; i += 1) {
      now += 100;
      await card.update({ lastUpdate: `update ${i}` });
    }
    // With cap=3: updates 0/1/2 edit the original card, update 3 hits the cap
    // and sends a fresh card, update 4 edits that fresh card. So 4 edits, 3
    // sends (initial post + 1 fresh card after cap).
    expect(edits.length).toBe(4);
    expect(sends.length).toBe(2); // post + 1 fresh card
  });

  it('falls back to sendMessage when channel does not support editing', async () => {
    const { channel, sends, edits } = makeChannel({ editMessage: false });
    let now = 0;
    const card = new JobStatusCard({
      channel,
      chatJid: 'tg:1',
      initialState: baseState(),
      config: { now: () => now, minEditIntervalMs: 0 },
    });
    await card.post();
    now = 100;
    await card.update({ status: 'running', lastUpdate: 'progressing' });
    expect(edits).toHaveLength(0);
    // Without edit support every flush sends a new message.
    expect(sends.length).toBeGreaterThan(1);
  });

  it('falls back to sendMessage when an edit raises', async () => {
    const { channel, sends, edits } = makeChannel({ failNthEdit: 1 });
    let now = 0;
    const card = new JobStatusCard({
      channel,
      chatJid: 'tg:1',
      initialState: baseState(),
      config: { now: () => now, minEditIntervalMs: 0 },
    });
    await card.post();
    now = 100;
    await card.update({ status: 'running', lastUpdate: 'progress' });
    // Edit attempted but failed → fresh send.
    expect(edits).toHaveLength(0);
    expect(sends.length).toBe(2);
  });

  it('truncates outputTail to outputTailMaxChars from the end of the text', async () => {
    const { channel, sends, edits } = makeChannel();
    let now = 0;
    const card = new JobStatusCard({
      channel,
      chatJid: 'tg:1',
      initialState: baseState(),
      config: { now: () => now, minEditIntervalMs: 0, outputTailMaxChars: 50 },
    });
    await card.post();
    now = 100;
    const big = 'x'.repeat(200) + 'TAIL_MARKER';
    await card.update({ status: 'running', outputTail: big });
    const lastEdit = edits[edits.length - 1];
    expect(lastEdit.text).toContain('TAIL_MARKER');
    expect(lastEdit.text).not.toContain('x'.repeat(100));
    // Truncated tails are prefixed with an ellipsis so the user knows they're partial.
    expect(lastEdit.text).toContain('…');
  });

  it('sendFinalOutput posts a separate message, not an edit', async () => {
    const { channel, sends, edits } = makeChannel();
    const card = new JobStatusCard({
      channel,
      chatJid: 'tg:1',
      initialState: baseState(),
    });
    await card.post();
    await card.sendFinalOutput('here is the diff');
    expect(edits).toHaveLength(0);
    expect(sends).toHaveLength(2);
    expect(sends[1].text).toBe('here is the diff');
  });

  it('flushes a terminal update that arrives while a prior flush is in-flight (race regression)', async () => {
    // Audit found that the original flush() short-circuited the second
    // caller, dropping terminal state when it arrived during an in-flight
    // edit. This test only blocks the first edit (so the second flush
    // attempt runs unblocked) and asserts the terminal text appears.
    const editGate: { resolve?: () => void; promise?: Promise<void> } = {};
    editGate.promise = new Promise<void>((r) => {
      editGate.resolve = r;
    });
    let editAttempt = 0;
    const edits: { text: string }[] = [];
    let counter = 0;
    const channel = {
      async sendMessage(_jid: string, _text: string) {
        counter += 1;
        return { platformMessageId: `m-${counter}` };
      },
      async editMessage(_jid: string, _messageId: string, text: string) {
        editAttempt += 1;
        if (editAttempt === 1) {
          await editGate.promise;
        }
        edits.push({ text });
        return { platformMessageId: 'm-x' };
      },
    };
    let now = 0;
    const card = new JobStatusCard({
      channel,
      chatJid: 'tg:1',
      initialState: baseState(),
      config: { now: () => now, minEditIntervalMs: 0 },
    });
    await card.post();

    // Update A (running) starts the first edit and blocks on editGate.
    now = 100;
    const aPromise = card.update({ status: 'running', lastUpdate: 'A' });

    // Update B (terminal) arrives while A is blocked.
    now = 200;
    const bPromise = card.update({ status: 'completed', lastUpdate: 'B' });

    // Release the gate; A's edit lands, B's flush sees state still dirty
    // and issues its own (unblocked) edit.
    editGate.resolve!();
    await aPromise;
    await bPromise;

    expect(edits.length).toBe(2);
    expect(edits[edits.length - 1].text).toContain('Status: completed');
  });

  it('sendFinalOutput is a no-op when text is empty or whitespace-only', async () => {
    const { channel, sends } = makeChannel();
    const card = new JobStatusCard({
      channel,
      chatJid: 'tg:1',
      initialState: baseState(),
    });
    await card.post();
    await card.sendFinalOutput(null);
    await card.sendFinalOutput('');
    await card.sendFinalOutput('   \n  ');
    expect(sends).toHaveLength(1); // only the initial post
  });
});
