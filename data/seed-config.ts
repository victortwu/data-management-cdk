import { DynamoDBClient, BatchWriteItemCommand } from '@aws-sdk/client-dynamodb'
import { marshall } from '@aws-sdk/util-dynamodb'
import { readFileSync } from 'fs'
import { join } from 'path'

const CONFIG_TABLE = process.env.CONFIG_TABLE

if (!CONFIG_TABLE) {
  console.error('Error: CONFIG_TABLE environment variable is required.')
  console.error('Usage: AWS_REGION=<region> CONFIG_TABLE=<name> npx ts-node data/seed-config.ts')
  process.exit(1)
}

const REGION = process.env.AWS_REGION ?? 'us-west-2'
const client = new DynamoDBClient({ region: REGION })

const batchWrite = async (items: Record<string, unknown>[]) => {
  for (let i = 0; i < items.length; i += 25) {
    const batch = items.slice(i, i + 25)
    const putRequests = batch.map((item) => ({ PutRequest: { Item: marshall(item) } }))
    await client.send(new BatchWriteItemCommand({ RequestItems: { [CONFIG_TABLE!]: putRequests } }))
  }
}

const seed = async () => {
  const items = JSON.parse(readFileSync(join(__dirname, 'seed-config.json'), 'utf-8'))
  await batchWrite(items)
  console.log(`Seeded ${items.length} config items into ${CONFIG_TABLE}.`)
}

seed().catch(console.error)
