import { execFile, spawn } from 'node:child_process';
import { ROOT } from './config.js';

/**
 * Self-update via git: "new release" = the tracked upstream branch has commits
 * we don't. This works for anyone who got the project with `git clone` and
 * needs no platform API (GitHub/GitLab/...). Zip users get { supported: false }
 * and the UI stays silent.
 */

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

  let result;
  try {
    await git(['rev-parse', '--is-inside-work-tree']);
    let upstream = null;
    try {
      upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    } catch {
      result = { supported: false, reason: '目前分支沒有追蹤的遠端分支' };
    }
    if (upstream) {
      await git(['fetch', '--quiet']);
      const behind = Number(await git(['rev-list', '--count', 'HEAD..@{u}']));
      const [curHash, curSubject] = (await git(['log', '-1', '--format=%h\t%s', 'HEAD'])).split('\t');
      const [newHash, newSubject, newDate] = (await git(['log', '-1', '--format=%h\t%s\t%cI', '@{u}'])).split('\t');
      result = {
        supported: true,
        upstream,
        behind,
        current: { hash: curHash, subject: curSubject },
        latest: { hash: newHash, subject: newSubject, date: newDate },
      };
    }
  } catch (err) {
    result = { supported: false, reason: `git 檢查失敗：${err.message}` };
  }

  result.checkedAt = new Date().toISOString();
  cache = { at: Date.now(), result };
  return result;
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
