import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { mockClient } from 'aws-sdk-client-mock'

import { persistPreClassifiedUris } from '../../lambdas/processing/utils/persistPreClassifiedUris'

const ddbMock = mockClient(DynamoDBDocumentClient)
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))

const uris = {
  originalUri: 's3://b/documents/t/d1/original.heic',
  convertedPdfUri: 's3://b/documents/t/d1/converted.pdf',
  extractedTextUri: 's3://b/documents/t/d1/extracted.txt',
}

describe('persistPreClassifiedUris', () => {
  beforeEach(() => ddbMock.reset())

  it('sets only the three URI attributes, conditionally, and returns the merged record', async () => {
    const merged = { documentId: 'd1', vendorName: 'manual-vendor', ...uris }
    ddbMock.on(UpdateCommand).resolves({ Attributes: merged })

    const result = await persistPreClassifiedUris('t', 'd1', uris, ddb)

    expect(result).toEqual(merged)
    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input
    expect(input.Key).toEqual({ tenantId: 't', documentId: 'd1' })
    expect(input.ConditionExpression).toBe('attribute_exists(documentId)')
    expect(input.UpdateExpression).toBe(
      'SET originalUri = :originalUri, convertedPdfUri = :convertedPdfUri, extractedTextUri = :extractedTextUri',
    )
    expect(input.ExpressionAttributeValues).toEqual({
      ':originalUri': uris.originalUri,
      ':convertedPdfUri': uris.convertedPdfUri,
      ':extractedTextUri': uris.extractedTextUri,
    })
    expect(input.ReturnValues).toBe('ALL_NEW')
  })

  it('propagates a failed condition (record missing)', async () => {
    ddbMock.on(UpdateCommand).rejects(new Error('ConditionalCheckFailedException'))
    await expect(persistPreClassifiedUris('t', 'd1', uris, ddb)).rejects.toThrow(
      'ConditionalCheckFailedException',
    )
  })
})
