'use strict';
const test = require('node:test');
const assert = require('node:assert');

// Simulated api function with timeout (extracted from mobile-web/app.js)
async function api(url, options, fetchFn) {
  if (options?.method === 'POST') options = { ...options, headers: { ...options.headers, 'X-CSRF-Token': 'token' } };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetchFn(url, { credentials: 'same-origin', ...options, signal: controller.signal });
    if (response.status === 401) throw new Error('登录已过期。');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '请求失败，请稍后刷新。');
    return result;
  } finally { clearTimeout(timeout); }
}

test('mobile-web: api receives AbortSignal for timeout', async () => {
  let receivedSignal = null;
  const trackingFetch = async (url, options) => {
    receivedSignal = options.signal;
    assert.ok(receivedSignal, 'fetch should receive AbortSignal');
    assert.ok(typeof receivedSignal.addEventListener === 'function', 'signal should be an AbortSignal');
    return { status: 200, ok: true, json: async () => ({ queued: true }) };
  };

  const result = await api('/api/captain', { method: 'POST', body: '{}' }, trackingFetch);
  assert.ok(receivedSignal, 'signal should have been passed to fetch');
  assert.deepEqual(result, { queued: true });
});

test('mobile-web: api request succeeds before timeout', async () => {
  const response = { status: 200, ok: true, json: async () => ({ queued: true }) };
  let fetchCalled = false;
  const quickFetch = async (url, options) => {
    fetchCalled = true;
    assert.ok(options.signal, 'fetch should receive AbortSignal');
    return response;
  };

  const result = await api('/api/captain', { method: 'POST', body: '{}' }, quickFetch);
  assert.ok(fetchCalled, 'fetch should have been called');
  assert.deepEqual(result, { queued: true });
});

test('mobile-web: api handles network errors', async () => {
  const failingFetch = async () => {
    throw new TypeError('Failed to fetch');
  };

  try {
    await api('/api/captain', { method: 'POST', body: '{}' }, failingFetch);
    assert.fail('Should have thrown TypeError');
  } catch (err) {
    assert.equal(err.message, 'Failed to fetch');
    assert.ok(err instanceof TypeError);
  }
});

test('mobile-web: api handles HTTP errors', async () => {
  const response = { status: 500, ok: false, json: async () => ({ error: '服务器错误' }) };
  const failingFetch = async () => response;

  try {
    await api('/api/captain', { method: 'POST', body: '{}' }, failingFetch);
    assert.fail('Should have thrown error');
  } catch (err) {
    assert.equal(err.message, '服务器错误');
  }
});
