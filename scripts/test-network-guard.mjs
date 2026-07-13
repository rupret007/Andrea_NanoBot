import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';
import workerThreads from 'node:worker_threads';

const STATE_KEY = Symbol.for('andrea.test-network-guard');
const DENIAL_CODE = 'ANDREA_DETERMINISTIC_NETWORK_DENIED';
const GUARD_PRELOAD = `--import=${import.meta.url}`;
const PROXY_ENV_KEYS = new Set([
  'ALL_PROXY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
]);
const FORCED_ENV_KEYS = new Set([
  'ANDREA_EVALUATION_ORIGIN',
  'ANDREA_TEST_DISABLE_PROVIDER_ENV_FILE',
  'ANDREA_TEST_NETWORK_GUARD_ACTIVE',
  'NODE_OPTIONS',
]);
const PROVIDER_ENV_PREFIXES = [
  'ANTHROPIC_',
  'AWS_',
  'AZURE_',
  'BEDROCK_',
  'BRACE_',
  'BRAVE_',
  'CLAUDE_',
  'CLAUDE_CODE_',
  'CODEX_',
  'COHERE_',
  'CURSOR_',
  'DEEPSEEK_',
  'EXA_',
  'FIREWORKS_',
  'GEMINI_',
  'GOOGLE_',
  'GROQ_',
  'HUGGINGFACE_',
  'LMSTUDIO_',
  'MINIMAX_',
  'MISTRAL_',
  'OLLAMA_',
  'ONECLI_',
  'OPENAI_',
  'OPENROUTER_',
  'PERPLEXITY_',
  'REPLICATE_',
  'SERPER_',
  'TAVILY_',
  'TOGETHER_',
  'VERTEX_AI_',
  'VLLM_',
  'VOYAGE_',
  'XAI_',
];
const PROVIDER_ENV_EXACT_KEYS = new Set([
  'ANDREA_OPENAI_BACKEND_ENABLED',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_API_KEY',
  'HF_TOKEN',
  'NANOCLAW_AGENT_MODEL',
]);
const CREDENTIAL_ENV_SUFFIX =
  /(?:^|_)(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|SECRET_ACCESS_KEY|SESSION_TOKEN|TOKEN|PRIVATE_KEY|PASSWORD|CREDENTIALS)$/;
const ENDPOINT_ENV_SUFFIX =
  /(?:^|_)(?:BASE_URL|ENDPOINT|ENDPOINT_URL|API_URL)$/;
const LIVE_EVALUATION_ENV_KEY =
  /(?:^|_)(?:LIVE|NETWORKED)(?:_|$)|^ANDREA_EVALUATION(?:_|$)|(?:^|_)(?:EVALUATION|SCORECARD|BENCHMARK|COUNCIL|PROVIDER)_(?:MODE|ORIGIN)$/;
const DNS_RESOLVE_METHODS = [
  'resolve',
  'resolve4',
  'resolve6',
  'resolveAny',
  'resolveCaa',
  'resolveCname',
  'resolveMx',
  'resolveNaptr',
  'resolveNs',
  'resolvePtr',
  'resolveSoa',
  'resolveSrv',
  'resolveTxt',
];

function denialError(kind) {
  const error = new Error(
    `External network access is disabled for deterministic tests (${kind}).`,
  );
  error.code = DENIAL_CODE;
  return error;
}

function isUnsafeEnvironmentKey(key) {
  const normalizedKey = String(key).toUpperCase();
  return (
    FORCED_ENV_KEYS.has(normalizedKey) ||
    PROVIDER_ENV_EXACT_KEYS.has(normalizedKey) ||
    PROXY_ENV_KEYS.has(normalizedKey) ||
    PROVIDER_ENV_PREFIXES.some((prefix) => normalizedKey.startsWith(prefix)) ||
    CREDENTIAL_ENV_SUFFIX.test(normalizedKey) ||
    ENDPOINT_ENV_SUFFIX.test(normalizedKey) ||
    LIVE_EVALUATION_ENV_KEY.test(normalizedKey)
  );
}

function normalizedHost(hostname) {
  if (hostname === undefined || hostname === null || hostname === '') {
    return 'localhost';
  }
  const value = String(hostname).trim().toLowerCase().replace(/\.$/, '');
  if (value.startsWith('[')) {
    const closingBracket = value.indexOf(']');
    return closingBracket > 0 ? value.slice(1, closingBracket) : value;
  }
  const colonCount = (value.match(/:/g) || []).length;
  return colonCount === 1 ? value.slice(0, value.indexOf(':')) : value;
}

