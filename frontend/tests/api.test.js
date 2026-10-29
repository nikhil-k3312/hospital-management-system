/**
 * MediApi client: token handling, transparent refresh, real error states.
 * fetch is replaced with a jest mock that plays the server.
 */
const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
  json: async () => body,
});

let api;
beforeEach(() => {
  jest.resetModules();
  global.fetch = jest.fn();
  api = require('../js/api');
});

test('sends the in-memory access token as a Bearer header', async () => {
  api.setToken('abc');
  fetch.mockResolvedValueOnce(jsonResponse(200, { success: true, data: [] }));
  await api.get('/api/appointments', { status: 'pending', empty: '' });
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe('/api/appointments?status=pending');
  expect(init.headers.Authorization).toBe('Bearer abc');
  expect(init.credentials).toBe('same-origin');
});

test('on 401 it refreshes the session once, then retries the request', async () => {
  api.setToken('expired');
  fetch
    .mockResolvedValueOnce(jsonResponse(401, { success: false, code: 'TOKEN_EXPIRED' }))
    .mockResolvedValueOnce(jsonResponse(200, { success: true, data: { token: 'fresh', user: { role: 'patient' } } }))
    .mockResolvedValueOnce(jsonResponse(200, { success: true, data: ['ok'] }));

  const res = await api.get('/api/records');
  expect(res.data).toEqual(['ok']);
  expect(fetch.mock.calls[1][0]).toBe('/api/auth/refresh-token');
  expect(fetch.mock.calls[2][1].headers.Authorization).toBe('Bearer fresh');
});

test('concurrent 401s share a single refresh call', async () => {
  api.setToken('expired');
  fetch.mockImplementation(async (url, init) => {
    if (url === '/api/auth/refresh-token') return jsonResponse(200, { data: { token: 'fresh', user: {} } });
    return init.headers.Authorization === 'Bearer fresh' ? jsonResponse(200, { data: url }) : jsonResponse(401, {});
  });
  await Promise.all([api.get('/api/a'), api.get('/api/b'), api.get('/api/c')]);
  expect(fetch.mock.calls.filter(([url]) => url === '/api/auth/refresh-token')).toHaveLength(1);
});

test('when the refresh fails too, it reports SESSION_ENDED', async () => {
  fetch
    .mockResolvedValueOnce(jsonResponse(401, {}))
    .mockResolvedValueOnce(jsonResponse(401, { message: 'Session expired' }));
  await expect(api.get('/api/records')).rejects.toMatchObject({ status: 401, code: 'SESSION_ENDED' });
});

test('server errors become ApiError with status, code and validation details', async () => {
  fetch.mockResolvedValueOnce(jsonResponse(400, { success: false, message: 'Validation failed', errors: ['reason is required'] }));
  const error = await api.post('/api/appointments', {}).catch((e) => e);
  expect(error).toBeInstanceOf(api.ApiError);
  expect(error.status).toBe(400);
  expect(error.message).toBe('Validation failed: reason is required');
});

test('a network failure is reported as status 0 (server unreachable)', async () => {
  fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  await expect(api.get('/api/x')).rejects.toMatchObject({ status: 0 });
});

test('the break-glass reason is attached only while emergency access is on', async () => {
  fetch.mockResolvedValue(jsonResponse(200, { data: [] }));
  api.setBreakGlass('Unconscious patient in ER');
  await api.get('/api/records');
  expect(fetch.mock.calls[0][1].headers['x-break-glass-reason']).toBe('Unconscious patient in ER');
  api.setBreakGlass(null);
  await api.get('/api/records');
  expect(fetch.mock.calls[1][1].headers['x-break-glass-reason']).toBeUndefined();
});

test('logout clears the token even if the server call fails', async () => {
  api.setToken('t');
  fetch.mockRejectedValueOnce(new TypeError('offline'));
  await api.logout().catch(() => {});
  expect(api.hasToken()).toBe(false);
});
