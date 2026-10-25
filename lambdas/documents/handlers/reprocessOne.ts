import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb'
import { APIGatewayProxyHandlerV2WithJWTAuthorizer } from 'aws-lambda'

import { DOCUMENT_TABLE } from '../constants'
import { respond } from '../../shared/utils/respond'
import { fetchExtractedText } from '../utils/fetchExtractedText'
import { emitDocumentProcessedEvent } from '../../processing/utils/emitDocumentProcessedEvent'
import { buildBedrockPrompt } from '../../processing/utils/buildBedrockPrompt'
import { saveMetadata } from '../../processing/utils/saveMetadata'
import { createBedrockAdapter } from '../../processing/adapters/bedrock'
import type { DocumentRecord, DocumentStatus } from '../../processing/types'

type ReprocessMode = 'emit-only' | 'reclassify'

// Module-scoped (container-cached) classifier. The Documents Lambda only ever
// reclassifies via Bedrock (LLM_PROVIDER is fixed to 'bedrock' in CDK), so we import
// the processing Lambda's Bedrock adapter DIRECTLY rather than the adapter factory —
// this reuses the exact same classification code without dragging the ollama/openai
// adapters into the Documents Lambda's bundle/import graph.
const llm = createBedrockAdapter(process.env.LLM_MODEL_ID ?? 'us.amazon.nova-lite-v1:0')

/**
 * Single-document reprocess (Parsely #2/#3).
 *
 * Loads ONE document tenant-scoped, then either re-emits the stored metadata or
 * re-runs classification, depending on the body `mode` param.
 *
 * Modes (body param `mode`):
 *
 *   - `emit-only` (DEFAULT): re-emit the stored metadata via the EXISTING
 *     `emitDocumentProcessedEvent` util (verbatim — the event schema is therefore
 *     guaranteed byte-compatible with the happy-path emitter, satisfying the
 *     backwards-compatibility gate). No metadata is changed.
 *
 *   - `reclassify` (OPT-IN, Parsely #3): re-run the SAME Bedrock classification the
 *     processing Lambda uses — over the already-stored `extractedTextUri` — then
 *     patch the document metadata and emit the fresh `DocumentProcessed`. This reuses
 *     the processing Lambda's classification modules directly (shared-module approach,
 *     NOT invoking the processing Lambda) so there is no cross-Lambda coupling,
 *     cold-start, or extra IAM beyond `bedrock:InvokeModel`. The event schema is
 *     unchanged (same emitter), so `reclassify` is strictly additive for existing
 *     consumers.
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

  const doc = result.Item as DocumentRecord

  if (mode === 'reclassify') {
    if (!doc.extractedTextUri)
      return respond(409, {
        error: 'NO_EXTRACTED_TEXT',
        message: 'Document has no stored extracted text to reclassify',
      })

    // 1. Fetch the already-extracted text (no re-OCR) from the processed bucket.
    const extractedText = await fetchExtractedText(doc.extractedTextUri)

    // 2. Re-run the SAME classification the processing Lambda uses (shared modules):
    //    tenant-scoped system prompt + the Bedrock adapter (Nova Lite).
    const systemPrompt = await buildBedrockPrompt(tenantId, ddb)
    const analysis = await llm.analyze(extractedText, systemPrompt)

    // 3. Mirror the processing Lambda's status derivation.
    let status: DocumentStatus = 'processed'
    let reviewReason: string | undefined
    if (analysis.confidence === 'low' || analysis.documentType === 'unknown') {
      status = 'needs_review'
      reviewReason = analysis.flagReason ?? 'low_confidence'
    }

    // 4. Patch metadata: refresh the classification fields, preserve storage/identity
    //    fields (documentId/source/fileType/uploadedAt/*Uri). `saveMetadata` re-derives
    //    the GSI composite keys (typeDate/vendorDate/statusDate) exactly as processing does.
    const updated: DocumentRecord = {
      ...doc,
      status,
      reviewReason,
      documentDate: analysis.documentDate,
      documentType: analysis.documentType,
      subType: analysis.subType,
      vendorName: analysis.vendorName,
      contactName: analysis.contactName,
      amounts: analysis.amounts,
      description: analysis.description,
      confidence: analysis.confidence,
      tags: [analysis.documentType, analysis.subType, analysis.vendorName].filter(
        Boolean,
      ) as string[],
    }
    await saveMetadata(tenantId, updated, ddb)

    // 5. Emit via the EXISTING emitter — unchanged schema.
    await emitDocumentProcessedEvent(tenantId, updated)

    return respond(200, {
      documentId: id,
      mode,
      reclassified: true,
      documentType: updated.documentType,
      subType: updated.subType,
      vendorName: updated.vendorName,
      confidence: updated.confidence,
      status: updated.status,
    })
  }

  await emitDocumentProcessedEvent(tenantId, doc)

  return respond(200, { documentId: id, mode, emitted: true })
}