function isLoopbackHost(hostname) {
  const normalized = normalizedHost(hostname);
  return (
    normalized === 'localhost' ||
    normalized === '::' ||
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    normalized === '0.0.0.0' ||
    normalized.startsWith('127.') ||
    normalized.startsWith('::ffff:127.')
  );
}

function callbackFrom(args) {
  const callback = args.findLast((argument) => typeof argument === 'function');
  if (typeof callback !== 'function') {
    throw new TypeError('A callback is required for deterministic DNS.');
  }
  return callback;
}

function loopbackAddress(hostname, familyPreference = 0) {
  const hostnameValue = normalizedHost(hostname);
  if (hostnameValue.startsWith('127.') || hostnameValue === '0.0.0.0') {
    return { address: hostnameValue, family: 4 };
  }
  if (
    hostnameValue === '::' ||
    hostnameValue === '::1' ||
    hostnameValue === '0:0:0:0:0:0:0:1' ||
    hostnameValue.startsWith('::ffff:127.')
  ) {
    return { address: hostnameValue, family: 6 };
  }
  return familyPreference === 6
    ? { address: '::1', family: 6 }
    : { address: '127.0.0.1', family: 4 };
}

function lookupResult(hostname, options) {
  const rawFamily =
    typeof options === 'number'
      ? options
      : options && typeof options === 'object'
        ? options.family || 0
        : 0;
  const family =
    rawFamily === 6 || String(rawFamily).toLowerCase() === 'ipv6' ? 6 : 4;
  const result = loopbackAddress(hostname, family);
  return options && typeof options === 'object' && options.all
    ? [result]
    : result;
}

function dnsRecordType(method, args) {
  if (method === 'resolve') {
    return typeof args[0] === 'string' ? args[0].toUpperCase() : 'A';
  }
  if (method === 'resolve4') return 'A';
  if (method === 'resolve6') return 'AAAA';
  return method.slice('resolve'.length).toUpperCase();
}

function resolveResult(method, args) {
  const type = dnsRecordType(method, args);
  const options = args.find(
    (argument) => argument && typeof argument === 'object',
  );
  switch (type) {
    case 'A':
      return options?.ttl ? [{ address: '127.0.0.1', ttl: 0 }] : ['127.0.0.1'];
    case 'AAAA':
      return options?.ttl ? [{ address: '::1', ttl: 0 }] : ['::1'];
    case 'ANY':
      return [
        { address: '127.0.0.1', ttl: 0, type: 'A' },
        { address: '::1', ttl: 0, type: 'AAAA' },
      ];
    case 'CNAME':
    case 'PTR':
      return ['localhost'];
    case 'SOA':
      return {
        expire: 0,
        hostmaster: 'localhost',
        minttl: 0,
        nsname: 'localhost',
        refresh: 0,
        retry: 0,
        serial: 0,
      };
    case 'TXT':
      return [['localhost']];
    default:
      return [];
  }
}

function installCallbackDnsGuard(target) {
  target.lookup = (hostname, options, callback) => {
    assertLoopback(hostname, 'dns');
    const actualCallback = callbackFrom([options, callback]);
    const result = lookupResult(hostname, options);
    queueMicrotask(() => {
      if (Array.isArray(result)) actualCallback(null, result);
      else actualCallback(null, result.address, result.family);
    });
  };
  target.lookupService = (address, port, callback) => {
    assertLoopback(address, 'dns');
    const actualCallback = callbackFrom([callback]);
    queueMicrotask(() => actualCallback(null, 'localhost', String(port)));
  };
  target.reverse = (address, callback) => {
    assertLoopback(address, 'dns');
    const actualCallback = callbackFrom([callback]);
    queueMicrotask(() => actualCallback(null, ['localhost']));
  };
  for (const method of DNS_RESOLVE_METHODS) {
    if (typeof target[method] !== 'function') continue;
    target[method] = (hostname, ...args) => {
      assertLoopback(hostname, 'dns');
      const actualCallback = callbackFrom(args);
      const result = resolveResult(method, args);
      queueMicrotask(() => actualCallback(null, result));
    };
  }
}

