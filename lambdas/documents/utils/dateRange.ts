export const dateRangeExpr = (qs: Record<string, string | undefined>, sortKey: string): string => {
  if (qs.startDate && qs.endDate) return ` AND ${sortKey} BETWEEN :start AND :end`
  if (qs.startDate) return ` AND ${sortKey} >= :start`
  if (qs.endDate) return ` AND ${sortKey} <= :end`
  return ''
}

export const dateRangeValues = (qs: Record<string, string | undefined>): Record<string, string> => {
  const vals: Record<string, string> = {}
  if (qs.startDate) vals[':start'] = qs.startDate
  if (qs.endDate) vals[':end'] = qs.endDate
  return vals
}
