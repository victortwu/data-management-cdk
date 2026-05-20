import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { APIGatewayProxyHandlerV2WithJWTAuthorizer } from 'aws-lambda'
import { DOCUMENT_TABLE } from '../constants'
import { respond } from '../../shared/utils/respond'

export const patchDocument = async (
  tenantId: string,
  id: string,
  event: Parameters<APIGatewayProxyHandlerV2WithJWTAuthorizer>[0],
  ddb: DynamoDBDocumentClient,
) => {
  const body = JSON.parse(event.body ?? '{}')
  const { status, documentType, reviewNotes } = body

  if (!status && !documentType && reviewNotes === undefined) {
    return respond(400, {
      error: 'VALIDATION_ERROR',
      message: 'Provide at least one of: status, documentType, reviewNotes',
    })
  }

  const names: Record<string, string> = {}
  const values: Record<string, unknown> = {}
  const parts: string[] = []

  if (status) {
    names['#s'] = 'status'
    values[':s'] = status
    parts.push('#s = :s')
  }
  if (documentType) {
    names['#dt'] = 'documentType'
    values[':dt'] = documentType
    parts.push('#dt = :dt')
  }
  if (reviewNotes !== undefined) {
    names['#rn'] = 'reviewNotes'
    values[':rn'] = reviewNotes
    parts.push('#rn = :rn')
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