function installPromiseDnsGuard(target) {
  target.lookup = async (hostname, options) => {
    assertLoopback(hostname, 'dns');
    return lookupResult(hostname, options);
  };
  target.lookupService = async (address, port) => {
    assertLoopback(address, 'dns');
    return { hostname: 'localhost', service: String(port) };
  };
  target.reverse = async (address) => {
    assertLoopback(address, 'dns');
    return ['localhost'];
  };
  for (const method of DNS_RESOLVE_METHODS) {
    if (typeof target[method] !== 'function') continue;
    target[method] = async (hostname, ...args) => {
      assertLoopback(hostname, 'dns');
      return resolveResult(method, args);
    };
  }
}

function installResolverGuards(Resolver, promiseMode) {
  if (typeof Resolver !== 'function') return;
  const target = Resolver.prototype;
  const methods = [...DNS_RESOLVE_METHODS, 'reverse'];
  for (const method of methods) {
    if (typeof target[method] !== 'function') continue;
    if (promiseMode) {
      target[method] = async (hostname, ...args) => {
        assertLoopback(hostname, 'dns');
        return method === 'reverse'
          ? ['localhost']
          : resolveResult(method, args);
      };
    } else {
      target[method] = function (hostname, ...args) {
        assertLoopback(hostname, 'dns');
        const actualCallback = callbackFrom(args);
        const result =
          method === 'reverse' ? ['localhost'] : resolveResult(method, args);
        queueMicrotask(() => actualCallback(null, result));
      };
    }
  }
}

function assertLoopback(hostname, kind) {
  if (!isLoopbackHost(hostname)) throw denialError(kind);
}

function urlFor(input) {
  try {
    if (input instanceof URL) return input;
    if (typeof Request !== 'undefined' && input instanceof Request) {
      return new URL(input.url);
    }
    if (typeof input === 'string') return new URL(input);
    return new URL(String(input));
  } catch {
    throw denialError('invalid-target');
  }
}

function assertLocalUrl(input, kind) {
  const url = urlFor(input);
  if (url.protocol === 'data:' || url.protocol === 'blob:') return;
  assertLoopback(url.hostname, kind);
}

function hostFromHttpArguments(args) {
  const [first, second] = args;
  let hostname = 'localhost';
  if (first instanceof URL || typeof first === 'string') {
    hostname = urlFor(first).hostname;
  } else if (first && typeof first === 'object') {
    if (typeof first.socketPath === 'string') return undefined;
    hostname = first.hostname ?? first.host ?? hostname;
  }
  if (second && typeof second === 'object' && !Array.isArray(second)) {
    if (typeof second.socketPath === 'string') return undefined;
    hostname = second.hostname ?? second.host ?? hostname;
  }
  return hostname;
}

function assertHttpArguments(args, kind) {
  const hostname = hostFromHttpArguments(args);
  if (hostname !== undefined) assertLoopback(hostname, kind);
}

function normalizedConnectionArguments(args) {
  if (Array.isArray(args[0])) return args[0];
  return args;
}

function hostFromConnectionArguments(inputArgs) {
  const args = normalizedConnectionArguments(inputArgs);
  const [first, second] = args;
  if (first && typeof first === 'object') {
    if (typeof first.path === 'string') return undefined;
    return first.host ?? first.hostname ?? 'localhost';
  }
  if (typeof first === 'number') {
    return typeof second === 'string' ? second : 'localhost';
  }
  // A string first argument is a Unix socket or Windows named-pipe path.
  return undefined;
}

function assertConnectionArguments(args, kind) {
  const hostname = hostFromConnectionArguments(args);
  if (hostname !== undefined) assertLoopback(hostname, kind);
}

function hostFromDgramSendArguments(args) {
  const remaining = args.slice(1);
  if (typeof remaining.at(-1) === 'function') remaining.pop();
  if (
    remaining.length >= 4 &&
    typeof remaining[0] === 'number' &&
    typeof remaining[1] === 'number' &&
    typeof remaining[2] === 'number'
  ) {
    return typeof remaining[3] === 'string' ? remaining[3] : 'localhost';
  }
  if (remaining.length >= 2 && typeof remaining[0] === 'number') {
    return typeof remaining[1] === 'string' ? remaining[1] : 'localhost';
  }
  // A connected socket was already checked by dgram.connect().
  return undefined;
}

function canonicalPath(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return '';
  try {
    const resolved = fs.realpathSync.native(file);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  } catch {
    return '';
  }
}

const CANONICAL_NODE_PATH = canonicalPath(process.execPath);

function isCanonicalNodeExecutable(file) {
  return Boolean(
    CANONICAL_NODE_PATH && canonicalPath(file) === CANONICAL_NODE_PATH,
  );
}

