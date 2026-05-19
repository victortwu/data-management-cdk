import * as cdk from 'aws-cdk-lib'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as sqs from 'aws-cdk-lib/aws-sqs'
import * as kms from 'aws-cdk-lib/aws-kms'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as events from 'aws-cdk-lib/aws-events'
import * as targets from 'aws-cdk-lib/aws-events-targets'
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

    this.landingBucket = new s3.Bucket(this, 'LandingBucket', {
      versioned: true,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      eventBridgeEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ expiration: cdk.Duration.days(14) }],
    })

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
        },
      },
      targets: [new targets.SqsQueue(this.ingestionQueue)],
    })
  }
}
