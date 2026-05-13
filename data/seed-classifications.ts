import { DynamoDBClient, BatchWriteItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { readFileSync } from 'fs';
import { join } from 'path';

const CLASSIFICATION_TABLE = process.env.CLASSIFICATION_TABLE;
const VENDOR_TABLE = process.env.VENDOR_TABLE;

if (!CLASSIFICATION_TABLE && !VENDOR_TABLE) {
  console.error('Error: At least one of CLASSIFICATION_TABLE or VENDOR_TABLE environment variables is required.');
  console.error('Usage: AWS_REGION=<region> CLASSIFICATION_TABLE=<name> VENDOR_TABLE=<name> npx ts-node data/seed-classifications.ts');
  process.exit(1);
}

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const client = new DynamoDBClient({ region: REGION });

const batchWrite = async (tableName: string, items: Record<string, unknown>[]) => {
  // BatchWriteItem supports max 25 items per call
  for (let i = 0; i < items.length; i += 25) {
    const batch = items.slice(i, i + 25);
    const putRequests = batch.map((item) => ({ PutRequest: { Item: marshall(item) } }));
    await client.send(new BatchWriteItemCommand({ RequestItems: { [tableName]: putRequests } }));
  }
};

const seed = async () => {
  if (CLASSIFICATION_TABLE) {
    const classifications = JSON.parse(readFileSync(join(__dirname, 'seed-classifications.json'), 'utf-8'));
    await batchWrite(CLASSIFICATION_TABLE, classifications);
    console.log(`Seeded ${classifications.length} classification configs into ${CLASSIFICATION_TABLE}.`);
  }

  if (VENDOR_TABLE) {
    const vendors = JSON.parse(readFileSync(join(__dirname, 'seed-vendors.json'), 'utf-8'));
    await batchWrite(VENDOR_TABLE, vendors);
    console.log(`Seeded ${vendors.length} vendor configs into ${VENDOR_TABLE}.`);
  }
};

seed().catch(console.error);
