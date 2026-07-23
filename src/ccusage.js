import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { CCUSAGE_MAX_BUFFER, CCUSAGE_TIMEOUT_MS } from './config.js';

const require = createRequire(import.meta.url);

/**
 * ccusage 20.x ships per-platform native binaries (optionalDependencies); its
 * cli.js is only a wrapper that spawns them. Running the native exe directly
 * skips a process hop and — crucially — works inside a packaged Electron app,
 * where process.execPath is electron.exe rather than node.
 */
const NATIVE_PKG = {
  'win32-x64': '@ccusage/ccusage-win32-x64',
  'win32-arm64': '@ccusage/ccusage-win32-arm64',
  'darwin-arm64': '@ccusage/ccusage-darwin-arm64',
  'darwin-x64': '@ccusage/ccusage-darwin-x64',
  'linux-x64': '@ccusage/ccusage-linux-x64',
  'linux-arm64': '@ccusage/ccusage-linux-arm64',
}[`${process.platform}-${process.arch}`];

function findNativeExe() {
  if (!NATIVE_PKG) return null;
  const sub = process.platform === 'win32' ? 'bin/ccusage.exe' : 'bin/ccusage';
  try {
    // An exe cannot be spawned from inside app.asar; electron-builder unpacks it
    // beside the archive (asarUnpack), so redirect the resolved path there.
    const p = require
      .resolve(`${NATIVE_PKG}/${sub}`)
      .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/**
 * Locate ccusage's real JS entrypoint so we can run it with node directly.
 *
 * The `ccusage` on PATH is a .cmd/.ps1/sh shim trio. Since Node 20 (the
 * CVE-2024-27980 fix) child_process refuses to spawn a .cmd without shell:true,
 * which is exactly what we must avoid. Resolving package bin -> node cli.js
 * sidesteps the shim entirely: no shell, no quoting, no injection surface.
 */
function findCli() {
  // 1. Installed alongside this project.
  try {
    const pkg = require.resolve('ccusage/package.json');
    const bin = require(pkg).bin;
    const rel = typeof bin === 'string' ? bin : bin?.ccusage;
    if (rel) {
      const p = path.resolve(path.dirname(pkg), rel);
      if (fs.existsSync(p)) return p;
    }
  } catch {
    // not a local dependency — fall through to global locations
  }

  // 2. Common global roots.
  const roots = [
    path.join(path.dirname(process.execPath), 'node_modules'), // C:\Program Files\nodejs\node_modules
    process.env.npm_config_prefix && path.join(process.env.npm_config_prefix, 'node_modules'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules'),
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
  ].filter(Boolean);

  for (const root of roots) {
    const pkgPath = path.join(root, 'ccusage', 'package.json');
    if (!fs.existsSync(pkgPath)) continue;
    try {
      const bin = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).bin;
      const rel = typeof bin === 'string' ? bin : bin?.ccusage;
      const p = path.resolve(path.dirname(pkgPath), rel ?? './src/cli.js');
      if (fs.existsSync(p)) return p;
    } catch {
      // keep looking
    }
  }
  return null;
}

/**
 * ccusage is bin-only (no library exports), so we shell out to it.
 *
 * Always execFile with an args array and shell:false — shell:true would trigger
 * Node's DEP0190 warning and open a command-injection path for date arguments.
 *
 * We never pass -O/--offline: it silently prices unknown models at $0.00, which
 * on this machine hid $45.69 of claude-sonnet-5. Under-reporting is worse than
 * a visible failure.
 */
export class CcusageError extends Error {
  constructor(kind, message, detail) {
    super(message);
    this.name = 'CcusageError';
    this.kind = kind; // 'not_found' | 'timeout' | 'exit' | 'parse'
    this.detail = detail;
  }
}

function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        shell: false,
        timeout: CCUSAGE_TIMEOUT_MS,
        maxBuffer: CCUSAGE_MAX_BUFFER,
        windowsHide: true,
        env: env ?? process.env,
      },
      (err, stdout, stderr) => {
        if (err) {
          if (err.code === 'ENOENT') return reject(new CcusageError('not_found', `${cmd} not found`, err.message));
          if (err.killed || err.signal === 'SIGTERM') {
            return reject(new CcusageError('timeout', `${cmd} timed out after ${CCUSAGE_TIMEOUT_MS}ms`, err.message));
          }
          return reject(new CcusageError('exit', `${cmd} exited ${err.code}`, stderr || err.message));
        }
        resolve(stdout);
      },
    );
  });
}

let exePath;
let cliPath;

async function invoke(args) {
  if (exePath === undefined) exePath = findNativeExe();
  if (exePath) return run(exePath, args);

  if (cliPath === undefined) cliPath = findCli();
  if (!cliPath) {
    throw new CcusageError(
      'not_found',
      'ccusage not found. Install it with: npm install -g ccusage',
    );
  }
  // Under Electron process.execPath is electron.exe — make it behave as node.
  const env = process.versions.electron
    ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    : undefined;
  return run(process.execPath, [cliPath, ...args], env);
}

export function cliLocation() {
  if (exePath === undefined) exePath = findNativeExe();
  if (exePath) return exePath;
  if (cliPath === undefined) cliPath = findCli();
  return cliPath;
}

async function json(args) {
  const out = await invoke([...args, '--json']);
  try {
    return JSON.parse(out);
  } catch (err) {
    throw new CcusageError('parse', 'ccusage returned unparsable JSON', out.slice(0, 500));
  }
}

// ccusage wants compact YYYYMMDD; the UI sends YYYY-MM-DD. Strip separators.
const ymd = (s) => (s ? String(s).replace(/-/g, '') : s);
const opts = ({ since, until, timezone } = {}) => [
  ...(since ? ['--since', ymd(since)] : []),
  ...(until ? ['--until', ymd(until)] : []),
  ...(timezone ? ['--timezone', timezone] : []),
];

export const daily = (o) => json(['daily', ...opts(o)]);
export const monthly = (o) => json(['monthly', ...opts(o)]);
export const sessions = (o) => json(['session', ...opts(o)]);

/**
 * Raw stdout of `ccusage claude daily --mode calculate --breakdown --json`,
 * kept as a string so the export download is byte-for-byte what ccusage emitted.
 */
export const exportClaudeDaily = (o) =>
  invoke(['claude', 'daily', ...opts(o), '--mode', 'calculate', '--breakdown', '--json']);

export async function version() {
  try {
    return (await invoke(['--version'])).trim();
  } catch (err) {
    return `unavailable (${err.kind})`;
  }
}

/** Flatten `daily` into per-model totals, split claude vs other agents. */
export function modelTotalsFromDaily(doc) {
  const byModel = new Map();
  for (const day of doc.daily ?? []) {
    for (const b of day.modelBreakdowns ?? []) {
      const m = byModel.get(b.modelName) ?? {
        model: b.modelName,
        cost: 0,
        input: 0,
        output: 0,
        cacheWrite: 0,
        cacheRead: 0,
      };
      m.cost += b.cost ?? 0;
      m.input += b.inputTokens ?? 0;
      m.output += b.outputTokens ?? 0;
      m.cacheWrite += b.cacheCreationTokens ?? 0;
      m.cacheRead += b.cacheReadTokens ?? 0;
      byModel.set(b.modelName, m);
    }
  }
  const models = [...byModel.values()].sort((a, z) => z.cost - a.cost);
  const claudeCost = models.filter((m) => m.model.startsWith('claude')).reduce((s, m) => s + m.cost, 0);
  const totalCost = models.reduce((s, m) => s + m.cost, 0);
  return { models, claudeCost, otherCost: totalCost - claudeCost, totalCost };
}
