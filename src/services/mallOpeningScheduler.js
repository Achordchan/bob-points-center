import { notifyGroupInteractiveCardBySettings } from './groupCardNotifyService.js';
import { publishMallRealtimeEvent } from './mallRealtimeService.js';

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

function buildReminderCard(openAt, closeAt = null) {
  const openText = formatOpenTime(openAt);
  const closeText = formatOpenTime(closeAt);
  const closeLine = closeText ? `\n- 关闭时间：${closeText}` : '';
  return {
    title: '【BOB币中心】即将开启下单',
    markdown: `## 即将开启下单\n\n- 开启时间：${openText || '待定'}${closeLine}\n\n请提前准备，下单即将开放。`,
    outTrackId: `mall_open_remind_${openAt}`,
  };
}

function buildOpenCard(openAt, closeAt = null) {
  const openText = formatOpenTime(openAt);
  const closeText = formatOpenTime(closeAt);
  const closeLine = closeText ? `\n- 关闭时间：${closeText}` : '';
  return {
    title: '【BOB币中心】商城已开启',
    markdown: `## 商城已开启\n\n- 开启时间：${openText || '刚刚'}${closeLine}\n\n现在可以下单啦！`,
    outTrackId: `mall_open_now_${openAt}`,
  };
}

function buildCloseSoonCard(closeAt) {
  const closeText = formatOpenTime(closeAt);
  return {
    title: '【BOB币中心】商城即将关闭',
    markdown: `## 即将关闭\n\n- 关闭时间：${closeText || '待定'}\n\n请尽快完成下单。`,
    outTrackId: `mall_close_remind_${closeAt}`,
  };
}

function buildCloseCard(closeAt) {
  const closeText = formatOpenTime(closeAt);
  return {
    title: '【BOB币中心】商城已关闭',
    markdown: `## 商城已关闭\n\n- 关闭时间：${closeText || '刚刚'}\n\n本轮下单已结束。`,
    outTrackId: `mall_close_now_${closeAt}`,
  };
}

async function claimScheduleUpdate(db, fields, whereSql, whereValues) {
  const updates = Object.entries(fields || {}).filter(([, v]) => v !== undefined);
  if (!updates.length) return false;
  const sets = updates.map(([k]) => `${k} = ?`).join(', ');
  const values = updates.map(([, v]) => v);
  const result = await db.run(
    `UPDATE mall_opening_schedule SET ${sets}, updated_at = unixepoch() WHERE id = 1 AND ${whereSql}`,
    [...values, ...(Array.isArray(whereValues) ? whereValues : [])],
  );
  return Number(result?.changes || 0) > 0;
}

