# Connector failure notification preferences — draft, release held

Task: [B635C261](https://tasks.forit.io/?task=B635C261-9125-469F-90AA-955F56BE84F4).
Common handoff `msg_fedbe504ee43` relays Ben's 2026-10-26 no-exemptions ruling on
card `3c160a7a`. The applicable standard/checker is Common merge
`987aaf3eeae7b032c02993d8c0d07eab56f0d755`, clarified by design merge
`fd90981` and handoffs `msg_b58e74c104dc` / `msg_13da95ba15ef`. That policy ruling does not grant
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

There are no production signing keys, address peppers or tenant-brand defaults
in source. The configured recipient is known to this sender by email, so its
subject is always Common's `subjectForAddress(TenantKey, address, pepper)` (`e:`).
The TenantKey is validated at function registration, so a missing or invalid key
stops startup before the preference route is registered; other configuration
remains lazy and fails closed before use.
This does not assert whether the person has an account elsewhere. Unresolved or absent configuration fails closed.
Do not set these values or grant access merely to make this draft pass.

| Setting | Contract |
|---|---|
| `NOTIFICATION_TENANT_KEY` | Own stable server-configured key, at most 64 characters. Never an Entra/Graph tenant ID, domain, host or brand. |
| `NOTIFICATION_PRODUCT_NAME` | This tenant/product's approved display name. |
| `NOTIFICATION_PRIMARY_COLOR` | Approved `#RRGGBB`, used consistently in both renderers. |
| `NOTIFICATION_PREFERENCES_URL` | Own public HTTPS origin and exact `/api/notification-preferences` path; no query, fragment or credentials. |
| `NOTIFICATION_RECONNECT_URL` | Approved HTTPS portal connection-management URL. |
| `NOTIFICATION_UNSUBSCRIBE_KEYRING` | Product-owned Key Vault reference resolving to Common's `{current, keys}` JSON; no default key. Retain old verification keys until their links expire. |
| `NOTIFICATION_ADDRESS_PEPPER` | Required separate stable Key Vault reference, at least 32 UTF-8 bytes. Exact bytes are retained. The pepper never rotates. |
| `NOTIFICATION_DB_SERVER`, `NOTIFICATION_DB_NAME` | Explicit notification database target; no legacy pool fallback. |

Existing `notification-email`, `NOTIFICATION_SENDER_EMAIL` and the ACS connection
remain the recipient, sender and transport sources. This draft neither reads
their live values nor provisions replacements.

`sql/002-email-opt-outs.sql` is the installed mail 0.6.0 canonical template with
`APP_SCHEMA=interest` and its source checksum. It requires that schema to exist.
Apply it only through this product's approved migration identity, with the runtime
identity admitted to the exact required table operations. Do not run it through
the existing admin-password migration workflow or an agent SQL login.

## Manage page and later Website integration

Common confirms the signed route page is the manage page for this category.
There is no canonical-account resolver dependency or Website account-switch
release gate. The previous mapping question is resolved by the address subject.

Website may later add an account switch: its server derives verified email from
its own session, authenticates with its own scoped service key, and accepts only
`on:boolean` from the browser. Xero derives TenantKey and address subject with its
own pepper. That integration is a later item under Website task AB931EB5, not
implemented or provisioned by this draft.

No local contact/feedback/request-intake form was found; external portal behavior
is not certified by that inventory. There are no `raiseAlert` sends here to which
Common's temporary notifications-package hold could apply.

## Proposed set for Common's single provisioning wave

Register on child B635C261 and wave
[319BC7CE-CDB3-45C2-8D22-D07CA07E8989](https://tasks.forit.io/?task=319BC7CE-CDB3-45C2-8D22-D07CA07E8989).
These are requested names, not provisioned resources or verified assignments.
Common owns the ONE wave card; this lane does not file a second card.

| Item | Requested binding / qualification |
|---|---|
| App / pod | `forit-interest-accrual`, `rg-forit-xero`, Central US; source and Oct 25 inventory only, no current state verification. Internal ForIT tool, US L1. |
| Store | `forit-saas-sql.database.windows.net:forit`, `interest.EmailOptOuts`; schema/table existence unverified. |
| Runtime | App system-assigned MI; object ID not retained. Proposed group `forit-interest-email-optouts-runtime`, SQL TYPE=X, exactly SELECT/INSERT/UPDATE on `interest.EmailOptOuts`. No DELETE/EXECUTE or schema-wide DML requested. |
| Migration | Proposed OIDC identity `forit-interest-email-optouts-deploy`, separate group of the same name; object/client/group IDs unprovisioned/unverified. Proposed issuer `https://token.actions.githubusercontent.com`, audience `api://AzureADTokenExchange`, subject `repo:ForITLLC/for-Xero:environment:interest-email-optouts`. Environment and federation are proposals, not existing configuration. |
| Vault | Proposed own vault `forit-interest-kv`; availability, existence and app ownership unverified. Existing `KEY_VAULT_URL` value was not read. Shared legacy `forit-saas-kv` literals do not prove an own-vault binding. |
| Secret pair | `interest-notifications-unsubscribe-keyring` -> `NOTIFICATION_UNSUBSCRIBE_KEYRING`; `interest-notifications-address-pepper` -> `NOTIFICATION_ADDRESS_PEPPER`. One independent pair for this deployment; pepper immutable. Values not generated/read. |
| Secret access | Runtime Key Vault reference access restricted to those two secrets via Key Vault Secrets User; no vault-wide or other-secret access requested. |
| Server settings | `NOTIFICATION_DB_SERVER=forit-saas-sql.database.windows.net`, `NOTIFICATION_DB_NAME=forit`; proposed immutable `NOTIFICATION_TENANT_KEY=d-b4647691-bfa9-431f-9271-d77cf51298e3` (fresh local opaque deployment UUID, not an Entra ID). Approved branding/HTTPS URLs remain unpinned; never infer any key from Graph/domain/brand. |

The manifest is **not executable yet**: fresh app MI object ID, exact deploy
identity/group IDs, vault ownership/availability, OIDC binding and approved
non-secret setting values are missing. Security/database seats must qualify and
pin these in the wave manifest before Ben decides its exact writes; mismatch or
missing evidence stops provisioning. The existing workflow uses a credentials
secret, not proven OIDC; no secret value was read and no deployment identity is
silently reused.

Use the passwordless `provision-db-principal.yml` / `common_provisioning` module
route with a newly reviewed card-bound operation. The retiring never-run
`xero-runtime-admission` pair and decision 18b3e8e7 are not reused or requested.
The broad `grant_schema_dml` flag includes DELETE/EXECUTE and does not represent
this exact table-level triple. The database seat must encode the exact grant.
A separate OIDC deploy group runs the canonical DDL. Existing legacy SQL-password
migration is not an authorized path.

CI is a separate held permission gap: its exact proposed fix is job
`permissions: {contents: read, packages: read}` and `NODE_AUTH_TOKEN` from
`${{ secrets.GITHUB_TOKEN }}` on `npm ci`, plus repository read access to the
required org packages. The active workflow remains unchanged. This permission
change needs explicit decided coverage; the wave is not assumed to include it.

## Release gates and evidence still owed

1. Resolve Ben's stopped-app deployment hold and choose the approved own-domain
   route, stable TenantKey and tenant presentation.
2. Have Common qualify the requested set and obtain Ben's decision on its ONE
   wave card before signing material/pepper, Key Vault references/grants, SQL
   admission/table access, OIDC identity or permission changes. CI permissions
   and public route activation require explicit decided coverage too; do not
   assume the policy ruling or the old connector card covers these effects.
3. The existing Interest CI supplies neither `NODE_AUTH_TOKEN` nor package-read
   permission. This draft adds only GitHub Packages registry configuration, with
   an environment placeholder and no token. Establish the approved package-read
   path before normal CI/release; no workflow permissions were changed here.
4. Prove the signed manage page and send check use the same durable row and
   subsequent sends are suppressed; no Website switch is required here.
5. After authorized migration/deployment, prove deployed GET has no write and a
   cookie-free one-click POST returns 200 and changes the intended durable row.
6. Record an actual received ACS message with both unsubscribe headers and DKIM
   pass covering `list-unsubscribe:list-unsubscribe-post`, on this task and the
   Common epic. Mocked ACS and source checks do not establish delivery or DKIM.
7. Verify sender/link/page branding for the actual approved tenant. Keep the
   child task open until the applicable Done-means evidence is recorded.

All current automated checks are offline. No test sends mail, connects to SQL,
reads a live secret, calls Xero, starts the app, or changes cloud configuration.
