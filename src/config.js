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

/** Overridable because ROOT is read-only inside a packaged Electron app (asar). */
export const CACHE_DIR = process.env.AITA_CACHE_DIR || path.join(ROOT, '.cache');
export const PARSED_CACHE_FILE = path.join(CACHE_DIR, 'parsed.json');
export const PRICES_CACHE_FILE = path.join(CACHE_DIR, 'prices.json');
export const PRICES_SNAPSHOT_FILE = path.join(ROOT, 'prices.json');

/** Bump to invalidate every cached rollup after a parser/attribution change. */
export const CACHE_VERSION = 1;

export const PORT = Number(process.env.PORT) || 4317;
export const HOST = '127.0.0.1';

/** Public repo — used by the zip-mode update check (raw package.json + zip download). */
export const REPO_URL = 'https://github.com/cs60811/AITokenAnalysis';

export const LITELLM_PRICES_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
export const LITELLM_TIMEOUT_MS = 5000;

/** Warn in the UI once the pricing snapshot is this old. */
export const PRICES_STALE_DAYS = 30;

/** Global reconciliation gate: our claude-only total vs `ccusage daily`. Measured 1.01%. */
export const RECONCILE_TOLERANCE_PCT = 2;

/** Fail if more than this share of cost cannot be tied back to a prompt. */
export const UNATTRIBUTED_TOLERANCE_PCT = 5;

export const CCUSAGE_TIMEOUT_MS = 60_000;
export const CCUSAGE_MAX_BUFFER = 1 << 28;

/**
 * The ccusage cache is fingerprint-invalidated for Claude transcripts, but ccusage
 * also reads other agents' logs (codex/gemini) the fingerprint can't see. A cached
 * document older than this is served stale and refreshed in the background.
 */
export const CCUSAGE_SWR_MS = 5 * 60_000;

export const SNIPPET_CHARS = 120;
