'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const common = require('@foritllc/mail');
const { loadFunctions, DIST } = require('./helpers/harness');

const RECIPIENT = 'reader@example.test';
const SETTINGS_ENV = {
  NOTIFICATION_TENANT_KEY: 'example-air',
  NOTIFICATION_PRODUCT_NAME: 'Example Air',
  NOTIFICATION_PRIMARY_COLOR: '#245678',
  NOTIFICATION_PREFERENCES_URL: 'https://alerts.example.test/api/notification-preferences',
  NOTIFICATION_RECONNECT_URL: 'https://portal.example.test/connections',
  NOTIFICATION_UNSUBSCRIBE_KEYRING: JSON.stringify({ current: 'k1', keys: { k1: 'a'.repeat(40) } }),
  NOTIFICATION_SUBJECT_KIND: 'address',
  NOTIFICATION_ADDRESS_PEPPER: 'p'.repeat(40),
};

function fixture(overrides = {}) {
  loadFunctions('services/notifications.js', {
    'services/keyvault.js': { getSecret: async () => { throw new Error('Network forbidden'); }, SECRETS: {} },
    'services/notificationStore.js': { createNotificationStore: () => { throw new Error('SQL forbidden'); } },
  });
  const policy = require(path.join(DIST, 'services/notificationPreferences.js'));
  const { createFailureNotifier } = require(path.join(DIST, 'services/notifications.js'));
  const settings = policy.loadNotificationSettings(SETTINGS_ENV);
  const store = common.createMemoryOptOutStore();
  const state = { messages: [], clientCalls: 0, recipientCalls: 0, storeCalls: 0, polls: 0 };
  const send = createFailureNotifier({
    getSettings: () => settings,
    getStore: () => { state.storeCalls++; return store; },
    getRecipient: async () => { state.recipientCalls++; return RECIPIENT; },
    getSender: () => 'alerts@example.test',
    getClient: () => {
      state.clientCalls++;
      return {
        beginSend: async (message) => {
          state.messages.push(message);
          return { pollUntilDone: async () => { state.polls++; return { status: 'Succeeded' }; } };
        },
      };
    },
    ...overrides,
  });
  return { send, state, settings, store, policy };
}

async function captureWarnings(fn) {
  const original = console.warn;
  const logs = [];
  console.warn = (...args) => logs.push(args.join(' '));
  try { return { result: await fn(), logs }; } finally { console.warn = original; }
}

function signedTarget(message) {
  const header = message.headers['List-Unsubscribe'];
  assert.match(header, /^<https:\/\/alerts\.example\.test\/api\/notification-preferences\?t=[^>]+>$/);
  return header.slice(1, -1);
}

