export interface StageConfig {
  stageName: string;
}

export const stages: StageConfig[] = [
  { stageName: 'Beta' },
  { stageName: 'Prod' },
];
