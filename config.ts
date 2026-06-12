export interface StageConfig {
  stageName: string
  selfSignUp?: boolean
  env?: { account: string; region: string }
}

export interface EmailConfig {
  ingestEmailAddress: string
  landingBucketName: string
}

export const stages: StageConfig[] = [
  { stageName: 'Beta' },
  { stageName: 'Gamma', selfSignUp: true },
  { stageName: 'Prod', selfSignUp: true },
]

export const emailConfig: Record<string, EmailConfig> = {
  Beta: {
    ingestEmailAddress: 'ingest@eatbdk.com',
    landingBucketName: 'beta-datamgmtingestionstack-landingbucket23fe90fb-gyxw2zx8ddd5',
  },
}
