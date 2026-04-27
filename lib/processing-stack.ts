import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaBase from 'aws-cdk-lib/aws-lambda';
import * as sqsSources from 'aws-cdk-lib/aws-lambda-event-sources';
import { Construct } from 'constructs';
import { StageConfig } from './config';
import * as path from 'path';

export interface ProcessingStackProps extends cdk.StackProps {
  stage: StageConfig;
  landingBucket: s3.Bucket;
  ingestionQueue: sqs.Queue;
}

export class ProcessingStack extends cdk.Stack {
  public readonly processedBucket: s3.Bucket;
  public readonly glacierBucket: s3.Bucket;
  public readonly archiveQueue: sqs.Queue;
  public readonly archiveDlq: sqs.Queue;
  public readonly documentTable: dynamodb.Table;
  public readonly classificationConfigTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: ProcessingStackProps) {
    super(scope, id, props);

    this.processedBucket = new s3.Bucket(this, 'ProcessedBucket', {
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.glacierBucket = new s3.Bucket(this, 'GlacierBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{
        transitions: [{
          storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL,
          transitionAfter: cdk.Duration.days(0),
        }],
      }],
    });

    this.archiveDlq = new sqs.Queue(this, 'ArchiveDlq', {
      retentionPeriod: cdk.Duration.days(14),
    });

    this.archiveQueue = new sqs.Queue(this, 'ArchiveQueue', {
      visibilityTimeout: cdk.Duration.seconds(300),
      deadLetterQueue: {
        queue: this.archiveDlq,
        maxReceiveCount: 3,
      },
    });

    new events.Rule(this, 'S3ObjectCreatedArchiveRule', {
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: { name: [props.landingBucket.bucketName] },
        },
      },
      targets: [new targets.SqsQueue(this.archiveQueue)],
    });

    this.documentTable = new dynamodb.Table(this, 'DocumentMetadata', {
      partitionKey: { name: 'documentId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.documentTable.addGlobalSecondaryIndex({
      indexName: 'ByType',
      partitionKey: { name: 'documentType', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'documentDate', type: dynamodb.AttributeType.STRING },
    });

    this.documentTable.addGlobalSecondaryIndex({
      indexName: 'ByVendor',
      partitionKey: { name: 'vendorName', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'documentDate', type: dynamodb.AttributeType.STRING },
    });

    this.documentTable.addGlobalSecondaryIndex({
      indexName: 'ByStatus',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'uploadedAt', type: dynamodb.AttributeType.STRING },
    });

    this.classificationConfigTable = new dynamodb.Table(this, 'ClassificationConfig', {
      partitionKey: { name: 'documentType', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const archiveLambda = new lambda.NodejsFunction(this, 'ArchiveLambda', {
      entry: path.join(__dirname, '..', 'lambdas', 'archive', 'index.ts'),
      handler: 'handler',
      runtime: lambdaBase.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(60),
      environment: {
        GLACIER_BUCKET: this.glacierBucket.bucketName,
      },
    });

    props.landingBucket.grantRead(archiveLambda);
    this.glacierBucket.grantWrite(archiveLambda);
    archiveLambda.addEventSource(new sqsSources.SqsEventSource(this.archiveQueue));

    const processingLambda = new lambda.NodejsFunction(this, 'ProcessingLambda', {
      entry: path.join(__dirname, '..', 'lambdas', 'processing', 'index.ts'),
      handler: 'handler',
      runtime: lambdaBase.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment: {
        PROCESSED_BUCKET: this.processedBucket.bucketName,
        DOCUMENT_TABLE: this.documentTable.tableName,
        CLASSIFICATION_TABLE: this.classificationConfigTable.tableName,
      },
    });

    props.landingBucket.grantRead(processingLambda);
    this.processedBucket.grantWrite(processingLambda);
    this.documentTable.grantWriteData(processingLambda);
    this.classificationConfigTable.grantReadData(processingLambda);
    processingLambda.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['textract:DetectDocumentText'],
      resources: ['*'],
    }));
    processingLambda.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['comprehend:DetectEntities'],
      resources: ['*'],
    }));
    processingLambda.addEventSource(new sqsSources.SqsEventSource(props.ingestionQueue));
  }
}
