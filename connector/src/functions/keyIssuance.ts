import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { issueForMcpReadKey } from '../services/keyIssuance';
import { errorResponse } from '../services/errors';

const APPROVED_DECISION_ID = '18b3e8e7-0812-4bea-9cad-8351c1d2277a';

/**
 * One approved administrative operation, authenticated by the Functions host
 * master key. Customer API keys and function-level keys cannot invoke it.
 * The service independently pins its customer, scope and vault destination.
 */
async function issueReadKey(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { status: 400, jsonBody: { error: 'Expected the approved decision_id only' } };
  }

  if (
    body === null || typeof body !== 'object' || Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(body, 'decision_id') ||
    (body as { decision_id?: unknown }).decision_id !== APPROVED_DECISION_ID
  ) {
    return { status: 400, jsonBody: { error: 'Expected the approved decision_id only' } };
  }

  try {
    const receipt = await issueForMcpReadKey(APPROVED_DECISION_ID);
    // Explicit projection keeps future service internals out of this response.
    return {
      status: 200,
      jsonBody: {
        decision_id: receipt.decision_id,
        key_id: receipt.key_id,
        customer_id: receipt.customer_id,
        scope: receipt.scope,
        secret_name: receipt.secret_name,
        secret_version: receipt.secret_version,
        reused: receipt.reused,
      },
    };
  } catch {
    // SDK/SQL exceptions can contain credentials. Neither the caller nor host
    // logs should receive an exception originating in this issuance operation.
    return errorResponse(context, 'Approved key issuance failed', new Error('Key issuance failed'));
  }
}

app.http('IssueForMcpReadKey', {
  methods: ['POST'],
  authLevel: 'admin',
  route: 'admin/keys/for-mcp',
  handler: issueReadKey,
});
