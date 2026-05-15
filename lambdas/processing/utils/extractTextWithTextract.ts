import {
  TextractClient,
  DetectDocumentTextCommand,
  StartDocumentTextDetectionCommand,
  GetDocumentTextDetectionCommand,
} from '@aws-sdk/client-textract'

const textract = new TextractClient({})

export const extractTextWithTextract = async (
  fileBytes: Buffer,
  s3Bucket?: string,
  s3Key?: string,
): Promise<string> => {
  if (s3Bucket && s3Key) {
    const { JobId } = await textract.send(
      new StartDocumentTextDetectionCommand({
        DocumentLocation: { S3Object: { Bucket: s3Bucket, Name: s3Key } },
      }),
    )

    let status = 'IN_PROGRESS'
    while (status === 'IN_PROGRESS') {
      await new Promise((r) => setTimeout(r, 1000))
      const job = await textract.send(new GetDocumentTextDetectionCommand({ JobId }))
      status = job.JobStatus ?? 'FAILED'
      if (status === 'SUCCEEDED') {
        const lines: string[] = []
        let nextToken = job.NextToken
        for (const block of job.Blocks ?? []) {
          if (block.BlockType === 'LINE') lines.push(block.Text ?? '')
        }
        while (nextToken) {
          const next = await textract.send(
            new GetDocumentTextDetectionCommand({ JobId, NextToken: nextToken }),
          )
          for (const block of next.Blocks ?? []) {
            if (block.BlockType === 'LINE') lines.push(block.Text ?? '')
          }
          nextToken = next.NextToken
        }
        return lines.join('\n')
      }
      if (status === 'FAILED') throw new Error('Textract async job failed')
    }
    return ''
  }

  const resp = await textract.send(
    new DetectDocumentTextCommand({ Document: { Bytes: fileBytes } }),
  )
  return (resp.Blocks ?? [])
    .filter((b) => b.BlockType === 'LINE')
    .map((b) => b.Text)
    .join('\n')
}
