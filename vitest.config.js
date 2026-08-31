import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.{test,spec}.js', 'src/**/*.{test,spec}.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // 分析核心，加上前端的純邏輯。app.js 本身是 DOM、圖表與 fetch ——
      // 那是靠實際跑頁面驗證的，不是靠單元測試（見下方 exclude）。
      // electron/ 裝的是瀏覽器視窗，scripts/ 是一次性的建置輔助工具，兩者都不在此涵蓋。
      include: ['src/**/*.js', 'public/lib.js'],
      // 這三個都是整合面：server.js 載入時就會綁 port，verify.js 會呼叫 ccusage
      // 並與它對帳，update.js 則會呼叫 git、抓 GitHub 並重啟程序。
      // 它們由 `npm run verify` 以及實際把 app 跑起來涵蓋；用假的 child_process
      // 去驅動它們，只會變成「測試那些假物件」的鷹架。
      exclude: ['src/server.js', 'src/verify.js', 'src/update.js', 'public/app.js', 'public/vendor/**'],
    },
  },
});
