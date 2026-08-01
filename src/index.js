import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { initDb } from './db/index.js';
import { applyDingtalkConnectionSettings, getDingtalkConnectionSettings } from './services/systemSettings.js';
import { configureDnsResultOrder } from './utils/network.js';

async function main() {
  configureDnsResultOrder();
  const cfg = loadConfig();
  const db = await initDb(cfg);
  const dingtalkSettings = await getDingtalkConnectionSettings(db, cfg);
  applyDingtalkConnectionSettings(cfg, dingtalkSettings);

  // 会话全局版本：重启不失效；多实例共享同一 system_settings 即可主动吊销。
  try {
    const row = await db.get('SELECT value FROM system_settings WHERE key = ? LIMIT 1', ['session_global_version']);
    const n = Number(row?.value);
    cfg.sessionGlobalVersion = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  } catch {
    cfg.sessionGlobalVersion = 0;
  }

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
