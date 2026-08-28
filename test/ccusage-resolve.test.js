/**
 * The cli-fallback half of ccusage.js: what happens when there is no native
 * binary and we have to run `node <cli.js>` ourselves.
 *
 * Separate file because the resolver results are memoized per module instance,
 * and this one needs a machine with no native exe — the opposite of the machine
 * ccusage.test.js runs on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

vi.mock('../src/config.js', () => ({
  CCUSAGE_TIMEOUT_MS: 60_000,
  CCUSAGE_MAX_BUFFER: 1 << 28,
  CCUSAGE_EXPORT_MAX_BUFFER: 1 << 24,
  IS_DESKTOP: true, // the packaged desktop build, where execPath is electron.exe
}));

const calls = [];
vi.mock('node:child_process', () => ({
  execFile: (cmd, args, opts, cb) => {
    calls.push({ cmd, args, opts });
    setImmediate(() => cb(null, '{}', ''));
  },
  spawn: vi.fn(),
}));

/** Files this fake machine has. The native exe is deliberately absent. */
let present = new Set();
vi.mock('node:fs', () => ({
  default: {
    existsSync: (p) => present.has(p),
    readFileSync: () => JSON.stringify({ bin: { ccusage: './dist/cli.js' } }),
  },
}));

/** require.resolve finds the ccusage manifest but never the native binary. */
let localManifest = null;
vi.mock('node:module', () => ({
  createRequire: () => {
    const req = (p) => (p === localManifest ? { bin: './lib/entry.js' } : {});
    req.resolve = (spec) => {
      if (spec === 'ccusage/package.json') {
        if (!localManifest) throw new Error('not a local dependency');
        return localManifest;
      }
      throw new Error(`cannot resolve ${spec}`);
    };
    return req;
  },
}));

const load = async () => {
  vi.resetModules();
  return import('../src/ccusage.js');
};

beforeEach(() => {
  calls.length = 0;
  present = new Set();
  localManifest = null;
});

describe('resolving the cli when there is no native binary', () => {
  it('runs the locally-installed cli with node, not the PATH shim', async () => {
    // The `ccusage` on PATH is a .cmd/.ps1/sh shim trio, and since Node 20
    // child_process refuses to spawn a .cmd without shell:true.
    localManifest = path.join('C:', 'proj', 'node_modules', 'ccusage', 'package.json');
    const cli = path.resolve(path.dirname(localManifest), './lib/entry.js');
    present.add(cli);

    const { daily } = await load();
    await daily();

    expect(calls[0].cmd).toBe(process.execPath);
    expect(calls[0].args[0]).toBe(cli);
    expect(calls[0].args.slice(1)).toEqual(['daily', '--json']);
    expect(calls[0].opts.shell).toBe(false);
  });

  it('makes electron behave as node via ELECTRON_RUN_AS_NODE', async () => {
    localManifest = path.join('C:', 'proj', 'node_modules', 'ccusage', 'package.json');
    present.add(path.resolve(path.dirname(localManifest), './lib/entry.js'));

    const { daily } = await load();
    await daily();
    // IS_DESKTOP is true here: under Electron process.execPath is electron.exe.
    expect(calls[0].opts.env.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('falls back to a global install when the package is not a local dependency', async () => {
    const globalRoot = path.join(path.dirname(process.execPath), 'node_modules');
    const pkgPath = path.join(globalRoot, 'ccusage', 'package.json');
    // readFileSync above reports bin.ccusage = './dist/cli.js'.
    const cli = path.resolve(path.dirname(pkgPath), './dist/cli.js');
    present.add(pkgPath);
    present.add(cli);

    const { cliLocation } = await load();
    expect(cliLocation()).toBe(cli);
  });

  it('skips a global root whose manifest resolves to a file that is not there', async () => {
    const pkgPath = path.join(path.dirname(process.execPath), 'node_modules', 'ccusage', 'package.json');
    present.add(pkgPath); // manifest present, cli.js absent
    const { cliLocation } = await load();
    expect(cliLocation()).toBeNull();
  });

  it('reports a not_found error naming the install command when nothing resolves', async () => {
    const { daily, cliLocation } = await load();
    expect(cliLocation()).toBeNull();
    await expect(daily()).rejects.toMatchObject({
      name: 'CcusageError',
      kind: 'not_found',
      message: expect.stringContaining('npm install -g ccusage'),
    });
    expect(calls).toHaveLength(0);
  });

  it('memoizes the resolution rather than probing the disk per call', async () => {
    localManifest = path.join('C:', 'proj', 'node_modules', 'ccusage', 'package.json');
    present.add(path.resolve(path.dirname(localManifest), './lib/entry.js'));

    const { daily, cliLocation } = await load();
    const first = cliLocation();
    present.clear(); // the disk changes under us
    await daily();
    expect(cliLocation()).toBe(first);
  });
});
