import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, BatchWriteCommand } from '@aws-sdk/lib-dynamodb'
import {
  CognitoIdentityProviderClient,
  AdminUpdateUserAttributesCommand,
} from '@aws-sdk/client-cognito-identity-provider'
import { PostConfirmationTriggerHandler } from 'aws-lambda'
import { randomUUID } from 'crypto'
import { DEFAULT_CONFIG } from './constants/defaultConfig'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const cognito = new CognitoIdentityProviderClient({})
const CONFIG_TABLE = process.env.CONFIG_TABLE!

export const handler: PostConfirmationTriggerHandler = async (event) => {
  const tenantId = `t_${randomUUID().slice(0, 8)}`
  const userId = event.request.userAttributes.sub

  // Write tenant record + default config
  const items = [
    {
      tenantId,
      sk: 'TENANT#meta',
      plan: 'free',
      documentsThisMonth: 0,
      monthlyLimit: 50,
      maxUsers: 1,
      createdAt: new Date().toISOString(),
      ownerUserId: userId,
    },
    ...DEFAULT_CONFIG.map((item) => ({ tenantId, ...item })),
  ]

  // BatchWrite in chunks of 25
  for (let i = 0; i < items.length; i += 25) {
    const batch = items.slice(i, i + 25)
    await ddb.send(
      new BatchWriteCommand({
        RequestItems: {
          [CONFIG_TABLE]: batch.map((item) => ({ PutRequest: { Item: item } })),
        },
      }),
    )
  }

  // Set tenantId on the Cognito user
  await cognito.send(
    new AdminUpdateUserAttributesCommand({
      UserPoolId: event.userPoolId,
      Username: event.userName,
      UserAttributes: [{ Name: 'custom:tenantId', Value: tenantId }],
    }),
  )

  return event
}
