import { app, BrowserWindow, Menu, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Desktop shell: run the same Express server in-process on a dynamic port and
 * show it in a window. No preload, no IPC — the renderer is the plain dashboard
 * talking to 127.0.0.1 over HTTP, exactly like the web mode.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ASCII, productName-independent data dir: %APPDATA%\AITokenAnalysis
app.setPath('userData', path.join(app.getPath('appData'), 'AITokenAnalysis'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.on('window-all-closed', () => app.quit());

  app.whenReady().then(async () => {
    // Must be set BEFORE server.js (-> config.js) is imported: the packaged app
    // root lives inside read-only app.asar, so the pricing cache moves here.
    process.env.AITA_CACHE_DIR = path.join(app.getPath('userData'), 'cache');

    const { startServer } = await import('../src/server.js');
    // Dynamic port: never clashes with a web-mode instance on 4317.
    const server = await startServer({ port: 0 });
    const { port } = server.address();

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
