import * as cdk from 'aws-cdk-lib'
import { Template, Match } from 'aws-cdk-lib/assertions'
import { DataMgmtAuthStack } from '../lib/stacks/auth-stack'

const createStack = (stageName = 'Beta') => {
  const app = new cdk.App()
  const stack = new DataMgmtAuthStack(app, `${stageName}-DataMgmtAuthStack`, {
    stage: { stageName },
  })
  return { stack, template: Template.fromStack(stack) }
}

describe('Cognito User Pool', () => {
  test('exists with email sign-in', () => {
    const { template } = createStack()
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UsernameAttributes: ['email'],
    })
  })

  test('has strong password policy', () => {
    const { template } = createStack()
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      Policies: {
        PasswordPolicy: Match.objectLike({
          MinimumLength: 8,
          RequireUppercase: true,
          RequireNumbers: true,
          RequireSymbols: true,
        }),
      },
    })
  })

  test('disables self sign-up', () => {
    const { template } = createStack()
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    })
  })

  test('has RETAIN removal policy', () => {
    const { template } = createStack()
    template.hasResource('AWS::Cognito::UserPool', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    })
  })
})

describe('Cognito User Pool Client', () => {
  test('exists', () => {
    const { template } = createStack()
    template.resourceCountIs('AWS::Cognito::UserPoolClient', 1)
  })
})

describe('CfnOutputs', () => {
  test('exports User Pool ID and Client ID', () => {
    const { template } = createStack()
    template.hasOutput('UserPoolId', { Value: Match.anyValue() })
    template.hasOutput('UserPoolClientId', { Value: Match.anyValue() })
  })
})
