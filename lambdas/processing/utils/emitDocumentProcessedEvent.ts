import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge'
import type { DocumentRecord } from '../types'

const eventBridge = new EventBridgeClient({})

export const emitDocumentProcessedEvent = async (
  tenantId: string,
  metadata: DocumentRecord,
) => {
  await eventBridge.send(
    new PutEventsCommand({
      Entries: [
        {
          Source: 'parsely.processing',
          DetailType: 'DocumentProcessed',
          Detail: JSON.stringify({
            tenantId,
            documentId: metadata.documentId,
            documentType: metadata.documentType,
            subType: metadata.subType,
            vendorName: metadata.vendorName,
            vendorDisplay: metadata.vendorDisplay,
            documentDate: metadata.documentDate,
            amounts: metadata.amounts,
            description: metadata.description,
            confidence: metadata.confidence,
            source: metadata.source,
            extractedTextUri: metadata.extractedTextUri,
          }),
        },
      ],
    }),
  )
}