test('real Common rendering puts the same signed URL in HTML, text and both ACS headers for one person', async () => {
  const { send, state, settings, policy } = fixture();
  const sensitive = '<script>raw-error-and-accounting-context</script>';
  const { result, logs } = await captureWarnings(() => send(sensitive, new Error(sensitive), { account: sensitive }));
  assert.equal(result, true);
  assert.equal(state.messages.length, 1);
  assert.equal(state.polls, 1);
  const message = state.messages[0];
  assert.deepEqual(message.recipients, { to: [{ address: RECIPIENT }] });
  assert.equal(message.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  const url = signedTarget(message);
  assert.ok(message.content.html.includes(url));
  assert.ok(message.content.plainText.includes(url));
  const verified = common.verifyUnsubscribeToken(new URL(url).searchParams.get('t'), {
    keyring: settings.keyring, purpose: policy.NOTIFICATION_PURPOSE,
  });
  assert.equal(verified.ok, true);
  assert.deepEqual(verified.who, policy.notificationSubject(settings, RECIPIENT));
  assert.equal(verified.category, policy.NOTIFICATION_CATEGORY);
  const visible = JSON.stringify({ message, logs });
  assert.ok(!visible.includes(sensitive));
  assert.ok(!visible.includes('raw-error-and-accounting-context'));
  assert.doesNotMatch(visible, /forit\.io|ForIT|your-function-app|\/api\/auth\/start/);
  assert.ok(message.content.html.includes(settings.reconnectUrl));
  assert.ok(message.content.plainText.includes(settings.reconnectUrl));
});

test('a saved address opt-out stops the sender before constructing the ACS client', async () => {
  const { send, state, store, settings, policy } = fixture();
  await store.setOff(policy.notificationSubject(settings, RECIPIENT), policy.NOTIFICATION_CATEGORY, 'one-click');
  assert.equal(await send('ignored', new Error('ignored')), false);
  assert.equal(state.clientCalls, 0);
  assert.equal(state.messages.length, 0);
});

test('a malformed opt-out result is unavailable, never permission to send', async () => {
  for (const resultFromStore of [undefined, null, 0, '', 'false', {}]) {
    let preferenceReads = 0;
    const { send, state } = fixture({
      getStore: () => ({ isOff: async () => { preferenceReads++; return resultFromStore; } }),
    });
    const { result } = await captureWarnings(() => send('ignored', new Error('ignored')));
    assert.equal(preferenceReads, 1);
    assert.equal(result, false);
    assert.equal(state.clientCalls, 0);
    assert.equal(state.messages.length, 0);
  }
});

test('missing configuration, recipient, keyring, store or sender fails closed before ACS client creation', async () => {
  const missingKeySettings = { ...fixture().settings, keyring: undefined };
  for (const override of [
    { getSettings: () => { throw new Error('configuration-sensitive-detail'); } },
    { getSettings: () => missingKeySettings },
    { getRecipient: async () => { throw new Error('recipient-sensitive-detail'); } },
    { getRecipient: async () => 'not-an-email' },
    { getStore: () => { throw new Error('SQL-sensitive-detail'); } },
    { getStore: () => ({ isOff: async () => { throw new Error('store-sensitive-detail'); } }) },
    { getSender: () => undefined },
  ]) {
    const { send, state } = fixture(override);
    const { result, logs } = await captureWarnings(() => send('function-sensitive-detail', new Error('error-sensitive-detail')));
    assert.equal(result, false);
    assert.equal(state.clientCalls, 0);
    assert.equal(state.messages.length, 0);
    assert.doesNotMatch(logs.join('\n'), /sensitive-detail/);
  }
});

test('a recipient list or header-like recipient never reaches the preference store or ACS client', async () => {
  for (const recipient of [
    'one@example.test,two@example.test', 'one@example.test;two@example.test',
    'one@example.test two@example.test', 'Reader <one@example.test>',
    'one@@example.test', 'one@example.test\r\nBcc: other@example.test',
  ]) {
    const { send, state } = fixture({ getRecipient: async () => recipient });
    const { result } = await captureWarnings(() => send('ignored', new Error('ignored')));
    assert.equal(result, false);
    assert.equal(state.storeCalls, 0);
    assert.equal(state.clientCalls, 0);
    assert.equal(state.messages.length, 0);
  }
});

test('user identity is explicit and uses the stable account subject rather than an address subject', async () => {
  const initial = fixture();
  const settings = initial.policy.loadNotificationSettings({
    ...SETTINGS_ENV, NOTIFICATION_SUBJECT_KIND: 'user', NOTIFICATION_USER_ID: 'person-42',
  });
  const { send, state } = fixture({ getSettings: () => settings });
  assert.equal(await send('ignored', new Error('ignored')), true);
  const url = signedTarget(state.messages[0]);
  const verified = common.verifyUnsubscribeToken(new URL(url).searchParams.get('t'), {
    keyring: settings.keyring, purpose: initial.policy.NOTIFICATION_PURPOSE,
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.who.subject, 'u:person-42');
  assert.ok(!JSON.stringify(verified).includes(RECIPIENT));
});

test('GET confirmation writes nothing; cookie-free one-click POST changes the same row and suppresses the next send', async () => {
  const { send, state, store, settings, policy } = fixture();
  assert.equal(await send('ignored', new Error('ignored')), true);
  const url = signedTarget(state.messages[0]);
  const who = policy.notificationSubject(settings, RECIPIENT);
  const handlers = policy.createNotificationPreferencesHandlers(settings, store);
  const get = await handlers.GET(new Request(url));
  assert.equal(get.status, 200);
  assert.equal(await store.isOff(who, policy.NOTIFICATION_CATEGORY), false);
  const post = await handlers.POST(new Request(url, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click',
  }));
  assert.equal(post.status, 200);
  assert.match(post.headers.get('Content-Type'), /text\/plain/);
  assert.equal(await store.isOff(who, policy.NOTIFICATION_CATEGORY), true);
  assert.equal((await store.list(who))[0].source, 'one-click');
  assert.equal(await send('ignored', new Error('ignored')), false);
  assert.equal(state.clientCalls, 1);
  assert.equal(state.messages.length, 1);
});

test('ACS rejection and unsuccessful terminal delivery are not reported as a successful send', async () => {
  for (const beginSend of [
    async () => { throw new Error('ACS-secret-diagnostic'); },
    async () => ({ pollUntilDone: async () => ({ status: 'Failed' }) }),
    async () => ({ pollUntilDone: async () => { throw new Error('ACS-secret-diagnostic'); } }),
  ]) {
    const { send } = fixture({ getClient: () => ({ beginSend }) });
    const { result, logs } = await captureWarnings(() => send('ignored', new Error('ignored')));
    assert.equal(result, false);
    assert.doesNotMatch(logs.join('\n'), /ACS-secret-diagnostic/);
  }
});
