import { buildDailyCompanionResponse } from '../src/daily-companion.js';
import { getAllTasks, initDatabase } from '../src/db.js';
import { readEnvFile } from '../src/env.js';

const CALENDAR_ENV_KEYS = [
  'APPLE_CALENDAR_LOCAL_ENABLED',
  'APPLE_CALDAV_URL',
  'APPLE_CALDAV_USERNAME',
  'APPLE_CALDAV_PASSWORD',
  'APPLE_CALDAV_CALENDAR_URLS',
  'GOOGLE_CALENDAR_ACCESS_TOKEN',
  'GOOGLE_CALENDAR_REFRESH_TOKEN',
  'GOOGLE_CALENDAR_CLIENT_ID',
  'GOOGLE_CALENDAR_CLIENT_SECRET',
  'GOOGLE_CALENDAR_IDS',
  'OUTLOOK_CALENDAR_ACCESS_TOKEN',
  'OUTLOOK_CALENDAR_REFRESH_TOKEN',
  'OUTLOOK_CALENDAR_CLIENT_ID',
  'OUTLOOK_CALENDAR_CLIENT_SECRET',
  'OUTLOOK_CALENDAR_TENANT_ID',
  'OUTLOOK_CALENDAR_USER_ID',
] as const;

const DEFAULT_PROMPTS = [
  'what am I forgetting',
  "what's still open with Candace",
  'what should I remember tonight',
  'what do Candace and I have coming up',
];

function parseArgs(argv: string[]): {
  groupFolder: string;
  channel: 'telegram' | 'alexa';
  prompts: string[];
} {
  let groupFolder = 'main';
  let channel: 'telegram' | 'alexa' = 'telegram';
  const prompts: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value) continue;
    if (value === '--group' && argv[i + 1]) {
      groupFolder = argv[i + 1]!;
      i += 1;
      continue;
    }
    if (value === '--channel' && argv[i + 1]) {
      const next = argv[i + 1]!;
      if (next === 'telegram' || next === 'alexa') {
        channel = next;
      }
      i += 1;
      continue;
    }
    prompts.push(value);
  }

  return {
    groupFolder,
    channel,
    prompts: prompts.length > 0 ? [prompts.join(' ')] : DEFAULT_PROMPTS,
  };
}

async function main(): Promise<void> {
  initDatabase();
  const { groupFolder, channel, prompts } = parseArgs(process.argv.slice(2));
  const env = {
    ...process.env,
    ...readEnvFile([...CALENDAR_ENV_KEYS]),
  };
  const tasks = getAllTasks().filter((task) => task.group_folder === groupFolder);
  const timeZone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago';

  for (const prompt of prompts) {
    const response = await buildDailyCompanionResponse(prompt, {
      channel,
      groupFolder,
      now: new Date(),
      timeZone,
      env,
      tasks,
    });

    process.stdout.write(`PROMPT: ${prompt}\n`);
    if (!response) {
      process.stdout.write('NO_RESPONSE\n\n');
      continue;
    }

    process.stdout.write(`MODE: ${response.mode}\n`);
    process.stdout.write(`LEAD_REASON: ${response.leadReason}\n`);
    process.stdout.write(
      `USED_THREADS: ${
        response.context.usedThreadTitles.length > 0
          ? response.context.usedThreadTitles.join(', ')
          : 'none'
      }\n`,
    );
    process.stdout.write(
      `SIGNALS: ${
        response.signalsUsed.length > 0
          ? response.signalsUsed.join(', ')
          : 'none'
      }\n`,
    );
    process.stdout.write('REPLY:\n');
    process.stdout.write(`${response.reply}\n\n`);
  }
}

main().catch((error) => {
  process.stderr.write(
    `debug-daily-companion failed: ${
      error instanceof Error ? error.stack || error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
