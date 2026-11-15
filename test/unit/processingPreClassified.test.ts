import { S3Client } from '@aws-sdk/client-s3'
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb'
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge'
import { mockClient } from 'aws-sdk-client-mock'

jest.mock('../../lambdas/processing/adapters', () => ({
  createLlmAdapter: () => ({ analyze: jest.fn() }),
}))
jest.mock('../../lambdas/processing/utils/buildBedrockPrompt', () => ({
  buildBedrockPrompt: async () => 'prompt',
}))
jest.mock('../../lambdas/processing/utils/getFileFromS3', () => ({
  getFileFromS3: async () => ({
    bytes: Buffer.from('some receipt text'),
    metadata: { documentid: 'doc1' },
  }),
}))
jest.mock('../../lambdas/processing/utils/textToPdf', () => ({
  textToPdf: async () => Buffer.from('pdf'),
}))

const s3Mock = mockClient(S3Client)
const ddbMock = mockClient(DynamoDBDocumentClient)
const ebMock = mockClient(EventBridgeClient)

const sqsEvent = {
  Records: [
    {
      body: JSON.stringify({
        detail: { bucket: { name: 'landing' }, object: { key: 'uploads/t1/b1/receipt.txt' } },
      }),
    },
  ],
} as any

describe('processing handler: pre-classified upload', () => {
  beforeEach(() => {
    process.env.DOCUMENT_TABLE = 'docs'
    s3Mock.reset()
    ddbMock.reset()
    ebMock.reset()
    s3Mock.resolves({})
    ebMock.resolves({})
  })

  it('persists URIs without overwriting metadata and emits DocumentProcessed', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { documentId: 'doc1', status: 'processed' } })
    const merged = {
      documentId: 'doc1',
      status: 'processed',
      documentType: 'financial',
      vendorName: 'manual-vendor',
      source: 'upload',
      originalUri: 's3://x/documents/t1/doc1/original.txt',
      extractedTextUri: 's3://x/documents/t1/doc1/extracted.txt',
    }
    ddbMock.on(UpdateCommand).resolves({ Attributes: merged })

    const { handler } = await import('../../lambdas/processing')
    await (handler as any)(sqsEvent, {} as any, () => undefined)

    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1)
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0)
    const sent = ebMock.commandCalls(PutEventsCommand)
    expect(sent).toHaveLength(1)
    const detail = JSON.parse(sent[0].args[0].input.Entries![0].Detail!)
    expect(detail.tenantId).toBe('t1')
    expect(detail.documentId).toBe('doc1')
    expect(detail.vendorName).toBe('manual-vendor')
    expect(detail.originalUri).toBe(merged.originalUri)
    expect(detail.extractedTextUri).toBe(merged.extractedTextUri)
    expect(Object.keys(detail)).not.toContain('convertedPdfUri')
  })
})
