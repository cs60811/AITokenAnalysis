import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');

/**
 * 探索階段已確認這是本機唯一的用量資料來源：~/.config/claude 不存在、
 * CLAUDE_CONFIG_DIR 未設定，而 ~/.claude 底下其他的 .jsonl 只有
 * history.jsonl（不含用量記錄）。
 */
export const CLAUDE_PROJECTS_DIR =
  process.env.CLAUDE_CONFIG_DIR
    ? path.join(process.env.CLAUDE_CONFIG_DIR, 'projects')
    : path.join(os.homedir(), '.claude', 'projects');

/**
 * 桌面版的 local agent mode（在它 UI 裡設定的排程任務）把記錄寫在這裡，
 * 不寫進 CLAUDE_PROJECTS_DIR，而且 ccusage 也不讀這個根目錄 —— 見 localagent.js。
 *
 * Claude Desktop 以 MSIX 套件形式安裝（Program Files\WindowsApps），所以它寫進
 * %APPDATA%\claude 的內容會被虛擬化到套件自己的容器裡。容器路徑才是真正的儲存位置，
 * 任何程序都讀得到。%APPDATA%\claude 這個視圖並不等價：本機實測，中完整性等級下
 * readdir 會得到 ENOENT，但從提升權限的程序讀卻列出 49 個項目。也就是說，讀
 * %APPDATA% 會讓這個功能對每個一般使用者都靜默地空掉 —— 而且我們還看不見，
 * 因為開發用的 shell 是提升權限的。
 *
 * 因此優先用容器路徑，非套件安裝才退回 %APPDATA%。
 */
function resolveLocalAgentDir() {
  const leaf = ['claude', 'local-agent-mode-sessions'];
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const packages = path.join(local, 'Packages');
  try {
    for (const entry of fs.readdirSync(packages)) {
      if (!entry.startsWith('Claude_')) continue;
      const candidate = path.join(packages, entry, 'LocalCache', 'Roaming', ...leaf);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // 這台機器沒有套件容器 —— 往下走
  }
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), ...leaf);
}

export const LOCAL_AGENT_DIR = resolveLocalAgentDir();

/**
 * 「這是打包後的桌面版」。
 *
 * 刻意不只看 process.versions.electron：伺服器現在跑在子程序裡
 * （electron/server-host.cjs），而這個旗標所控制的東西 —— git 自我更新、
 * POST /api/update、更新下載網址 —— 取決於「這個 app 是怎麼安裝的」，
 * 而不是「現在執行的是哪個二進位檔」。electron/main.js 在 fork 時會設
 * AITA_DESKTOP=1；versions 檢查仍保留，好讓 `electron .` 直接跑這個 repo 時
 * 依然被當成桌面版。
 */
export const IS_DESKTOP = process.env.AITA_DESKTOP === '1' || Boolean(process.versions.electron);

/** 可被覆寫，因為打包後的 Electron app 裡 ROOT 是唯讀的（asar）。 */
export const CACHE_DIR = process.env.AITA_CACHE_DIR || path.join(ROOT, '.cache');
export const PARSED_CACHE_FILE = path.join(CACHE_DIR, 'parsed.json');
export const PRICES_CACHE_FILE = path.join(CACHE_DIR, 'prices.json');
export const PRICES_SNAPSHOT_FILE = path.join(ROOT, 'prices.json');

/** 改動解析器或歸因邏輯後，調高這個數字即可讓所有既有快取失效。 */
export const CACHE_VERSION = 3;

export const PORT = Number(process.env.PORT) || 4317;
export const HOST = '127.0.0.1';

/** 公開 repo —— zip 模式的更新檢查會用到（讀原始 package.json 與下載 zip）。 */
export const REPO_URL = 'https://github.com/cs60811/AITokenAnalysis';

export const LITELLM_PRICES_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
export const LITELLM_TIMEOUT_MS = 5000;

/**
 * 第二份型錄，用途有兩個：查 fast 模式的加價倍率，以及替 LiteLLM 補漏。
 *
 * 倍率：LiteLLM 沒有速度這個維度，所以它根本無法為一則 `/fast` 訊息定價。
 * models.dev 把它放在 `experimental.modes.fast` —— 也正是 ccusage 讀的同一份來源。
 *
 * 補漏：剛發布的模型會比 LiteLLM 型錄先到，而沒有費率的模型會照算 token、卻算不出
 * 金額，於是它整份支出從總額裡消失（實測 claude-fable-5-1 漏掉 $83.08＝3.28%）。
 * 因此 LiteLLM 沒收錄的模型改由 models.dev 的 anthropic 費率補上 —— 只補、不覆蓋：
 * LiteLLM 有的仍以 LiteLLM 為準，因為只有它把 5m/1h 快取寫入費率分開公布。
 * 詳見 pricing.js 的 withFallbackRates。
 */
export const MODELSDEV_PRICES_URL = 'https://models.dev/api.json';

/** 定價快照超過這個天數就在 UI 上提醒。 */
export const PRICES_STALE_DAYS = 30;

/**
 * 全域對帳閘門：我們的 claude 總額 vs `ccusage daily`。
 *
 * 這個容差原本要吸收的兩個記帳缺口（串流訊息的部分寫入、advisor 層）都已修好，
 * 兩邊現在對到分。剩下的只有時間差：儀表板拿的是即時解析結果，比對的卻是最舊可到
 * CCUSAGE_SWR_MS 的 ccusage 文件，所以在那個時間窗內爆量的支出會表現成偏差。
 * 1% 足以涵蓋這個時間差還有餘裕，同時仍抓得到真正的迴歸 —— 上面那兩個 bug 每個
 * 單獨就約 1%。
 */
export const RECONCILE_TOLERANCE_PCT = 1;

/** 無法歸因回某個 prompt 的成本占比超過這個數字就算失敗。 */
export const UNATTRIBUTED_TOLERANCE_PCT = 5;

export const CCUSAGE_TIMEOUT_MS = 60_000;
export const CCUSAGE_MAX_BUFFER = 1 << 28;

/**
 * 匯出的內容是一份 `daily --breakdown` 文件 —— 本機實測整年份約 22 KB。
 * 它不需要一般路徑上那個 256 MB 的上限，而且匯出端點正好是使用者可以連續狂點的那一個。
 */
export const CCUSAGE_EXPORT_MAX_BUFFER = 1 << 24;

/**
 * ccusage 快取對 Claude 的記錄是用指紋失效的，但 ccusage 同時也會讀其他 agent
 * （codex／gemini）的記錄，那是指紋看不到的。因此文件超過這個時間就先回舊的，
 * 同時在背景重新抓。
 */
export const CCUSAGE_SWR_MS = 5 * 60_000;

export const SNIPPET_CHARS = 120;
