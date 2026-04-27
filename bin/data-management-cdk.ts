#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { IngestionStack } from '../lib/ingestion-stack';
import { ProcessingStack } from '../lib/processing-stack';
import { stages } from '../lib/config';

const app = new cdk.App();

for (const stage of stages) {
  const ingestion = new IngestionStack(app, `IngestionStack-${stage.stageName}`, { stage });
  new ProcessingStack(app, `ProcessingStack-${stage.stageName}`, {
    stage,
    landingBucket: ingestion.landingBucket,
    ingestionQueue: ingestion.ingestionQueue,
  });
}
