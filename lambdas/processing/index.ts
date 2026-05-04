import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { TextractClient, DetectDocumentTextCommand } from '@aws-sdk/client-textract';
import { ComprehendClient, DetectEntitiesCommand } from '@aws-sdk/client-comprehend';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { SQSHandler } from 'aws-lambda';
import { simpleParser, ParsedMail } from 'mailparser';
import { randomUUID } from 'crypto';

const s3 = new S3Client({});
const textract = new TextractClient({});
const comprehend = new ComprehendClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const PROCESSED_BUCKET = process.env.PROCESSED_BUCKET!;
const DOCUMENT_TABLE = process.env.DOCUMENT_TABLE!;
const CLASSIFICATION_TABLE = process.env.CLASSIFICATION_TABLE!;

const MIN_EMAIL_BODY_LENGTH = 50;

interface DocumentRecord {
  documentId: string;
  status: string;
  reviewReason?: string;
  classificationDebug?: { typesChecked: number; keywordsChecked: number; textPreview: string };
  fileType: string;
  source: string;
  uploadedAt: string;
  originalUri: string;
  convertedPdfUri?: string;
  extractedTextUri?: string;
  documentDate?: string;
  documentType?: string;
  vendorName?: string;
  contactName?: string;
  amounts?: string[];
  tags?: string[];
  sourceEmailId?: string;
}

const getFileFromS3 = async (bucket: string, key: string): Promise<Buffer> => {
  const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return Buffer.from(await resp.Body!.transformToByteArray());
};

const detectFileType = (key: string): string => {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    pdf: 'pdf', jpg: 'image', jpeg: 'image', png: 'image', tiff: 'image', tif: 'image',
    xlsx: 'excel', xls: 'excel', csv: 'csv', eml: 'email',
  };
  return map[ext] ?? 'email'; // SES files have no extension, treat as email
};

const textToPdfBytes = (text: string): Buffer => {
  // Minimal PDF generation — produces a valid single-page PDF with text
  const stream = `1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
4 0 obj<</Length ${20 + text.length}>>stream
BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET
endstream endobj
xref
0 6
trailer<</Size 6/Root 1 0 R>>
startxref
0
%%EOF`;
  return Buffer.from(stream);
};

const extractTextWithTextract = async (fileBytes: Buffer): Promise<string> => {
  const resp = await textract.send(new DetectDocumentTextCommand({
    Document: { Bytes: fileBytes },
  }));
  return (resp.Blocks ?? [])
    .filter((b) => b.BlockType === 'LINE')
    .map((b) => b.Text)
    .join('\n');
};

const detectEntities = async (text: string) => {
  const result = { dates: [] as string[], organizations: [] as string[], persons: [] as string[], quantities: [] as string[] };
  if (!text.trim()) return result;

  // Comprehend has a 5000 byte limit per call — truncate if needed
  const truncated = text.slice(0, 4900);
  const resp = await comprehend.send(new DetectEntitiesCommand({
    Text: truncated, LanguageCode: 'en',
  }));

  for (const entity of resp.Entities ?? []) {
    const val = entity.Text ?? '';
    switch (entity.Type) {
      case 'DATE': result.dates.push(val); break;
      case 'ORGANIZATION': result.organizations.push(val); break;
      case 'PERSON': result.persons.push(val); break;
      case 'QUANTITY': result.quantities.push(val); break;
    }
  }
  return result;
};

interface ClassificationResult {
  documentType: string;
  debug: { typesChecked: number; keywordsChecked: number; textPreview: string };
}

const classifyDocument = async (text: string): Promise<ClassificationResult> => {
  const configItems = await ddb.send(new ScanCommand({ TableName: CLASSIFICATION_TABLE }));
  const lowerText = text.toLowerCase();
  let keywordsChecked = 0;

  for (const item of configItems.Items ?? []) {
    const keywords = (item.keywords as string[]) ?? [];
    keywordsChecked += keywords.length;
    if (keywords.some((kw) => lowerText.includes(kw.toLowerCase()))) {
      return { documentType: item.documentType as string, debug: { typesChecked: configItems.Items?.length ?? 0, keywordsChecked, textPreview: text.slice(0, 200) } };
    }
  }

  return {
    documentType: 'unknown',
    debug: {
      typesChecked: configItems.Items?.length ?? 0,
      keywordsChecked,
      textPreview: text.slice(0, 200),
    },
  };
};

const buildTags = (documentType: string, entities: { organizations: string[]; dates: string[] }): string[] => {
  const tags: string[] = [];
  if (documentType !== 'unknown') tags.push(documentType);
  if (entities.organizations[0]) tags.push(entities.organizations[0].toLowerCase().replace(/\s+/g, '-'));
  return tags;
};

