/**
 * MediChain API client, used by every page.
 *
 * Security model:
 *  - The short-lived access token lives ONLY in memory (this closure). It is
 *    never written to localStorage, so a script injected into the page cannot
 *    read a stored copy, and it disappears when the tab closes.
 *  - The refresh token is an HttpOnly cookie the browser sends automatically to
 *    /api/auth/*. Page JavaScript can neither read nor steal it.
 *  - On page load, or when the access token expires (401), the client calls
 *    /api/auth/refresh-token once to get a new access token, then retries.
 */
(function initApi(global) {
  let accessToken = null;
  let refreshing = null; // one shared in-flight refresh, however many calls hit 401 at once
  let breakGlassReason = null; // set only while the user has emergency access switched on

  class ApiError extends Error {
    constructor(status, message, body) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = body && body.code;
      this.errors = (body && body.errors) || [];
      this.body = body;
    }
  }

  async function parse(response) {
    const type = response.headers.get('content-type') || '';
    const body = type.includes('application/json') ? await response.json() : null;
    if (!response.ok) {
      const detail = body && body.errors && body.errors.length ? `: ${body.errors.join('; ')}` : '';
      throw new ApiError(response.status, ((body && body.message) || `Request failed (${response.status})`) + detail, body);
    }
    return body;
  }

  /** Exchanges the HttpOnly refresh cookie for a new access token (rotating the cookie). */
  function refreshSession() {
    if (!refreshing) {
      refreshing = fetch('/api/auth/refresh-token', { method: 'POST', credentials: 'same-origin' })
        .then(parse)
        .then((body) => {
          accessToken = body.data.token;
          return body.data.user;
        })
        .finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  /**
   * request('GET', '/api/appointments') -> parsed JSON body
   * Throws ApiError with .status and .code on failure, so screens can show a
   * real error state.
   */
  async function request(method, path, { body, query, form, retry = true } = {}) {
    let url = path;
    if (query) {
      const params = new URLSearchParams();
      Object.entries(query).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') params.append(k, v); });
      if ([...params].length) url += `?${params}`;
    }

    const headers = {};
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    if (breakGlassReason) headers['x-break-glass-reason'] = breakGlassReason;
    let payload;
    if (form) {
      payload = form; // FormData: the browser sets the multipart boundary
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
    } catch (networkError) {
      throw new ApiError(0, 'Cannot reach the MediChain server. Check that it is running.', null);
    }

    const expired = response.status === 401 && retry && !path.startsWith('/api/auth/');
    if (expired) {
      try {
        await refreshSession();
      } catch (refreshError) {
        accessToken = null;
        throw new ApiError(401, 'Your session has ended. Please log in again.', { code: 'SESSION_ENDED' });
      }
      return request(method, path, { body, query, form, retry: false });
    }
    return parse(response);
  }

  /** Downloads a protected file with the token and returns { blob, sha256 }. */
  async function download(path) {
    const headers = { Authorization: `Bearer ${accessToken}` };
    if (breakGlassReason) headers['x-break-glass-reason'] = breakGlassReason;
    const response = await fetch(path, { headers, credentials: 'same-origin' });
    if (!response.ok) await parse(response);
    return { blob: await response.blob(), sha256: response.headers.get('X-Content-SHA256') };
  }

  const api = {
    ApiError,
    request,
    download,
    refreshSession,
    get: (path, query) => request('GET', path, { query }),
    post: (path, body) => request('POST', path, { body }),
    patch: (path, body) => request('PATCH', path, { body }),
    del: (path, body) => request('DELETE', path, { body }),
    upload: (path, formData) => request('POST', path, { form: formData }),
    setToken: (token) => { accessToken = token; },
    hasToken: () => Boolean(accessToken),
    setBreakGlass: (reason) => { breakGlassReason = reason || null; },
    getBreakGlass: () => breakGlassReason,
    async logout() {
      try {
        await request('POST', '/api/auth/logout');
      } finally {
        accessToken = null;
        breakGlassReason = null;
      }
    },
  };

  global.MediApi = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof window !== 'undefined' ? window : globalThis));
