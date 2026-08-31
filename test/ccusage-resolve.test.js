/**
 * ccusage.js 中「退回 cli」的那一半：當沒有原生執行檔、必須由我們自己跑
 * `node <cli.js>` 時會發生什麼事。
 *
 * 之所以獨立成一個檔案，是因為解析結果是「每個模組實例」各自快取的，
 * 而這個檔案需要的是一台「沒有原生執行檔」的機器 ——
 * 正好和 ccusage.test.js 所在的機器相反。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

vi.mock('../src/config.js', () => ({
  CCUSAGE_TIMEOUT_MS: 60_000,
  CCUSAGE_MAX_BUFFER: 1 << 28,
  CCUSAGE_EXPORT_MAX_BUFFER: 1 << 24,
  IS_DESKTOP: true, // 打包後的桌面版，那裡的 execPath 是 electron.exe
}));

const calls = [];
vi.mock('node:child_process', () => ({
  execFile: (cmd, args, opts, cb) => {
    calls.push({ cmd, args, opts });
    setImmediate(() => cb(null, '{}', ''));
  },
  spawn: vi.fn(),
}));

/** 這台假機器上有的檔案。原生執行檔刻意不存在。 */
let present = new Set();
vi.mock('node:fs', () => ({
  default: {
    existsSync: (p) => present.has(p),
    readFileSync: () => JSON.stringify({ bin: { ccusage: './dist/cli.js' } }),
  },
}));

/** require.resolve 找得到 ccusage 的 manifest，但永遠找不到原生執行檔。 */
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
    // PATH 上的 `ccusage` 是 .cmd/.ps1/sh 三件組的 shim，而自 Node 20 起，
    // child_process 拒絕在沒有 shell:true 的情況下啟動 .cmd。
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
    // 這裡 IS_DESKTOP 是 true：在 Electron 底下 process.execPath 是 electron.exe。
    expect(calls[0].opts.env.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('falls back to a global install when the package is not a local dependency', async () => {
    const globalRoot = path.join(path.dirname(process.execPath), 'node_modules');
    const pkgPath = path.join(globalRoot, 'ccusage', 'package.json');
    // 上面的 readFileSync 會回報 bin.ccusage = './dist/cli.js'。
    const cli = path.resolve(path.dirname(pkgPath), './dist/cli.js');
    present.add(pkgPath);
    present.add(cli);

    const { cliLocation } = await load();
    expect(cliLocation()).toBe(cli);
  });

  it('skips a global root whose manifest resolves to a file that is not there', async () => {
    const pkgPath = path.join(path.dirname(process.execPath), 'node_modules', 'ccusage', 'package.json');
    present.add(pkgPath); // manifest 存在，但 cli.js 不存在
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
    present.clear(); // 磁碟內容在我們腳下被換掉了
    await daily();
    expect(cliLocation()).toBe(first);
  });
});
