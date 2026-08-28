import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_PROJECTS_DIR } from './config.js';

/** Directories under a project that are not sessions. */
const IGNORED_DIRS = new Set(['memory', 'tool-results']);

/** Agent transcripts sit under <sid>/subagents/, workflow runs one level deeper. */
const SUBAGENTS_DIR = 'subagents';
const WORKFLOWS_DIR = 'workflows';
const JSONL_EXT = '.jsonl';

const entriesIn = (dir) => fs.readdirSync(dir, { withFileTypes: true });
const dirsIn = (dir) => entriesIn(dir).filter((e) => e.isDirectory());
const isJsonl = (e) => e.isFile() && e.name.endsWith(JSONL_EXT);
const jsonlFilesIn = (dir) =>
  fs.readdirSync(dir).filter((f) => f.endsWith(JSONL_EXT)).map((f) => path.join(dir, f));

/**
 * Fallback label for a project dir name, used only when no line carries a `cwd`.
 *
 * The encoding replaces every path separator AND every literal hyphen with '-',
 * so "MS-Web" and a separator are indistinguishable — splitting on '-' would
 * turn "…repos-MS-Web" into "Web". We therefore keep everything after the last
 * "repos-"/"source-" marker if present, and otherwise return the name as-is.
 * attribute.js overrides this with basename(cwd), which is authoritative.
 */
export function projectLabelFromDirName(name) {
  const m = /(?:^|-)repos-(.+)$/.exec(name) ?? /(?:^|-)source-(.+)$/.exec(name);
  return m ? m[1] : name;
}

/**
 * The workflow runs under one `subagents/workflows` directory, keyed by runId
 * (the wf_* directory name). A run holding no transcript is not a run.
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
 * The two agent tiers under one session's `subagents/` directory.
 *
 * They must stay separable all the way to the UI: `ccusage session` counts the
 * subagent tier and silently omits the workflow tier, and showing the gap is the
 * point of this tool.
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
 * Walk ~/.claude/projects and group every .jsonl by session, tagged by tier.
 *
 * Layout verified on this machine (337 files / 103.7 MB):
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
      // main transcript: <sid>.jsonl
      if (isJsonl(ent)) {
        get(ent.name.slice(0, -JSONL_EXT.length), projectDir).main = path.join(projPath, ent.name);
        continue;
      }
      if (!ent.isDirectory() || IGNORED_DIRS.has(ent.name)) continue;

      // A session directory, whose agent transcripts live under subagents/.
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
