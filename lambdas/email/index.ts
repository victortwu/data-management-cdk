import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { EventBridgeHandler } from 'aws-lambda'
import { simpleParser } from 'mailparser'
import { ulid } from 'ulid'

const s3 = new S3Client({})

const LANDING_BUCKET = process.env.LANDING_BUCKET!
const TENANT_ID = process.env.TENANT_ID!
const MAX_ATTACHMENTS = 20
const MIN_BODY_LENGTH = 50

const PROCESS_EXTENSIONS = new Set(['pdf', 'jpg', 'jpeg', 'png', 'tiff', 'tif'])
const STORE_EXTENSIONS = new Set(['doc', 'docx', 'xls', 'xlsx', 'csv', 'txt', 'html'])
const DISCARD_EXTENSIONS = new Set(['exe', 'zip', 'bat', 'scr', 'js'])

const getExtension = (filename: string): string =>
  (filename.split('.').pop() ?? '').toLowerCase()

const classifyAttachment = (filename: string): 'process' | 'store' | 'discard' => {
  const ext = getExtension(filename)
  if (PROCESS_EXTENSIONS.has(ext)) return 'process'
  if (STORE_EXTENSIONS.has(ext)) return 'store'
  if (DISCARD_EXTENSIONS.has(ext)) return 'discard'
  return 'discard'
}

export const handler: EventBridgeHandler<'Object Created', { bucket: { name: string }; object: { key: string } }, void> = async (event) => {
  const { bucket, object } = event.detail
  const key = object.key

  // Fetch raw email from S3
  const response = await s3.send(
    new GetObjectCommand({ Bucket: bucket.name, Key: key }),
  )
  const emailBytes = Buffer.from(await response.Body!.transformToByteArray())

  // Parse MIME
  const parsed = await simpleParser(emailBytes)
  const batchId = ulid()
  const prefix = `uploads/${TENANT_ID}/${batchId}`

  // Process body as document if long enough
  if ((parsed.text ?? '').length >= MIN_BODY_LENGTH) {
    const bodyFilename = `email-body-${batchId}.txt`
    await s3.send(
      new PutObjectCommand({
        Bucket: LANDING_BUCKET,
        Key: `${prefix}/${bodyFilename}`,
        Body: parsed.text,
        Metadata: { source: 'email', 'email-subject': parsed.subject ?? '' },
      }),
    )
  }

  // Process attachments (up to MAX_ATTACHMENTS)
  const attachments = (parsed.attachments ?? []).slice(0, MAX_ATTACHMENTS)

  for (const attachment of attachments) {
    const filename = attachment.filename ?? `attachment-${ulid()}`
    const action = classifyAttachment(filename)

    if (action === 'discard') continue

    const metadata: Record<string, string> = {
      source: 'email',
      'email-subject': parsed.subject ?? '',
      'original-filename': filename,
    }

    if (action === 'store') {
      metadata['needs_review'] = 'unsupported_file_type'
    }

    await s3.send(
      new PutObjectCommand({
        Bucket: LANDING_BUCKET,
        Key: `${prefix}/${filename}`,
        Body: attachment.content,
        Metadata: metadata,
      }),
    )
  }
}
