import * as cdk from 'aws-cdk-lib'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as kms from 'aws-cdk-lib/aws-kms'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as cognito from 'aws-cdk-lib/aws-cognito'
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
  landingBucket: s3.Bucket
  ingestionEncryptionKey: kms.Key
  processedBucket: s3.Bucket
  processingEncryptionKey: kms.Key
  documentTable: dynamodb.Table
  configTable: dynamodb.Table
  userPool: cognito.UserPool
  userPoolClient: cognito.UserPoolClient
  /** @deprecated kept for migration — remove after deploy */
  classificationConfigTable?: dynamodb.Table
  /** @deprecated kept for migration — remove after deploy */
  vendorConfigTable?: dynamodb.Table
}

export class DataMgmtApiStack extends cdk.Stack {
  public readonly api: apigwv2.HttpApi

  constructor(scope: Construct, id: string, props: DataMgmtApiStackProps) {
    super(scope, id, props)

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

    const authorizer = new apigwv2Auth.HttpJwtAuthorizer(
      'CognitoAuthorizer',
      props.userPool.userPoolProviderUrl,
      { jwtAudience: [props.userPoolClient.userPoolClientId] },
    )

    // Upload Lambda
    const uploadLambda = new lambda.NodejsFunction(this, 'UploadLambda', {
      entry: path.join(__dirname, '..', '..', 'lambdas', 'upload', 'index.ts'),
      handler: 'handler',
      runtime: lambdaBase.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      environment: { LANDING_BUCKET: props.landingBucket.bucketName },
    })
    props.landingBucket.grantPut(uploadLambda)
    props.ingestionEncryptionKey.grantEncrypt(uploadLambda)

    // Documents Lambda
    const documentsLambda = new lambda.NodejsFunction(this, 'DocumentsLambda', {
      entry: path.join(__dirname, '..', '..', 'lambdas', 'documents', 'index.ts'),
      handler: 'handler',
      runtime: lambdaBase.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(60),
      environment: {
        DOCUMENT_TABLE: props.documentTable.tableName,
        PROCESSED_BUCKET: props.processedBucket.bucketName,
        CONFIG_TABLE: props.configTable.tableName,
      },
    })
    props.documentTable.grantReadWriteData(documentsLambda)
    props.processedBucket.grantRead(documentsLambda)
    props.configTable.grantReadData(documentsLambda)
    props.processingEncryptionKey.grantDecrypt(documentsLambda)

    // Classifications Lambda (operates on config table TYPE# items)
    const classificationsLambda = new lambda.NodejsFunction(this, 'ClassificationsLambda', {
      entry: path.join(__dirname, '..', '..', 'lambdas', 'classifications', 'index.ts'),
      handler: 'handler',
      runtime: lambdaBase.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      environment: { CONFIG_TABLE: props.configTable.tableName },
    })
    props.configTable.grantReadWriteData(classificationsLambda)
    props.processingEncryptionKey.grantDecrypt(classificationsLambda)

    // Vendors Lambda (operates on config table VENDOR# items)
    const vendorsLambda = new lambda.NodejsFunction(this, 'VendorsLambda', {
      entry: path.join(__dirname, '..', '..', 'lambdas', 'vendors', 'index.ts'),
      handler: 'handler',
      runtime: lambdaBase.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      environment: { CONFIG_TABLE: props.configTable.tableName },
    })
    props.configTable.grantReadWriteData(vendorsLambda)
    props.processingEncryptionKey.grantDecrypt(vendorsLambda)

    // Routes
    const uploadIntegration = new apigwv2Int.HttpLambdaIntegration('UploadInt', uploadLambda)
    const documentsIntegration = new apigwv2Int.HttpLambdaIntegration(
      'DocumentsInt',
      documentsLambda,
    )
    const classificationsIntegration = new apigwv2Int.HttpLambdaIntegration(
      'ClassificationsInt',
      classificationsLambda,
    )
    const vendorsIntegration = new apigwv2Int.HttpLambdaIntegration('VendorsInt', vendorsLambda)

    this.api.addRoutes({
      path: '/upload',
      methods: [apigwv2.HttpMethod.POST],
      integration: uploadIntegration,
      authorizer,
    })
    this.api.addRoutes({
      path: '/documents',
      methods: [apigwv2.HttpMethod.GET],
      integration: documentsIntegration,
      authorizer,
    })
    this.api.addRoutes({
      path: '/documents/reprocess',
      methods: [apigwv2.HttpMethod.POST],
      integration: documentsIntegration,
      authorizer,
    })
    this.api.addRoutes({
      path: '/documents/{id}',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PATCH],
      integration: documentsIntegration,
      authorizer,
    })
    this.api.addRoutes({
      path: '/classifications',
      methods: [apigwv2.HttpMethod.GET],
      integration: classificationsIntegration,
      authorizer,
    })
    this.api.addRoutes({
      path: '/classifications/stats',
      methods: [apigwv2.HttpMethod.GET],
      integration: documentsIntegration,
      authorizer,
    })
    this.api.addRoutes({
      path: '/classifications/{documentType}',
      methods: [apigwv2.HttpMethod.PUT, apigwv2.HttpMethod.DELETE],
      integration: classificationsIntegration,
      authorizer,
    })
    this.api.addRoutes({
      path: '/vendors',
      methods: [apigwv2.HttpMethod.GET],
      integration: vendorsIntegration,
      authorizer,
    })
    this.api.addRoutes({
      path: '/vendors/{vendorId}',
      methods: [apigwv2.HttpMethod.PUT, apigwv2.HttpMethod.DELETE],
      integration: vendorsIntegration,
      authorizer,
    })

    new cdk.CfnOutput(this, 'ApiUrl', { value: this.api.apiEndpoint })

    // Legacy — keep cross-stack imports alive during migration (remove after next deploy)
    if (props.classificationConfigTable) {
      props.classificationConfigTable.grantReadData(classificationsLambda)
      new cdk.CfnOutput(this, 'LegacyClassificationTableName', {
        value: props.classificationConfigTable.tableName,
      })
    }
    if (props.vendorConfigTable) {
      props.vendorConfigTable.grantReadData(vendorsLambda)
      new cdk.CfnOutput(this, 'LegacyVendorTableName', {
        value: props.vendorConfigTable.tableName,
      })
    }
  }
}
