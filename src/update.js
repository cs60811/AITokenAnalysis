import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { IS_DESKTOP, REPO_URL, ROOT } from './config.js';

/**
 * 自我更新，兩種模式：
 *
 * - git（以 clone 方式安裝）：「有新版」＝所追蹤的上游分支有我們沒有的 commit。
 *   支援一鍵 pull + 重啟。
 * - zip（完全沒有 .git）：拿我們的 package.json 版本，比對 repo 在
 *   raw.githubusercontent.com 上的版本。只做通知 —— 按鈕會打開 zip 下載頁；
 *   發版時把 `version` 往上調，才會讓那個提示浮出來。
 */

const RAW_PKG_URL = `${REPO_URL.replace('https://github.com/', 'https://raw.githubusercontent.com/')}/master/package.json`;
const ZIP_URL = `${REPO_URL}/archive/refs/heads/master.zip`;
const RELEASES_URL = `${REPO_URL}/releases/latest`;
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
        // 絕不讓 git 在無介面的伺服器環境下跳出輸入帳密的視窗。
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message).trim()));
        else resolve(stdout.trim());
      },
    );
  });
}

/** 把檢查結果快取起來，免得每次重新載入頁面都去狂打 `git fetch`。 */
let cache = { at: 0, result: null };
const CHECK_TTL_MS = 30 * 60_000;

export async function checkForUpdate({ force = false } = {}) {
  if (!force && cache.result && Date.now() - cache.at < CHECK_TTL_MS) return cache.result;

  // null 代表根本不是 git checkout -> 退回用 zip 的版本比對。
  // 有 git checkout 但沒有上游分支（開發用分支）則刻意保持安靜。
  // 桌面版一律走版本比對：否則在 repo 裡執行 `electron .` 會看到 .git，
  // 進而提供那個桌面版其實已停用的一鍵更新。
  const result = (IS_DESKTOP ? null : await gitCheck()) ?? (await zipCheck());
  result.checkedAt = new Date().toISOString();
  cache = { at: Date.now(), result };
  return result;
}

async function gitCheck() {
  try {
    await git(['rev-parse', '--is-inside-work-tree']);
  } catch {
    return null; // 沒有 .git（zip 安裝）或根本沒裝 git
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

/** 比較帶點號的版本字串，判斷 a 是否大於 b（"1.10.0" > "1.9.1"）。 */
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
      downloadUrl: IS_DESKTOP ? RELEASES_URL : ZIP_URL,
    };
  } catch (err) {
    return { supported: false, reason: `版本檢查失敗：${err.message}` };
  }
}

export async function applyUpdate() {
  // 在本機有改動的情況下 pull 可能弄丟成果 —— 只要有被追蹤的檔案被修改就拒絕。
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
 * 更新後重啟：啟動一個獨立（detached）的 shell，等這個程序釋放 port、
 * 重新安裝相依套件（涵蓋這次 pull 進來的 package.json 變動），再把伺服器啟動起來 ——
 * 然後自己結束。
 *
 * `ping -n 3` 是拿來當 sleep 用的：當 stdin 不是主控台時 `timeout` 會直接報錯，
 * 而獨立子程序正好就是這種情況。
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
  // 在結束前留點時間讓 HTTP 回應送出去。
  setTimeout(() => process.exit(0), 400).unref();
}
