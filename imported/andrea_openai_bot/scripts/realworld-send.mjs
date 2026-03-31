/**
 * Send or dry-run the real-world message corpus via Telegram Bot API.
 *
 * Usage:
 *   node scripts/realworld-send.mjs --dry-run
 *   node scripts/realworld-send.mjs --dry-run --limit 5
 *   node scripts/realworld-send.mjs --send --delay-ms 45000 --jitter-ms 15000
 *
 * Env for --send:
 *   TELEGRAM_BOT_TOKEN   (required)
 *   TELEGRAM_CHAT_ID     (required) e.g. numeric chat id or @channelusername
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const corpusPath = path.join(__dirname, 'fixtures', 'realworld-messages.json');

function parseArgs(argv) {
  let dryRun = false;
  let send = false;
  let limit = Infinity;
  let delayMs = 30_000;
  let jitterMs = 10_000;
  let category = null;

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--send') send = true;
    else if (a === '--limit' && argv[i + 1]) {
      limit = parseInt(argv[++i], 10);
    } else if (a === '--delay-ms' && argv[i + 1]) {
      delayMs = parseInt(argv[++i], 10);
    } else if (a === '--jitter-ms' && argv[i + 1]) {
      jitterMs = parseInt(argv[++i], 10);
    } else if (a === '--category' && argv[i + 1]) {
      category = argv[++i];
    }
  }

  if (!dryRun && !send) {
    dryRun = true;
  }
  if (dryRun && send) {
    console.error('Use either --dry-run or --send, not both.');
    process.exit(1);
  }

  return { dryRun, send, limit, delayMs, jitterMs, category };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function telegramSend(token, chatId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(JSON.stringify(data));
  }
  return data;
}

async function main() {
  const opts = parseArgs(process.argv);
  const raw = fs.readFileSync(corpusPath, 'utf8');
  const corpus = JSON.parse(raw);
  let list = corpus.messages;
  if (opts.category) {
    list = list.filter((m) => m.category === opts.category);
  }
  list = list.slice(0, opts.limit);

  const repoRoot = path.join(__dirname, '..');
  const logPath = path.join(
    repoRoot,
    'logs',
    `realworld-send-log-${Date.now()}.jsonl`,
  );

  console.log(
    `Mode: ${opts.send ? 'SEND' : 'DRY-RUN'} | messages: ${list.length} | delay ${opts.delayMs}±${opts.jitterMs}ms`,
  );

  if (opts.send && list.length) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
  }

  if (opts.send) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
      console.error(
        'TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required for --send',
      );
      process.exit(1);
    }
  }

  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    const line = {
      ts: new Date().toISOString(),
      id: m.id,
      category: m.category,
      expect: m.expect,
      textPreview: m.text.slice(0, 120),
    };

    if (opts.dryRun) {
      console.log(`${m.id} [${m.category}] ${m.text.slice(0, 80)}...`);
    } else {
      await telegramSend(
        process.env.TELEGRAM_BOT_TOKEN,
        process.env.TELEGRAM_CHAT_ID,
        m.text,
      );
      line.sent = true;
      fs.appendFileSync(logPath, JSON.stringify(line) + '\n', 'utf8');
      console.log(`Sent ${m.id}`);
      if (i < list.length - 1) {
        const jitter = Math.floor(Math.random() * opts.jitterMs);
        await sleep(opts.delayMs + jitter);
      }
    }
  }

  if (opts.send && list.length) {
    console.log(`Append log: ${logPath}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
