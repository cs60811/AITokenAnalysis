import { app, BrowserWindow, Menu, dialog, shell, utilityProcess } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Desktop shell: the Express server runs in a utility process on a dynamic port
 * and the window is a plain browser pointed at 127.0.0.1 — no preload, no IPC.
 *
 * The server used to run IN this process. Its cold path is thousands of
 * synchronous fs calls plus a ~170 MB readFileSync corpus, which froze the whole
 * window on 重新整理 (Windows: 「沒有回應」). Web mode never froze, because there
 * the server is its own `node` process; this restores that property.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST_ENTRY = path.join(__dirname, 'server-host.cjs');
// initPricing() fetches LiteLLM with a 5s timeout before listen, and a cold
// Defender scan of electron.exe adds seconds on top. Be generous.
const START_TIMEOUT_MS = 30_000;
const MAX_RESTARTS = 2;

// ASCII, productName-independent data dir: %APPDATA%\AITokenAnalysis
app.setPath('userData', path.join(app.getPath('appData'), 'AITokenAnalysis'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;
  let child = null;
  let quitting = false;
  let restarts = 0;
  /** Last lines of child output, so a startup failure can show why. */
  const tail = [];

  const log = (chunk) => {
    tail.push(String(chunk));
    if (tail.length > 40) tail.shift();
    // A packaged Windows GUI app has no console attached.
    try {
      process.stdout.write(chunk);
    } catch {
      // no stdout
    }
  };

  /** Fork the server and resolve once it reports the port it is listening on. */
  function startServerProcess() {
    return new Promise((resolve, reject) => {
      const proc = utilityProcess.fork(HOST_ENTRY, [], {
        serviceName: 'AITA server',
        // Must be a REAL directory: the app root is inside app.asar, which is not
        // one, and a packaged build fails to start if we point cwd at it.
        cwd: app.getPath('userData'),
        stdio: 'pipe',
        env: {
          ...process.env,
          // Read at import time by config.js. The packaged app root lives in
          // read-only app.asar, so the pricing cache moves to userData.
          AITA_CACHE_DIR: path.join(app.getPath('userData'), 'cache'),
          // The child must not be identified by process.versions.electron —
          // see IS_DESKTOP in config.js.
          AITA_DESKTOP: '1',
        },
      });

      // An unread pipe fills and stalls the child, so these must stay attached.
      proc.stdout?.on('data', log);
      proc.stderr?.on('data', log);

      const timer = setTimeout(
        () => reject(new Error(`伺服器在 ${START_TIMEOUT_MS / 1000} 秒內沒有回報連線埠`)),
        START_TIMEOUT_MS,
      );
      const settle = (fn, arg) => {
        clearTimeout(timer);
        fn(arg);
      };

      proc.on('message', (msg) => {
        if (msg?.type === 'listening') settle(resolve, { proc, port: msg.port });
        else if (msg?.type === 'error') settle(reject, new Error(msg.message));
      });
      proc.on('exit', (code) => {
        // Settles the startup promise if we never got a port (a child that died
        // during import surfaces its stack instead of hanging for 30s); a no-op
        // once the promise has already settled.
        settle(reject, new Error(`伺服器程序結束（代碼 ${code}）`));
        onChildExit(proc, code);
      });
    });
  }

  /** Crash after a successful start: restart a couple of times, then give up loudly. */
  function onChildExit(proc, code) {
    if (proc !== child || quitting) return; // startup failure, or we killed it
    child = null;
    if (restarts >= MAX_RESTARTS) {
      fail(`伺服器程序反覆結束（代碼 ${code}）`);
      return;
    }
    restarts += 1;
    startServerProcess()
      .then(({ proc: next, port }) => {
        child = next;
        // The port is new, so the window has to be re-pointed.
        win?.loadURL(`http://127.0.0.1:${port}/`);
        setTimeout(() => {
          restarts = 0;
        }, 60_000).unref?.();
      })
      .catch((err) => fail(err.message));
  }

  function fail(message) {
    dialog.showErrorBox('AI 用量儀表板無法啟動', `${message}\n\n${tail.join('')}`.slice(0, 2000));
    quitting = true;
    app.quit();
  }

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    quitting = true;
  });
  // Belt and braces: nothing may outlive the window.
  app.on('will-quit', () => {
    child?.kill();
    child = null;
  });
  app.on('child-process-gone', (_e, d) => log(`child-process-gone: ${d.type}/${d.serviceName} ${d.reason}\n`));

  app.whenReady().then(async () => {
    let port;
    try {
      const started = await startServerProcess();
      child = started.proc;
      port = started.port;
    } catch (err) {
      fail(err.message);
      return;
    }

    Menu.setApplicationMenu(null);
    win = new BrowserWindow({
      width: 1280,
      height: 860,
      icon: path.join(__dirname, '..', 'build', 'icon.ico'),
      autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });

    // The update toast opens the download page via window.open -> system browser.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });

    win.on('closed', () => {
      win = null;
    });

    await win.loadURL(`http://127.0.0.1:${port}/`);
  });
}