function ensureGuardEnvironment() {
  for (const key of Object.keys(process.env)) {
    if (isUnsafeEnvironmentKey(key)) delete process.env[key];
  }
  process.env.ANDREA_TEST_DISABLE_PROVIDER_ENV_FILE = '1';
  process.env.ANDREA_EVALUATION_ORIGIN = 'synthetic';
  process.env.ANDREA_TEST_NETWORK_GUARD_ACTIVE = '1';
  process.env.NODE_OPTIONS = GUARD_PRELOAD;
}

function assertNodeArgumentsAllowed(args) {
  for (const rawArgument of args) {
    const argument = String(rawArgument);
    if (
      argument === '-r' ||
      argument === '--require' ||
      argument.startsWith('--require=') ||
      argument === '--import' ||
      argument.startsWith('--import=') ||
      argument === '--loader' ||
      argument.startsWith('--loader=') ||
      argument === '--experimental-loader' ||
      argument.startsWith('--experimental-loader=') ||
      argument === '--env-file' ||
      argument.startsWith('--env-file=') ||
      argument === '--env-file-if-exists' ||
      argument.startsWith('--env-file-if-exists=') ||
      argument.startsWith('--inspect')
    ) {
      throw denialError('child-process');
    }
  }
}

function assertExecutableAllowed(file, args = []) {
  if (!isCanonicalNodeExecutable(file)) {
    throw denialError('child-process');
  }
  assertNodeArgumentsAllowed(Array.isArray(args) ? args : []);
}

function assertNoShellOption(options) {
  if (
    options &&
    typeof options === 'object' &&
    !Array.isArray(options) &&
    options.shell
  ) {
    throw denialError('child-process');
  }
}

function sanitizedEnvironment(environment) {
  const source =
    environment && typeof environment === 'object' ? environment : process.env;
  const result = {};
  for (const [key, value] of Object.entries(source)) {
    if (!isUnsafeEnvironmentKey(key)) result[key] = value;
  }
  return {
    ...result,
    ANDREA_TEST_DISABLE_PROVIDER_ENV_FILE: '1',
    ANDREA_EVALUATION_ORIGIN: 'synthetic',
    ANDREA_TEST_NETWORK_GUARD_ACTIVE: '1',
    NODE_OPTIONS: GUARD_PRELOAD,
  };
}

function guardedOptions(options) {
  if (
    options !== undefined &&
    (typeof options !== 'object' || options === null || Array.isArray(options))
  ) {
    return options;
  }
  const normalized = options || {};
  return {
    ...normalized,
    env: sanitizedEnvironment(normalized.env),
  };
}

function guardedForkOptions(options) {
  const normalized = guardedOptions(options);
  if (!normalized || typeof normalized !== 'object') {
    return { env: sanitizedEnvironment(process.env), execArgv: [] };
  }
  if (normalized.execPath && !isCanonicalNodeExecutable(normalized.execPath)) {
    throw denialError('child-process');
  }
  return { ...normalized, execArgv: [] };
}

function guardedWorkerInvocation(filename, options) {
  if (
    options !== undefined &&
    (typeof options !== 'object' || options === null || Array.isArray(options))
  ) {
    throw denialError('worker');
  }
  const normalized = options || {};
  const userSource = normalized.eval
    ? String(filename)
    : `await import(${JSON.stringify(
        filename instanceof URL
          ? filename.href
          : pathToFileURL(path.resolve(String(filename))).href,
      )});`;
  const bootstrap = `(async () => { await import(${JSON.stringify(
    import.meta.url,
  )}); ${userSource}\n})().catch((error) => { setImmediate(() => { throw error; }); });`;
  return {
    filename: bootstrap,
    options: {
      ...normalized,
      env: sanitizedEnvironment(
        normalized.env === workerThreads.SHARE_ENV
          ? process.env
          : normalized.env,
      ),
      eval: true,
      execArgv: [],
    },
  };
}

