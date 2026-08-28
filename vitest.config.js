import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.{test,spec}.js', 'src/**/*.{test,spec}.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // The analysis core, plus the frontend's pure logic. app.js itself is DOM,
      // charts and fetch — verified by running the page, not by unit tests (see
      // exclude). electron/ hosts a browser window and scripts/ is a one-shot
      // build helper; neither is exercised here.
      include: ['src/**/*.js', 'public/lib.js'],
      // Integration surfaces, all three: server.js binds a port at import time,
      // verify.js shells out to ccusage and reconciles against it, and update.js
      // shells to git, fetches GitHub and restarts the process. They are covered
      // by `npm run verify` and by actually running the app; driving them through
      // mocked child_process would be scaffolding that tests the mocks.
      exclude: ['src/server.js', 'src/verify.js', 'src/update.js', 'public/app.js', 'public/vendor/**'],
    },
  },
});
