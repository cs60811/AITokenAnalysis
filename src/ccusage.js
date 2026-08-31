import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { CCUSAGE_EXPORT_MAX_BUFFER, CCUSAGE_MAX_BUFFER, CCUSAGE_TIMEOUT_MS, IS_DESKTOP } from './config.js';

const require = createRequire(import.meta.url);

/**
 * ccusage 20.x 會附帶各平台的原生執行檔（optionalDependencies）；它的 cli.js
 * 只是一層負責去啟動那些執行檔的包裝。直接執行原生 exe 可以少跳一次程序，
 * 而且關鍵是 —— 它在打包後的 Electron app 裡也能運作，
 * 因為那裡的 process.execPath 是 electron.exe 而不是 node。
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
    // 執行檔無法從 app.asar 內部啟動；electron-builder 會把它解壓到封存檔旁邊
    // （asarUnpack），所以要把解析出來的路徑導向那裡。
    const p = require
      .resolve(`${NATIVE_PKG}/${sub}`)
      .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/**
 * package.json 裡的 `bin` 可能是字串，也可能是「名稱 -> 路徑」的物件。
 * 這個套件兩種形狀都出現過，所以下面兩條解析路徑都必須同時處理。
 */
const binPathOf = (bin) => (typeof bin === 'string' ? bin : bin?.ccusage);

/** 當 ccusage 的 manifest 沒有宣告 `bin` 時，它的 cli 預設所在位置。 */
const DEFAULT_CLI_REL = './src/cli.js';

/**
 * 依據 `pkgPath` 這份 package.json 找出 ccusage 的 JS 進入點；
 * 若 manifest 沒有指名、也沒有給備用路徑，或檔案根本不存在，則回傳 null。
 */
function cliUnder(pkgPath, bin, fallbackRel = null) {
  const rel = binPathOf(bin) ?? fallbackRel;
  if (!rel) return null;
  const p = path.resolve(path.dirname(pkgPath), rel);
  return fs.existsSync(p) ? p : null;
}

/** 全域 npm 的根目錄，依值得嘗試的順序排列。 */
const GLOBAL_NODE_MODULES = [
  path.join(path.dirname(process.execPath), 'node_modules'), // C:\Program Files\nodejs\node_modules
  process.env.npm_config_prefix && path.join(process.env.npm_config_prefix, 'node_modules'),
  process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules'),
  '/usr/local/lib/node_modules',
  '/usr/lib/node_modules',
].filter(Boolean);

/**
 * 找出 ccusage 真正的 JS 進入點，好讓我們直接用 node 執行它。
 *
 * PATH 上的 `ccusage` 是 .cmd/.ps1/sh 三件組的 shim。自 Node 20（CVE-2024-27980
 * 的修補）起，child_process 拒絕在沒有 shell:true 的情況下啟動 .cmd，
 * 而 shell:true 正是我們必須避免的東西。改成解析套件的 bin 再用 node 跑 cli.js，
 * 就完全繞開了那層 shim：不用 shell、不用處理引號、也沒有注入面。
 */
function findCli() {
  // 1. 與本專案一起安裝的版本。
  try {
    const pkg = require.resolve('ccusage/package.json');
    const found = cliUnder(pkg, require(pkg).bin);
    if (found) return found;
  } catch {
    // 不是本地相依套件 —— 往下找全域安裝的位置
  }

  // 2. 常見的全域根目錄。全域安裝的版本可能完全沒有宣告 `bin`，
  //    所以這條路徑帶了一個本地路徑不需要的備用值。
  for (const root of GLOBAL_NODE_MODULES) {
    const pkgPath = path.join(root, 'ccusage', 'package.json');
    if (!fs.existsSync(pkgPath)) continue;
    try {
      const found = cliUnder(pkgPath, JSON.parse(fs.readFileSync(pkgPath, 'utf8')).bin, DEFAULT_CLI_REL);
      if (found) return found;
    } catch {
      // 繼續找
    }
  }
  return null;
}

