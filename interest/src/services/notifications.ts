import { EmailClient } from '@azure/communication-email';
import { renderBranded, renderBrandedText, type BrandIdentity, type BrandedDocument } from '@foritllc/email';
import { unsubscribeHeaders, unsubscribeLink, type OptOutStore } from '@foritllc/mail';
import { getSecret, SECRETS } from './keyvault';
import { createNotificationStore } from './notificationStore';
import { loadNotificationSettings, notificationSubject, scopeNotificationStore,
  NOTIFICATION_CATEGORY, NOTIFICATION_PURPOSE, type NotificationSettings } from './notificationPreferences';

let emailClient: EmailClient | null = null;
function getEmailClient(): EmailClient {
  if (!emailClient) {
    const connection = process.env.AZURE_COMMUNICATION_CONNECTION_STRING;
    if (!connection) throw new Error('Notification transport unavailable');
    emailClient = new EmailClient(connection);
  }
  return emailClient;
}

export interface FailureNotifierOptions {
  getSettings?: () => NotificationSettings;
  getStore?: () => OptOutStore;
  getRecipient?: () => Promise<string>;
  getSender?: () => string | undefined;
  getClient?: () => Pick<EmailClient, 'beginSend'>;
}

/** Production dependencies stay lazy so missing configuration/preferences prevent any send. */
export function createFailureNotifier(options: FailureNotifierOptions = {}) {
  const getSettings = options.getSettings ?? loadNotificationSettings;
  const getStore = options.getStore ?? createNotificationStore;
  const getRecipient = options.getRecipient ?? (() => getSecret(SECRETS.NOTIFICATION_EMAIL));
  const getSender = options.getSender ?? (() => process.env.NOTIFICATION_SENDER_EMAIL);
  const getClient = options.getClient ?? getEmailClient;
  return async (_functionName: string, _error: Error, _context?: Record<string, unknown>): Promise<boolean> => {
    try {
      const settings = getSettings();
      const recipient = (await getRecipient()).trim();
      // ACS takes an address, not a display-name/list. One signed subject must reach one person.
      if (!/^[^\s,;<>@]+@[^\s,;<>@]+$/.test(recipient)) throw new Error('Notification recipient unavailable');
      const who = notificationSubject(settings, recipient);
      const target = unsubscribeLink({ baseUrl: settings.preferencesUrl, keyring: settings.keyring,
        purpose: NOTIFICATION_PURPOSE, who, category: NOTIFICATION_CATEGORY });
      if (!target) throw new Error('Signed notification preferences unavailable');
      const store = scopeNotificationStore(getStore(), settings.tenant);
      const off = await store.isOff(who, NOTIFICATION_CATEGORY);
      if (typeof off !== 'boolean') throw new Error('Notification preference result unavailable');
      if (off) return false;
      const sender = getSender()?.trim();
      if (!sender) throw new Error('Notification sender unavailable');
      const brand: BrandIdentity = { tenant_id: settings.tenant, company_name: settings.productName,
        primary_color: settings.primaryColor, secondary_color: settings.primaryColor,
        accent_color: settings.primaryColor, operator_credit: 'none' };
      const document: BrandedDocument = {
        title: 'Your Xero connection needs attention',
        // Upstream errors/context can contain accounting data or credentials; keep them out of mail.
        blocks: [
          { kind: 'paragraph', html: 'A connector operation could not complete. Review your connection in the portal and reconnect if needed.' },
          { kind: 'action', label: 'Review connection', href: settings.reconnectUrl },
        ],
        footerNote: 'You receive this because you are the configured connection contact.',
        footer: { unsubscribe: { url: target.url, label: 'Stop connector failure alerts' },
          managePreferences: { url: target.url, label: 'Manage connector failure alerts' } },
      };
      const rendered = renderBranded(brand, document);
      const plain = renderBrandedText(brand, document);
      if (!plain.unsubscribe || plain.unsubscribe.url !== target.url || !plain.text.includes(target.url)) {
        throw new Error('Notification preference footer unavailable');
      }
      const message = {
        senderAddress: sender, recipients: { to: [{ address: recipient }] },
        headers: unsubscribeHeaders(plain.unsubscribe),
        content: { subject: `${settings.productName}: Xero connection needs attention`,
          html: rendered.html, plainText: plain.text },
      };
      // mail-kind: notification
      const poller = await getClient().beginSend(message);
      if ((await poller.pollUntilDone()).status !== 'Succeeded') throw new Error('Notification delivery unavailable');
      return true;
    } catch {
      // No raw driver errors, recipient, signed link or exception/context in logs.
      console.warn('Connector failure notification unavailable or suppressed');
      return false;
    }
  };
}

export const sendFailureNotification = createFailureNotifier();

export async function withFailureNotification<T>(
  functionName: string,
  fn: () => Promise<T>,
  context?: Record<string, unknown>
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));

    // Send notification (don't await - fire and forget to not delay response)
    sendFailureNotification(functionName, err, context).catch(() => {});

    throw error;
  }
}