if (!globalThis[STATE_KEY]) {
  const nativeFetch = globalThis.fetch;
  const nativeHttpRequest = http.request;
  const nativeHttpGet = http.get;
  const nativeHttpsRequest = https.request;
  const nativeHttpsGet = https.get;
  const nativeNetConnect = net.connect;
  const nativeNetCreateConnection = net.createConnection;
  const nativeSocketConnect = net.Socket.prototype.connect;
  const nativeTlsConnect = tls.connect;
  const nativeDgramConnect = dgram.Socket.prototype.connect;
  const nativeDgramSend = dgram.Socket.prototype.send;
  const nativeSpawn = childProcess.spawn;
  const nativeSpawnSync = childProcess.spawnSync;
  const nativeExecFile = childProcess.execFile;
  const nativeExecFileSync = childProcess.execFileSync;
  const nativeFork = childProcess.fork;
  const NativeWorker = workerThreads.Worker;

  if (typeof nativeFetch === 'function') {
    globalThis.fetch = async (input, init) => {
      assertLocalUrl(input, 'fetch');
      return nativeFetch(input, init);
    };
  }

  http.request = (...args) => {
    assertHttpArguments(args, 'http');
    return nativeHttpRequest(...args);
  };
  http.get = (...args) => {
    assertHttpArguments(args, 'http');
    return nativeHttpGet(...args);
  };
  https.request = (...args) => {
    assertHttpArguments(args, 'https');
    return nativeHttpsRequest(...args);
  };
  https.get = (...args) => {
    assertHttpArguments(args, 'https');
    return nativeHttpsGet(...args);
  };

  net.connect = (...args) => {
    assertConnectionArguments(args, 'net');
    return nativeNetConnect(...args);
  };
  net.createConnection = (...args) => {
    assertConnectionArguments(args, 'net');
    return nativeNetCreateConnection(...args);
  };
  net.Socket.prototype.connect = function (...args) {
    assertConnectionArguments(args, 'net');
    return nativeSocketConnect.apply(this, args);
  };
  tls.connect = (...args) => {
    assertConnectionArguments(args, 'tls');
    return nativeTlsConnect(...args);
  };

  dgram.Socket.prototype.connect = function (port, address, callback) {
    if (typeof address === 'string') assertLoopback(address, 'dgram');
    return nativeDgramConnect.call(this, port, address, callback);
  };
  dgram.Socket.prototype.send = function (...args) {
    const hostname = hostFromDgramSendArguments(args);
    if (hostname !== undefined) assertLoopback(hostname, 'dgram');
    return nativeDgramSend.apply(this, args);
  };

  installCallbackDnsGuard(dns);
  installPromiseDnsGuard(dnsPromises);
  installResolverGuards(dns.Resolver, false);
  installResolverGuards(dnsPromises.Resolver, true);

  childProcess.spawn = function (file, args, options) {
    const childArgs = Array.isArray(args) ? args : [];
    assertExecutableAllowed(file, childArgs);
    if (Array.isArray(args)) {
      assertNoShellOption(options);
      return nativeSpawn(file, args, guardedOptions(options));
    }
    assertNoShellOption(args);
    return nativeSpawn(file, guardedOptions(args));
  };
  childProcess.spawnSync = function (file, args, options) {
    const childArgs = Array.isArray(args) ? args : [];
    assertExecutableAllowed(file, childArgs);
    if (Array.isArray(args)) {
      assertNoShellOption(options);
      return nativeSpawnSync(file, args, guardedOptions(options));
    }
    assertNoShellOption(args);
    return nativeSpawnSync(file, guardedOptions(args));
  };
  childProcess.execFile = function (file, args, options, callback) {
    const childArgs = Array.isArray(args) ? args : [];
    assertExecutableAllowed(file, childArgs);
    if (!Array.isArray(args)) {
      return nativeExecFile(file, guardedOptions(args), options);
    }
    return nativeExecFile(file, args, guardedOptions(options), callback);
  };
  childProcess.execFileSync = function (file, args, options) {
    const childArgs = Array.isArray(args) ? args : [];
    assertExecutableAllowed(file, childArgs);
    if (Array.isArray(args)) {
      return nativeExecFileSync(file, args, guardedOptions(options));
    }
    return nativeExecFileSync(file, guardedOptions(args));
  };
  childProcess.exec = function (command, options, callback) {
    void command;
    void options;
    void callback;
    throw denialError('child-process');
  };
  childProcess.execSync = function (command, options) {
    void command;
    void options;
    throw denialError('child-process');
  };
  childProcess.fork = function (modulePath, args, options) {
    if (Array.isArray(args)) {
      return nativeFork(modulePath, args, guardedForkOptions(options));
    }
    return nativeFork(modulePath, guardedForkOptions(args));
  };
  workerThreads.Worker = class GuardedWorker extends NativeWorker {
    constructor(filename, options) {
      const guarded = guardedWorkerInvocation(filename, options);
      super(guarded.filename, guarded.options);
    }
  };

  syncBuiltinESMExports();
  globalThis[STATE_KEY] = true;
}

ensureGuardEnvironment();
