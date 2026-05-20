import * as cdk from 'aws-cdk-lib'
import * as cognito from 'aws-cdk-lib/aws-cognito'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs'
import * as lambdaBase from 'aws-cdk-lib/aws-lambda'
import * as iam from 'aws-cdk-lib/aws-iam'
import { Construct } from 'constructs'
import { StageConfig } from '../../config'
import * as path from 'path'

export interface DataMgmtAuthStackProps extends cdk.StackProps {
  stage: StageConfig
}

export class DataMgmtAuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool
  public readonly userPoolClient: cognito.UserPoolClient

  constructor(scope: Construct, id: string, props: DataMgmtAuthStackProps) {
    super(scope, id, props)

    const prefix = `/${props.stage.stageName}/datamgmt`

    // Config table ARN (written by processing stack — may not exist on first deploy)
    const configTableName = ssm.StringParameter.valueForStringParameter(
      this, `${prefix}/config-table-name`,
    )
    const configTableArn = ssm.StringParameter.valueForStringParameter(
      this, `${prefix}/config-table-arn`,
    )

    // Post-confirmation Lambda
    const postConfirmationLambda = new lambda.NodejsFunction(this, 'PostConfirmationLambda', {
      entry: path.join(__dirname, '..', '..', 'lambdas', 'post-confirmation', 'index.ts'),
      handler: 'handler',
      runtime: lambdaBase.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      environment: { CONFIG_TABLE: configTableName },
    })

    // Grant DynamoDB write access
    postConfirmationLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:BatchWriteItem', 'dynamodb:PutItem'],
        resources: [configTableArn],
      }),
    )

    // User Pool
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${props.stage.stageName}-DataMgmt-UserPool`,
      selfSignUpEnabled: props.stage.selfSignUp ?? false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 8,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      customAttributes: {
        tenantId: new cognito.StringAttribute({ mutable: true }),
      },
      lambdaTriggers: {
        postConfirmation: postConfirmationLambda,
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })

    // Grant Cognito admin access for setting custom attributes (use * to avoid circular dep with UserPool)
    postConfirmationLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:AdminUpdateUserAttributes'],
        resources: [`arn:aws:cognito-idp:${this.region}:${this.account}:userpool/*`],
      }),
    )

    const clientReadAttributes = new cognito.ClientAttributes()
      .withStandardAttributes({ email: true, emailVerified: true })
      .withCustomAttributes('tenantId')

    this.userPoolClient = this.userPool.addClient('WebClient', {
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      readAttributes: clientReadAttributes,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: ['http://localhost:5173/', 'https://app.datamanager.io/'],
        logoutUrls: ['http://localhost:5173/', 'https://app.datamanager.io/'],
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
    })

    // SSM Parameters
    new ssm.StringParameter(this, 'UserPoolIdParam', {
      parameterName: `${prefix}/user-pool-id`,
      stringValue: this.userPool.userPoolId,
    })
    new ssm.StringParameter(this, 'UserPoolClientIdParam', {
      parameterName: `${prefix}/user-pool-client-id`,
      stringValue: this.userPoolClient.userPoolClientId,
    })
    new ssm.StringParameter(this, 'UserPoolArnParam', {
      parameterName: `${prefix}/user-pool-arn`,
      stringValue: this.userPool.userPoolArn,
    })

    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId })
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId })
  }
}
