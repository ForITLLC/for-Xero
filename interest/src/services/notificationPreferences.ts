import {
  createUnsubscribeKeyring, createUnsubscribeRouteHandler, subjectForAddress, verifyUnsubscribeToken,
  type OptOutStore, type OptOutSubject, type UnsubscribeKeyring,
} from '@foritllc/mail';

export const NOTIFICATION_CATEGORY = 'connector-failures';
export const NOTIFICATION_PURPOSE = 'interest-notifications';
export const PREFERENCES_PATH = '/api/notification-preferences';

export interface NotificationSettings {
  tenant: string;
  productName: string;
  primaryColor: string;
  preferencesUrl: string;
  reconnectUrl: string;
  keyring: UnsubscribeKeyring;
  addressPepper: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error('Notification configuration unavailable');
  return value;
}

/** Stable product identity is explicit and must never be normalized or inferred. */
export function loadNotificationTenantKey(env: NodeJS.ProcessEnv = process.env): string {
  const tenant = env.NOTIFICATION_TENANT_KEY;
  if (typeof tenant !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(tenant)) {
    throw new Error('Notification tenant key unavailable');
  }
  return tenant;
}

function httpsUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || /[\s<>"'\\]/.test(value)) {
    throw new Error('Notification URL unavailable');
  }
  return url;
}

/** Values come from this product's approved settings/KV references, never a request. */
export function loadNotificationSettings(env: NodeJS.ProcessEnv = process.env): NotificationSettings {
  try {
    const tenant = loadNotificationTenantKey(env);
    const productName = required(env, 'NOTIFICATION_PRODUCT_NAME');
    const primaryColor = required(env, 'NOTIFICATION_PRIMARY_COLOR');
    const preferencesUrl = required(env, 'NOTIFICATION_PREFERENCES_URL');
    const preferences = httpsUrl(preferencesUrl);
    const reconnectUrl = required(env, 'NOTIFICATION_RECONNECT_URL');
    httpsUrl(reconnectUrl);
    if (productName.length > 100 || /[\x00-\x1f\x7f]/.test(productName) ||
        !/^#[0-9a-fA-F]{6}$/.test(primaryColor) || preferences.search ||
        preferences.pathname !== PREFERENCES_PATH) {
      throw new Error('Invalid notification configuration');
    }
    const keyring = createUnsubscribeKeyring(JSON.parse(required(env, 'NOTIFICATION_UNSUBSCRIBE_KEYRING')));
    // The sender knows its recipient by email. Preserve the pepper's exact bytes:
    // trimming or replacing it changes the subject of existing opt-out rows.
    const addressPepper = env.NOTIFICATION_ADDRESS_PEPPER;
    if (!addressPepper || Buffer.byteLength(addressPepper, 'utf8') < 32) throw new Error('Address pepper unavailable');
    return { tenant, productName, primaryColor, preferencesUrl, reconnectUrl, keyring,
      addressPepper };
  } catch {
    // Never echo a malformed keyring, secret reference or configuration value.
    throw new Error('Notification configuration unavailable');
  }
}

/** Email-only sender identity; this makes no claim about whether the person has an account. */
export function notificationSubject(settings: NotificationSettings, address: string): OptOutSubject {
  return {
    tenant: settings.tenant,
    subject: subjectForAddress(settings.tenant, address, settings.addressPepper),
  };
}

/** One-click skips Common's page callback, so the actual store enforces our scope too. */
export function scopeNotificationStore(store: OptOutStore, tenant: string): OptOutStore {
  const check = (who: OptOutSubject, category?: string): void => {
    if (who.tenant !== tenant || (category !== undefined && category !== NOTIFICATION_CATEGORY)) {
      throw new Error('Notification preference scope unavailable');
    }
  };
  return {
    isOff: (who, category) => { check(who, category); return store.isOff(who, category); },
    setOff: (who, category, source) => { check(who, category); return store.setOff(who, category, source); },
    setOn: (who, category, source) => { check(who, category); return store.setOn(who, category, source); },
    list: (who) => { check(who); return store.list(who); },
  };
}

export function preferenceFailure(status = 503): Response {
  return new Response('Notification preferences are unavailable.', {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' },
  });
}

/** This signed route's page manages this email category without an account resolver. */
export function createNotificationPreferencesHandlers(settings: NotificationSettings, store: OptOutStore) {
  const handlers = createUnsubscribeRouteHandler({
    keyring: settings.keyring,
    purpose: NOTIFICATION_PURPOSE,
    store: scopeNotificationStore(store, settings.tenant),
    page: (tenant) => {
      if (tenant !== settings.tenant) throw new Error('Notification tenant unavailable');
      return { productName: settings.productName, primaryColor: settings.primaryColor,
        categoryLabels: { [NOTIFICATION_CATEGORY]: 'connector failure alerts' } };
    },
    onError: () => { console.warn('Notification preference operation unavailable'); },
  });
  const guard = (method: 'GET' | 'POST') => async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const expected = new URL(settings.preferencesUrl);
      if (url.origin !== expected.origin || url.pathname !== expected.pathname) return preferenceFailure(400);
      const verified = verifyUnsubscribeToken(url.searchParams.get('t'), {
        keyring: settings.keyring, purpose: NOTIFICATION_PURPOSE,
      });
      if (verified.ok && (verified.who.tenant !== settings.tenant || verified.category !== NOTIFICATION_CATEGORY)) {
        return preferenceFailure(400);
      }
      return await handlers[method](request);
    } catch {
      return preferenceFailure();
    }
  };
  return { GET: guard('GET'), POST: guard('POST') };
}
