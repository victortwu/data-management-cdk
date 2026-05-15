export const respond = (statusCode: number, body?: Record<string, unknown>) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : '',
})
