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

export const patchDocument = async (
  tenantId: string,
  id: string,
  event: Parameters<APIGatewayProxyHandlerV2WithJWTAuthorizer>[0],
  ddb: DynamoDBDocumentClient,
) => {
  const body = JSON.parse(event.body ?? '{}')

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

  const result = await ddb
    .send(
      new UpdateCommand({
        TableName: DOCUMENT_TABLE,
        Key: { tenantId, documentId: id },
        UpdateExpression: `SET ${parts.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ConditionExpression: 'attribute_exists(documentId)',
        ReturnValues: 'ALL_NEW',
      }),
    )
    .catch((err) => {
      if (err.name === 'ConditionalCheckFailedException') return null
      throw err
    })

  if (!result) return respond(404, { error: 'NOT_FOUND', message: 'Document not found' })
  return respond(200, result.Attributes as Record<string, unknown>)
}
