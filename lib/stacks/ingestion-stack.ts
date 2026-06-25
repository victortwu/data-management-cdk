import * as cdk from 'aws-cdk-lib'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as sqs from 'aws-cdk-lib/aws-sqs'
import * as kms from 'aws-cdk-lib/aws-kms'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import * as events from 'aws-cdk-lib/aws-events'
import * as targets from 'aws-cdk-lib/aws-events-targets'
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs'
import * as lambdaRuntime from 'aws-cdk-lib/aws-lambda'
import { Construct } from 'constructs'
import { StageConfig } from '../../config'

export interface IngestionStackProps extends cdk.StackProps {
  stage: StageConfig
}

export class DataMgmtIngestionStack extends cdk.Stack {
  public readonly landingBucket: s3.Bucket
  public readonly ingestionQueue: sqs.Queue
  public readonly ingestionDlq: sqs.Queue
  public readonly encryptionKey: kms.Key

  constructor(scope: Construct, id: string, props: IngestionStackProps) {
    super(scope, id, props)

    this.encryptionKey = new kms.Key(this, 'IngestionKey', {
      enableKeyRotation: true,
      description: `Ingestion stack encryption key (${props.stage.stageName})`,
      alias: `ingestion-${props.stage.stageName.toLowerCase()}`,
    })

    // Allow EventBridge to use the key for SQS message delivery
    this.encryptionKey.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('events.amazonaws.com')],
        actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
        resources: ['*'],
      }),
    )

    // Allow SES to use the key for encrypting email objects
    this.encryptionKey.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('ses.amazonaws.com')],
        actions: ['kms:GenerateDataKey', 'kms:Encrypt'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'AWS:SourceAccount': cdk.Stack.of(this).account },
        },
      }),
    )

    this.landingBucket = new s3.Bucket(this, 'LandingBucket', {
      versioned: true,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      eventBridgeEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ expiration: cdk.Duration.days(14) }],
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: ['http://localhost:5173', 'https://app.datamanager.io', 'https://d3nkbx63md9n7v.cloudfront.net', 'https://d2cbycn7nzfhsx.cloudfront.net'],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3600,
        },
      ],
    })

    // Allow SES to write email objects to the landing bucket
    this.landingBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('ses.amazonaws.com')],
        actions: ['s3:PutObject'],
        resources: [this.landingBucket.arnForObjects('emails/*')],
        conditions: {
          StringEquals: { 'AWS:SourceAccount': cdk.Stack.of(this).account },
        },
      }),
    )

    this.ingestionDlq = new sqs.Queue(this, 'IngestionDlq', {
      retentionPeriod: cdk.Duration.days(14),
      encryptionMasterKey: this.encryptionKey,
    })

    this.ingestionQueue = new sqs.Queue(this, 'IngestionQueue', {
      visibilityTimeout: cdk.Duration.seconds(300),
      encryptionMasterKey: this.encryptionKey,
      deadLetterQueue: {
        queue: this.ingestionDlq,
        maxReceiveCount: 3,
      },
    })

    new events.Rule(this, 'S3ObjectCreatedRule', {
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: { name: [this.landingBucket.bucketName] },
          object: { key: [{ prefix: 'uploads/' }] },
        },
      },
      targets: [new targets.SqsQueue(this.ingestionQueue)],
    })

    // Email processing Lambda — parses MIME from emails/ prefix, writes to uploads/
    const emailLambda = new lambda.NodejsFunction(this, 'EmailLambda', {
      entry: 'lambdas/email/index.ts',
      handler: 'handler',
      runtime: lambdaRuntime.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      environment: {
        LANDING_BUCKET: this.landingBucket.bucketName,
        TENANT_ID: props.stage.stageName === 'Beta' ? 'a29f58f2-8459-4575-bbc2-44b68b050b64' : '',
      },
    })

    this.landingBucket.grantRead(emailLambda, 'emails/*')
    this.landingBucket.grantPut(emailLambda, 'uploads/*')

    new events.Rule(this, 'EmailObjectCreatedRule', {
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: { name: [this.landingBucket.bucketName] },
          object: { key: [{ prefix: 'emails/' }] },
        },
      },
      targets: [new targets.LambdaFunction(emailLambda)],
    })

    // SSM Parameters for cross-stack references
    const prefix = `/${props.stage.stageName}/datamgmt`
    new ssm.StringParameter(this, 'LandingBucketNameParam', {
      parameterName: `${prefix}/landing-bucket-name`,
      stringValue: this.landingBucket.bucketName,
    })
    new ssm.StringParameter(this, 'LandingBucketArnParam', {
      parameterName: `${prefix}/landing-bucket-arn`,
      stringValue: this.landingBucket.bucketArn,
    })
    new ssm.StringParameter(this, 'IngestionKeyArnParam', {
      parameterName: `${prefix}/ingestion-key-arn`,
      stringValue: this.encryptionKey.keyArn,
    })
    new ssm.StringParameter(this, 'IngestionQueueArnParam', {
      parameterName: `${prefix}/ingestion-queue-arn`,
      stringValue: this.ingestionQueue.queueArn,
    })
    new ssm.StringParameter(this, 'IngestionQueueUrlParam', {
      parameterName: `${prefix}/ingestion-queue-url`,
      stringValue: this.ingestionQueue.queueUrl,
    })
  }
}
