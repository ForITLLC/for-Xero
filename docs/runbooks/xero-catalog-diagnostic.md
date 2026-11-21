# Xero catalog collector preparation

Task: https://tasks.forit.io/?task=14CD1E29-C154-45CC-97D5-3F509A6A1799

`scripts/xero-catalog-diagnostic.cjs` prepares the fixed owner-side reader for
`xero.customers`, `customer_products`, `achaccounts`, `xero_connections` and
the recorded Website principal `website_app`. It has no runnable CLI, workflow,
HTTP registration, sign-in or secret lookup. Importing it does not connect to SQL.

An allowed owner-controlled operation must supply an existing `mssql` pool and
driver. The collector verifies the existing product migration principal,
database and server; rejects database-control/owner/security-admin observers;
then executes fixed catalog SELECTs in one transaction that is rolled back.
It neither creates a connection nor closes or mutates the caller's pool. It
requires the supplied pool's effective driver-supported timeout
(`config.options.requestTimeout ?? config.requestTimeout`) to be 1–15000 ms;
missing, unlimited or longer timeouts refuse before any transaction.
Queries have a 500-row bound; the receipt is capped at 512 KiB. This is the SQL
request timeout, not an overall deadline for pool acquisition or transaction cleanup.
Output includes actual observer, original login, SQL timestamp and source digest.
The future adapter must establish the actual authorized product identity outside
this module; the SQL principal-name guard alone is not OIDC identity proof.
It must supply its dedicated owner pool with this timeout configured before its
connections open, using the pinned mssql/Tedious driver, and prevent concurrent
configuration changes. Reading a shared pool's current config alone cannot attest
how an already-open connection was originally configured.

OAuth columns, row values, default/computed definitions and predicate bodies
are excluded. Returned catalog permissions are visible evidence, not effective
Website rights. Hidden objects/principals remain UNKNOWN. Even a full database
definition view does not establish Website identity, server-level permissions,
fixed-role rights, impersonation or ownership chains. No grant is qualified by
this collector alone. A depth/size/error bound yields a fixed failure with no
partial receipt or raw driver message.

Current execution adapter: **not admitted or implemented**. Do not turn this
module into a standalone GitHub Actions diagnostic/ops runner, call a GA/admin
SQL session, widen the Support reader, or perform a dummy deployment to obtain
admission. A genuine admitted owner operation may use its bounded pre/postflight,
or the product may implement an authorized runtime adapter separately.

Policy checked at Common main `429851eb4f099015457f50c04acf8da90972726c`:
`docs/reference/binding-rules.md:80` assigns own-product statements to the product;
`docs/patterns/platform-standards.md:49` excludes Actions diagnostic/ops runners;
`sql/admin/README.md:146` allows bounded read-only checks only inside a genuine
admitted provisioning/deploy operation. No reviewer seat or new access follows.
GitHub/SQL execution fallback remains unqualified; there is no runtime state to
lose here and the source stays under Xero custody. The module is preparation,
not a callable route or live catalog result.

Offline verification, with no token or SQL connection:

```sh
node --check scripts/xero-catalog-diagnostic.cjs
node --test scripts/test/xero-catalog-diagnostic.test.cjs
```

Attach the Xero Agile software record when its service binding is admitted.
