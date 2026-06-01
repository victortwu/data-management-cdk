import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'

const s3 = new S3Client({})

export interface S3FileResult {
  bytes: Buffer
  metadata: Record<string, string>
}

export const getFileFromS3 = async (bucket: string, key: string): Promise<S3FileResult> => {
  const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  return {
    bytes: Buffer.from(await resp.Body!.transformToByteArray()),
    metadata: resp.Metadata ?? {},
  }
}
