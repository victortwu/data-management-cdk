import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { DOCUMENT_TABLE } from '../constants'
import type { DocumentRecord } from '../types'

export interface PreClassifiedUris {
  originalUri: string
  convertedPdfUri: string
  extractedTextUri: string
}

/**
 * Merge-updates ONLY the three URI attributes onto an existing pre-classified record,
 * so user-supplied metadata is never overwritten. Returns the merged record.
 */
export const persistPreClassifiedUris = async (
  tenantId: string,
  documentId: string,
  uris: PreClassifiedUris,
  ddb: DynamoDBDocumentClient,
): Promise<DocumentRecord> => {
  const result = await ddb.send(
    new UpdateCommand({
      TableName: DOCUMENT_TABLE,
      Key: { tenantId, documentId },
      UpdateExpression:
        'SET originalUri = :originalUri, convertedPdfUri = :convertedPdfUri, extractedTextUri = :extractedTextUri',
      ConditionExpression: 'attribute_exists(documentId)',
      ExpressionAttributeValues: {
        ':originalUri': uris.originalUri,
        ':convertedPdfUri': uris.convertedPdfUri,
        ':extractedTextUri': uris.extractedTextUri,
      },
      ReturnValues: 'ALL_NEW',
    }),
  )
  return result.Attributes as DocumentRecord
}
