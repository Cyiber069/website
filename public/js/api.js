// Same origin API client. The session cookie rides along. A 401 from anywhere returns to sign in.

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code || 'request_failed');
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.userMessage = message || '';
    this.extra = extra;
    // The route itself does not exist yet on this server (other parts are still being built).
    this.unavailable = (status === 404 && (code === 'not_found' && /no such endpoint/i.test(message || ''))) || status === 405 || status === 501 || extra.notJson === true;
    this.offline = status === 0;
  }
}
export class AuthError extends Error { constructor() { super('signed_out'); this.name = 'AuthError'; } }

let onSignedOut = () => {};
export const setSignedOutHandler = (fn) => { onSignedOut = fn; };
// Settings locks (locks.js): owner answers carry what is locked (x-acx-locks), and a 423 says a box is locked.
let onLocks = () => {};
export const setLocksWatcher = (fn) => { onLocks = fn; };

export async function api(path, { method, body, form, quiet401 = false } = {}) {
  const init = { method: method || (body !== undefined || form ? 'POST' : 'GET'), credentials: 'same-origin', headers: { accept: 'application/json' } };
  if (form) init.body = form;
  else if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'offline', 'No connection. Check your internet and try again');
  }
  const text = await res.text();
  let data = null;
  let notJson = false;
  if (text) { try { data = JSON.parse(text); } catch { notJson = true; } }
  const locks = res.headers.get('x-acx-locks');
  if (locks || res.status === 423) { try { onLocks(locks, res.status === 423 ? data : null); } catch (e) { console.error(e); } }
  if (res.status === 401 && !quiet401) { onSignedOut(); throw new AuthError(); }
  if (!res.ok || notJson) {
    const d = data && typeof data === 'object' ? data : {};
    throw new ApiError(res.status, d.error || 'request_failed', typeof d.message === 'string' && d.message !== d.error ? d.message : '', { ...d, notJson });
  }
  return data ?? {};
}

export const get = (path) => api(path);
export const post = (path, body = {}) => api(path, { method: 'POST', body });
export const put = (path, body = {}) => api(path, { method: 'PUT', body });
export const patch = (path, body = {}) => api(path, { method: 'PATCH', body });
export const del = (path) => api(path, { method: 'DELETE' });
