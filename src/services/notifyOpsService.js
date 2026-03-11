import { notifyUserPrivateText, sendRobotPrivateText } from './robotNotifyService.js';
import { getNotifySettings } from './systemSettings.js';

export function toBool(value) {
  if (value === true) return true;
  if (value === false) return false;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  const s = value === null || value === undefined ? '' : String(value).trim().toLowerCase();
  if (!s) return false;
  return ['true', 'yes', 'y', 'on'].includes(s);
}

export async function getUserName(db, userid) {
  const uid = userid ? String(userid).trim() : '';
  if (!uid) return '';
  const row = await db.get('SELECT name FROM users WHERE userid = ? LIMIT 1', [uid]);
  const name = row?.name ? String(row.name).trim() : '';
  return name;
}

function buildNotifyContent({ title, lines }) {
  const arr = [title, ...((Array.isArray(lines) ? lines : []))]
    .map((x) => (x === null || x === undefined ? '' : String(x).trim()))
    .filter((x) => x);
  return arr.join('\n');
}

function renderTemplate(template, variables) {
  const vars = variables && typeof variables === 'object' ? variables : {};
  const source = template === null || template === undefined ? '' : String(template);
  return source.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, key) => {
    const v = vars[key];
    return v === null || v === undefined ? '' : String(v);
  });
}

export async function sendOrQueueNotify({
  db,
  cfg,
  userid,
  title,
  lines,
  awaitNotify,
  event,
  variables,
}) {
  const settings = await getNotifySettings(db);
  if (settings?.enabled === false) {
    return { ok: false, error: 'notify_disabled' };
  }

  let content = '';
  if (event && settings?.templates?.[event]) {
    const tpl = settings.templates[event];
    if (tpl?.enabled === false) {
      return { ok: false, error: 'notify_event_disabled' };
    }
    const tplTitle = renderTemplate(tpl?.title, variables);
    const tplContent = renderTemplate(tpl?.content, variables);
    content = buildNotifyContent({ title: tplTitle, lines: tplContent ? [tplContent] : [] });
  } else {
    content = buildNotifyContent({ title, lines });
  }
  if (!content) {
    return { ok: false, error: 'empty content' };
  }

  if (!awaitNotify) {
    notifyUserPrivateText(cfg, { userid, title: '', lines: [content] });
    return null;
  }

  try {
    await sendRobotPrivateText(cfg, { userid, content });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}
