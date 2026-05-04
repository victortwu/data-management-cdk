import { DynamoDBClient, BatchWriteItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { readFileSync } from 'fs';
import { join } from 'path';

const TABLE_NAME = process.env.TABLE_NAME;
if (!TABLE_NAME) {
  console.error('Error: TABLE_NAME environment variable is required.');
  console.error('Usage: AWS_REGION=<region> TABLE_NAME=<ClassificationConfigTableName> npx ts-node data/seed-classifications.ts');
  process.exit(1);
}

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const client = new DynamoDBClient({ region: REGION });

const classifications = JSON.parse(
  readFileSync(join(__dirname, 'seed-classifications.json'), 'utf-8'),
);

const seed = async () => {
  const putRequests = classifications.map((item: Record<string, unknown>) => ({
    PutRequest: { Item: marshall(item) },
  }));

  await client.send(
    new BatchWriteItemCommand({
      RequestItems: { [TABLE_NAME]: putRequests },
    }),
  );

  console.log(`Done. Seeded ${classifications.length} classification configs into ${TABLE_NAME}.`);
};

seed().catch(console.error);
