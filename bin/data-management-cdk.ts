#!/usr/bin/env node
import 'source-map-support/register'
import * as cdk from 'aws-cdk-lib'
import { DataMgmtIngestionStack } from '../lib/ingestion-stack'
import { DataMgmtProcessingStack } from '../lib/processing-stack'
import { DataMgmtApiStack } from '../lib/api-stack'
import { DataMgmtAuthStack } from '../lib/auth-stack'
import { stages } from '../lib/config'

const app = new cdk.App()

for (const stage of stages) {
  const auth = new DataMgmtAuthStack(app, `${stage.stageName}-DataMgmtAuthStack`, { stage })
  const ingestion = new DataMgmtIngestionStack(app, `${stage.stageName}-DataMgmtIngestionStack`, {
    stage,
  })
  const processing = new DataMgmtProcessingStack(
    app,
    `${stage.stageName}-DataMgmtProcessingStack`,
    {
      stage,
      landingBucket: ingestion.landingBucket,
      ingestionQueue: ingestion.ingestionQueue,
      ingestionEncryptionKey: ingestion.encryptionKey,
    },
  )
  new DataMgmtApiStack(app, `${stage.stageName}-DataMgmtApiStack`, {
    stage,
    landingBucket: ingestion.landingBucket,
    ingestionEncryptionKey: ingestion.encryptionKey,
    processedBucket: processing.processedBucket,
    processingEncryptionKey: processing.encryptionKey,
    documentTable: processing.documentTable,
    configTable: processing.configTable,
    classificationConfigTable: processing.classificationConfigTable,
    vendorConfigTable: processing.vendorConfigTable,
    userPool: auth.userPool,
    userPoolClient: auth.userPoolClient,
  })
}
