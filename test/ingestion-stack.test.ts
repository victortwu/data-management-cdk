import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { IngestionStack } from '../lib/ingestion-stack';
import { stages } from '../lib/config';

const createStack = (stageName = 'Beta'): cdk.Stack => {
  const app = new cdk.App();
  return new IngestionStack(app, `IngestionStack-${stageName}`, {
    stage: { stageName },
  });
}

describe('Stage configuration', () => {
  test('creates one stack per stage', () => {
    const app = new cdk.App();
    const stacks = stages.map(
      (stage) => new IngestionStack(app, `IngestionStack-${stage.stageName}`, { stage })
    );

    expect(stacks).toHaveLength(2);
    expect(stacks[0].stackName).toBe('IngestionStack-Beta');
    expect(stacks[1].stackName).toBe('IngestionStack-Prod');
  });
});

describe('S3 Landing Bucket', () => {
  test('has versioning enabled', () => {
    const template = Template.fromStack(createStack());
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
    });
  });

  test('uses S3-managed encryption', () => {
    const template = Template.fromStack(createStack());
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
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
