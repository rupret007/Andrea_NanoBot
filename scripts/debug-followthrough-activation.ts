import { initDatabase } from '../src/db.js';
import {
  applyFollowThroughActivation,
  buildFollowThroughActivationPreview,
  type FollowThroughActivationCandidateSelector,
} from '../src/follow-through-activation.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const apply = args.includes('--apply');
const preview = args.includes('--preview') || !apply;

function argValue(name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  return args[index + 1] || null;
}

function parseCandidate(
  value: string | null,
): FollowThroughActivationCandidateSelector {
  const raw = (value || 'safest').trim().toLowerCase();
  if (raw === 'first') return 'first';
  if (raw === 'safest' || raw === 'safe') return 'safest';
  const number = Number.parseInt(raw.replace(/^#/, ''), 10);
  return Number.isFinite(number) && number > 0 ? number : 'safest';
}

function printResult(value: unknown): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

const groupFolder = argValue('--group') || 'main';
const candidate = parseCandidate(argValue('--candidate'));
const timing = argValue('--timing');
const chatJid = argValue('--chat') || `local:followthrough:${groupFolder}`;

initDatabase();

if (apply) {
  if (!timing) {
    console.error(
      'Missing --timing. Example: npm run debug:followthrough-activation -- --apply --candidate safest --timing tonight --group main --json',
    );
    process.exitCode = 1;
  } else {
    const result = await applyFollowThroughActivation({
      groupFolder,
      candidate,
      timing,
      channel: 'telegram',
      chatJid,
      metadataOnly: true,
    });
    printResult(result);
  }
} else if (preview) {
  const result = buildFollowThroughActivationPreview({
    groupFolder,
    candidate,
    timing,
  });
  printResult(result);
}
