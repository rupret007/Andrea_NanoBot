const STATE_KEY = Symbol.for('andrea.test-network-guard');

function urlFor(input) {
  if (input instanceof URL) return input;
  if (input instanceof Request) return new URL(input.url);
  if (typeof input === 'string') return new URL(input);
  return new URL(String(input));
}

function isLoopbackHost(hostname) {
  const normalized = hostname.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '127.0.0.1' ||
    normalized === '0.0.0.0'
  );
}

if (!globalThis[STATE_KEY]) {
  const nativeFetch = globalThis.fetch;
  globalThis[STATE_KEY] = true;
  globalThis.fetch = async (input, init) => {
    const url = urlFor(input);
    if (!isLoopbackHost(url.hostname)) {
      throw new Error(
        `External network access is disabled for deterministic tests: ${url.origin}`,
      );
    }
    return nativeFetch(input, init);
  };
}

process.env.ANDREA_TEST_DISABLE_PROVIDER_ENV_FILE ||= '1';
