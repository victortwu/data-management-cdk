import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { SQSHandler } from 'aws-lambda'
import { simpleParser, ParsedMail } from 'mailparser'
import { randomUUID } from 'crypto'

import { PROCESSED_BUCKET, MIN_EMAIL_BODY_LENGTH } from './constants'
import type { DocumentRecord, DocumentStatus } from './types'
import { detectFileType } from './utils/detectFileType'
import { textToPdfBytes } from './utils/textToPdfBytes'
import { extractTextWithTextract } from './utils/extractTextWithTextract'
import { analyzeWithBedrock } from './utils/analyzeWithBedrock'
import { buildBedrockPrompt } from './utils/buildBedrockPrompt'
import { getFileFromS3 } from './utils/getFileFromS3'
import { saveMetadata } from './utils/saveMetadata'

const s3 = new S3Client({})
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))

const processDocument = async (
  fileBytes: Buffer,
  originalKey: string,
  fileType: string,
  source: string,
  systemPrompt: string,
  sourceEmailId?: string,
  preExtractedText?: string,
) => {
  const documentId = randomUUID()
  const prefix = `documents/${documentId}`

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
    pdfBytes = fileBytes
  } else {
    pdfBytes = textToPdfBytes(`[Converted from ${fileType} — original preserved]`)
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

  // Analyze with Bedrock
  const analysis = await analyzeWithBedrock(extractedText, systemPrompt)

  // Determine status based on confidence
  let status: DocumentStatus = 'processed'
  let reviewReason: string | undefined
  if (analysis.confidence === 'low' || analysis.documentType === 'unknown') {
    status = 'needs_review'
    reviewReason = analysis.flagReason ?? 'low_confidence'
  }

  // Build metadata
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
    tags: [analysis.documentType, analysis.subType, analysis.vendorName].filter(
      Boolean,
    ) as string[],
    sourceEmailId,
  }

  await saveMetadata(metadata, ddb)
}

const processEmail = async (fileBytes: Buffer, originalKey: string, systemPrompt: string) => {
  const parsed: ParsedMail = await simpleParser(fileBytes)
  const emailId = randomUUID()

  const bodyText = parsed.text ?? ''
  if (bodyText.length >= MIN_EMAIL_BODY_LENGTH) {
    const bodyPdfBytes = textToPdfBytes(bodyText)
    await processDocument(
      bodyPdfBytes,
      originalKey,
      'pdf',
      'email',
      systemPrompt,
      emailId,
      bodyText,
    )
  }

  for (const attachment of parsed.attachments ?? []) {
    const attKey = `${originalKey}/attachment/${attachment.filename ?? 'unnamed'}`
    const attType = detectFileType(attachment.filename ?? '')
    await processDocument(
      Buffer.from(attachment.content),
      attKey,
      attType,
      'email',
      systemPrompt,
      emailId,
    )
  }
}

export const handler: SQSHandler = async (event) => {
  // Build prompt once per invocation (config doesn't change mid-batch)
  const systemPrompt = await buildBedrockPrompt(ddb)

  for (const record of event.Records) {
    const body = JSON.parse(record.body)
    const bucket = body.detail.bucket.name
    const key = body.detail.object.key

    try {
      const fileBytes = await getFileFromS3(bucket, key)
      const fileType = detectFileType(key)

      if (fileType === 'email') {
        await processEmail(fileBytes, key, systemPrompt)
      } else {
        await processDocument(fileBytes, key, fileType, 'upload', systemPrompt)
      }
    } catch (err) {
      await saveMetadata(
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
}
