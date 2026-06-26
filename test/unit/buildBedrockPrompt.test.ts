import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { mockClient } from 'aws-sdk-client-mock'

// Must set env before importing module that reads it at load time
process.env.CONFIG_TABLE = 'test-config-table'

import { buildBedrockPrompt } from '../../lambdas/processing/utils/buildBedrockPrompt'

const ddbMock = mockClient(DynamoDBDocumentClient)

beforeEach(() => {
  ddbMock.reset()
})

describe('buildBedrockPrompt', () => {
  it('includes TYPE# items as known document types with subType hints', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          tenantId: 'tenant-1',
          sk: 'TYPE#financial',
          label: 'Financial',
          subTypes: { receipt: ['restaurant depot', 'us foods'], invoice: ['net 30', 'due date'] },
        },
        {
          tenantId: 'tenant-1',
          sk: 'TYPE#tax',
          label: 'Tax',
          subTypes: { notice: ['cp2000', 'balance due'] },
        },
      ],
    })

    const prompt = await buildBedrockPrompt('tenant-1', ddbMock as unknown as DynamoDBDocumentClient)

    expect(prompt).toContain('Known document types:')
    expect(prompt).toContain('- financial (subTypes:')
    expect(prompt).toContain('receipt [hints: restaurant depot, us foods]')
    expect(prompt).toContain('invoice [hints: net 30, due date]')
    expect(prompt).toContain('- tax (subTypes:')
    expect(prompt).toContain('notice [hints: cp2000, balance due]')
  })

  it('includes VENDOR# items as known vendors with aliases', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          tenantId: 'tenant-1',
          sk: 'TYPE#financial',
          label: 'Financial',
          subTypes: { receipt: ['food'] },
        },
        {
          tenantId: 'tenant-1',
          sk: 'VENDOR#irs',
          label: 'Internal Revenue Service',
          aliases: ['irs', 'internal revenue service'],
        },
        {
          tenantId: 'tenant-1',
          sk: 'VENDOR#wafd',
          label: 'WaFd Bank',
          aliases: ['wafd', 'washington federal'],
        },
      ],
    })

    const prompt = await buildBedrockPrompt('tenant-1', ddbMock as unknown as DynamoDBDocumentClient)

    expect(prompt).toContain('Known vendors:')
    expect(prompt).toContain('- irs: "Internal Revenue Service" (aliases: irs, internal revenue service)')
    expect(prompt).toContain('- wafd: "WaFd Bank" (aliases: wafd, washington federal)')
  })

  it('falls back to DEFAULT_CONFIG when tenant has no TYPE# items', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] })

    const prompt = await buildBedrockPrompt('tenant-1', ddbMock as unknown as DynamoDBDocumentClient)

    // Default config should provide at least some known types
    expect(prompt).toContain('Known document types:')
    expect(prompt).not.toContain('Known document types:\n\n')
  })

  it('omits vendors section content when no VENDOR# items exist', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { tenantId: 'tenant-1', sk: 'TYPE#financial', label: 'Financial', subTypes: { receipt: ['food'] } },
      ],
    })

    const prompt = await buildBedrockPrompt('tenant-1', ddbMock as unknown as DynamoDBDocumentClient)

    expect(prompt).toContain('Known vendors:')
    // Vendors section should be empty (just the header, no vendor lines)
    const vendorSection = prompt.split('Known vendors:\n')[1]?.split('\n\nRules:')[0]
    expect(vendorSection?.trim()).toBe('')
  })

  it('queries the correct table and tenant', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] })

    await buildBedrockPrompt('my-tenant-id', ddbMock as unknown as DynamoDBDocumentClient)

    const call = ddbMock.commandCalls(QueryCommand)[0]
    expect(call.args[0].input).toEqual({
      TableName: 'test-config-table',
      KeyConditionExpression: 'tenantId = :tid',
      ExpressionAttributeValues: { ':tid': 'my-tenant-id' },
    })
  })
})
