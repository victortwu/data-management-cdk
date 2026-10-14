import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb'
import { APIGatewayProxyHandlerV2WithJWTAuthorizer } from 'aws-lambda'

import { DOCUMENT_TABLE } from '../constants'
import { respond } from '../../shared/utils/respond'
import { emitDocumentProcessedEvent } from '../../processing/utils/emitDocumentProcessedEvent'
import type { DocumentRecord } from '../../processing/types'

type ReprocessMode = 'emit-only' | 'reclassify'

/**
 * Single-document reprocess (Parsely #2).
 *
 * Loads ONE document tenant-scoped and re-emits the canonical `DocumentProcessed`
 * EventBridge event via the EXISTING `emitDocumentProcessedEvent` util (verbatim —
 * the event schema is therefore guaranteed byte-compatible with the happy-path
 * emitter, satisfying the backwards-compatibility gate).
 *
 * Modes (body param `mode`):
 *   - `emit-only` (default): re-emit the stored metadata.
 *   - `reclassify`: reserved/opt-in; returns 501 until Parsely #3 decides the
 *     contract + shared-classification approach.
 *
 * Tenant isolation: the DynamoDB key is `{ tenantId, documentId }`, so a document
 * belonging to another tenant simply is not found → 404. No cross-tenant reprocess
 * is possible.
 */
export const reprocessOne = async (
  tenantId: string,
  id: string,
  event: Parameters<APIGatewayProxyHandlerV2WithJWTAuthorizer>[0],
  ddb: DynamoDBDocumentClient,
) => {
  const mode = (JSON.parse(event.body ?? '{}').mode ?? 'emit-only') as ReprocessMode

  const result = await ddb.send(
    new GetCommand({ TableName: DOCUMENT_TABLE, Key: { tenantId, documentId: id } }),
  )
  if (!result.Item) return respond(404, { error: 'NOT_FOUND', message: 'Document not found' })

  if (mode === 'reclassify') {
    return respond(501, {
      error: 'NOT_IMPLEMENTED',
      message: 'reclassify mode is not yet implemented (gated by Parsely #3)',
    })
  }

  await emitDocumentProcessedEvent(tenantId, result.Item as DocumentRecord)

  return respond(200, { documentId: id, mode, emitted: true })
}
