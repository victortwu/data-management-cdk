import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda'

export interface TenantContext {
  tenantId: string
  userId: string
}

// Maps machine client_ids to their tenantId.
// Client credentials tokens have no user claims — resolve tenant from this map.
// Add entries when provisioning new machine clients.
const MACHINE_CLIENT_TENANT_MAP: Record<string, string> = {
  // Populated via env var at runtime to avoid hardcoding across stages
}

const getMachineClientMap = (): Record<string, string> => {
  if (Object.keys(MACHINE_CLIENT_TENANT_MAP).length > 0) return MACHINE_CLIENT_TENANT_MAP
  const raw = process.env.MACHINE_CLIENT_TENANT_MAP
  if (raw) {
    try {
      Object.assign(MACHINE_CLIENT_TENANT_MAP, JSON.parse(raw))
    } catch { /* ignore parse errors */ }
  }
  return MACHINE_CLIENT_TENANT_MAP
}

export const extractTenantContext = (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): TenantContext => {
  const claims = event.requestContext.authorizer.jwt.claims

  // Browser tokens have custom:tenantId and sub
  const tenantId = claims['custom:tenantId'] as string | undefined
  const userId = claims.sub as string | undefined

  if (tenantId && userId) {
    return { tenantId, userId }
  }

  // Client credentials tokens have client_id but no sub/tenantId
  const clientId = claims.client_id as string | undefined
  if (clientId) {
    const map = getMachineClientMap()
    const mappedTenantId = map[clientId]
    if (mappedTenantId) {
      return { tenantId: mappedTenantId, userId: `machine:${clientId}` }
    }
  }

  throw new Error('Missing tenantId in JWT claims')
}
