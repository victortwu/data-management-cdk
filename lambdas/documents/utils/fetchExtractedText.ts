import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { PROCESSED_BUCKET } from '../constants'

const s3 = new S3Client({})

/**
 * Fetch the stored extracted-text object for a document and return it as a string.
 *
 * `uri` is the `s3://{bucket}/{key}` value saved by the processing Lambda
 * (`DocumentRecord.extractedTextUri`). Mirroring the presign utils, the bucket is
 * taken from the `PROCESSED_BUCKET` env var and only the key is derived from the
 * URI — the Lambda is granted read on that one bucket.
 */
export const fetchExtractedText = async (uri: string): Promise<string> => {
  const key = uri.replace(/^s3:\/\/[^/]+\//, '')
  const resp = await s3.send(new GetObjectCommand({ Bucket: PROCESSED_BUCKET, Key: key }))
  return resp.Body!.transformToString()
}
