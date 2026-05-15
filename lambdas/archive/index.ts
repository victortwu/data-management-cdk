import { S3Client, CopyObjectCommand } from '@aws-sdk/client-s3'
import { SQSHandler } from 'aws-lambda'

const s3 = new S3Client({})
const GLACIER_BUCKET = process.env.GLACIER_BUCKET!

export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    const body = JSON.parse(record.body)
    const bucket = body.detail.bucket.name
    const key = body.detail.object.key

    await s3.send(
      new CopyObjectCommand({
        CopySource: `${bucket}/${key}`,
        Bucket: GLACIER_BUCKET,
        Key: key,
      }),
    )
  }
}
