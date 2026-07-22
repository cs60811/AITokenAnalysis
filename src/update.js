import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_URL, ROOT } from './config.js';

/**
 * Self-update, two modes:
 *
 * - git (clone installs): "new release" = the tracked upstream branch has
 *   commits we don't. Supports one-click pull + restart.
 * - zip (no .git at all): compare our package.json version against the repo's
 *   on raw.githubusercontent.com. Notify only — the button opens the zip
 *   download; bumping `version` on release is what makes the toast appear.
 */

const RAW_PKG_URL = `${REPO_URL.replace('https://github.com/', 'https://raw.githubusercontent.com/')}/master/package.json`;
const ZIP_URL = `${REPO_URL}/archive/refs/heads/master.zip`;
const ZIP_FETCH_TIMEOUT_MS = 10_000;

const GIT_TIMEOUT_MS = 15_000;

function git(args, timeout = GIT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd: ROOT,
        shell: false,
        timeout,
        windowsHide: true,
        // Never let git pop a credential prompt under a headless server.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message).trim()));
        else resolve(stdout.trim());
      },
    );
  });
}

/** Cache the check so page reloads don't hammer `git fetch`. */
let cache = { at: 0, result: null };
const CHECK_TTL_MS = 30 * 60_000;

export async function checkForUpdate({ force = false } = {}) {
  if (!force && cache.result && Date.now() - cache.at < CHECK_TTL_MS) return cache.result;

  // null = not a git checkout at all -> fall back to the zip version check.
  // A git checkout without upstream (dev branches) stays silent on purpose.
  const result = (await gitCheck()) ?? (await zipCheck());
  result.checkedAt = new Date().toISOString();
  cache = { at: Date.now(), result };
  return result;
}

async function gitCheck() {
  try {
    await git(['rev-parse', '--is-inside-work-tree']);
  } catch {
    return null; // no .git (zip install) or git not installed
  }
  try {
    let upstream;
    try {
      upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    } catch {
      return { supported: false, reason: '目前分支沒有追蹤的遠端分支' };
    }
    await git(['fetch', '--quiet']);
    const behind = Number(await git(['rev-list', '--count', 'HEAD..@{u}']));
    const [curHash, curSubject] = (await git(['log', '-1', '--format=%h\t%s', 'HEAD'])).split('\t');
    const [newHash, newSubject, newDate] = (await git(['log', '-1', '--format=%h\t%s\t%cI', '@{u}'])).split('\t');
    return {
      supported: true,
      mode: 'git',
      upstream,
      behind,
      current: { hash: curHash, subject: curSubject },
      latest: { hash: newHash, subject: newSubject, date: newDate },
    };
  } catch (err) {
    return { supported: false, reason: `git 檢查失敗：${err.message}` };
  }
}

/** a > b for dotted version strings ("1.10.0" > "1.9.1"). */
function newerVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return false;
}

async function zipCheck() {
  try {
    const local = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ZIP_FETCH_TIMEOUT_MS);
    let remote;
    try {
      const res = await fetch(RAW_PKG_URL, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      remote = (await res.json()).version;
    } finally {
      clearTimeout(timer);
    }
    return {
      supported: true,
      mode: 'zip',
      behind: newerVersion(remote, local) ? 1 : 0,
      current: { version: local },
      latest: { version: remote },
      downloadUrl: ZIP_URL,
    };
  } catch (err) {
    return { supported: false, reason: `版本檢查失敗：${err.message}` };
  }
}

export async function applyUpdate() {
  // Pulling over local edits can lose work — refuse on modified tracked files.
  const dirty = (await git(['status', '--porcelain']))
    .split('\n')
    .filter((l) => l && !l.startsWith('??'));
  if (dirty.length) {
    const e = new Error(`有 ${dirty.length} 個檔案未提交，請先 commit 或還原後再更新`);
    e.kind = 'dirty';
    throw e;
  }

  const before = await git(['rev-parse', 'HEAD']);
  await git(['pull', '--ff-only'], 60_000);
  const after = await git(['rev-parse', 'HEAD']);
  cache = { at: 0, result: null };
  return { before: before.slice(0, 7), after: after.slice(0, 7), changed: before !== after };
}

/**
 * Restart after an update: spawn a detached shell that waits for this process
 * to release the port, refreshes dependencies (covers package.json bumps in the
 * pull), and starts the server again — then exit.
 *
 * `ping -n 3` is the sleep: `timeout` errors out when stdin is not a console,
 * which is exactly the case for a detached child.
 */
export function scheduleRestart() {
  if (process.platform === 'win32') {
    spawn(
      'cmd.exe',
      ['/d', '/s', '/c',
        `ping -n 3 127.0.0.1 >nul & cd /d "${ROOT}" & npm install --no-audit --no-fund >nul 2>&1 & npm start`],
      { cwd: ROOT, detached: true, stdio: 'ignore' },
    ).unref();
  } else {
    spawn(
      'sh',
      ['-c', `sleep 2; cd "${ROOT}"; npm install --no-audit --no-fund >/dev/null 2>&1; npm start`],
      { detached: true, stdio: 'ignore' },
    ).unref();
  }
  // Give the HTTP response time to flush before dying.
  setTimeout(() => process.exit(0), 400).unref();
}
