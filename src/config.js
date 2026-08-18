import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');

/**
 * Verified during exploration as the only source of usage data on this machine:
 * ~/.config/claude does not exist, CLAUDE_CONFIG_DIR is unset, and the only other
 * .jsonl under ~/.claude is history.jsonl (no usage records).
 */
export const CLAUDE_PROJECTS_DIR =
  process.env.CLAUDE_CONFIG_DIR
    ? path.join(process.env.CLAUDE_CONFIG_DIR, 'projects')
    : path.join(os.homedir(), '.claude', 'projects');

/**
 * The desktop app's local agent mode (the scheduled tasks configured in its UI)
 * writes transcripts here instead of CLAUDE_PROJECTS_DIR, and ccusage does not
 * read this root either — see localagent.js.
 *
 * Claude Desktop ships as an MSIX package (Program Files\WindowsApps), so its
 * writes to %APPDATA%\claude are virtualised into the package's own container.
 * The container path is the real storage and any process can read it. The
 * %APPDATA%\claude view is NOT equivalent: measured on this machine, readdir
 * there returns ENOENT at medium integrity but lists 49 entries from an elevated
 * process. Reading %APPDATA% therefore made the whole feature silently empty for
 * every normal user — and invisible to us, because the dev shell was elevated.
 *
 * Prefer the container; fall back to %APPDATA% for a non-packaged install.
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
    // no package container on this machine — fall through
  }
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), ...leaf);
}

export const LOCAL_AGENT_DIR = resolveLocalAgentDir();

/**
 * "This is the packaged desktop build."
 *
 * Deliberately NOT just `process.versions.electron`: the server runs in a child
 * process now (electron/server-host.cjs), and what this flag gates — git
 * self-update, POST /api/update, the update download URL — is about how the app
 * was installed, not about which binary happens to be executing. electron/main.js
 * sets AITA_DESKTOP=1 when it forks; the versions check stays so `electron .`
 * against this repo still behaves as the desktop build.
 */
export const IS_DESKTOP = process.env.AITA_DESKTOP === '1' || Boolean(process.versions.electron);

/** Overridable because ROOT is read-only inside a packaged Electron app (asar). */
export const CACHE_DIR = process.env.AITA_CACHE_DIR || path.join(ROOT, '.cache');
export const PARSED_CACHE_FILE = path.join(CACHE_DIR, 'parsed.json');
export const PRICES_CACHE_FILE = path.join(CACHE_DIR, 'prices.json');
export const PRICES_SNAPSHOT_FILE = path.join(ROOT, 'prices.json');

/** Bump to invalidate every cached rollup after a parser/attribution change. */
export const CACHE_VERSION = 3;

export const PORT = Number(process.env.PORT) || 4317;
export const HOST = '127.0.0.1';

/** Public repo — used by the zip-mode update check (raw package.json + zip download). */
export const REPO_URL = 'https://github.com/cs60811/AITokenAnalysis';

export const LITELLM_PRICES_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
export const LITELLM_TIMEOUT_MS = 5000;

/**
 * Second catalog, consulted only for fast-mode premiums.
 *
 * LiteLLM has no speed dimension, so it cannot price a `/fast` message at all.
 * models.dev publishes it as `experimental.modes.fast` — the same source ccusage
 * reads — and we take only the ratio from it, leaving LiteLLM authoritative for
 * the absolute rates and the 5m/1h cache-write split.
 */
export const MODELSDEV_PRICES_URL = 'https://models.dev/api.json';

/** Warn in the UI once the pricing snapshot is this old. */
export const PRICES_STALE_DAYS = 30;

/**
 * Global reconciliation gate: our claude-only total vs `ccusage daily`.
 *
 * The two accounting gaps this tolerance used to absorb (partial writes of
 * streamed messages, and the advisor tier) are fixed, and the two totals now
 * agree to the cent. What is left is staleness: the dashboard compares a fresh
 * parse against a ccusage document up to CCUSAGE_SWR_MS old, so a burst of
 * spend inside that window shows up as drift. 1% covers that with room while
 * still catching a real regression — each of the two bugs above was ~1% alone.
 */
export const RECONCILE_TOLERANCE_PCT = 1;

/** Fail if more than this share of cost cannot be tied back to a prompt. */
export const UNATTRIBUTED_TOLERANCE_PCT = 5;

export const CCUSAGE_TIMEOUT_MS = 60_000;
export const CCUSAGE_MAX_BUFFER = 1 << 28;

/**
 * The export is one `daily --breakdown` document — measured at 22 KB for a full
 * year on this machine. It does not need the 256 MB ceiling the general path
 * carries, and the export endpoint is the one a user can fire repeatedly.
 */
export const CCUSAGE_EXPORT_MAX_BUFFER = 1 << 24;

/**
 * The ccusage cache is fingerprint-invalidated for Claude transcripts, but ccusage
 * also reads other agents' logs (codex/gemini) the fingerprint can't see. A cached
 * document older than this is served stale and refreshed in the background.
 */
export const CCUSAGE_SWR_MS = 5 * 60_000;

export const SNIPPET_CHARS = 120;
