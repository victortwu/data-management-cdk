import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda'

export interface TenantContext {
  tenantId: string
  userId: string
}

export const extractTenantContext = (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): TenantContext => {
  const claims = event.requestContext.authorizer.jwt.claims
  const tenantId = (claims['custom:tenantId'] as string) ?? (claims.sub as string)
  const userId = claims.sub as string
  if (!tenantId) throw new Error('Missing tenantId in JWT claims')
  return { tenantId, userId }
}