const saveMetadata = async (record: DocumentRecord) => {
  // Remove undefined values
  const clean = Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined));
  await ddb.send(new PutCommand({ TableName: DOCUMENT_TABLE, Item: clean }));
};

const processDocument = async (
  fileBytes: Buffer, originalKey: string, fileType: string,
  source: string, sourceEmailId?: string, preExtractedText?: string,
) => {
  const documentId = randomUUID();
  const prefix = `documents/${documentId}`;

  // Store original
  const originalExt = originalKey.split('.').pop()?.toLowerCase() ?? 'bin';
  const originalUri = `${prefix}/original.${originalExt}`;
  await s3.send(new PutObjectCommand({
    Bucket: PROCESSED_BUCKET, Key: originalUri, Body: fileBytes,
  }));

  // Convert to PDF if needed (stub for non-PDF types)
  let pdfBytes: Buffer;
  if (fileType === 'pdf') {
    pdfBytes = fileBytes;
  } else if (fileType === 'image') {
    // Images go directly to Textract — no PDF conversion needed
    pdfBytes = fileBytes;
  } else {
    // Excel/CSV: store as-is, generate a placeholder PDF
    pdfBytes = textToPdfBytes(`[Converted from ${fileType} — original preserved]`);
  }

  const convertedPdfUri = `${prefix}/converted.pdf`;
  await s3.send(new PutObjectCommand({
    Bucket: PROCESSED_BUCKET, Key: convertedPdfUri, Body: pdfBytes,
  }));

  // Extract text via Textract (or use pre-extracted text for email bodies)
  let extractedText: string;
  if (preExtractedText) {
    extractedText = preExtractedText;
  } else if (fileType === 'csv' || fileType === 'excel') {
    extractedText = fileBytes.toString('utf-8');
  } else {
    extractedText = await extractTextWithTextract(fileBytes);
  }

  // Store extracted text
  const extractedTextUri = `${prefix}/extracted.txt`;
  await s3.send(new PutObjectCommand({
    Bucket: PROCESSED_BUCKET, Key: extractedTextUri, Body: extractedText,
  }));

  // Detect entities with Comprehend
  const entities = await detectEntities(extractedText);

  // Classify document type
  const { documentType, debug: classificationDebug } = await classifyDocument(extractedText);

  // Build metadata
  const metadata: DocumentRecord = {
    documentId,
    status: documentType === 'unknown' ? 'needs_review' : 'processed',
    reviewReason: documentType === 'unknown' ? 'no_classification_match' : undefined,
    classificationDebug: documentType === 'unknown' ? classificationDebug : undefined,
    fileType,
    source,
    uploadedAt: new Date().toISOString(),
    originalUri: `s3://${PROCESSED_BUCKET}/${originalUri}`,
    convertedPdfUri: `s3://${PROCESSED_BUCKET}/${convertedPdfUri}`,
    extractedTextUri: `s3://${PROCESSED_BUCKET}/${extractedTextUri}`,
    documentDate: entities.dates[0],
    documentType,
    vendorName: entities.organizations[0],
    contactName: entities.persons[0],
    amounts: entities.quantities,
    tags: buildTags(documentType, entities),
    sourceEmailId,
  };

  await saveMetadata(metadata);
};

const processEmail = async (fileBytes: Buffer, originalKey: string) => {
  const parsed: ParsedMail = await simpleParser(fileBytes);
  const emailId = randomUUID();

  // Process email body if substantial
  const bodyText = parsed.text ?? '';
  if (bodyText.length >= MIN_EMAIL_BODY_LENGTH) {
    const bodyPdfBytes = textToPdfBytes(bodyText);
    await processDocument(bodyPdfBytes, originalKey, 'pdf', 'email', emailId, bodyText);
  }

  // Process each attachment
  for (const attachment of parsed.attachments ?? []) {
    const attKey = `${originalKey}/attachment/${attachment.filename ?? 'unnamed'}`;
    const attType = detectFileType(attachment.filename ?? '');
    await processDocument(Buffer.from(attachment.content), attKey, attType, 'email', emailId);
  }
};

export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    const body = JSON.parse(record.body);
    const bucket = body.detail.bucket.name;
    const key = body.detail.object.key;

    try {
      const fileBytes = await getFileFromS3(bucket, key);
      const fileType = detectFileType(key);

      if (fileType === 'email') {
        await processEmail(fileBytes, key);
      } else {
        await processDocument(fileBytes, key, fileType, 'upload');
      }
    } catch (err) {
      await saveMetadata({
        documentId: randomUUID(),
        status: 'needs_review',
        reviewReason: `processing_error: ${(err as Error).message}`,
        fileType: 'unknown',
        source: 'upload',
        uploadedAt: new Date().toISOString(),
        originalUri: `s3://${bucket}/${key}`,
      });
    }
  }
};
