import { createApp } from './app.js';
import crypto from 'node:crypto';
import { loadConfig } from './config.js';
import { initDb } from './db/index.js';

async function main() {
  const cfg = loadConfig();
  cfg.sessionSalt = crypto.randomBytes(8).toString('hex');
  const db = await initDb(cfg);

  const app = createApp({ db, cfg });
  app.listen(cfg.port, '0.0.0.0', () => {
    // Intentionally no extra logging.
  });
}

main().catch((err) => {
  // Fail fast: if startup fails, surface it.
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
