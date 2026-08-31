/**
 * 伺服器宿主：把 Express 伺服器跑在一個「子程序」裡。
 *
 * 伺服器在冷啟動重新整理時做的每件事都是同步的 —— discoverSessions()
 * （巢狀 readdirSync）、算指紋（每個記錄檔一次 statSync）、readLines()
 * （readFileSync 約 170 MB，再逐行 JSON.parse），以及對 ccusage stdout 的 JSON.parse。
 * 這些工作若跑在 Electron 主程序裡，會把事件迴圈卡住好幾秒，Windows 就會把視窗畫成
 * 「沒有回應」。放到這裡之後它碰不到 UI —— 這也正是網頁版從來不會凍住的原因。
 *
 * 刻意用 CommonJS：utilityProcess.fork() 是用 require() 載入進入點的，
 * 而 src/server.js 是帶有頂層 await 的 ESM，只有動態 import() 才載得動它。
 * 在 package.json 標了 "type": "module" 的情況下，.cjs 副檔名是沒有歧義的。
 *
 * 與傳遞機制無關的訊息傳送：在 Electron utilityProcess（process.parentPort）
 * 和單純的 child_process.fork（process.send）底下都能運作。
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const send = process.parentPort
  ? (msg) => process.parentPort.postMessage(msg)
  : (msg) => process.send?.(msg);

// 只適用於 child_process.fork：父程序結束時 IPC 通道會關閉，所以我們絕不會活得比它久。
// utilityProcess 的子程序則是由 Chromium 的 job object 負責回收。
if (!process.parentPort) process.on('disconnect', () => process.exit(0));

function fatal(err) {
  try {
    send({ type: 'error', message: err?.message ?? String(err), stack: err?.stack ?? null });
  } catch {
    // 父程序已經不在了
  }
  console.error(err?.stack ?? String(err));
  // 在結束前讓訊息先送出去。
  setTimeout(() => process.exit(1), 50);
}

process.on('uncaughtException', fatal);
// 一個漏接的 rejection 不該把整個儀表板拖垮 —— 以前在同程序內也從來不會。
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
});

(async () => {
  const entry = pathToFileURL(path.join(__dirname, '..', 'src', 'server.js')).href;
  const { startServer } = await import(entry);
  // 動態 port：絕不會和網頁版跑在 4317 的實例衝突。
  const server = await startServer({ port: Number(process.env.AITA_PORT) || 0 });
  send({ type: 'listening', port: server.address().port });
})().catch(fatal);
