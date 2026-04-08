import { computeNextTelegramRoundtripDueAt } from '../src/ping-presence.js';

const [, , reference] = process.argv;

const nextDueAt = computeNextTelegramRoundtripDueAt(reference || null);
if (nextDueAt) {
  console.log(nextDueAt);
}
