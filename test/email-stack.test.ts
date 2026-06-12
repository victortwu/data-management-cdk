import * as cdk from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { DataMgmtEmailStack } from '../lib/stacks/email-stack'

describe('DataMgmtEmailStack', () => {
  const app = new cdk.App()
  const stack = new DataMgmtEmailStack(app, 'Test-DataMgmtEmailStack', {
    stage: { stageName: 'Beta' },
    landingBucketName: 'test-landing-bucket',
    ingestEmailAddress: 'ingest@eatbdk.com',
    env: { account: '653102291240', region: 'us-east-1' },
  })
  const template = Template.fromStack(stack)

  it('creates an SES receipt rule set', () => {
    template.hasResourceProperties('AWS::SES::ReceiptRuleSet', {
      RuleSetName: 'datamgmt-ingest-beta',
    })
  })

  it('creates a receipt rule with the ingest email address', () => {
    template.hasResourceProperties('AWS::SES::ReceiptRule', {
      Rule: {
        Enabled: true,
        Recipients: ['ingest@eatbdk.com'],
        ScanEnabled: true,
        Actions: [
          {
            S3Action: {
              BucketName: 'test-landing-bucket',
              ObjectKeyPrefix: 'emails/',
            },
          },
        ],
      },
    })
  })
})
