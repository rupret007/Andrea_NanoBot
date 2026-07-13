import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildHermeticTestEnv,
  withTestNetworkGuard,
} from './hermetic-test-env.js';

const originalDeterministicStorageMode =
  process.env.ANDREA_DETERMINISTIC_STORAGE_MODE;

function runGuardedNode(source: string): string {
  return execFileSync(process.execPath, ['-e', source], {
    encoding: 'utf8',
    env: buildHermeticTestEnv({ PATH: process.env.PATH }),
  });
}

describe('hermetic deterministic test environment', () => {
  afterEach(() => {
    if (originalDeterministicStorageMode === undefined) {
      delete process.env.ANDREA_DETERMINISTIC_STORAGE_MODE;
    } else {
      process.env.ANDREA_DETERMINISTIC_STORAGE_MODE =
        originalDeterministicStorageMode;
    }
    vi.resetModules();
  });

  it('suppresses provider env fallback, isolates storage, and preloads the network guard once', () => {
    const first = buildHermeticTestEnv({
      NODE_OPTIONS: '--trace-warnings',
      ANDREA_DETERMINISTIC_STORAGE_MODE: 'unsafe-inherited-value',
    });
    const second = withTestNetworkGuard(first.NODE_OPTIONS);

    expect(first.ANDREA_TEST_DISABLE_PROVIDER_ENV_FILE).toBe('1');
    expect(first.ANDREA_DETERMINISTIC_STORAGE_MODE).toBe('memory');
    expect(first.NODE_OPTIONS).toContain('--trace-warnings');
    const expectedGuardUrl = new URL(
      '../scripts/test-network-guard.mjs',
      import.meta.url,
    ).href;
    expect(first.NODE_OPTIONS).toContain(`--import=${expectedGuardUrl}`);
    expect(second.match(/test-network-guard\.mjs/g)).toHaveLength(1);

    const liveStorage = buildHermeticTestEnv(first, {
      isolateStorage: false,
    });
    expect(liveStorage.ANDREA_DETERMINISTIC_STORAGE_MODE).toBeUndefined();
    expect(liveStorage.ANDREA_TEST_DISABLE_PROVIDER_ENV_FILE).toBe('1');
    expect(liveStorage.NODE_OPTIONS).toContain('test-network-guard.mjs');
  });

  it('removes inherited credentials, provider endpoints, and live-evaluation opt-ins', () => {
    const unsafeKeys = [
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL',
      'ANTHROPIC_AUTH_TOKEN',
      'MINIMAX_OPENAI_BASE_URL',
      'GEMINI_API_KEY',
      'OLLAMA_BASE_URL',
      'BRAVE_SEARCH_API_KEY',
      'ONECLI_API_KEY',
      'ONECLI_BASE_URL',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'AWS_ACCESS_KEY_ID',
      'TELEGRAM_BOT_TOKEN',
      'CUSTOM_CLIENT_SECRET',
      'CUSTOM_PROVIDER_ENDPOINT',
      'CUSTOM_API_URL',
      'ALLOW_LIVE_COUNCIL',
      'ANDREA_OPENAI_BACKEND_ENABLED',
      'CODEX_LOCAL_ENABLED',
      'ANDREA_LIVE_EVAL_ENABLED',
      'ANDREA_LIVE_EVAL_COST_CAP_USD',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'NO_PROXY',
      'http_proxy',
      'https_proxy',
      'all_proxy',
      'no_proxy',
      'Http_Proxy',
      'Node_Options',
      'OpenAi_Api_Key',
      'CuStOm_Provider_Endpoint',
      'AndReA_EvAlUaTiOn_OrIgIn',
      'aNdReA_DeTeRmInIsTiC_StOrAgE_MoDe',
    ];
    const environment = Object.fromEntries(
      unsafeKeys.map((key) => [key, `unsafe-${key.toLowerCase()}`]),
    );
    const result = buildHermeticTestEnv({
      ...environment,
      PATH: '/safe/bin',
      CI: '1',
      ANDREA_EVALUATION_ORIGIN: 'live',
    });

    for (const key of unsafeKeys) expect(result[key]).toBeUndefined();
    expect(result.PATH).toBe('/safe/bin');
    expect(result.CI).toBe('1');
    expect(result.ANDREA_EVALUATION_ORIGIN).toBe('synthetic');
    expect(result.ANDREA_DETERMINISTIC_STORAGE_MODE).toBe('memory');
    expect(result.NODE_OPTIONS).not.toContain('unsafe-node_options');
  });

  it('keeps Windows preload paths as file URLs and adds them exactly once', () => {
    const guardUrl =
      'file:///D:/a/Andrea_NanoBot/Andrea_NanoBot/scripts/test-network-guard.mjs';
    const first = withTestNetworkGuard('--trace-warnings', guardUrl);
    const second = withTestNetworkGuard(first, guardUrl);

    expect(first).toBe(`--trace-warnings --import=${guardUrl}`);
    expect(second).toBe(first);
    expect(second).not.toContain('--import=D:');
    expect(second.match(/test-network-guard\.mjs/g)).toHaveLength(1);
  });

  it('discards inherited preload collisions and keeps only benign Node options', () => {
    const guardUrl = 'file:///D:/repo/scripts/test-network-guard.mjs';
    const collision = `--trace-warnings --import=${guardUrl}.disabled`;
    const guarded = withTestNetworkGuard(collision, guardUrl);

    expect(guarded).toBe(`--trace-warnings --import=${guardUrl}`);
    expect(guarded.trim().split(/\s+/)).toContain(`--import=${guardUrl}`);
    expect(guarded).not.toContain('.disabled');
    expect(
      withTestNetworkGuard(
        '--require=/tmp/escape.cjs --import=file:///tmp/escape.mjs',
        guardUrl,
      ),
    ).toBe(`--import=${guardUrl}`);
  });

  it('denies a non-loopback request in a spawned deterministic process', () => {
    const output = runGuardedNode(
      "fetch('https://example.com').then(() => process.exit(2)).catch((error) => process.stdout.write(error.message))",
    );

    expect(output).toContain(
      'External network access is disabled for deterministic tests',
    );
  });

  it('denies external fetch, HTTP, HTTPS, TCP, TLS, and UDP without leaking targets', () => {
    const output = runGuardedNode(String.raw`
      const dgram = require('node:dgram');
      const http = require('node:http');
      const https = require('node:https');
      const net = require('node:net');
      const tls = require('node:tls');
      const expected = 'ANDREA_DETERMINISTIC_NETWORK_DENIED';
      const passed = [];
      async function denied(name, operation) {
        try {
          await operation();
          throw new Error(name + ' unexpectedly reached the network');
        } catch (error) {
          if (error.code !== expected) throw error;
          if (error.message.includes('do-not-leak')) {
            throw new Error(name + ' leaked its target');
          }
          passed.push(name);
        }
      }
      (async () => {
        await denied('fetch', () => fetch('https://do-not-leak.example/path?token=do-not-leak'));
        await denied('http', () => http.get('http://do-not-leak.example/'));
        await denied('https', () => https.get('https://do-not-leak.example/'));
        await denied('net', () => net.connect(80, 'do-not-leak.example'));
        await denied('tls', () => tls.connect(443, 'do-not-leak.example'));
        await denied('dgram', () => {
          const socket = dgram.createSocket('udp4');
          try {
            return socket.send('probe', 53, '192.0.2.1');
          } finally {
            try { socket.close(); } catch {}
          }
        });
        process.stdout.write(passed.join(','));
      })().catch((error) => {
        process.stderr.write(error.stack || String(error));
        process.exit(1);
      });
    `);

    expect(output).toBe('fetch,http,https,net,tls,dgram');
  });

  it('denies callback, promise, and resolver DNS while resolving loopback locally', () => {
    const output = runGuardedNode(String.raw`
      const dns = require('node:dns');
      const dnsPromises = require('node:dns/promises');
      const expected = 'ANDREA_DETERMINISTIC_NETWORK_DENIED';
      const denied = [];
      async function expectDenied(name, operation) {
        try {
          await operation();
          throw new Error(name + ' unexpectedly resolved externally');
        } catch (error) {
          if (error.code !== expected) throw error;
          if (error.message.includes('do-not-leak')) {
            throw new Error(name + ' leaked its target');
          }
          denied.push(name);
        }
      }
      (async () => {
        await expectDenied('lookup', () => new Promise((resolve, reject) => {
          dns.lookup('do-not-leak.example', (error, value) => error ? reject(error) : resolve(value));
        }));
        await expectDenied('resolve', () => dnsPromises.resolve4('do-not-leak.example'));
        await expectDenied('reverse', () => new dnsPromises.Resolver().reverse('192.0.2.1'));

        const callbackLookup = await new Promise((resolve, reject) => {
          dns.lookup('localhost', { all: true }, (error, value) => error ? reject(error) : resolve(value));
        });
        const promiseLookup = await dnsPromises.lookup('localhost');
        const localResolve = await dnsPromises.resolve4('localhost');
        const localReverse = await dnsPromises.reverse('127.0.0.1');
        process.stdout.write(JSON.stringify({
          denied,
          callbackLookup,
          promiseLookup,
          localResolve,
          localReverse,
        }));
      })().catch((error) => {
        process.stderr.write(error.stack || String(error));
        process.exit(1);
      });
    `);

    expect(JSON.parse(output)).toEqual({
      denied: ['lookup', 'resolve', 'reverse'],
      callbackLookup: [{ address: '127.0.0.1', family: 4 }],
      promiseLookup: { address: '127.0.0.1', family: 4 },
      localResolve: ['127.0.0.1'],
      localReverse: ['localhost'],
    });
  });

  it('allows loopback HTTP, TCP, and UDP in a spawned deterministic process', () => {
    const output = runGuardedNode(String.raw`
      const dgram = require('node:dgram');
      const http = require('node:http');
      const server = http.createServer((_request, response) => response.end('http-ok'));
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        http.get({ host: '127.0.0.1', port, path: '/' }, (response) => {
          let body = '';
          response.on('data', (chunk) => { body += chunk; });
          response.on('end', () => {
            server.close(() => {
              const udpServer = dgram.createSocket('udp4');
              const udpClient = dgram.createSocket('udp4');
              udpServer.on('message', (message) => {
                udpClient.close();
                udpServer.close(() => process.stdout.write(body + ',' + message));
              });
              udpServer.bind(0, '127.0.0.1', () => {
                udpClient.send(
                  'udp-ok',
                  udpServer.address().port,
                  '127.0.0.1',
                );
              });
            });
          });
        });
      });
      setTimeout(() => {
        process.stderr.write('loopback test timed out');
        process.exit(1);
      }, 3000).unref();
    `);

    expect(output).toBe('http-ok,udp-ok');
  });

  it('propagates the preload and fails closed on child-process guard bypasses', () => {
    const output = runGuardedNode(String.raw`
      const { execFileSync, spawnSync } = require('node:child_process');
      const nested = execFileSync(
        process.execPath,
        [
          '-e',
          "try { require('node:http').get('http://192.0.2.1'); process.exit(2); } catch (error) { process.stdout.write(error.code); }",
        ],
        { encoding: 'utf8', env: { PATH: process.env.PATH } },
      );
      let clientCode = '';
      try {
        spawnSync('curl', ['https://example.com']);
      } catch (error) {
        clientCode = error.code;
      }
      const denied = [];
      const expectDenied = (name, operation) => {
        try {
          operation();
          throw new Error(name + ' unexpectedly bypassed the guard');
        } catch (error) {
          if (error.code !== 'ANDREA_DETERMINISTIC_NETWORK_DENIED') throw error;
          denied.push(name);
        }
      };
      expectDenied('env-unset', () => execFileSync(
        'env',
        ['-u', 'NODE_OPTIONS', process.execPath, '-e', 'process.exit(0)'],
      ));
      expectDenied('shell-unset', () => execFileSync(
        'sh',
        ['-c', 'unset NODE_OPTIONS; exec "$1" -e "process.exit(0)"', 'sh', process.execPath],
      ));
      expectDenied('shell-indirect', () => execFileSync(
        'bash',
        ['-c', 'v=NODE_OPTIONS; export -n "$v"; exec "$1" -e "process.exit(0)"', 'bash', process.execPath],
      ));
      expectDenied('interpreter', () => spawnSync('python3', ['-c', 'pass']));
      expectDenied('unknown-client', () => spawnSync('custom-network-client', []));
      expectDenied('git-fetch', () => spawnSync('git', ['-C', '.', 'fetch']));
      expectDenied('git-alias', () => spawnSync('git', [
        '-c',
        'alias.guardbypass=!export -n NODE_OPTIONS; node -e "process.exit(0)"',
        'guardbypass',
      ]));
      expectDenied('git-hook', () => spawnSync('git', [
        '-c',
        'core.hooksPath=.git/hooks',
        'commit',
        '--allow-empty',
        '-m',
        'guard-bypass',
      ]));
      expectDenied('git-clean-filter', () => spawnSync('git', [
        '-c',
        'filter.guard.clean=node ./network-client.js',
        'add',
        'guarded.txt',
      ]));
      expectDenied('git-textconv', () => spawnSync('git', [
        '-c',
        'diff.guard.textconv=node ./network-client.js',
        'diff',
        '--textconv',
      ]));
      expectDenied('node-import', () => spawnSync(process.execPath, [
        '--import=data:text/javascript,globalThis.guardBypassed=true',
        '-e',
        'process.exit(0)',
      ]));
      expectDenied('node-env-file', () => spawnSync(process.execPath, [
        '--env-file=.env',
        '-e',
        'process.exit(0)',
      ]));
      expectDenied('node-path-shadow', () => spawnSync(
        process.platform === 'win32' ? 'C:\\temp\\node.exe' : '/tmp/node',
        ['-e', 'process.exit(0)'],
      ));
      expectDenied('npm-audit', () => spawnSync('npm', ['--prefix', '.', 'audit']));
      expectDenied('native-service-wrapper', () => spawnSync('systemctl', ['status']));
      const nestedEnvironment = execFileSync(
        process.execPath,
        ['-e', "const keys = Object.keys(process.env).map((key) => key.toUpperCase()); process.stdout.write(String((process.env.NODE_OPTIONS.match(/test-network-guard\\.mjs/g) || []).length) + ':' + String(keys.includes('HTTP_PROXY')) + ':' + String(keys.includes('OPENAI_API_KEY')) + ':' + String(keys.filter((key) => key === 'NODE_OPTIONS').length !== 1))"],
        {
          encoding: 'utf8',
          env: { PATH: process.env.PATH, Node_Options: '--require=/tmp/escape.cjs', Http_Proxy: 'http://127.0.0.1:9999', OpenAi_Api_Key: 'mixed-case-provider-secret' },
        },
      );
      process.stdout.write(nested + ',' + clientCode + ',' + nestedEnvironment + ',' + denied.join(','));
    `);

    expect(output).toBe(
      'ANDREA_DETERMINISTIC_NETWORK_DENIED,ANDREA_DETERMINISTIC_NETWORK_DENIED,1:false:false:false,env-unset,shell-unset,shell-indirect,interpreter,unknown-client,git-fetch,git-alias,git-hook,git-clean-filter,git-textconv,node-import,node-env-file,node-path-shadow,npm-audit,native-service-wrapper',
    );
  });

  it('sanitizes child credentials without deleting parent test fixtures', () => {
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'parent-test-fixture';
    try {
      const output = execFileSync(
        process.execPath,
        [
          '-e',
          "process.stdout.write(String(Object.keys(process.env).some((key) => key.toUpperCase() === 'OPENAI_API_KEY')))",
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            OpenAi_Api_Key: 'mixed-case-child-fixture',
          },
        },
      );

      expect(output).toBe('false');
      expect(process.env.OPENAI_API_KEY).toBe('parent-test-fixture');
    } finally {
      if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
  });

  it('forces the guard into workers even when execArgv and env try to remove it', () => {
    const output = runGuardedNode(String.raw`
      const { Worker } = require('node:worker_threads');
      const worker = new Worker(
        "const { parentPort } = require('node:worker_threads'); const keys = Object.keys(process.env).map((key) => key.toUpperCase()); if (keys.includes('HTTP_PROXY') || keys.includes('OPENAI_API_KEY') || keys.filter((key) => key === 'NODE_OPTIONS').length !== 1) parentPort.postMessage('UNSAFE_ENV'); else fetch('https://worker-escape.example').then(() => parentPort.postMessage('BYPASS')).catch((error) => parentPort.postMessage(error.code))",
        {
          eval: true,
          execArgv: [],
          env: { PATH: process.env.PATH, Node_Options: '', Http_Proxy: 'http://127.0.0.1:9999', OpenAi_Api_Key: 'mixed-case-provider-secret' },
        },
      );
      worker.once('error', (error) => {
        process.stderr.write(error.stack || String(error));
        process.exit(1);
      });
      worker.once('message', async (message) => {
        process.stdout.write(String(message));
        await worker.terminate();
      });
    `);

    expect(output).toBe('ANDREA_DETERMINISTIC_NETWORK_DENIED');
  });

  it('forces the guard into forked and clustered Node descendants', () => {
    const output = runGuardedNode(String.raw`
      const cluster = require('node:cluster');
      const { fork } = require('node:child_process');
      const path = require('node:path');
      const fixture = path.join(process.cwd(), 'scripts', 'fixtures', 'network-guard-child.mjs');
      const results = [];
      const finish = (value) => {
        results.push(value);
        if (results.length !== 2) return;
        process.stdout.write(results.sort().join(','));
        cluster.disconnect();
      };
      const child = fork(fixture, [], {
        execArgv: ['--require', '/tmp/escape.cjs'],
        env: { PATH: process.env.PATH, NODE_OPTIONS: '', HTTP_PROXY: 'http://127.0.0.1:9999' },
        silent: true,
      });
      child.once('message', (message) => {
        finish('fork:' + message);
        child.disconnect();
      });
      cluster.setupPrimary({ exec: fixture, execArgv: [] });
      const worker = cluster.fork({
        NODE_OPTIONS: '',
        HTTP_PROXY: 'http://127.0.0.1:9999',
      });
      worker.once('message', (message) => {
        finish('cluster:' + message);
        worker.disconnect();
      });
      setTimeout(() => {
        process.stderr.write('fork/cluster guard test timed out');
        process.exit(1);
      }, 5000).unref();
    `);

    expect(output).toBe(
      'cluster:ANDREA_DETERMINISTIC_NETWORK_DENIED,fork:ANDREA_DETERMINISTIC_NETWORK_DENIED',
    );
  });

  it('forces the production initializer into isolated memory and rejects unknown modes', async () => {
    process.env.ANDREA_DETERMINISTIC_STORAGE_MODE = 'memory';
    let database = await import('./db.js');
    database.initDatabase();
    expect(database.isIsolatedTestDatabase()).toBe(true);
    database._closeDatabase();

    vi.resetModules();
    process.env.ANDREA_DETERMINISTIC_STORAGE_MODE =
      'sk-example-invalid-storage-mode';
    database = await import('./db.js');
    let invalidModeError: unknown;
    try {
      database.initDatabase();
    } catch (error) {
      invalidModeError = error;
    }
    expect(invalidModeError).toEqual(
      new Error('Unsupported deterministic storage mode.'),
    );
    expect(String(invalidModeError)).not.toContain('sk-example');
    expect(database.isDatabaseInitialized()).toBe(false);
  });

  it('forbids production database initialization in TypeScript test entrypoints', () => {
    const scriptsDir = path.join(process.cwd(), 'scripts');
    const violations = fs
      .readdirSync(scriptsDir)
      .filter((name) => /^test-.*\.ts$/.test(name))
      .filter((name) =>
        /\binitDatabase\b/.test(
          fs.readFileSync(path.join(scriptsDir, name), 'utf8'),
        ),
      );

    expect(violations).toEqual([]);
  });

  it('keeps the deterministic sweep on the shared portable guard boundary', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'scripts', 'test-deterministic-sweep.ts'),
      'utf8',
    );

    expect(source).not.toContain('networkGuardPath');
    expect(source).toContain("return ['--import=tsx', ...tokens.slice(3)]");
    expect(source).not.toContain('--import=./scripts/test-network-guard.mjs');
    expect(source).not.toContain("spawnSync('npm'");
    expect(source).toContain(
      'spawnSync(process.execPath, deterministicCommandArgs(script)',
    );
    expect(source).toContain(
      "['test:agi', 'AGI Vitest suite; run separately']",
    );
  });
});
