import * as cdk from 'aws-cdk-lib'
import * as ses from 'aws-cdk-lib/aws-ses'
import * as actions from 'aws-cdk-lib/aws-ses-actions'
import * as s3 from 'aws-cdk-lib/aws-s3'
import { Construct } from 'constructs'
import { StageConfig } from '../../config'

export interface EmailStackProps extends cdk.StackProps {
  stage: StageConfig
  landingBucketName: string
  ingestEmailAddress: string
}

export class DataMgmtEmailStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: EmailStackProps) {
    super(scope, id, props)

    const landingBucket = s3.Bucket.fromBucketName(
      this,
      'LandingBucket',
      props.landingBucketName,
    )

    const receiptRuleSet = new ses.ReceiptRuleSet(this, 'ReceiptRuleSet', {
      receiptRuleSetName: `datamgmt-ingest-${props.stage.stageName.toLowerCase()}`,
    })

    receiptRuleSet.addRule('IngestRule', {
      recipients: [props.ingestEmailAddress],
      scanEnabled: true,
      actions: [
        new actions.S3({
          bucket: landingBucket,
          objectKeyPrefix: 'emails/',
        }),
      ],
    })
  }
}
