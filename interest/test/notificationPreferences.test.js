'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const common = require('@foritllc/mail');
const { loadFunctions, DIST, makeContext } = require('./helpers/harness');

const ENV = {
  NOTIFICATION_TENANT_KEY: 'example-air', NOTIFICATION_PRODUCT_NAME: 'Example Air',
  NOTIFICATION_PRIMARY_COLOR: '#245678',
  NOTIFICATION_PREFERENCES_URL: 'https://alerts.example.test/api/notification-preferences',
  NOTIFICATION_RECONNECT_URL: 'https://portal.example.test/connections',
  NOTIFICATION_UNSUBSCRIBE_KEYRING: JSON.stringify({ current: 'k1', keys: { k1: 'a'.repeat(40) } }),
  NOTIFICATION_SUBJECT_KIND: 'address', NOTIFICATION_ADDRESS_PEPPER: 'p'.repeat(40),
};
const policy = require(path.join(DIST, 'services/notificationPreferences.js'));

function setup(settings = policy.loadNotificationSettings(ENV)) {
  const store = common.createMemoryOptOutStore();
  const who = policy.notificationSubject(settings, 'reader@example.test');
  const handlers = policy.createNotificationPreferencesHandlers(settings, store);
  const token = (changes = {}) => common.mintUnsubscribeToken({
    keyring: settings.keyring, purpose: policy.NOTIFICATION_PURPOSE,
    who, category: policy.NOTIFICATION_CATEGORY, ...changes,
  });
  return { settings, store, who, handlers, token, url: (value = token()) => `${settings.preferencesUrl}?t=${value}` };
}

function oneClick(url) {
  return new Request(url, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click',
  });
}

test('configuration requires explicit user/address identity, valid product URLs and a real keyring with no fallback', () => {
  for (const patch of [
    { NOTIFICATION_SUBJECT_KIND: undefined }, { NOTIFICATION_SUBJECT_KIND: 'automatic' },
    { NOTIFICATION_SUBJECT_KIND: 'user', NOTIFICATION_USER_ID: undefined },
    { NOTIFICATION_ADDRESS_PEPPER: 'short' }, { NOTIFICATION_UNSUBSCRIBE_KEYRING: undefined },
    { NOTIFICATION_UNSUBSCRIBE_KEYRING: JSON.stringify({ current: 'k1', keys: { k1: 'short' } }) },
    { NOTIFICATION_PREFERENCES_URL: 'http://alerts.example.test/api/notification-preferences' },
    { NOTIFICATION_PREFERENCES_URL: 'https://user:password@alerts.example.test/api/notification-preferences' },
    { NOTIFICATION_PREFERENCES_URL: `${ENV.NOTIFICATION_PREFERENCES_URL}?email=bare@example.test` },
    { NOTIFICATION_PREFERENCES_URL: `${ENV.NOTIFICATION_PREFERENCES_URL}#fragment` },
    { NOTIFICATION_PREFERENCES_URL: 'https://alerts.example.test/wrong-path' },
    { NOTIFICATION_RECONNECT_URL: 'javascript:alert(1)' },
  ]) {
    assert.throws(() => policy.loadNotificationSettings({ ...ENV, ...patch }), {
      message: 'Notification configuration unavailable',
    });
  }
  const address = policy.loadNotificationSettings(ENV);
  const first = policy.notificationSubject(address, 'Reader@Example.Test');
  assert.deepEqual(first, policy.notificationSubject(address, ' reader@example.test '));
  assert.match(first.subject, /^e:[a-f0-9]{32}$/);
  const user = policy.loadNotificationSettings({ ...ENV, NOTIFICATION_SUBJECT_KIND: 'user', NOTIFICATION_USER_ID: 'person-42' });
  assert.equal(policy.notificationSubject(user, 'reader@example.test').subject, 'u:person-42');
});

test('address pepper bytes survive configuration loading without silently changing existing HMAC identities', () => {
  const pepper = `  ${'p'.repeat(40)}  `;
  const settings = policy.loadNotificationSettings({ ...ENV, NOTIFICATION_ADDRESS_PEPPER: pepper });
  const who = policy.notificationSubject(settings, 'reader@example.test');
  assert.equal(settings.addressPepper, pepper);
  assert.equal(who.subject, common.subjectForAddress(settings.tenant, 'reader@example.test', pepper));
  assert.notEqual(who.subject, common.subjectForAddress(settings.tenant, 'reader@example.test', pepper.trim()));
});

test('real Common confirmation is branded only for a verified tenant and sends security headers without writing', async () => {
  const f = setup();
  const get = await f.handlers.GET(new Request(f.url()));
  assert.equal(get.status, 200);
  assert.match(await get.text(), /Example Air/);
  assert.equal(await f.store.isOff(f.who, policy.NOTIFICATION_CATEGORY), false);
  assert.equal(get.headers.get('Cache-Control'), 'no-store');
  assert.match(get.headers.get('X-Robots-Tag'), /noindex/);
  const invalid = await f.handlers.GET(new Request(f.url('not-a-valid-token')));
  assert.equal(invalid.status, 400);
  assert.doesNotMatch(await invalid.text(), /Example Air|ForIT|forit\.io/);
});

test('validly signed foreign-category or foreign-tenant GET tokens return neutral 400 without a preference write', async () => {
  const f = setup();
  const foreignWho = { ...f.who, tenant: 'other-air' };
  for (const token of [
    f.token({ category: 'another-category' }),
    f.token({ who: foreignWho }),
  ]) {
    const response = await f.handlers.GET(new Request(f.url(token)));
    assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), /Example Air|other-air|ForIT|forit\.io/);
    assert.deepEqual(await f.store.list(f.who), []);
    assert.deepEqual(await f.store.list(foreignWho), []);
  }
});

