// Production entrypoint. ncc bundles this into `dist/index.js` which is what
// GitHub Actions runtime executes (per action.yml `runs.main`). For local
// development use `@github/local-action` which imports `run` from `src/main.ts`
// directly (see `pnpm test:local`).
import { run } from './main';

void run();
