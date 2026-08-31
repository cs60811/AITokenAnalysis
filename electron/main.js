import { app, BrowserWindow, Menu, dialog, shell, utilityProcess } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 桌面外殼：Express 伺服器跑在一個 utility process 裡、使用動態 port，
 * 而視窗只是一個指向 127.0.0.1 的普通瀏覽器 —— 沒有 preload、沒有 IPC。
 *
 * 這個伺服器以前是跑在「這個」程序裡的。它的冷啟動路徑包含數千次同步 fs 呼叫，
 * 外加一份約 170 MB 的 readFileSync 語料，會讓整個視窗在「重新整理」時凍住
 * （Windows 上顯示「沒有回應」）。網頁版從來不會凍住，因為那邊的伺服器本來就是
 * 獨立的 `node` 程序；這個做法就是把那個特性找回來。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST_ENTRY = path.join(__dirname, 'server-host.cjs');
// initPricing() 會在開始監聽前以 5 秒逾時去抓 LiteLLM，而 Defender 對 electron.exe
// 的冷掃描還會再多花幾秒。這裡放寬一點。
const START_TIMEOUT_MS = 30_000;
const MAX_RESTARTS = 2;

// 純 ASCII、且不隨 productName 變動的資料目錄：%APPDATA%\AITokenAnalysis
app.setPath('userData', path.join(app.getPath('appData'), 'AITokenAnalysis'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;
  let child = null;
  let quitting = false;
  let restarts = 0;
  /** 子程序輸出的最後幾行，這樣啟動失敗時才能說明原因。 */
  const tail = [];

  const log = (chunk) => {
    tail.push(String(chunk));
    if (tail.length > 40) tail.shift();
    // 打包後的 Windows GUI 程式沒有附掛主控台。
    try {
      process.stdout.write(chunk);
    } catch {
      // 沒有 stdout
    }
  };

  /** 派生伺服器程序，並在它回報所監聽的 port 之後 resolve。 */
  function startServerProcess() {
    return new Promise((resolve, reject) => {
      const proc = utilityProcess.fork(HOST_ENTRY, [], {
        serviceName: 'AITA server',
        // 這裡必須是「真的」目錄：app 根目錄位於 app.asar 之內，那並不是真目錄，
        // 若把 cwd 指到那裡，打包後的版本會啟動失敗。
        cwd: app.getPath('userData'),
        stdio: 'pipe',
        env: {
          ...process.env,
          // config.js 會在載入時讀這個值。打包後的 app 根目錄位於唯讀的 app.asar，
          // 所以定價快取要改放到 userData。
          AITA_CACHE_DIR: path.join(app.getPath('userData'), 'cache'),
          // 不能靠 process.versions.electron 來辨識這個子程序 ——
          // 見 config.js 裡的 IS_DESKTOP。
          AITA_DESKTOP: '1',
        },
      });

      // 沒人讀的管線會塞滿並卡住子程序，所以這兩個必須一直掛著。
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
        // 若我們始終沒拿到 port，就在這裡把啟動的 promise 收掉（讓在載入階段就
        // 死掉的子程序把它的堆疊顯示出來，而不是空等 30 秒）；
        // 若 promise 已經收過了，這裡就什麼也不做。
        settle(reject, new Error(`伺服器程序結束（代碼 ${code}）`));
        onChildExit(proc, code);
      });
    });
  }

  /** 成功啟動後才崩潰：重試幾次，再放棄並明確地報出來。 */
  function onChildExit(proc, code) {
    if (proc !== child || quitting) return; // 啟動失敗，或是我們自己殺掉的
    child = null;
    if (restarts >= MAX_RESTARTS) {
      fail(`伺服器程序反覆結束（代碼 ${code}）`);
      return;
    }
    restarts += 1;
    startServerProcess()
      .then(({ proc: next, port }) => {
        child = next;
        // port 換新的了，所以視窗必須重新指向。
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
  // 雙保險：不允許任何東西活得比視窗久。
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

    // 更新提示會透過 window.open 打開下載頁 -> 交給系統瀏覽器。
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
