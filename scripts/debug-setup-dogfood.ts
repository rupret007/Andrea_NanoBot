import { _closeDatabase, _initTestDatabase, initDatabase } from '../src/db.js';
import {
  formatSetupDogfoodResult,
  runSetupDogfood,
} from '../src/setup-dogfood.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const apply = args.includes('--apply');
const groupIndex = args.indexOf('--group');
const groupFolder =
  groupIndex >= 0 ? args[groupIndex + 1] || 'setup-dogfood' : 'setup-dogfood';
const channelIndex = args.indexOf('--channel');
const channel =
  channelIndex >= 0
    ? (args[channelIndex + 1] as 'telegram' | 'bluebubbles' | 'alexa') ||
      'telegram'
    : 'telegram';

if (apply) {
  initDatabase();
} else {
  process.env.OPENAI_API_KEY = '';
  process.env.ANDREA_PROFILE_SETUP_CLOUD = 'disabled';
  _initTestDatabase();
}

runSetupDogfood({
  groupFolder,
  channel,
  apply,
  now: new Date(),
})
  .then((result) => {
    console.log(
      json ? JSON.stringify(result, null, 2) : formatSetupDogfoodResult(result),
    );
  })
  .finally(() => {
    if (!apply) _closeDatabase();
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
