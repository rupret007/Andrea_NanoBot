import { parentPort, workerData } from 'node:worker_threads';

const keys = Object.keys(process.env).map((key) => key.toUpperCase());
const unsafeEnvironment =
  keys.includes('HTTP_PROXY') ||
  keys.includes('OPENAI_API_KEY') ||
  keys.filter((key) => key === 'NODE_OPTIONS').length !== 1;

let networkResult = 'BYPASS';
try {
  await fetch('https://worker-escape.example');
} catch (error) {
  networkResult = error?.code || 'UNGUARDED_FAILURE';
}

parentPort?.postMessage({
  execArgv: process.execArgv,
  networkResult,
  unsafeEnvironment,
  workerData,
});
