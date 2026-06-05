import {
  buildProviderAlertEvents,
  collectCredentialHealthSnapshots,
  collectProviderHealthSnapshots,
} from '../src/provider-health.js';
import { collectProviderHealthSnapshotsWithLiveProbe } from '../src/provider-live-probe.js';

function printJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

const args = new Set(process.argv.slice(2));
const mode =
  process.argv
    .slice(2)
    .find((arg) => !arg.startsWith('--')) || 'providers';
const liveProbe = args.has('--live') || !args.has('--config-only');
const checkedAt = new Date().toISOString();

async function collectProvidersForDebug() {
  return liveProbe
    ? collectProviderHealthSnapshotsWithLiveProbe(checkedAt)
    : collectProviderHealthSnapshots(checkedAt);
}

if (mode === 'credentials') {
  printJson({
    checkedAt,
    credentials: collectCredentialHealthSnapshots(checkedAt),
  });
} else if (mode === 'alerts') {
  const providers = await collectProvidersForDebug();
  printJson({
    checkedAt,
    liveProbe,
    alerts: buildProviderAlertEvents(providers, checkedAt),
  });
} else {
  const providers = await collectProvidersForDebug();
  printJson({
    checkedAt,
    liveProbe,
    providers,
    alertsPending: buildProviderAlertEvents(providers, checkedAt).length,
  });
}
