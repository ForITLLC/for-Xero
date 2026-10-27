import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { createNotificationStore } from '../services/notificationStore';
import { createNotificationPreferencesHandlers, loadNotificationSettings, loadNotificationTenantKey,
  preferenceFailure } from '../services/notificationPreferences';

const MAX_BODY_BYTES = 8 * 1024;

// Only the non-secret tenant key is checked at startup. No SQL, signing key or pepper is read here.
loadNotificationTenantKey();

/** Bound the Azure stream before adapting it to Common's Web Request handler. */
async function readBody(request: HttpRequest): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new RangeError('Notification preference body too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

async function toAzure(response: Response): Promise<HttpResponseInit> {
  return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
}

export async function notificationPreferences(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  if (request.method !== 'GET' && request.method !== 'POST') return toAzure(preferenceFailure(405));
  try {
    const settings = loadNotificationSettings();
    const handlers = createNotificationPreferencesHandlers(settings, createNotificationStore());
    const headers = new Headers();
    // Cookies/Authorization never enter the unsubscribe adapter.
    for (const name of ['Content-Type', 'Content-Length']) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    const body = request.method === 'POST' ? await readBody(request) : undefined;
    const webRequest = new Request(request.url, { method: request.method, headers, body });
    return toAzure(await handlers[request.method](webRequest));
  } catch (error) {
    context.warn('Notification preferences unavailable');
    return toAzure(preferenceFailure(error instanceof RangeError ? 413 : 503));
  }
}

app.http('NotificationPreferences', {
  methods: ['GET', 'POST'], authLevel: 'anonymous', route: 'notification-preferences',
  handler: notificationPreferences,
});
