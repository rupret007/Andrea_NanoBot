import { createHash } from 'node:crypto';
import fs from 'node:fs';

function fingerprint(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
}

function byteLength(value) {
  return Buffer.byteLength(String(value), 'utf8');
}

function nextSequence(filePath) {
  try {
    return (
      fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).length + 1
    );
  } catch {
    return 1;
  }
}

function appendJsonLine(filePath, value) {
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function parseInternalArguments(arguments_) {
  const remaining = [];
  let configPath = '';
  let ledgerPath = '';
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--fixture-config') {
      configPath = String(arguments_[index + 1] || '');
      index += 1;
    } else if (argument === '--fixture-ledger') {
      ledgerPath = String(arguments_[index + 1] || '');
      index += 1;
    } else {
      remaining.push(String(argument));
    }
  }
  if (!configPath || !ledgerPath) {
    throw new Error('fixture_configuration_missing');
  }
  return { configPath, ledgerPath, remaining };
}

function loadConfiguration(configPath) {
  const stat = fs.lstatSync(configPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('fixture_configuration_invalid');
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const requiredStrings = [
    'programName',
    'version',
    'resourceId',
    'readCommand',
    'readFlag',
    'destructiveCommand',
    'destructiveFlag',
    'datasetPath',
    'outputField',
    'destructiveMarkerPath',
    'effectLedgerPath',
  ];
  if (
    config.schemaVersion !== 1 ||
    requiredStrings.some(
      (key) => typeof config[key] !== 'string' || config[key].length === 0,
    )
  ) {
    throw new Error('fixture_configuration_invalid');
  }
  return config;
}

function parseDataset(datasetPath) {
  const lines = fs
    .readFileSync(datasetPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean);
  if (lines.length < 2) throw new Error('fixture_dataset_invalid');
  const headers = lines[0].split(',');
  const numericIndex = headers.indexOf('amount');
  if (numericIndex < 0) throw new Error('fixture_dataset_invalid');
  const rows = lines.slice(1).map((line) => line.split(','));
  const total = rows.reduce((sum, row) => {
    const value = Number(row[numericIndex]);
    if (!Number.isFinite(value)) throw new Error('fixture_dataset_invalid');
    return sum + value;
  }, 0);
  return {
    rows: rows.length,
    total,
    sourceFingerprint: fingerprint(fs.readFileSync(datasetPath)),
  };
}

function helpText(config) {
  return [
    `${config.programName} ${config.version}`,
    '',
    'Commands:',
    `  ${config.readCommand} ${config.readFlag}   Read and summarize the fixture dataset.`,
    `  ${config.destructiveCommand} ${config.destructiveFlag}   DESTRUCTIVE: mutate fixture state.`,
    '',
    'Discovery:',
    '  --describe-json   Print the machine-readable command contract.',
  ].join('\n');
}

function describe(config) {
  return {
    schemaVersion: 1,
    program: config.programName,
    version: config.version,
    commands: [
      {
        name: config.readCommand,
        requiredFlag: config.readFlag,
        authority: 'read_only',
        output: 'json',
      },
      {
        name: config.destructiveCommand,
        requiredFlag: config.destructiveFlag,
        authority: 'destructive_fixture_only',
        output: 'json',
      },
    ],
  };
}

function recordRequest(ledgerPath, config, operation, args, status, output) {
  appendJsonLine(ledgerPath, {
    schemaVersion: 1,
    sequence: nextSequence(ledgerPath),
    resourceId: config.resourceId,
    operationClass: 'cli_invocation',
    targetFingerprint: fingerprint(operation),
    inputFingerprint: fingerprint(JSON.stringify(args)),
    inputBytes: byteLength(JSON.stringify(args)),
    status,
    resultFingerprint: output === null ? null : fingerprint(output),
    resultBytes: output === null ? 0 : byteLength(output),
  });
}

function run() {
  const { configPath, ledgerPath, remaining } = parseInternalArguments(
    process.argv.slice(2),
  );
  const config = loadConfiguration(configPath);
  const command = remaining[0] || '--help';

  if (command === '--help' || command === '-h') {
    const output = helpText(config);
    recordRequest(ledgerPath, config, 'help', remaining, 'completed', output);
    process.stdout.write(`${output}\n`);
    return;
  }
  if (command === '--describe-json') {
    const output = JSON.stringify(describe(config));
    recordRequest(
      ledgerPath,
      config,
      'describe',
      remaining,
      'completed',
      output,
    );
    process.stdout.write(`${output}\n`);
    return;
  }
  if (
    command === config.readCommand &&
    remaining.slice(1).includes(config.readFlag)
  ) {
    const summary = parseDataset(config.datasetPath);
    const output = JSON.stringify({
      [config.outputField]: summary.total,
      rows: summary.rows,
      sourceFingerprint: summary.sourceFingerprint,
    });
    recordRequest(ledgerPath, config, 'read', remaining, 'completed', output);
    process.stdout.write(`${output}\n`);
    return;
  }
  if (
    command === config.destructiveCommand &&
    remaining.slice(1).includes(config.destructiveFlag)
  ) {
    let outcome = 'applied';
    try {
      const descriptor = fs.openSync(config.destructiveMarkerPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, 'fixture-destructive-effect\n');
      fs.closeSync(descriptor);
    } catch (error) {
      if (error?.code === 'EEXIST') outcome = 'duplicate';
      else throw error;
    }
    appendJsonLine(config.effectLedgerPath, {
      schemaVersion: 1,
      sequence: nextSequence(config.effectLedgerPath),
      resourceId: config.resourceId,
      effectClass: 'cli_destructive_action',
      idempotencyFingerprint: fingerprint(
        `${config.resourceId}:${config.destructiveCommand}`,
      ),
      targetFingerprint: fingerprint(config.destructiveMarkerPath),
      outcome,
      markerFingerprint: fingerprint('fixture-destructive-effect'),
    });
    const output = JSON.stringify({ outcome });
    recordRequest(
      ledgerPath,
      config,
      'destructive',
      remaining,
      'completed',
      output,
    );
    process.stdout.write(`${output}\n`);
    return;
  }

  recordRequest(ledgerPath, config, 'invalid', remaining, 'blocked', null);
  process.stderr.write('fixture_cli_invalid_invocation\n');
  process.exitCode = 64;
}

try {
  run();
} catch {
  process.stderr.write('fixture_cli_failed_closed\n');
  process.exitCode = 1;
}
