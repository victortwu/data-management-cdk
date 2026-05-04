import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { DataMgmtIngestionStack } from '../lib/ingestion-stack';
import { DataMgmtProcessingStack } from '../lib/processing-stack';
import { DataMgmtApiStack } from '../lib/api-stack';
import { DataMgmtAuthStack } from '../lib/auth-stack';

const createStacks = () => {
  const app = new cdk.App();
  const auth = new DataMgmtAuthStack(app, 'Test-DataMgmtAuthStack', {
    stage: { stageName: 'Test' },
  });
  const ingestion = new DataMgmtIngestionStack(app, 'Test-DataMgmtIngestionStack', {
    stage: { stageName: 'Test' },
  });
  const processing = new DataMgmtProcessingStack(app, 'Test-DataMgmtProcessingStack', {
    stage: { stageName: 'Test' },
    landingBucket: ingestion.landingBucket,
    ingestionQueue: ingestion.ingestionQueue,
    ingestionEncryptionKey: ingestion.encryptionKey,
  });
  const api = new DataMgmtApiStack(app, 'Test-DataMgmtApiStack', {
    stage: { stageName: 'Test' },
    landingBucket: ingestion.landingBucket,
    ingestionEncryptionKey: ingestion.encryptionKey,
    processedBucket: processing.processedBucket,
    processingEncryptionKey: processing.encryptionKey,
    documentTable: processing.documentTable,
    classificationConfigTable: processing.classificationConfigTable,
    userPool: auth.userPool,
    userPoolClient: auth.userPoolClient,
  });
  return { api, template: Template.fromStack(api) };
};

describe('API Gateway', () => {
  test('HTTP API exists with CORS', () => {
    const { template } = createStacks();
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      ProtocolType: 'HTTP',
      CorsConfiguration: Match.objectLike({
        AllowMethods: Match.anyValue(),
        AllowHeaders: Match.arrayWith(['Authorization', 'Content-Type']),
      }),
    });
  });

  test('has 7 routes (5 paths, some with multiple methods)', () => {
    const { template } = createStacks();
    template.resourceCountIs('AWS::ApiGatewayV2::Route', 7);
  });

  test('all routes have an authorizer', () => {
    const { template } = createStacks();
    const routes = template.findResources('AWS::ApiGatewayV2::Route');
    const allAuthorized = Object.values(routes).every(
      (r: any) => r.Properties.AuthorizationType === 'JWT',
    );
    expect(allAuthorized).toBe(true);
  });
});

describe('Upload Lambda', () => {
  test('exists with correct environment variables', () => {
    const { template } = createStacks();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs20.x',
      Environment: {
        Variables: Match.objectLike({
          LANDING_BUCKET: Match.anyValue(),
        }),
      },
    });
  });
});

describe('Documents Lambda', () => {
  test('exists with correct environment variables', () => {
    const { template } = createStacks();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs20.x',
      Environment: {
        Variables: Match.objectLike({
          DOCUMENT_TABLE: Match.anyValue(),
          PROCESSED_BUCKET: Match.anyValue(),
        }),
      },
    });
  });
});

describe('Classifications Lambda', () => {
  test('exists with correct environment variables', () => {
    const { template } = createStacks();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs20.x',
      Environment: {
        Variables: Match.objectLike({
          CLASSIFICATION_TABLE: Match.anyValue(),
        }),
      },
    });
  });
});

describe('Lambda Functions', () => {
  test('creates exactly 3 Lambda functions', () => {
    const { template } = createStacks();
    template.resourceCountIs('AWS::Lambda::Function', 3);
  });

  test('all Lambdas use Node.js 20', () => {
    const { template } = createStacks();
    const functions = template.findResources('AWS::Lambda::Function');
    const allNode20 = Object.values(functions).every(
      (f: any) => f.Properties.Runtime === 'nodejs20.x',
    );
    expect(allNode20).toBe(true);
  });
});

describe('CfnOutputs', () => {
  test('exports API URL', () => {
    const { template } = createStacks();
    template.hasOutput('ApiUrl', { Value: Match.anyValue() });
  });
});