/**
 * ccusage 只提供執行檔（沒有函式庫匯出），所以我們只能以外部程序方式呼叫它。
 *
 * 一律使用 execFile 搭配參數陣列與 shell:false —— shell:true 會觸發 Node 的
 * DEP0190 警告，並替日期參數開出一條命令注入的路。
 *
 * 我們絕不傳 -O/--offline：它會把未知模型靜默地定價為 $0.00，
 * 在這台機器上就藏掉了 $45.69 的 claude-sonnet-5。少報遠比明顯的失敗更糟。
 */
export class CcusageError extends Error {
  constructor(kind, message, detail) {
    super(message);
    this.name = 'CcusageError';
    this.kind = kind; // 'not_found' | 'timeout' | 'exit' | 'parse'
    this.detail = detail;
  }
}

function run(cmd, args, { env, maxBuffer = CCUSAGE_MAX_BUFFER } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        shell: false,
        timeout: CCUSAGE_TIMEOUT_MS,
        maxBuffer,
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

async function invoke(args, { maxBuffer } = {}) {
  if (exePath === undefined) exePath = findNativeExe();
  if (exePath) return run(exePath, args, { maxBuffer });

  if (cliPath === undefined) cliPath = findCli();
  if (!cliPath) {
    throw new CcusageError(
      'not_found',
      'ccusage not found. Install it with: npm install -g ccusage',
    );
  }
  // 在 Electron 底下 process.execPath 是 electron.exe —— 讓它表現得像 node。
  // IS_DESKTOP 涵蓋的是 server-host 子程序：那裡的 execPath 仍然是 electron.exe，
  // 即使這段程式已經不在主程序裡執行。
  const env = process.versions.electron || IS_DESKTOP
    ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    : undefined;
  return run(process.execPath, [cliPath, ...args], { env, maxBuffer });
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

// ccusage 要的是緊湊的 YYYYMMDD；UI 送來的是 YYYY-MM-DD。把分隔符去掉。
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
 * `ccusage claude daily --mode calculate --breakdown --json` 的原始 stdout，
 * 以字串保存，讓匯出的檔案與 ccusage 輸出的內容逐位元組相同。
 *
 * 依區間去重：這後面接的是一顆下載按鈕，而以前每點一次就會啟動一個自己的
 * ccusage 程序，把整份語料重新解析一遍。
 */
const exportInflight = new Map();

export function exportClaudeDaily(o = {}) {
  const args = ['claude', 'daily', ...opts(o), '--mode', 'calculate', '--breakdown', '--json'];
  const key = JSON.stringify(args);
  const running = exportInflight.get(key);
  if (running) return running;

  const p = invoke(args, { maxBuffer: CCUSAGE_EXPORT_MAX_BUFFER })
    .finally(() => exportInflight.delete(key));
  exportInflight.set(key, p);
  return p;
}

/**
 * 失敗時直接拋錯 —— 由呼叫端決定失敗代表什麼。它以前會回傳字串
 * `unavailable (kind)`，這讓 cachedVersion() 根本分不出失敗和版本號的差別，
 * 於是那個失敗就被快取了整個程序的生命週期。
 */
export async function version() {
  return (await invoke(['--version'])).trim();
}

/** ccusage 也會回報其他 agent；我們靠這個前綴把自己的支出分出來。 */
const CLAUDE_MODEL_PREFIX = 'claude';

/**
 * 把 `daily` 攤平成各模型的總計，並拆成 claude 與其他 agent。
 *
 * 輸出的是「我們自己的」token 名稱（cacheWrite/cacheRead）。ccusage 的原始欄位名到
 * 這裡為止 —— ccusage-cache.js 裡的 monthlyFromDaily 刻意反其道而行、保留原始名稱，
 * 因為它的資料列是用來代替 `ccusage monthly` 自己的輸出。
 */
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
  const claudeCost = models
    .filter((m) => m.model.startsWith(CLAUDE_MODEL_PREFIX))
    .reduce((s, m) => s + m.cost, 0);
  const totalCost = models.reduce((s, m) => s + m.cost, 0);
  return { models, claudeCost, otherCost: totalCost - claudeCost, totalCost };
}