test('forged, wrong-purpose, cross-tenant, cross-category and wrong-host one-click requests never change any row', async () => {
  const f = setup();
  const valid = f.token();
  const parts = valid.split('.');
  parts[parts.length - 1] = (parts.at(-1)[0] === 'a' ? 'b' : 'a') + parts.at(-1).slice(1);
  const otherWho = { ...f.who, tenant: 'other-air' };
  const cases = [
    f.url(parts.join('.')),
    f.url(f.token({ purpose: 'another-purpose' })),
    f.url(f.token({ who: otherWho })),
    f.url(f.token({ category: 'another-category' })),
    f.url().replace('alerts.example.test', 'attacker.example.test'),
  ];
  for (const url of cases) {
    const response = await f.handlers.POST(oneClick(url));
    assert.notEqual(response.status, 200);
    assert.equal(await f.store.isOff(f.who, policy.NOTIFICATION_CATEGORY), false);
    assert.equal(await f.store.isOff(otherWho, policy.NOTIFICATION_CATEGORY), false);
    assert.equal(await f.store.isOff(f.who, 'another-category'), false);
  }
});

test('expired signed links are rejected and signing-key rotation keeps old valid links while the old key remains', async () => {
  const original = setup();
  const expired = original.token({ now: Date.now() - 181 * 24 * 60 * 60 * 1000 });
  assert.equal((await original.handlers.POST(oneClick(original.url(expired)))).status, 400);
  assert.equal(await original.store.isOff(original.who, policy.NOTIFICATION_CATEGORY), false);
  const oldToken = original.token();
  const rotated = setup({ ...original.settings, keyring: common.createUnsubscribeKeyring({
    current: 'k2', keys: { k1: 'a'.repeat(40), k2: 'b'.repeat(40) },
  }) });
  assert.equal(rotated.token().split('.')[1], 'k2');
  assert.equal((await rotated.handlers.GET(new Request(rotated.url(oldToken)))).status, 200);
  assert.equal((await rotated.handlers.POST(oneClick(rotated.url(oldToken)))).status, 200);
  assert.equal(await rotated.store.isOff(rotated.who, policy.NOTIFICATION_CATEGORY), true);
  const removed = setup({ ...original.settings, keyring: common.createUnsubscribeKeyring({ current: 'k2', keys: { k2: 'b'.repeat(40) } }) });
  assert.equal((await removed.handlers.POST(oneClick(removed.url(oldToken)))).status, 400);
  assert.equal(await removed.store.isOff(removed.who, policy.NOTIFICATION_CATEGORY), false);
});

async function withEnvironment(fn) {
  const previous = Object.fromEntries(Object.keys(ENV).map((name) => [name, process.env[name]]));
  Object.assign(process.env, ENV);
  try { return await fn(); } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

function loadAzure(store) {
  return loadFunctions('functions/notificationPreferences.js', {
    'services/notificationStore.js': { createNotificationStore: () => store },
  });
}

function azureRequest(url, { method = 'GET', chunks, headers = {}, onCancel } = {}) {
  return {
    method, url,
    headers: new Headers(headers),
    body: chunks ? new ReadableStream({
      start(controller) { for (const chunk of chunks) controller.enqueue(chunk); },
      cancel() { onCancel?.(); },
    }) : null,
  };
}

test('actual Azure adapter exposes only anonymous GET/POST, confirms without writes, and supports cookie-free one-click', async () => withEnvironment(async () => {
  const f = setup();
  const { handlers, registrations } = loadAzure(f.store);
  assert.equal(registrations.length, 1);
  assert.deepEqual(registrations[0].options.methods, ['GET', 'POST']);
  assert.equal(registrations[0].options.authLevel, 'anonymous');
  const invoke = handlers.NotificationPreferences;
  const context = makeContext();
  const get = await invoke(azureRequest(f.url()), context);
  assert.equal(get.status, 200);
  assert.equal(await f.store.isOff(f.who, policy.NOTIFICATION_CATEGORY), false);
  const payload = new TextEncoder().encode('List-Unsubscribe=One-Click');
  // A finite stream for this complete normal request.
  const request = azureRequest(f.url(), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  request.body = new ReadableStream({ start(controller) { controller.enqueue(payload); controller.close(); } });
  const post = await invoke(request, context);
  assert.equal(post.status, 200);
  assert.equal(post.headers['cache-control'], 'no-store');
  assert.match(post.headers['x-robots-tag'], /noindex/);
  assert.match(post.headers['content-type'], /text\/plain/);
  assert.equal(await f.store.isOff(f.who, policy.NOTIFICATION_CATEGORY), true);
  assert.equal((await f.store.list(f.who))[0].source, 'one-click');
}));

test('Azure adapter cancels an over-8192-byte stream despite a false Content-Length and refuses other methods', async () => withEnvironment(async () => {
  const f = setup();
  const { handlers } = loadAzure(f.store);
  let cancelled = false;
  const request = azureRequest(f.url(), {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': '1' },
    chunks: [new Uint8Array(4096), new Uint8Array(4097)], onCancel: () => { cancelled = true; },
  });
  const response = await handlers.NotificationPreferences(request, makeContext());
  assert.equal(response.status, 413);
  assert.equal(cancelled, true);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(await f.store.isOff(f.who, policy.NOTIFICATION_CATEGORY), false);
  const other = await handlers.NotificationPreferences(azureRequest(f.url(), { method: 'PUT' }), makeContext());
  assert.equal(other.status, 405);
  assert.equal(await f.store.isOff(f.who, policy.NOTIFICATION_CATEGORY), false);
}));
