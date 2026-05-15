import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb'
import { DOCUMENT_TABLE } from '../constants'
import type { DocumentRecord } from '../types'

export const saveMetadata = async (
  record: DocumentRecord,
  ddb: DynamoDBDocumentClient,
): Promise<void> => {
  const clean = Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined))
  await ddb.send(new PutCommand({ TableName: DOCUMENT_TABLE, Item: clean }))
}
