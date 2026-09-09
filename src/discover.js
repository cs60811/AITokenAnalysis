import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_PROJECTS_DIR } from './config.js';

/**
 * 專案底下不屬於 session 的目錄。
 *
 * 一併匯出，因為 verify.js 也要用同一份定義去掃磁碟 —— 它若跳過的目錄和這裡不同，
 * 那道檢查就會拿「兩種不同的語料」互相比較。
 */
export const IGNORED_DIRS = new Set(['memory', 'tool-results']);

/** Agent 記錄放在 <sid>/subagents/ 底下，workflow 的執行則再深一層。 */
const SUBAGENTS_DIR = 'subagents';
export const WORKFLOWS_DIR = 'workflows';
const JSONL_EXT = '.jsonl';

const entriesIn = (dir) => fs.readdirSync(dir, { withFileTypes: true });
const dirsIn = (dir) => entriesIn(dir).filter((e) => e.isDirectory());
const isJsonl = (e) => e.isFile() && e.name.endsWith(JSONL_EXT);
const jsonlFilesIn = (dir) =>
  fs.readdirSync(dir).filter((f) => f.endsWith(JSONL_EXT)).map((f) => path.join(dir, f));

/**
 * 從專案目錄名推出的備用標籤，只有在所有行都沒有 `cwd` 時才會用到。
 *
 * 這個編碼會把每個路徑分隔符「以及」每個原本就存在的連字號都換成 '-'，
 * 所以 "MS-Web" 和一個分隔符根本分不出來 —— 用 '-' 去切會把 "…repos-MS-Web"
 * 變成 "Web"。因此我們的做法是：若出現 "repos-"／"source-" 這個標記，
 * 就保留它之後的全部內容；否則原名照回。
 * attribute.js 會用 basename(cwd) 覆蓋這個結果，那才是權威來源。
 */
export function projectLabelFromDirName(name) {
  const m = /(?:^|-)repos-(.+)$/.exec(name) ?? /(?:^|-)source-(.+)$/.exec(name);
  return m ? m[1] : name;
}

/**
 * 單一個 `subagents/workflows` 目錄底下的 workflow 執行，以 runId
 * （wf_* 目錄名）為鍵。沒有任何記錄檔的執行不算一次執行。
 */
function workflowRunsIn(wfRoot) {
  const runs = new Map();
  for (const runEnt of dirsIn(wfRoot)) {
    const files = jsonlFilesIn(path.join(wfRoot, runEnt.name));
    if (files.length) runs.set(runEnt.name, files);
  }
  return runs;
}

/**
 * 單一 session 的 `subagents/` 目錄底下的兩個 agent 層級。
 *
 * 它們必須一路可區分到 UI：`ccusage session` 只算 subagent 這一層，
 * 會靜默地漏掉 workflow 那一層，而把這個差額呈現出來正是本工具的用意。
 */
function agentTiersIn(subDir) {
  const subagents = [];
  let workflows = new Map();
  for (const ent of entriesIn(subDir)) {
    if (isJsonl(ent)) {
      subagents.push(path.join(subDir, ent.name));
    } else if (ent.isDirectory() && ent.name === WORKFLOWS_DIR) {
      workflows = workflowRunsIn(path.join(subDir, ent.name));
    }
  }
  return { subagents, workflows };
}

/**
 * 走訪 ~/.claude/projects，把每個 .jsonl 依 session 分組並標記所屬層級。
 *
 * 目錄結構已在本機驗證（337 個檔案／103.7 MB）：
 *   <project>/<sid>.jsonl                                  -> main
 *   <project>/<sid>/subagents/agent-N.jsonl                -> subagent
 *   <project>/<sid>/subagents/workflows/<runId>/agent-N     -> workflow
 *
 * @returns {Map<string, {sessionId, projectDir, projectLabel, main: string|null,
 *   subagents: string[], workflows: Map<string, string[]>}>}
 */
export function discoverSessions(root = CLAUDE_PROJECTS_DIR) {
  /** @type {Map<string, any>} */
  const sessions = new Map();
  if (!fs.existsSync(root)) return sessions;

  const get = (sid, projectDir) => {
    let s = sessions.get(sid);
    if (!s) {
      s = {
        sessionId: sid,
        projectDir,
        projectLabel: projectLabelFromDirName(projectDir),
        main: null,
        subagents: [],
        workflows: new Map(),
      };
      sessions.set(sid, s);
    }
    return s;
  };

  for (const projEnt of dirsIn(root)) {
    const projectDir = projEnt.name;
    const projPath = path.join(root, projectDir);

    for (const ent of entriesIn(projPath)) {
      // 主記錄：<sid>.jsonl
      if (isJsonl(ent)) {
        get(ent.name.slice(0, -JSONL_EXT.length), projectDir).main = path.join(projPath, ent.name);
        continue;
      }
      if (!ent.isDirectory() || IGNORED_DIRS.has(ent.name)) continue;

      // 一個 session 目錄，它的 agent 記錄都放在 subagents/ 底下。
      const subDir = path.join(projPath, ent.name, SUBAGENTS_DIR);
      if (!fs.existsSync(subDir)) continue;
      Object.assign(get(ent.name, projectDir), agentTiersIn(subDir));
    }
  }

  return sessions;
}

export function allFilesOf(session) {
  return [
    ...(session.main ? [session.main] : []),
    ...session.subagents,
    ...[...session.workflows.values()].flat(),
  ];
}
