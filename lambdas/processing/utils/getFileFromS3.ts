import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'

const s3 = new S3Client({})

export const getFileFromS3 = async (bucket: string, key: string): Promise<Buffer> => {
  const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  return Buffer.from(await resp.Body!.transformToByteArray())
}
