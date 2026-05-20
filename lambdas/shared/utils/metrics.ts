import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics'

export const metrics = new Metrics({ namespace: 'DataManager', serviceName: 'data-manager' })
export { MetricUnit }
