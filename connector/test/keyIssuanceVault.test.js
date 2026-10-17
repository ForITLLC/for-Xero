'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadFunctions, DIST } = require('./helpers/harness');

function loadVault() {
  const state = { identities: [], clients: [] };
  class ManagedIdentityCredential {
    constructor(clientId) { this.clientId = clientId; state.identities.push(this); }
  }
  class SecretClient {
    constructor(url, credential, options) {
      this.url = url;
      this.credential = credential;
      this.options = options;
      state.clients.push(this);
    }
  }
  loadFunctions('services/keyIssuance.js', {
    'services/issuanceDatabase.js': { getIssuancePool: async () => { throw new Error('SQL forbidden'); } },
  }, {
    mssql: {},
    '@azure/identity': {
      ManagedIdentityCredential,
      DefaultAzureCredential: class {
        constructor() { throw new Error('Credential fallback forbidden'); }
      },
    },
    '@azure/keyvault-secrets': { SecretClient },
  });
  return {
    ...require(path.join(DIST, 'services/keyIssuance.js')),
    state,
    ManagedIdentityCredential,
  };
}

test('issuance vault pins ForIT, uses managed identity, and disables automatic version-creating retries', () => {
  const previous = process.env.ISSUANCE_MANAGED_IDENTITY_CLIENT_ID;
  delete process.env.ISSUANCE_MANAGED_IDENTITY_CLIENT_ID;
  try {
    const { getIssuanceVault, state, ManagedIdentityCredential } = loadVault();
    const vault = getIssuanceVault();
    assert.equal(vault.url, 'https://forit-saas-kv.vault.azure.net');
    assert.ok(vault.credential instanceof ManagedIdentityCredential);
    assert.equal(vault.credential.clientId, undefined);
    assert.deepEqual(vault.options, { retryOptions: { maxRetries: 0 } });
    assert.equal(state.identities.length, 1);
    assert.equal(state.clients.length, 1);
  } finally {
    if (previous === undefined) delete process.env.ISSUANCE_MANAGED_IDENTITY_CLIENT_ID;
    else process.env.ISSUANCE_MANAGED_IDENTITY_CLIENT_ID = previous;
  }
});

test('issuance vault accepts only an explicit managed identity selection, with retries still disabled', () => {
  const previous = process.env.ISSUANCE_MANAGED_IDENTITY_CLIENT_ID;
  process.env.ISSUANCE_MANAGED_IDENTITY_CLIENT_ID = 'issuance-managed-identity-client-id';
  try {
    const { getIssuanceVault, ManagedIdentityCredential } = loadVault();
    const vault = getIssuanceVault();
    assert.ok(vault.credential instanceof ManagedIdentityCredential);
    assert.equal(vault.credential.clientId, 'issuance-managed-identity-client-id');
    assert.equal(vault.options.retryOptions.maxRetries, 0);
  } finally {
    if (previous === undefined) delete process.env.ISSUANCE_MANAGED_IDENTITY_CLIENT_ID;
    else process.env.ISSUANCE_MANAGED_IDENTITY_CLIENT_ID = previous;
  }
});
