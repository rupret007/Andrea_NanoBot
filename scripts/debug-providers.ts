import {
  buildProviderAlertEvents,
  collectCredentialHealthSnapshots,
  collectProviderHealthSnapshots,
} from '../src/provider-health.js';

function printJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

const mode = process.argv[2] || 'providers';
const checkedAt = new Date().toISOString();

if (mode === 'credentials') {
  printJson({
    checkedAt,
    credentials: collectCredentialHealthSnapshots(checkedAt),
  });
} else if (mode === 'alerts') {
  const providers = collectProviderHealthSnapshots(checkedAt);
  printJson({
    checkedAt,
    alerts: buildProviderAlertEvents(providers, checkedAt),
  });
} else {
  const providers = collectProviderHealthSnapshots(checkedAt);
  printJson({
    checkedAt,
    providers,
    alertsPending: buildProviderAlertEvents(providers, checkedAt).length,
  });
}
