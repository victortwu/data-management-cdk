const FILE_TYPE_MAP: Record<string, string> = {
  pdf: 'pdf',
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  tiff: 'image',
  tif: 'image',
  xlsx: 'excel',
  xls: 'excel',
  csv: 'csv',
  eml: 'email',
}

export const detectFileType = (key: string): string => {
  const ext = key.split('.').pop()?.toLowerCase() ?? ''
  return FILE_TYPE_MAP[ext] ?? 'email'
}
