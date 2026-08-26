/**
 * Server host: runs the Express server in a CHILD process.
 *
 * Everything the server does on a cold refresh is synchronous — discoverSessions()
 * (nested readdirSync), the fingerprint (one statSync per transcript), readLines()
 * (readFileSync of ~170 MB, then JSON.parse per line) and JSON.parse of ccusage's
 * stdout. Run in the Electron main process, that work stalls the event loop for
 * seconds and Windows paints the window as 「沒有回應」. Out here it cannot touch
 * the UI — which is exactly why web mode never froze.
 *
 * CommonJS on purpose: utilityProcess.fork() loads its entry point with require(),
 * and src/server.js is ESM with a top-level await, so only dynamic import() can
 * load it. A .cjs extension is unambiguous under package.json "type": "module".
 *
 * Mechanism-agnostic messaging: works as an Electron utilityProcess
 * (process.parentPort) and as a plain child_process.fork (process.send).
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const send = process.parentPort
  ? (msg) => process.parentPort.postMessage(msg)
  : (msg) => process.send?.(msg);

// child_process.fork only: the IPC channel closes when the parent dies, so we
// never outlive it. utilityProcess children are reaped by Chromium's job object.
if (!process.parentPort) process.on('disconnect', () => process.exit(0));

function fatal(err) {
  try {
    send({ type: 'error', message: err?.message ?? String(err), stack: err?.stack ?? null });
  } catch {
    // parent already gone
  }
  console.error(err?.stack ?? String(err));
  // Let the message flush before dying.
  setTimeout(() => process.exit(1), 50);
}

process.on('uncaughtException', fatal);
// A stray rejection must not take the dashboard down — it never did in-process.
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
});

(async () => {
  const entry = pathToFileURL(path.join(__dirname, '..', 'src', 'server.js')).href;
  const { startServer } = await import(entry);
  // Dynamic port: never clashes with a web-mode instance on 4317.
  const server = await startServer({ port: Number(process.env.AITA_PORT) || 0 });
  send({ type: 'listening', port: server.address().port });
})().catch(fatal);
