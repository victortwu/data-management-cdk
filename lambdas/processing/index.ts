import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb'
import { SQSHandler } from 'aws-lambda'
import { simpleParser, ParsedMail } from 'mailparser'
import { randomUUID } from 'crypto'

import { PROCESSED_BUCKET, DOCUMENT_TABLE, MIN_EMAIL_BODY_LENGTH } from './constants'
import type { DocumentRecord, DocumentStatus } from './types'
import { detectFileType } from './utils/detectFileType'
import { textToPdf } from './utils/textToPdf'
import { imageToPdf } from './utils/imageToPdf'
import { extractTextWithTextract } from './utils/extractTextWithTextract'
import { createLlmAdapter } from './adapters'
import { buildBedrockPrompt } from './utils/buildBedrockPrompt'
import { getFileFromS3 } from './utils/getFileFromS3'
import { saveMetadata } from './utils/saveMetadata'
import { logger } from '../shared/utils/logger'
import { metrics, MetricUnit } from '../shared/utils/metrics'

const s3 = new S3Client({})
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const llm = createLlmAdapter()

const extractTenantIdFromKey = (key: string): string => {
  // Key format: uploads/{tenantId}/{batchId}/{filename}
  const parts = key.split('/')
  return parts[1] ?? 'unknown'
}

const processDocument = async (
  tenantId: string,
  fileBytes: Buffer,
  originalKey: string,
  fileType: string,
  source: string,
  systemPrompt: string,
  sourceEmailId?: string,
  preExtractedText?: string,
) => {
  const documentId = randomUUID()
  const prefix = `documents/${tenantId}/${documentId}`

  // Check if document was pre-classified at upload time
  const existing = await ddb.send(
    new GetCommand({
      TableName: DOCUMENT_TABLE,
      Key: { tenantId, documentId },
    }),
  )
  const skipLlm = existing.Item?.status === 'processed'

  // Store original
  const originalExt = originalKey.split('.').pop()?.toLowerCase() ?? 'bin'
  const originalUri = `${prefix}/original.${originalExt}`
  await s3.send(
    new PutObjectCommand({ Bucket: PROCESSED_BUCKET, Key: originalUri, Body: fileBytes }),
  )

  // Convert to PDF if needed
  let pdfBytes: Buffer
  if (fileType === 'pdf') {
    pdfBytes = fileBytes
  } else if (fileType === 'image') {
    pdfBytes = await imageToPdf(fileBytes, fileType)
  } else if (fileType === 'csv' || fileType === 'excel') {
    pdfBytes = await textToPdf(fileBytes.toString('utf-8'))
  } else {
    pdfBytes = await textToPdf(fileBytes.toString('utf-8'))
  }

  const convertedPdfUri = `${prefix}/converted.pdf`
  await s3.send(
    new PutObjectCommand({ Bucket: PROCESSED_BUCKET, Key: convertedPdfUri, Body: pdfBytes }),
  )

  // Extract text
  let extractedText: string
  if (preExtractedText) {
    extractedText = preExtractedText
  } else if (fileType === 'csv' || fileType === 'excel') {
    extractedText = fileBytes.toString('utf-8')
  } else if (fileType === 'pdf') {
    extractedText = await extractTextWithTextract(fileBytes, PROCESSED_BUCKET, originalUri)
  } else {
    extractedText = await extractTextWithTextract(fileBytes)
  }

  const extractedTextUri = `${prefix}/extracted.txt`
  await s3.send(
    new PutObjectCommand({ Bucket: PROCESSED_BUCKET, Key: extractedTextUri, Body: extractedText }),
  )

  // Skip LLM if document was pre-classified at upload
  if (skipLlm) return

  // Analyze with LLM
  const analysis = await llm.analyze(extractedText, systemPrompt)

  // Determine status based on confidence
  let status: DocumentStatus = 'processed'
  let reviewReason: string | undefined
  if (analysis.confidence === 'low' || analysis.documentType === 'unknown') {
    status = 'needs_review'
    reviewReason = analysis.flagReason ?? 'low_confidence'
  }

  const metadata: DocumentRecord = {
    documentId,
    status,
    reviewReason,
    fileType,
    source,
    uploadedAt: new Date().toISOString(),
    originalUri: `s3://${PROCESSED_BUCKET}/${originalUri}`,
    convertedPdfUri: `s3://${PROCESSED_BUCKET}/${convertedPdfUri}`,
    extractedTextUri: `s3://${PROCESSED_BUCKET}/${extractedTextUri}`,
    documentDate: analysis.documentDate,
    documentType: analysis.documentType,
    subType: analysis.subType,
    vendorName: analysis.vendorName,
    contactName: analysis.contactName,
    amounts: analysis.amounts,
    description: analysis.description,
    confidence: analysis.confidence,
    tags: [analysis.documentType, analysis.subType, analysis.vendorName].filter(Boolean) as string[],
    sourceEmailId,
  }

  await saveMetadata(tenantId, metadata, ddb)
}

const processEmail = async (
  tenantId: string,
  fileBytes: Buffer,
  originalKey: string,
  systemPrompt: string,
) => {
  const parsed: ParsedMail = await simpleParser(fileBytes)
  const emailId = randomUUID()

  const bodyText = parsed.text ?? ''
  if (bodyText.length >= MIN_EMAIL_BODY_LENGTH) {
    const bodyPdfBytes = await textToPdf(bodyText)
    await processDocument(tenantId, bodyPdfBytes, originalKey, 'pdf', 'email', systemPrompt, emailId, bodyText)
  }

  for (const attachment of parsed.attachments ?? []) {
    const attKey = `${originalKey}/attachment/${attachment.filename ?? 'unnamed'}`
    const attType = detectFileType(attachment.filename ?? '')
    await processDocument(tenantId, Buffer.from(attachment.content), attKey, attType, 'email', systemPrompt, emailId)
  }
}

export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    const body = JSON.parse(record.body)
    const bucket = body.detail.bucket.name
    const key = body.detail.object.key
    const tenantId = extractTenantIdFromKey(key)

    logger.appendKeys({ tenantId })

    try {
      const start = Date.now()
      const systemPrompt = await buildBedrockPrompt(tenantId, ddb)
      const fileBytes = await getFileFromS3(bucket, key)
      const fileType = detectFileType(key)

      if (fileType === 'email') {
        await processEmail(tenantId, fileBytes, key, systemPrompt)
      } else {
        await processDocument(tenantId, fileBytes, key, fileType, 'upload', systemPrompt)
      }

      const latencyMs = Date.now() - start
      logger.info('Document processed', { key, fileType, latencyMs })
      metrics.addMetric('DocumentsProcessed', MetricUnit.Count, 1)
      metrics.addMetric('ProcessingLatency', MetricUnit.Milliseconds, latencyMs)
    } catch (err) {
      logger.error('Processing failed', { key, error: (err as Error).message })
      metrics.addMetric('DocumentsFailed', MetricUnit.Count, 1)
      await saveMetadata(
        tenantId,
        {
          documentId: randomUUID(),
          status: 'needs_review',
          reviewReason: `processing_error: ${(err as Error).message}`,
          fileType: 'unknown',
          source: 'upload',
          uploadedAt: new Date().toISOString(),
          originalUri: `s3://${bucket}/${key}`,
        },
        ddb,
      )
    }
  }

  metrics.publishStoredMetrics()
}
