import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.{test,spec}.js', 'src/**/*.{test,spec}.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // Only the analysis core is unit-testable in-process. electron/ hosts a
      // browser window, public/ is a plain <script> with no exports, and
      // scripts/ is a one-shot build helper — none of them are exercised here.
      include: ['src/**/*.js'],
      // server.js binds a port at import time; verify.js shells out to ccusage.
      // Both are integration surfaces, covered by `npm run verify`, not by unit
      // tests, and counting them would only depress the number that matters.
      exclude: ['src/server.js', 'src/verify.js'],
    },
  },
});
