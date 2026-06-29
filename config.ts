export interface StageConfig {
  stageName: string
  selfSignUp?: boolean
  machineClientTenantId?: string
  env?: { account: string; region: string }
}

export interface EmailConfig {
  ingestEmailAddress: string
  landingBucketName: string
}

export const stages: StageConfig[] = [
  { stageName: 'Beta', machineClientTenantId: 'a29f58f2-8459-4575-bbc2-44b68b050b64' },
  { stageName: 'Gamma', selfSignUp: true },
  { stageName: 'Prod', selfSignUp: false, machineClientTenantId: 'ea1cc884-de90-48eb-8236-136574aafe35', env: { account: '639914975031', region: 'us-west-2' } },
]

export const emailConfig: Record<string, EmailConfig> = {
  Beta: {
    ingestEmailAddress: 'ingest@eatbdk.com',
    landingBucketName: 'beta-datamgmtingestionstack-landingbucket23fe90fb-gyxw2zx8ddd5',
  },
}
