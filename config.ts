export interface StageConfig {
  stageName: string
  selfSignUp?: boolean
  env?: { account: string; region: string }
}

export const stages: StageConfig[] = [
  { stageName: 'Beta' },
  { stageName: 'Gamma', selfSignUp: true },
  { stageName: 'Prod', selfSignUp: true },
]
