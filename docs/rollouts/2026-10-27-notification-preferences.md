# Connector failure notification preferences — draft, release held

Task: [B635C261](https://tasks.forit.io/?task=B635C261-9125-469F-90AA-955F56BE84F4).
Common handoff `msg_fedbe504ee43` relays Ben's 2026-10-26 no-exemptions ruling on
card `3c160a7a`. The applicable standard/checker is Common merge
`987aaf3eeae7b032c02993d8c0d07eab56f0d755`. That policy ruling does not grant
permission to provision keys, change access, or deploy this stopped app.

This change belongs to for-Xero's connector-operation interface scope. It changes
the connector-token failure alert, not accrual calculations or Finance policy.
The deployment hold in `interest-ci.yml` remains in force. Merging `interest/**`
currently triggers `interest.yml`, which deploys the app. **Do not merge or deploy
this draft while that hold remains.**

## Source change

The one ACS send is a notification in category `connector-failures`, with purpose
`interest-notifications`. It uses published `@foritllc/mail` 0.6.0 and
`@foritllc/email` 0.14.0. Mail 0.6.0 already provides the required primitives;
0.8.0's optional table name is unnecessary for this fixed-schema integration.

- A signed URL supplies the HTML footer, plain text, and both RFC 8058 headers.
  A message has exactly one plain address, no Cc or Bcc.
- Configuration, signature, preference-store and transport failures prevent a
  send. An opted-out recipient is suppressed before the ACS client is acquired.
- The message uses the configured product's brand and a configured portal link.
  Raw exceptions and accounting context are excluded from both parts and logs.
  The old link to the disabled Interest OAuth endpoint is removed.
- `GET /api/notification-preferences?t=…` confirms without writing. The same
  route's cookie-free POST uses Common's handler and the same store as the send
  check. The Azure adapter bounds the request body to 8 KiB.
- Host/path and tenant/category scope apply to both methods. The store wrapper
  enforces tenant/category even when one-click bypasses the page resolver.
- The notification store uses a fresh system-managed-identity SQL token/pool per
  operation, with encrypted connections and bound parameters, then closes it.
  It never imports the existing Interest admin-password database pool.

## Configuration to approve before rollout

There are no production signing keys, address peppers, identity selections or
tenant-brand defaults in source. Unresolved or absent configuration fails closed.
Do not set these values or grant access merely to make this draft pass.

| Setting | Contract |
|---|---|
| `NOTIFICATION_TENANT_KEY` | Reviewed stable tenant key, at most 64 characters. |
| `NOTIFICATION_PRODUCT_NAME` | This tenant/product's approved display name. |
| `NOTIFICATION_PRIMARY_COLOR` | Approved `#RRGGBB`, used consistently in both renderers. |
| `NOTIFICATION_PREFERENCES_URL` | Own public HTTPS origin and exact `/api/notification-preferences` path; no query, fragment or credentials. |
| `NOTIFICATION_RECONNECT_URL` | Approved HTTPS portal connection-management URL. |
| `NOTIFICATION_UNSUBSCRIBE_KEYRING` | Product-owned Key Vault reference resolving to Common's `{current, keys}` JSON; no default key. Retain old verification keys until their links expire. |
| `NOTIFICATION_SUBJECT_KIND` | Explicit `user` or `address`; absence of local UI does not establish accountless status. |
| `NOTIFICATION_USER_ID` | For `user` mode, the verified canonical account ID mapped to the configured authorizer recipient; stable across sends and account preferences. |
| `NOTIFICATION_ADDRESS_PEPPER` | Only for confirmed accountless `address` mode: separate stable Key Vault reference, at least 32 UTF-8 bytes. Exact bytes are retained. Do not rotate with signing keys or change subject mode without reconciling existing opt-outs. |
| `NOTIFICATION_DB_SERVER`, `NOTIFICATION_DB_NAME` | Explicit notification database target; no legacy pool fallback. |

Existing `notification-email`, `NOTIFICATION_SENDER_EMAIL` and the ACS connection
remain the recipient, sender and transport sources. This draft neither reads
their live values nor provisions replacements.

`sql/002-email-opt-outs.sql` is the installed mail 0.6.0 canonical template with
`APP_SCHEMA=interest` and its source checksum. It requires that schema to exist.
Apply it only through this product's approved migration identity, with the runtime
identity admitted to the exact required table operations. Do not run it through
the existing admin-password migration workflow or an agent SQL login.

## Account page and external owner

The configured authorizer may have a shared portal account. Address-mode identity
and a token page cannot substitute for a required account switch without that
fact being verified. for-Website owns the current portal UI/API; its existing
email-preferences route writes CRM subscriptions and is not the Xero store.

Website contract request `msg_be5fe9ff25a0` asks for server-verified identity and
an authenticated product-owned integration writing the exact tenant, subject and
category used here. No body-supplied email or unauthenticated account-write API
is accepted by this change. Account switch integration remains outstanding.
No local contact/feedback/request-intake form was found; external portal behavior
is not certified by that inventory. There are no `raiseAlert` sends here to which
Common's temporary notifications-package hold could apply.

## Release gates and evidence still owed

1. Resolve Ben's stopped-app deployment hold and choose the approved own-domain
   route, recipient/account mapping and tenant presentation.
2. Obtain an applicable Ben-decided card before new security effects: signing
   material/pepper, Key Vault references or grants, SQL admission/table access,
   or GitHub token permission changes. The source policy card is not that scope.
3. The existing Interest CI supplies neither `NODE_AUTH_TOKEN` nor package-read
   permission. This draft adds only GitHub Packages registry configuration, with
   an environment placeholder and no token. Establish the approved package-read
   path before normal CI/release; no workflow permissions were changed here.
4. Complete the authenticated account switch with the Website owner, prove it
   and the link change the same row, and prove subsequent sends are suppressed.
5. After authorized migration/deployment, prove deployed GET has no write and a
   cookie-free one-click POST returns 200 and changes the intended durable row.
6. Record an actual received ACS message with both unsubscribe headers and DKIM
   pass covering `list-unsubscribe:list-unsubscribe-post`, on this task and the
   Common epic. Mocked ACS and source checks do not establish delivery or DKIM.
7. Verify sender/link/page branding for the actual approved tenant. Keep the
   child task open until the applicable Done-means evidence is recorded.

All current automated checks are offline. No test sends mail, connects to SQL,
reads a live secret, calls Xero, starts the app, or changes cloud configuration.
