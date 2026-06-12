#!/usr/bin/env node
import 'source-map-support/register'
import * as cdk from 'aws-cdk-lib'
import { DataMgmtIngestionStack } from '../lib/stacks/ingestion-stack'
import { DataMgmtProcessingStack } from '../lib/stacks/processing-stack'
import { DataMgmtApiStack } from '../lib/stacks/api-stack'
import { DataMgmtAuthStack } from '../lib/stacks/auth-stack'
import { DataMgmtEmailStack } from '../lib/stacks/email-stack'
import { stages, emailConfig } from '../config'

const app = new cdk.App()

for (const stage of stages) {
  new DataMgmtAuthStack(app, `${stage.stageName}-DataMgmtAuthStack`, { stage })
  new DataMgmtIngestionStack(app, `${stage.stageName}-DataMgmtIngestionStack`, { stage })
  new DataMgmtProcessingStack(app, `${stage.stageName}-DataMgmtProcessingStack`, { stage })
  new DataMgmtApiStack(app, `${stage.stageName}-DataMgmtApiStack`, { stage })

  // Email stack deploys to us-east-1 (SES receiving region)
  const email = emailConfig[stage.stageName]
  if (email) {
    new DataMgmtEmailStack(app, `${stage.stageName}-BDK-DataMgmtEmailStack`, {
      stage,
      landingBucketName: email.landingBucketName,
      ingestEmailAddress: email.ingestEmailAddress,
      env: { account: '653102291240', region: 'us-east-1' },
    })
  }
}
