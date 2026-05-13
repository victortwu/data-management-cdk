import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { APIGatewayProxyHandlerV2WithJWTAuthorizer } from 'aws-lambda';
import { randomUUID } from 'crypto';

const s3 = new S3Client({});
const LANDING_BUCKET = process.env.LANDING_BUCKET!;
const URL_EXPIRY_SECONDS = 900;
const MAX_FILES = 25;

interface FileRequest {
  filename: string;
  contentType: string;
}

const respond = (statusCode: number, body: Record<string, unknown>) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  const body = JSON.parse(event.body ?? '{}');
  const files: FileRequest[] = body.files;

  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) {
    return respond(400, { error: 'VALIDATION_ERROR', message: `files must be an array of 1–${MAX_FILES} items` });
  }

  for (const f of files) {
    if (!f.filename || !f.contentType) {
      return respond(400, { error: 'VALIDATION_ERROR', message: 'Each file must have filename and contentType' });
    }
  }

  const sub = event.requestContext?.authorizer?.jwt?.claims?.sub ?? 'anonymous';
  const batchId = randomUUID();

  const uploads = await Promise.all(
    files.map(async (f) => {
      const key = `uploads/${sub}/${batchId}/${f.filename}`;
      const url = await getSignedUrl(
        s3,
        new PutObjectCommand({ Bucket: LANDING_BUCKET, Key: key, ContentType: f.contentType }),
        { expiresIn: URL_EXPIRY_SECONDS },
      );
      return { filename: f.filename, uploadUrl: url, key, expiresIn: URL_EXPIRY_SECONDS };
    }),
  );

  return respond(200, { uploads });
};
