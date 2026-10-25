# Retired accounting adapter connector key

Security checklist CE4BEA05-F622-4208-AE39-9CB20B3894C2 asks for revocation of
the key actually configured in `forit-accounting` as `XERO_CONNECTOR_API_KEY`.
The adapter has no function bindings; this procedure does not start it.

Use the manual **Inspect or revoke retired accounting connector key** workflow
on `main`. It runs under the existing `github-actions-forit-xero` migration
identity, obtains an Entra SQL token inside the runner, and refuses a different
tenant, subscription, application or database principal. It introduces no new
database password, cloud grant, agent SQL login, or runtime deployment. This
existing deployment identity remains a transition workload; this procedure does
not claim managed-identity/group compliance for it.

Before any revoke, Finance/Security must establish a sealed SHA-256 match from
the actual accounting setting. A name, shared outbound address, last-used time,
or hash from the database alone is insufficient. Never print, persist or pass the
key value to a workflow input, artifact or agent. Keep the fingerprint out of
human reports; report the row ID or a short fingerprint only.

Inputs are the full checklist ID, exact key ID, SHA-256 expected hash and mode
`inspect` or `revoke`. The operation pins row
`b3c32598-6e6a-4e8f-be6d-7c914ffd59c7`, customer
`70fbb207-4249-4385-a2c6-4f1767f5c3e9`, key name
`finance-portal-recurring-engine` and scope `full`. Any mismatch refuses the
operation. `inspect` reads and reports the column-update permission without
writing. `revoke` takes a transaction lock, conditionally changes only
`is_active` to false, checks exactly one affected row, rereads it inactive and
commits. An already inactive matching row returns an idempotent readback.
No gateway read key, other key, customer, subscription, OAuth credential or
setting changes. The receipt contains metadata, never the value or hash.

A lost result is unknown: read the exact row before considering a retry.
After the inactive-row receipt, a reviewed sealed Finance-side job must present
the same actual configured credential to `GET /api/connector/Organisation`
and report HTTP 401 with error `Invalid API key`, without logging the key,
headers or raw body. A hash-only validator test cannot replace that HTTP proof.
If no safe caller exists, report the 401 proof as blocked rather than revive
the retired integration. Keep the checklist open until both proofs exist.
