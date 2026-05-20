import * as cdk from 'aws-cdk-lib'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as kms from 'aws-cdk-lib/aws-kms'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs'
import * as lambdaBase from 'aws-cdk-lib/aws-lambda'
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2'
import * as apigwv2Auth from 'aws-cdk-lib/aws-apigatewayv2-authorizers'
import * as apigwv2Int from 'aws-cdk-lib/aws-apigatewayv2-integrations'
import { Construct } from 'constructs'
import { StageConfig } from '../../config'
import * as path from 'path'

export interface DataMgmtApiStackProps extends cdk.StackProps {
  stage: StageConfig
}

export class DataMgmtApiStack extends cdk.Stack {
  public readonly api: apigwv2.HttpApi

  constructor(scope: Construct, id: string, props: DataMgmtApiStackProps) {
    super(scope, id, props)

    const prefix = `/${props.stage.stageName}/datamgmt`

    // Import resources via SSM
    const landingBucketName = ssm.StringParameter.valueForStringParameter(this, `${prefix}/landing-bucket-name`)
    const landingBucketArn = ssm.StringParameter.valueForStringParameter(this, `${prefix}/landing-bucket-arn`)
    const ingestionKeyArn = ssm.StringParameter.valueForStringParameter(this, `${prefix}/ingestion-key-arn`)
    const processedBucketName = ssm.StringParameter.valueForStringParameter(this, `${prefix}/processed-bucket-name`)
    const processedBucketArn = ssm.StringParameter.valueForStringParameter(this, `${prefix}/processed-bucket-arn`)
    const processingKeyArn = ssm.StringParameter.valueForStringParameter(this, `${prefix}/processing-key-arn`)
    const documentTableName = ssm.StringParameter.valueForStringParameter(this, `${prefix}/document-table-name`)
    const documentTableArn = ssm.StringParameter.valueForStringParameter(this, `${prefix}/document-table-arn`)
    const configTableName = ssm.StringParameter.valueForStringParameter(this, `${prefix}/config-table-name`)
    const configTableArn = ssm.StringParameter.valueForStringParameter(this, `${prefix}/config-table-arn`)
    const userPoolId = ssm.StringParameter.valueForStringParameter(this, `${prefix}/user-pool-id`)
    const userPoolClientId = ssm.StringParameter.valueForStringParameter(this, `${prefix}/user-pool-client-id`)

    const landingBucket = s3.Bucket.fromBucketAttributes(this, 'LandingBucket', { bucketArn: landingBucketArn, bucketName: landingBucketName })
    const ingestionKey = kms.Key.fromKeyArn(this, 'IngestionKey', ingestionKeyArn)
    const processedBucket = s3.Bucket.fromBucketAttributes(this, 'ProcessedBucket', { bucketArn: processedBucketArn, bucketName: processedBucketName })
    const processingKey = kms.Key.fromKeyArn(this, 'ProcessingKey', processingKeyArn)
    const documentTable = dynamodb.Table.fromTableArn(this, 'DocumentTable', documentTableArn)
    const configTable = dynamodb.Table.fromTableArn(this, 'ConfigTable', configTableArn)

    // API Gateway
    this.api = new apigwv2.HttpApi(this, 'HttpApi', {
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PATCH,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.DELETE,
        ],
        allowHeaders: ['Authorization', 'Content-Type'],
      },
    })

    const issuerUrl = `https://cognito-idp.${cdk.Stack.of(this).region}.amazonaws.com/${userPoolId}`
    const authorizer = new apigwv2Auth.HttpJwtAuthorizer('CognitoAuthorizer', issuerUrl, {
      jwtAudience: [userPoolClientId],
    })

    // Upload Lambda
    const uploadLambda = new lambda.NodejsFunction(this, 'UploadLambda', {
      entry: path.join(__dirname, '..', '..', 'lambdas', 'upload', 'index.ts'),
      handler: 'handler',
      runtime: lambdaBase.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      tracing: lambdaBase.Tracing.ACTIVE,
      environment: {
        LANDING_BUCKET: landingBucketName,
        DOCUMENT_TABLE: documentTableName,
      },
    })
    landingBucket.grantPut(uploadLambda)
    ingestionKey.grantEncrypt(uploadLambda)
    documentTable.grantWriteData(uploadLambda)

    // Documents Lambda
    const documentsLambda = new lambda.NodejsFunction(this, 'DocumentsLambda', {
      entry: path.join(__dirname, '..', '..', 'lambdas', 'documents', 'index.ts'),
      handler: 'handler',
      runtime: lambdaBase.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(60),
      tracing: lambdaBase.Tracing.ACTIVE,
      environment: {
        DOCUMENT_TABLE: documentTableName,
        PROCESSED_BUCKET: processedBucketName,
        CONFIG_TABLE: configTableName,
      },
    })
    documentTable.grantReadWriteData(documentsLambda)
    processedBucket.grantRead(documentsLambda)
    configTable.grantReadData(documentsLambda)
    processingKey.grantDecrypt(documentsLambda)

    // Classifications Lambda
    const classificationsLambda = new lambda.NodejsFunction(this, 'ClassificationsLambda', {
      entry: path.join(__dirname, '..', '..', 'lambdas', 'classifications', 'index.ts'),
      handler: 'handler',
      runtime: lambdaBase.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      tracing: lambdaBase.Tracing.ACTIVE,
      environment: { CONFIG_TABLE: configTableName },
    })
    configTable.grantReadWriteData(classificationsLambda)
    processingKey.grantDecrypt(classificationsLambda)

    // Vendors Lambda
    const vendorsLambda = new lambda.NodejsFunction(this, 'VendorsLambda', {
      entry: path.join(__dirname, '..', '..', 'lambdas', 'vendors', 'index.ts'),
      handler: 'handler',
      runtime: lambdaBase.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      tracing: lambdaBase.Tracing.ACTIVE,
      environment: { CONFIG_TABLE: configTableName },
    })
    configTable.grantReadWriteData(vendorsLambda)
    processingKey.grantDecrypt(vendorsLambda)

    // Routes
    const uploadInt = new apigwv2Int.HttpLambdaIntegration('UploadInt', uploadLambda)
    const docsInt = new apigwv2Int.HttpLambdaIntegration('DocumentsInt', documentsLambda)
    const classInt = new apigwv2Int.HttpLambdaIntegration('ClassificationsInt', classificationsLambda)
    const vendorsInt = new apigwv2Int.HttpLambdaIntegration('VendorsInt', vendorsLambda)

    this.api.addRoutes({ path: '/upload', methods: [apigwv2.HttpMethod.POST], integration: uploadInt, authorizer })
    this.api.addRoutes({ path: '/documents', methods: [apigwv2.HttpMethod.GET], integration: docsInt, authorizer })
    this.api.addRoutes({ path: '/documents/reprocess', methods: [apigwv2.HttpMethod.POST], integration: docsInt, authorizer })
    this.api.addRoutes({ path: '/documents/{id}', methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PATCH], integration: docsInt, authorizer })
    this.api.addRoutes({ path: '/classifications', methods: [apigwv2.HttpMethod.GET], integration: classInt, authorizer })
    this.api.addRoutes({ path: '/classifications/stats', methods: [apigwv2.HttpMethod.GET], integration: docsInt, authorizer })
    this.api.addRoutes({ path: '/classifications/{documentType}', methods: [apigwv2.HttpMethod.PUT, apigwv2.HttpMethod.DELETE], integration: classInt, authorizer })
    this.api.addRoutes({ path: '/vendors', methods: [apigwv2.HttpMethod.GET], integration: vendorsInt, authorizer })
    this.api.addRoutes({ path: '/vendors/{vendorId}', methods: [apigwv2.HttpMethod.PUT, apigwv2.HttpMethod.DELETE], integration: vendorsInt, authorizer })

    new cdk.CfnOutput(this, 'ApiUrl', { value: this.api.apiEndpoint })
  }
}
