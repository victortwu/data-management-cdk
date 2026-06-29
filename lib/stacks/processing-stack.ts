import * as cdk from 'aws-cdk-lib'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as sqs from 'aws-cdk-lib/aws-sqs'
import * as kms from 'aws-cdk-lib/aws-kms'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import * as events from 'aws-cdk-lib/aws-events'
import * as targets from 'aws-cdk-lib/aws-events-targets'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs'
import * as lambdaBase from 'aws-cdk-lib/aws-lambda'
import * as sqsSources from 'aws-cdk-lib/aws-lambda-event-sources'
import { Construct } from 'constructs'
import { StageConfig } from '../../config'
import * as path from 'path'

export interface ProcessingStackProps extends cdk.StackProps {
  stage: StageConfig
}

export class DataMgmtProcessingStack extends cdk.Stack {
  public readonly processedBucket: s3.Bucket
  public readonly glacierBucket: s3.Bucket
  public readonly documentTable: dynamodb.Table
  public readonly configTable: dynamodb.Table
  public readonly encryptionKey: kms.Key

  constructor(scope: Construct, id: string, props: ProcessingStackProps) {
    super(scope, id, props)

    const prefix = `/${props.stage.stageName}/datamgmt`

    // Import ingestion resources via SSM
    const landingBucketArn = ssm.StringParameter.valueForStringParameter(
      this, `${prefix}/landing-bucket-arn`,
    )
    const landingBucketName = ssm.StringParameter.valueForStringParameter(
      this, `${prefix}/landing-bucket-name`,
    )
    const ingestionKeyArn = ssm.StringParameter.valueForStringParameter(
      this, `${prefix}/ingestion-key-arn`,
    )
    const ingestionQueueArn = ssm.StringParameter.valueForStringParameter(
      this, `${prefix}/ingestion-queue-arn`,
    )

    const landingBucket = s3.Bucket.fromBucketAttributes(this, 'LandingBucket', {
      bucketArn: landingBucketArn,
      bucketName: landingBucketName,
    })
    const ingestionKey = kms.Key.fromKeyArn(this, 'IngestionKey', ingestionKeyArn)
    const ingestionQueue = sqs.Queue.fromQueueArn(this, 'IngestionQueue', ingestionQueueArn)

    // Encryption key
    this.encryptionKey = new kms.Key(this, 'ProcessingKey', {
      enableKeyRotation: true,
      description: `Processing stack encryption key (${props.stage.stageName})`,
      alias: `processing-${props.stage.stageName.toLowerCase()}`,
    })

    this.encryptionKey.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('events.amazonaws.com')],
        actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
        resources: ['*'],
      }),
    )

    // Processed bucket
    this.processedBucket = new s3.Bucket(this, 'ProcessedBucket', {
      versioned: true,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET],
          allowedOrigins: ['http://localhost:5173', 'https://app.datamanager.io', 'https://d3nkbx63md9n7v.cloudfront.net', 'https://d2cbycn7nzfhsx.cloudfront.net'],
          allowedHeaders: ['*'],
          maxAge: 3600,
        },
      ],
    })

    // Glacier bucket
    this.glacierBucket = new s3.Bucket(this, 'GlacierBucket', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL,
              transitionAfter: cdk.Duration.days(0),
            },
          ],
        },
      ],
    })

    // Archive queue
    const archiveDlq = new sqs.Queue(this, 'ArchiveDlq', {
      retentionPeriod: cdk.Duration.days(14),
      encryptionMasterKey: this.encryptionKey,
    })

    const archiveQueue = new sqs.Queue(this, 'ArchiveQueue', {
      visibilityTimeout: cdk.Duration.seconds(300),
      encryptionMasterKey: this.encryptionKey,
      deadLetterQueue: { queue: archiveDlq, maxReceiveCount: 3 },
    })

    new events.Rule(this, 'S3ObjectCreatedArchiveRule', {
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: { bucket: { name: [landingBucketName] } },
      },
      targets: [new targets.SqsQueue(archiveQueue)],
    })

    // Document metadata table (multi-tenant: PK=tenantId, SK=documentId)
    this.documentTable = new dynamodb.Table(this, 'DocumentMetadata', {
      partitionKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'documentId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.encryptionKey,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })

    this.documentTable.addGlobalSecondaryIndex({
      indexName: 'ByType',
      partitionKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'typeDate', type: dynamodb.AttributeType.STRING },
    })

    this.documentTable.addGlobalSecondaryIndex({
      indexName: 'ByVendor',
      partitionKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'vendorDate', type: dynamodb.AttributeType.STRING },
    })

    this.documentTable.addGlobalSecondaryIndex({
      indexName: 'ByStatus',
      partitionKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'statusDate', type: dynamodb.AttributeType.STRING },
    })

    // Config table (multi-tenant: PK=tenantId, SK=configKey)
    this.configTable = new dynamodb.Table(this, 'ConfigTable', {
      partitionKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.encryptionKey,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })

    // Archive Lambda
    const archiveLambda = new lambda.NodejsFunction(this, 'ArchiveLambda', {
      entry: path.join(__dirname, '..', '..', 'lambdas', 'archive', 'index.ts'),
      handler: 'handler',
      runtime: lambdaBase.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(60),
      environment: {
        GLACIER_BUCKET: this.glacierBucket.bucketName,
      },
    })

    landingBucket.grantRead(archiveLambda)
    this.glacierBucket.grantWrite(archiveLambda)
    ingestionKey.grantDecrypt(archiveLambda)
    archiveLambda.addEventSource(new sqsSources.SqsEventSource(archiveQueue))

    // Processing Lambda
    const processingLambda = new lambda.NodejsFunction(this, 'ProcessingLambda', {
      entry: path.join(__dirname, '..', '..', 'lambdas', 'processing', 'index.ts'),
      handler: 'handler',
      runtime: lambdaBase.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      tracing: lambdaBase.Tracing.ACTIVE,
      environment: {
        PROCESSED_BUCKET: this.processedBucket.bucketName,
        DOCUMENT_TABLE: this.documentTable.tableName,
        CONFIG_TABLE: this.configTable.tableName,
        LLM_PROVIDER: 'bedrock',
        LLM_MODEL_ID: 'us.amazon.nova-lite-v1:0',
      },
    })

    landingBucket.grantRead(processingLambda)
    this.processedBucket.grantReadWrite(processingLambda)
    this.documentTable.grantReadWriteData(processingLambda)
    this.configTable.grantReadData(processingLambda)
    ingestionKey.grantDecrypt(processingLambda)

    processingLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'textract:DetectDocumentText',
          'textract:StartDocumentTextDetection',
          'textract:GetDocumentTextDetection',
        ],
        resources: ['*'],
      }),
    )

    processingLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: ['*'],
      }),
    )

    processingLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['events:PutEvents'],
        resources: [
          `arn:aws:events:${this.region}:${this.account}:event-bus/default`,
        ],
      }),
    )

    processingLambda.addEventSource(new sqsSources.SqsEventSource(ingestionQueue))

    // SSM Parameters for cross-stack references
    new ssm.StringParameter(this, 'ProcessedBucketNameParam', {
      parameterName: `${prefix}/processed-bucket-name`,
      stringValue: this.processedBucket.bucketName,
    })
    new ssm.StringParameter(this, 'ProcessedBucketArnParam', {
      parameterName: `${prefix}/processed-bucket-arn`,
      stringValue: this.processedBucket.bucketArn,
    })
    new ssm.StringParameter(this, 'ProcessingKeyArnParam', {
      parameterName: `${prefix}/processing-key-arn`,
      stringValue: this.encryptionKey.keyArn,
    })
    new ssm.StringParameter(this, 'DocumentTableNameParam', {
      parameterName: `${prefix}/document-table-name`,
      stringValue: this.documentTable.tableName,
    })
    new ssm.StringParameter(this, 'DocumentTableArnParam', {
      parameterName: `${prefix}/document-table-arn`,
      stringValue: this.documentTable.tableArn,
    })
    new ssm.StringParameter(this, 'ConfigTableNameParam', {
      parameterName: `${prefix}/config-table-name`,
      stringValue: this.configTable.tableName,
    })
    new ssm.StringParameter(this, 'ConfigTableArnParam', {
      parameterName: `${prefix}/config-table-arn`,
      stringValue: this.configTable.tableArn,
    })
  }
}
