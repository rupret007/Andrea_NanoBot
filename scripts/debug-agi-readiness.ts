import { _initTestDatabase, initDatabase } from '../src/db.js';
import {
  formatAgiReadinessReport,
  runAgiGauntlet,
} from '../src/agi-gauntlet.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const live = args.includes('--live-db');
const persist = args.includes('--persist-synthetic');

// The gauntlet can seed synthetic reliability/verification records. By
// default it runs against an isolated in-memory database and never touches
// live ledgers. --live-db opts into reading the real workspace, but synthetic
// writes remain disabled unless --persist-synthetic is also present.
if (live) {
  initDatabase();
} else {
  _initTestDatabase();
}

const report = runAgiGauntlet({ persist: live ? persist : undefined });
console.log(
  json ? JSON.stringify(report, null, 2) : formatAgiReadinessReport(report),
);
if (!live) {
  console.log(
    '(ran against an isolated synthetic database; use --live-db to include live workspace state)',
  );
} else if (!persist) {
  console.log(
    '(read live workspace state with synthetic writes disabled; add --persist-synthetic only for an intentional seeded benchmark run)',
  );
}
