import * as cdk from 'aws-cdk-lib'
import { Template, Match } from 'aws-cdk-lib/assertions'
import { DataMgmtIngestionStack } from '../lib/stacks/ingestion-stack'
import { DataMgmtProcessingStack } from '../lib/stacks/processing-stack'
import { DataMgmtApiStack } from '../lib/stacks/api-stack'
import { DataMgmtAuthStack } from '../lib/stacks/auth-stack'

const createStacks = () => {
  const app = new cdk.App()
  const auth = new DataMgmtAuthStack(app, 'Test-DataMgmtAuthStack', { stage: { stageName: 'Test' } })
  const ingestion = new DataMgmtIngestionStack(app, 'Test-DataMgmtIngestionStack', { stage: { stageName: 'Test' } })
  const processing = new DataMgmtProcessingStack(app, 'Test-DataMgmtProcessingStack', { stage: { stageName: 'Test' } })
  const api = new DataMgmtApiStack(app, 'Test-DataMgmtApiStack', { stage: { stageName: 'Test' } })
  processing.addDependency(ingestion)
  api.addDependency(auth)
  api.addDependency(ingestion)
  api.addDependency(processing)
  return { api, template: Template.fromStack(api) }
}

describe('Single-doc reprocess (Parsely #2)', () => {
  test('new route POST /documents/{id}/reprocess exists with JWT authorizer', () => {
    const { template } = createStacks()
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /documents/{id}/reprocess',
      AuthorizationType: 'JWT',
    })
  })

  test('existing bulk route POST /documents/reprocess is UNCHANGED (backwards-compat)', () => {
    const { template } = createStacks()
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /documents/reprocess',
      AuthorizationType: 'JWT',
    })
  })

  test('documents Lambda role has scoped events:PutEvents on the default bus (NOT *)', () => {
    const { template } = createStacks()
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'events:PutEvents',
            Effect: 'Allow',
            // Scoped to the default event bus ARN — must not be '*'.
            Resource: {
              'Fn::Join': Match.arrayWith([
                Match.arrayWith([
                  Match.stringLikeRegexp('^arn:aws:events:'),
                  Match.stringLikeRegexp(':event-bus/default$'),
                ]),
              ]),
            },
          }),
        ]),
      }),
    })
  })

  test('exactly one events:PutEvents statement exists in the api stack (no over-grant)', () => {
    const { template } = createStacks()
    const policies = template.findResources('AWS::IAM::Policy')
    const putEventsStatements = Object.values(policies).flatMap((p: any) =>
      (p.Properties.PolicyDocument.Statement as any[]).filter(
        (s) => s.Action === 'events:PutEvents' || (Array.isArray(s.Action) && s.Action.includes('events:PutEvents')),
      ),
    )
    expect(putEventsStatements).toHaveLength(1)
    // The single grant must be scoped (object with Fn::Join), never the string '*'.
    expect(putEventsStatements[0].Resource).not.toBe('*')
  })
})
