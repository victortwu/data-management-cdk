import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { DataMgmtIngestionStack } from '../lib/ingestion-stack';
import { stages } from '../lib/config';

const createStack = (stageName = 'Beta'): cdk.Stack => {
  const app = new cdk.App();
  return new DataMgmtIngestionStack(app, `${stageName}-DataMgmtIngestionStack`, {
    stage: { stageName },
  });
}

describe('Stage configuration', () => {
  test('creates one stack per stage', () => {
    const app = new cdk.App();
    const stacks = stages.map(
      (stage) => new DataMgmtIngestionStack(app, `${stage.stageName}-DataMgmtIngestionStack`, { stage })
    );

    expect(stacks).toHaveLength(2);
    expect(stacks[0].stackName).toBe('Beta-DataMgmtIngestionStack');
    expect(stacks[1].stackName).toBe('Prod-DataMgmtIngestionStack');
  });
});

describe('S3 Landing Bucket', () => {
  test('has versioning enabled', () => {
    const template = Template.fromStack(createStack());
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
    });
  });

  test('uses KMS encryption', () => {
    const template = Template.fromStack(createStack());
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms' } },
        ],
      },
    });
  });

  test('has EventBridge notifications enabled', () => {
    const template = Template.fromStack(createStack());
    // CDK enables EventBridge via a custom resource, not a bucket property
    template.hasResourceProperties('Custom::S3BucketNotifications', {
      NotificationConfiguration: {
        EventBridgeConfiguration: {},
      },
    });
  });

  test('has 14-day lifecycle expiration', () => {
    const template = Template.fromStack(createStack());
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ ExpirationInDays: 14, Status: 'Enabled' }),
        ]),
      },
    });
  });

  test('blocks all public access', () => {
    const template = Template.fromStack(createStack());
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test('enforces SSL via bucket policy', () => {
    const template = Template.fromStack(createStack());
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      },
    });
  });

  test('has RETAIN removal policy', () => {
    const template = Template.fromStack(createStack());
    template.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });
});

describe('SQS Ingestion Queue', () => {
  test('main queue has DLQ with maxReceiveCount of 3', () => {
    const template = Template.fromStack(createStack());
    template.hasResourceProperties('AWS::SQS::Queue', {
      VisibilityTimeout: 300,
      RedrivePolicy: {
        maxReceiveCount: 3,
      },
    });
  });

  test('DLQ has 14-day retention', () => {
    const template = Template.fromStack(createStack());
    template.hasResourceProperties('AWS::SQS::Queue', {
      MessageRetentionPeriod: 1209600,
    });
  });

  test('creates exactly 2 queues', () => {
    const template = Template.fromStack(createStack());
    template.resourceCountIs('AWS::SQS::Queue', 2);
  });
});

describe('KMS Encryption', () => {
  test('creates a KMS key with rotation enabled', () => {
    const template = Template.fromStack(createStack());
    template.hasResourceProperties('AWS::KMS::Key', {
      EnableKeyRotation: true,
    });
  });

  test('creates exactly 1 KMS key', () => {
    const template = Template.fromStack(createStack());
    template.resourceCountIs('AWS::KMS::Key', 1);
  });

  test('SQS queues use KMS encryption', () => {
    const template = Template.fromStack(createStack());
    const queues = template.findResources('AWS::SQS::Queue');
    const allEncrypted = Object.values(queues).every(
      (q: any) => q.Properties.KmsMasterKeyId !== undefined,
    );
    expect(allEncrypted).toBe(true);
  });
});

describe('EventBridge Rule', () => {
  test('routes S3 Object Created events', () => {
    const template = Template.fromStack(createStack());
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        source: ['aws.s3'],
        'detail-type': ['Object Created'],
      },
    });
  });

  test('targets the ingestion SQS queue', () => {
    const template = Template.fromStack(createStack());
    template.hasResourceProperties('AWS::Events::Rule', {
      Targets: Match.arrayWith([
        Match.objectLike({
          Arn: Match.anyValue(),
        }),
      ]),
    });
  });
});
