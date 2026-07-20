import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_PROJECTS_DIR } from './config.js';

const IGNORED_DIRS = new Set(['memory', 'tool-results']);

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
 * Walk ~/.claude/projects and group every .jsonl by session, tagged by tier.
 *
 * Layout verified on this machine (337 files / 103.7 MB):
 *   <project>/<sid>.jsonl                                  -> main
 *   <project>/<sid>/subagents/agent-N.jsonl                -> subagent
 *   <project>/<sid>/subagents/workflows/<runId>/agent-N    -> workflow
 *
 * The workflow tier is the one `ccusage session` silently omits, so it must stay
 * separable all the way to the UI.
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

  for (const projEnt of fs.readdirSync(root, { withFileTypes: true })) {
    if (!projEnt.isDirectory()) continue;
    const projectDir = projEnt.name;
    const projPath = path.join(root, projectDir);

    for (const ent of fs.readdirSync(projPath, { withFileTypes: true })) {
      // main transcript: <sid>.jsonl
      if (ent.isFile() && ent.name.endsWith('.jsonl')) {
        const sid = ent.name.slice(0, -'.jsonl'.length);
        get(sid, projectDir).main = path.join(projPath, ent.name);
        continue;
      }
      if (!ent.isDirectory() || IGNORED_DIRS.has(ent.name)) continue;

      // agent transcripts live under <sid>/subagents/
      const sid = ent.name;
      const subDir = path.join(projPath, sid, 'subagents');
      if (!fs.existsSync(subDir)) continue;
      const s = get(sid, projectDir);

      for (const sEnt of fs.readdirSync(subDir, { withFileTypes: true })) {
        if (sEnt.isFile() && sEnt.name.endsWith('.jsonl')) {
          s.subagents.push(path.join(subDir, sEnt.name));
          continue;
        }
        if (!sEnt.isDirectory() || sEnt.name !== 'workflows') continue;

        // <sid>/subagents/workflows/<runId>/agent-*.jsonl
        const wfRoot = path.join(subDir, 'workflows');
        for (const runEnt of fs.readdirSync(wfRoot, { withFileTypes: true })) {
          if (!runEnt.isDirectory()) continue;
          const runId = runEnt.name;
          const files = fs
            .readdirSync(path.join(wfRoot, runId))
            .filter((f) => f.endsWith('.jsonl'))
            .map((f) => path.join(wfRoot, runId, f));
          if (files.length) s.workflows.set(runId, files);
        }
      }
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
