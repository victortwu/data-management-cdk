import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb'
import { DOCUMENT_TABLE } from '../constants'
import { respond } from '../../shared/utils/respond'
import { presignInline } from '../utils/presignInline'
import { presignDownload } from '../utils/presignDownload'

export const getDocument = async (tenantId: string, id: string, ddb: DynamoDBDocumentClient) => {
  const result = await ddb.send(
    new GetCommand({ TableName: DOCUMENT_TABLE, Key: { tenantId, documentId: id } }),
  )
  if (!result.Item) return respond(404, { error: 'NOT_FOUND', message: 'Document not found' })

  const doc = result.Item
  const previewUrls = {
    original: doc.originalUri ? await presignInline(doc.originalUri) : null,
    convertedPdf: doc.convertedPdfUri ? await presignInline(doc.convertedPdfUri) : null,
  }
  const downloadUrls = {
    original: doc.originalUri ? await presignDownload(doc.originalUri) : null,
    convertedPdf: doc.convertedPdfUri ? await presignDownload(doc.convertedPdfUri) : null,
    extractedText: doc.extractedTextUri ? await presignDownload(doc.extractedTextUri) : null,
  }

  return respond(200, { ...doc, previewUrls, downloadUrls })
}
