export type DocumentStatus =
  | 'pending'
  | 'processed'
  | 'needs_review'
  | 'action_required'
  | 'archived'

export interface DocumentRecord {
  documentId: string
  status: DocumentStatus
  reviewReason?: string
  fileType: string
  source: string
  uploadedAt: string
  originalUri: string
  convertedPdfUri?: string
  extractedTextUri?: string
  documentDate?: string
  documentType?: string
  subType?: string
  vendorName?: string
  vendorDisplay?: string
  contactName?: string
  amounts?: string[]
  description?: string
  tags?: string[]
  confidence?: 'high' | 'medium' | 'low'
  sourceEmailId?: string
}

export interface BedrockAnalysisResult {
  documentType: string
  subType?: string
  vendorName?: string
  documentDate?: string
  contactName?: string
  amounts?: string[]
  description?: string
  confidence: 'high' | 'medium' | 'low'
  flagReason?: string
}

export interface ConfigItem {
  pk: string // TYPE#financial, VENDOR#irs, STATUS#processed
  label: string
  subTypes?: Record<string, string[]>
  aliases?: string[]
  description?: string
}
