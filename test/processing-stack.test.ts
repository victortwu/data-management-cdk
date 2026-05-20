import * as cdk from 'aws-cdk-lib'
import { Template, Match } from 'aws-cdk-lib/assertions'
import { DataMgmtIngestionStack } from '../lib/stacks/ingestion-stack'
import { DataMgmtProcessingStack } from '../lib/stacks/processing-stack'

const createStacks = () => {
  const app = new cdk.App()
  // Ingestion stack must be created first to write SSM params that processing reads
  const ingestion = new DataMgmtIngestionStack(app, 'Test-DataMgmtIngestionStack', {
    stage: { stageName: 'Test' },
  })
  const processing = new DataMgmtProcessingStack(app, 'Test-DataMgmtProcessingStack', {
    stage: { stageName: 'Test' },
  })
  // Add dependency so SSM params resolve
  processing.addDependency(ingestion)
  return { ingestion, processing, template: Template.fromStack(processing) }
}

describe('Processed Bucket', () => {
  test('exists with correct config', () => {
    const { template } = createStacks()
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms' } },
        ],
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    })
  })
})

describe('Glacier Bucket', () => {
  test('has Glacier transition lifecycle rule', () => {
    const { template } = createStacks()
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Transitions: Match.arrayWith([
              Match.objectLike({ StorageClass: 'GLACIER_IR', TransitionInDays: 0 }),
            ]),
          }),
        ]),
      },
    })
  })
})

describe('Archive Queue', () => {
  test('has DLQ with maxReceiveCount of 3', () => {
    const { template } = createStacks()
    template.hasResourceProperties('AWS::SQS::Queue', {
      VisibilityTimeout: 300,
      RedrivePolicy: { maxReceiveCount: 3 },
    })
  })

  test('DLQ has 14-day retention', () => {
    const { template } = createStacks()
    template.hasResourceProperties('AWS::SQS::Queue', {
      MessageRetentionPeriod: 1209600,
    })
  })
})

describe('Archive EventBridge Rule', () => {
  test('routes S3 Object Created events to archive queue', () => {
    const { template } = createStacks()
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        source: ['aws.s3'],
        'detail-type': ['Object Created'],
      },
      Targets: Match.arrayWith([Match.objectLike({ Arn: Match.anyValue() })]),
    })
  })
})

describe('Document Metadata Table', () => {
  test('has tenantId partition key, documentId sort key, and on-demand billing', () => {
    const { template } = createStacks()
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'tenantId', KeyType: 'HASH' },
        { AttributeName: 'documentId', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    })
  })

  test('has ByType GSI with tenantId partition key', () => {
    const { template } = createStacks()
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'ByType',
          KeySchema: [
            { AttributeName: 'tenantId', KeyType: 'HASH' },
            { AttributeName: 'typeDate', KeyType: 'RANGE' },
          ],
        }),
      ]),
    })
  })

  test('has ByVendor GSI with tenantId partition key', () => {
    const { template } = createStacks()
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'ByVendor',
          KeySchema: [
            { AttributeName: 'tenantId', KeyType: 'HASH' },
            { AttributeName: 'vendorDate', KeyType: 'RANGE' },
          ],
        }),
      ]),
    })
  })

  test('has ByStatus GSI with tenantId partition key', () => {
    const { template } = createStacks()
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'ByStatus',
          KeySchema: [
            { AttributeName: 'tenantId', KeyType: 'HASH' },
            { AttributeName: 'statusDate', KeyType: 'RANGE' },
          ],
        }),
      ]),
    })
  })

  test('has RETAIN removal policy', () => {
    const { template } = createStacks()
    const tables = template.findResources('AWS::DynamoDB::Table')
    const metadataTable = Object.values(tables).find((t: any) =>
      t.Properties.KeySchema.some((k: any) => k.AttributeName === 'tenantId') &&
      t.Properties.KeySchema.some((k: any) => k.AttributeName === 'documentId'),
    ) as any
    expect(metadataTable.DeletionPolicy).toBe('Retain')
  })
})

describe('Config Table', () => {
  test('has tenantId partition key, sk sort key, and on-demand billing', () => {
    const { template } = createStacks()
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'tenantId', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    })
  })

  test('creates exactly 2 DynamoDB tables', () => {
    const { template } = createStacks()
    template.resourceCountIs('AWS::DynamoDB::Table', 2)
  })
})

describe('KMS Encryption', () => {
  test('creates a KMS key with rotation enabled', () => {
    const { template } = createStacks()
    template.hasResourceProperties('AWS::KMS::Key', {
      EnableKeyRotation: true,
    })
  })

  test('creates exactly 1 KMS key', () => {
    const { template } = createStacks()
    template.resourceCountIs('AWS::KMS::Key', 1)
  })

  test('SQS queues use KMS encryption', () => {
    const { template } = createStacks()
    const queues = template.findResources('AWS::SQS::Queue')
    const allEncrypted = Object.values(queues).every(
      (q: any) => q.Properties.KmsMasterKeyId !== undefined,
    )
    expect(allEncrypted).toBe(true)
  })

  test('DynamoDB tables use customer-managed KMS', () => {
    const { template } = createStacks()
    const tables = template.findResources('AWS::DynamoDB::Table')
    const allEncrypted = Object.values(tables).every(
      (t: any) => t.Properties.SSESpecification?.SSEEnabled === true,
    )
    expect(allEncrypted).toBe(true)
  })
})

describe('Archive Lambda', () => {
  test('exists with Node.js 20 runtime', () => {
    const { template } = createStacks()
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs20.x',
      Environment: {
        Variables: Match.objectLike({
          GLACIER_BUCKET: Match.anyValue(),
        }),
      },
    })
  })

  test('has SQS event source from archive queue', () => {
    const { template } = createStacks()
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      EventSourceArn: Match.anyValue(),
    })
  })
})

describe('Processing Lambda', () => {
  test('exists with correct environment variables', () => {
    const { template } = createStacks()
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs20.x',
      MemorySize: 512,
      Timeout: 300,
      Environment: {
        Variables: Match.objectLike({
          PROCESSED_BUCKET: Match.anyValue(),
          DOCUMENT_TABLE: Match.anyValue(),
          CONFIG_TABLE: Match.anyValue(),
        }),
      },
    })
  })

  test('has Textract permissions', () => {
    const { template } = createStacks()
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: [
              'textract:DetectDocumentText',
              'textract:StartDocumentTextDetection',
              'textract:GetDocumentTextDetection',
            ],
            Effect: 'Allow',
          }),
        ]),
      },
    })
  })

  test('has Bedrock permissions', () => {
    const { template } = createStacks()
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'bedrock:InvokeModel',
            Effect: 'Allow',
          }),
        ]),
      },
    })
  })

  test('has 2 event source mappings (archive + processing)', () => {
    const { template } = createStacks()
    template.resourceCountIs('AWS::Lambda::EventSourceMapping', 2)
  })
})