export function startMallOpeningScheduler({ db, cfg }) {
  if (!db) return null;

  const tickIntervalMs = 1000;
  let ticking = false;

  const timer = setInterval(async () => {
    if (ticking) return;
    ticking = true;

    try {
      const row = await getScheduleRow(db);
      if (!row || !row.auto_enabled) return;

      const now = Math.floor(Date.now() / 1000);
      const nextOpenAt = toInt(row.next_open_at);
      const intervalMinutes = toInt(row.interval_minutes);
      const remindBeforeSeconds = toInt(row.remind_before_seconds);
      const openDurationMinutes = toInt(row.open_duration_minutes);
      const closeRemindSeconds = toInt(row.close_remind_seconds);
      const notifiedOpenAt = toInt(row.open_notify_for_open_at);
      const isOpen = Number(row.is_open) === 1;
      let changed = false;
      const realtime = { reason: 'scheduler' };

      if (isOpen && openDurationMinutes && notifiedOpenAt) {
        const closeAt = notifiedOpenAt + openDurationMinutes * 60;
        if (Number.isFinite(closeAt) && now >= closeAt) {
          const claimed = await claimScheduleUpdate(
            db,
            { is_open: 0, close_notify_for_close_at: closeAt },
            'is_open = 1 AND open_notify_for_open_at = ? AND (close_notify_for_close_at IS NULL OR close_notify_for_close_at <> ?)',
            [notifiedOpenAt, closeAt],
          );
          if (claimed) {
            changed = true;
            realtime.is_open = 0;
            await notifyGroupInteractiveCardBySettings(db, cfg, {
              ...buildCloseCard(closeAt),
              event: 'mall_close',
              vars: { close_time: formatOpenTime(closeAt) || '-' },
            });
          }
        }
      }

      if (!isOpen && nextOpenAt && now >= nextOpenAt) {
        const closeAt = openDurationMinutes ? nextOpenAt + openDurationMinutes * 60 : null;
        let next = null;
        if (intervalMinutes && intervalMinutes > 0) {
          next = nextOpenAt + intervalMinutes * 60;
          while (next <= now) next += intervalMinutes * 60;
        }
        const claimed = await claimScheduleUpdate(
          db,
          {
            is_open: 1,
            open_notify_for_open_at: nextOpenAt,
            close_remind_for_close_at: null,
            close_notify_for_close_at: null,
            next_open_at: next === null ? undefined : next,
            remind_for_open_at: next === null ? undefined : null,
          },
          'is_open = 0 AND next_open_at = ? AND (open_notify_for_open_at IS NULL OR open_notify_for_open_at <> ?)',
          [nextOpenAt, nextOpenAt],
        );
        if (claimed) {
          changed = true;
          realtime.is_open = 1;
          if (next !== null) realtime.next_open_at = next;
          await notifyGroupInteractiveCardBySettings(db, cfg, {
            ...buildOpenCard(nextOpenAt, closeAt),
            event: 'mall_open',
            vars: {
              open_time: formatOpenTime(nextOpenAt) || '-',
              close_time: formatOpenTime(closeAt) || '-',
            },
          });
        }
      }

      if (!isOpen && nextOpenAt && remindBeforeSeconds && remindBeforeSeconds > 0 && now < nextOpenAt) {
        const remindAt = nextOpenAt - remindBeforeSeconds;
        if (now >= remindAt) {
          const closeAt = openDurationMinutes ? nextOpenAt + openDurationMinutes * 60 : null;
          const claimed = await claimScheduleUpdate(
            db,
            { remind_for_open_at: nextOpenAt },
            'is_open = 0 AND next_open_at = ? AND (remind_for_open_at IS NULL OR remind_for_open_at <> ?)',
            [nextOpenAt, nextOpenAt],
          );
          if (claimed) {
            changed = true;
            await notifyGroupInteractiveCardBySettings(db, cfg, {
              ...buildReminderCard(nextOpenAt, closeAt),
              event: 'mall_open_remind',
              vars: {
                open_time: formatOpenTime(nextOpenAt) || '-',
                close_time: formatOpenTime(closeAt) || '-',
              },
            });
          }
        }
      }

      if (isOpen && openDurationMinutes && closeRemindSeconds && closeRemindSeconds > 0 && notifiedOpenAt) {
        const closeAt = notifiedOpenAt + openDurationMinutes * 60;
        const remindAt = closeAt - closeRemindSeconds;
        if (Number.isFinite(closeAt) && now >= remindAt && now < closeAt) {
          const claimed = await claimScheduleUpdate(
            db,
            { close_remind_for_close_at: closeAt },
            'is_open = 1 AND open_notify_for_open_at = ? AND (close_remind_for_close_at IS NULL OR close_remind_for_close_at <> ?)',
            [notifiedOpenAt, closeAt],
          );
          if (claimed) {
            changed = true;
            await notifyGroupInteractiveCardBySettings(db, cfg, {
              ...buildCloseSoonCard(closeAt),
              event: 'mall_close_remind',
              vars: { close_time: formatOpenTime(closeAt) || '-' },
            });
          }
        }
      }

      if (changed) {
        publishMallRealtimeEvent('opening_changed', realtime);
      }
    } catch (_) {
      // ignore this tick; next tick will re-read the persisted scheduler state
    } finally {
      ticking = false;
    }
  }, tickIntervalMs);

  return () => clearInterval(timer);
}
