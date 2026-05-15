import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { PROCESSED_BUCKET, URL_EXPIRY_SECONDS } from '../constants'

const s3 = new S3Client({})

export const presignInline = async (uri: string): Promise<string> => {
  const key = uri.replace(/^s3:\/\/[^/]+\//, '')
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: PROCESSED_BUCKET,
      Key: key,
      ResponseContentDisposition: 'inline',
      ResponseContentType: 'application/pdf',
    }),
    { expiresIn: URL_EXPIRY_SECONDS },
  )
}
