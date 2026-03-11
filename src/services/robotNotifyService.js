import { getV1AccessToken } from './dingtalkService.js';

 class DingtalkHttpError extends Error {
   constructor(message, { status, bodyText } = {}) {
     super(message);
     this.name = 'DingtalkHttpError';
     this.status = status;
     this.bodyText = bodyText;
   }
 }

 function sleep(ms) {
   return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
 }

async function httpJsonWithHeaders(method, url, { headers = {}, body } = {}) {
  const opts = { method, headers: { ...headers } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  if (typeof fetch !== 'function') {
    throw new Error('fetch not available, please use Node.js 18+');
  }

  const resp = await fetch(url, opts);
  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`dingtalk invalid json: ${text}`);
  }
  if (!resp.ok) {
    throw new DingtalkHttpError(`dingtalk http ${resp.status}: ${text}`, {
      status: resp.status,
      bodyText: text,
    });
  }
  return data;
}

 let notifyQueue = Promise.resolve();

 function enqueueNotify(fn) {
   notifyQueue = notifyQueue
     .then(fn)
     // eslint-disable-next-line no-console
     .catch((err) => console.error(err));
   return notifyQueue;
 }

 async function sendWithRetry(sendFn) {
   const maxAttempts = 3;
   for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
     try {
       return await sendFn();
     } catch (err) {
       const status = err instanceof DingtalkHttpError ? err.status : null;
       const retryable = status === 429 || (typeof status === 'number' && status >= 500);
       if (!retryable || attempt >= maxAttempts) {
         throw err;
       }
       const backoffMs = 300 * 2 ** (attempt - 1);
       await sleep(backoffMs);
     }
   }
   return null;
 }

function isNotifyEnabled(cfg) {
  const enabled = cfg?.dingtalk?.robotNotifyEnabled;
  if (enabled === true) return true;
  if (enabled === false) return false;
  const robotCode = cfg?.dingtalk?.robotCode ? String(cfg.dingtalk.robotCode).trim() : '';
  return Boolean(robotCode);
}

function joinLines(lines) {
  const arr = Array.isArray(lines) ? lines : [];
  return arr
    .map((x) => (x === null || x === undefined ? '' : String(x).trim()))
    .filter((x) => x)
    .join('\n');
}

export async function sendRobotPrivateText(cfg, { userid, content }) {
  const robotCode = cfg?.dingtalk?.robotCode ? String(cfg.dingtalk.robotCode).trim() : '';
  if (!robotCode) {
    throw new Error('DINGTALK_ROBOT_CODE missing');
  }
  const uid = userid ? String(userid).trim() : '';
  if (!uid) {
    throw new Error('missing userid');
  }

  const token = await getV1AccessToken(cfg);

  const msgKey = 'sampleText';
  const msgParam = JSON.stringify({ content: String(content || '') });

  const url = 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend';
  const body = {
    robotCode,
    userIds: [uid],
    msgKey,
    msgParam,
  };

  return httpJsonWithHeaders('POST', url, {
    headers: { 'x-acs-dingtalk-access-token': token },
    body,
  });
}

export function notifyUserPrivateText(cfg, { userid, title, lines }) {
  if (!isNotifyEnabled(cfg)) return;

  const content = joinLines([title, ...((Array.isArray(lines) ? lines : []))]);
  if (!content) return;

  enqueueNotify(async () => {
    await sendWithRetry(() => sendRobotPrivateText(cfg, { userid, content }));
    await sleep(200);
  });
}
