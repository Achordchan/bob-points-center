export async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  let body = options.body;
  if (body && typeof body === 'object' && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const res = await fetch(path, { ...options, headers, body, credentials: 'same-origin' });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok || data?.ok === false || data?.error) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return data;
}

export function qs(params = {}) {
  const sp = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') sp.set(key, String(value));
  });
  return sp.toString();
}
