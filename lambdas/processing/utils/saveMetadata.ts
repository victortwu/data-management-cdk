import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb'
import { DOCUMENT_TABLE } from '../constants'
import type { DocumentRecord } from '../types'

export const saveMetadata = async (
  tenantId: string,
  record: DocumentRecord,
  ddb: DynamoDBDocumentClient,
): Promise<void> => {
  const item = {
    tenantId,
    ...record,
    // Composite sort keys for GSIs
    typeDate: record.documentType ? `${record.documentType}#${record.documentDate ?? ''}` : undefined,
    vendorDate: record.vendorName ? `${record.vendorName}#${record.documentDate ?? ''}` : undefined,
    statusDate: `${record.status}#${record.uploadedAt}`,
  }
  const clean = Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined))
  await ddb.send(new PutCommand({ TableName: DOCUMENT_TABLE, Item: clean }))
}
