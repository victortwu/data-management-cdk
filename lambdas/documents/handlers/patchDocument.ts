import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb'
import { APIGatewayProxyHandlerV2WithJWTAuthorizer } from 'aws-lambda'
import { DOCUMENT_TABLE } from '../constants'
import { respond } from '../../shared/utils/respond'

const EDITABLE_FIELDS = [
  'status',
  'documentType',
  'subType',
  'vendorName',
  'documentDate',
  'contactName',
  'amounts',
  'description',
  'reviewNotes',
] as const

// Body param carrying the client's expected current version for optimistic
// concurrency. It is NOT in EDITABLE_FIELDS — `version` is a managed attribute,
// never directly user-set. Clients read it from a prior GET/PATCH response and
// echo it back on the next PATCH as an If-Match-style guard.
const VERSION_FIELD = 'version'

export const patchDocument = async (
  tenantId: string,
  id: string,
  event: Parameters<APIGatewayProxyHandlerV2WithJWTAuthorizer>[0],
  ddb: DynamoDBDocumentClient,
) => {
  const body = JSON.parse(event.body ?? '{}')

  // Optimistic concurrency is OPT-IN and backwards-compatible:
  //   - If the body includes a numeric `version`, we guard the write so it only
  //     succeeds when the stored version equals the supplied one, and we bump
  //     the stored version by 1 (initializing to 1 when the attribute is absent
  //     on legacy docs — if_not_exists(version, :zero)).
  //   - If the body does NOT include `version`, behavior is UNCHANGED from
  //     before this feature: the only guard is attribute_exists(documentId).
  //     Existing clients that never send a version keep working exactly as-is.
  const rawVersion = body[VERSION_FIELD]
  const useOptimisticConcurrency = rawVersion !== undefined
  const expectedVersion = useOptimisticConcurrency ? Number(rawVersion) : undefined

  if (useOptimisticConcurrency && !Number.isInteger(expectedVersion)) {
    return respond(400, {
      error: 'VALIDATION_ERROR',
      message: '`version` must be an integer',
    })
  }

  const updates: Record<string, unknown> = {}
  for (const field of EDITABLE_FIELDS) {
    if (body[field] !== undefined) updates[field] = body[field]
  }

  if (Object.keys(updates).length === 0) {
    return respond(400, {
      error: 'VALIDATION_ERROR',
      message: `Provide at least one of: ${EDITABLE_FIELDS.join(', ')}`,
    })
  }

  // If GSI key components are changing, read current doc to merge
  const needsGsiUpdate =
    updates.documentType !== undefined ||
    updates.vendorName !== undefined ||
    updates.documentDate !== undefined ||
    updates.status !== undefined

  let current: Record<string, unknown> = {}
  if (needsGsiUpdate) {
    const existing = await ddb.send(
      new GetCommand({
        TableName: DOCUMENT_TABLE,
        Key: { tenantId, documentId: id },
        ProjectionExpression: 'documentType, vendorName, documentDate',
      }),
    )
    if (!existing.Item) return respond(404, { error: 'NOT_FOUND', message: 'Document not found' })
    current = existing.Item
  }

  // Merge current + updates for composite keys
  const docType = (updates.documentType ?? current.documentType) as string | undefined
  const docDate = (updates.documentDate ?? current.documentDate) as string | undefined
  const vendor = (updates.vendorName ?? current.vendorName) as string | undefined

  if (docType !== undefined || updates.documentType !== undefined || updates.documentDate !== undefined) {
    updates.typeDate = docType ? `${docType}#${docDate ?? ''}` : undefined
  }
  if (vendor !== undefined || updates.vendorName !== undefined || updates.documentDate !== undefined) {
    updates.vendorDate = vendor ? `${vendor}#${docDate ?? ''}` : undefined
  }
  if (updates.status !== undefined) {
    updates.statusDate = `${updates.status}#${new Date().toISOString()}`
  }

  const names: Record<string, string> = {}
  const values: Record<string, unknown> = {}
  const parts: string[] = []

  for (const [field, value] of Object.entries(updates)) {
    const alias = `#${field}`
    names[alias] = field
    values[`:${field}`] = value
    parts.push(`${alias} = :${field}`)
  }

  // Base condition (always): the item must exist.
  let conditionExpression = 'attribute_exists(documentId)'

  if (useOptimisticConcurrency) {
    // Guard on the stored version AND bump it. Legacy docs without a `version`
    // attribute are treated as version 0 via if_not_exists, so the first
    // versioned write must supply version 0 (and lands them at version 1).
    names['#version'] = 'version'
    values[':expectedVersion'] = expectedVersion
    values[':newVersion'] = (expectedVersion as number) + 1
    values[':zero'] = 0
    parts.push('#version = :newVersion')
    conditionExpression = `attribute_exists(documentId) AND if_not_exists(#version, :zero) = :expectedVersion`
  }

  const result = await ddb
    .send(
      new UpdateCommand({
        TableName: DOCUMENT_TABLE,
        Key: { tenantId, documentId: id },
        UpdateExpression: `SET ${parts.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ConditionExpression: conditionExpression,
        ReturnValues: 'ALL_NEW',
      }),
    )
    .catch((err) => {
      if (err.name === 'ConditionalCheckFailedException') return null
      throw err
    })

  if (!result) {
    // The combined condition (exists AND version match) collapses both a missing
    // doc and a version mismatch into one ConditionalCheckFailedException. When
    // concurrency is in play we re-read to disambiguate: absent → 404, present
    // but mismatched → 409 (with the real currentVersion so the client can
    // reload/retry). Without concurrency, the only possible cause is "missing".
    if (!useOptimisticConcurrency) {
      return respond(404, { error: 'NOT_FOUND', message: 'Document not found' })
    }

    const existing = await ddb.send(
      new GetCommand({
        TableName: DOCUMENT_TABLE,
        Key: { tenantId, documentId: id },
        ProjectionExpression: '#version',
        ExpressionAttributeNames: { '#version': 'version' },
      }),
    )

    if (!existing.Item) return respond(404, { error: 'NOT_FOUND', message: 'Document not found' })

    // Legacy docs with no stored version are treated as version 0.
    const currentVersion = (existing.Item.version ?? 0) as number
    return respond(409, {
      error: 'CONFLICT',
      message: 'Document changed; reload and retry',
      currentVersion,
    })
  }

  return respond(200, result.Attributes as Record<string, unknown>)
}
