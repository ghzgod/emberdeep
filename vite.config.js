import { defineConfig } from 'vite';
import { writeFileSync, mkdirSync } from 'node:fs';

// Unique id per build — baked into the bundle AND written to dist/version.json.
// The running game compares the two to detect (and force-load) new deploys,
// since GitHub Pages caches index.html for 10 minutes and phones cache harder.
const buildId = Date.now().toString(36);

export default defineConfig({
  // Relative base so the built game runs from any path (e.g. GitHub Pages).
  base: './',
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
    __BUILD_DATE__: JSON.stringify(new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })),
  },
  plugins: [
    {
      name: 'emit-version-json',
      closeBundle() {
        mkdirSync('dist', { recursive: true });
        writeFileSync('dist/version.json', JSON.stringify({ id: buildId }));
      },
    },
  ],
});
