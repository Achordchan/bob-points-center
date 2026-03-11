import { notifyGroupInteractiveCardBySettings } from './groupCardNotifyService.js';

function toInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n;
}

function formatOpenTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  try {
    return new Date(n * 1000).toLocaleString('zh-CN', { hour12: false });
  } catch (_) {
    return String(ts);
  }
}

async function getScheduleRow(db) {
  const row = await db.get('SELECT * FROM mall_opening_schedule WHERE id = 1');
  return row || null;
}

async function updateScheduleRow(db, fields) {
  const updates = Object.entries(fields || {}).filter(([, v]) => v !== undefined);
  if (!updates.length) return;
  const sets = updates.map(([k]) => `${k} = ?`).join(', ');
  const values = updates.map(([, v]) => v);
  await db.run(`UPDATE mall_opening_schedule SET ${sets}, updated_at = unixepoch() WHERE id = 1`, values);
}

function buildReminderCard(openAt) {
  const openText = formatOpenTime(openAt);
  return {
    title: '【BOB币中心】即将开启下单',
    markdown: `## 即将开启下单\n\n- 开启时间：${openText || '待定'}\n\n请提前准备，下单即将开放。`,
    outTrackId: `mall_open_remind_${openAt}_${Date.now()}`,
  };
}

function buildOpenCard(openAt) {
  const openText = formatOpenTime(openAt);
  return {
    title: '【BOB币中心】商城已开启',
    markdown: `## 商城已开启\n\n- 开启时间：${openText || '刚刚'}\n\n现在可以下单啦！`,
    outTrackId: `mall_open_now_${openAt}_${Date.now()}`,
  };
}

function buildCloseSoonCard(closeAt) {
  const closeText = formatOpenTime(closeAt);
  return {
    title: '【BOB币中心】商城即将关闭',
    markdown: `## 即将关闭\n\n- 关闭时间：${closeText || '待定'}\n\n请尽快完成下单。`,
    outTrackId: `mall_close_remind_${closeAt}_${Date.now()}`,
  };
}

export function startMallOpeningScheduler({ db, cfg }) {
  if (!db) return null;
  const tickIntervalMs = 1000;

  const timer = setInterval(async () => {
    let row;
    try {
      row = await getScheduleRow(db);
    } catch (_) {
      return;
    }
    if (!row) return;

    const now = Math.floor(Date.now() / 1000);
    const nextOpenAt = toInt(row.next_open_at);
    const intervalMinutes = toInt(row.interval_minutes);
    const remindBeforeSeconds = toInt(row.remind_before_seconds);
    const openDurationMinutes = toInt(row.open_duration_minutes);
    const closeRemindSeconds = toInt(row.close_remind_seconds);

    const updates = {};

    if (row.auto_enabled) {
      const isOpen = Number(row.is_open) === 1;

      if (isOpen && openDurationMinutes && row.open_notify_for_open_at) {
        const openAt = Number(row.open_notify_for_open_at);
        const closeAt = openAt + openDurationMinutes * 60;
        if (Number.isFinite(closeAt) && now >= closeAt) {
          updates.is_open = 0;
        }
      }

      if (!isOpen && nextOpenAt && now >= nextOpenAt) {
        updates.is_open = 1;

        if (row.open_notify_for_open_at !== nextOpenAt) {
          await notifyGroupInteractiveCardBySettings(db, cfg, {
            ...buildOpenCard(nextOpenAt),
            event: 'mall_open',
            vars: { open_time: formatOpenTime(nextOpenAt) || '-' },
          });
          updates.open_notify_for_open_at = nextOpenAt;
        }

        if (intervalMinutes && intervalMinutes > 0) {
          let next = nextOpenAt + intervalMinutes * 60;
          while (next <= now) {
            next += intervalMinutes * 60;
          }
          updates.next_open_at = next;
          updates.remind_for_open_at = null;
        }
      }

      if (!isOpen && nextOpenAt && remindBeforeSeconds && remindBeforeSeconds > 0) {
        const remindAt = nextOpenAt - remindBeforeSeconds;
        if (now >= remindAt && row.remind_for_open_at !== nextOpenAt) {
          await notifyGroupInteractiveCardBySettings(db, cfg, {
            ...buildReminderCard(nextOpenAt),
            event: 'mall_open_remind',
            vars: { open_time: formatOpenTime(nextOpenAt) || '-' },
          });
          updates.remind_for_open_at = nextOpenAt;
        }
      }

      if (isOpen && openDurationMinutes && closeRemindSeconds && closeRemindSeconds > 0 && row.open_notify_for_open_at) {
        const openAt = Number(row.open_notify_for_open_at);
        const closeAt = openAt + openDurationMinutes * 60;
        const remindAt = closeAt - closeRemindSeconds;
        if (Number.isFinite(closeAt) && now >= remindAt && row.close_remind_for_close_at !== closeAt) {
          await notifyGroupInteractiveCardBySettings(db, cfg, {
            ...buildCloseSoonCard(closeAt),
            event: 'mall_close_remind',
            vars: { close_time: formatOpenTime(closeAt) || '-' },
          });
          updates.close_remind_for_close_at = closeAt;
        }
      }
    }

    if (Object.keys(updates).length) {
      try {
        await updateScheduleRow(db, updates);
      } catch (_) {
        // ignore
      }
    }
  }, tickIntervalMs);

  return () => clearInterval(timer);
}
