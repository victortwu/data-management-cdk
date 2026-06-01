import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { APIGatewayProxyHandlerV2WithJWTAuthorizer } from 'aws-lambda'
import { randomUUID } from 'crypto'
import { respond } from '../shared/utils/respond'
import { extractTenantContext } from '../shared/utils/tenantContext'

const s3 = new S3Client({})
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const LANDING_BUCKET = process.env.LANDING_BUCKET!
const DOCUMENT_TABLE = process.env.DOCUMENT_TABLE!
const URL_EXPIRY_SECONDS = 900
const MAX_FILES = 50

interface FileRequest {
  filename: string
  contentType: string
  metadata?: {
    documentType?: string
    subType?: string
    vendorName?: string
    documentDate?: string
    description?: string
  }
}

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  const { tenantId } = extractTenantContext(event)
  const body = JSON.parse(event.body ?? '{}')
  const files: FileRequest[] = body.files

  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) {
    return respond(400, {
      error: 'VALIDATION_ERROR',
      message: `files must be an array of 1–${MAX_FILES} items`,
    })
  }

  for (const f of files) {
    if (!f.filename || !f.contentType) {
      return respond(400, {
        error: 'VALIDATION_ERROR',
        message: 'Each file must have filename and contentType',
      })
    }
  }

  const batchId = randomUUID()

  const uploads = await Promise.all(
    files.map(async (f) => {
      const documentId = randomUUID()
      const key = `uploads/${tenantId}/${batchId}/${f.filename}`
      const url = await getSignedUrl(
        s3,
        new PutObjectCommand({
          Bucket: LANDING_BUCKET,
          Key: key,
          ContentType: f.contentType,
          Metadata: { documentid: documentId },
        }),
        { expiresIn: URL_EXPIRY_SECONDS },
      )

      // If metadata provided, write document record immediately (skip LLM later)
      if (f.metadata) {
        await ddb.send(
          new PutCommand({
            TableName: DOCUMENT_TABLE,
            Item: {
              tenantId,
              documentId,
              status: 'processed',
              fileType: f.contentType.split('/').pop() ?? 'unknown',
              source: 'upload',
              uploadedAt: new Date().toISOString(),
              s3Key: key,
              ...f.metadata,
              tags: [f.metadata.documentType, f.metadata.subType, f.metadata.vendorName].filter(
                Boolean,
              ),
              typeDate: f.metadata.documentType
                ? `${f.metadata.documentType}#${f.metadata.documentDate ?? ''}`
                : undefined,
              vendorDate: f.metadata.vendorName
                ? `${f.metadata.vendorName}#${f.metadata.documentDate ?? ''}`
                : undefined,
              statusDate: `processed#${new Date().toISOString()}`,
            },
          }),
        )
      }

      return { filename: f.filename, uploadUrl: url, key, documentId, expiresIn: URL_EXPIRY_SECONDS }
    }),
  )

  return respond(200, { uploads })
}
