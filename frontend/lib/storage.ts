import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const client = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  // R2 expects the literal region "auto". The us-east-1 default is only a
  // fallback for an S3-compatible endpoint that does not care; set S3_REGION
  // explicitly for anything that does.
  region: process.env.S3_REGION ?? 'us-east-1',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? '',
    secretAccessKey: process.env.S3_SECRET_KEY ?? '',
  },
  // Addresses buckets as <endpoint>/<bucket>/<key>. Correct for both MinIO and
  // Cloudflare R2; only AWS S3 proper would want virtual-hosted style.
  forcePathStyle: true,
  // Since aws-sdk 3.729.0 the default is WHEN_SUPPORTED, which makes the SDK
  // attach a CRC32 checksum to every request. That is actively wrong for
  // presigned URLs: presigning has no body to hash, so the SDK signs the
  // checksum of an EMPTY payload into the URL as x-amz-checksum-crc32=AAAAAA==
  // and any storage provider that actually validates it then rejects every
  // upload of a non-empty file. MinIO ignores the parameter, which is the only
  // reason uploads work today; R2 is not guaranteed to. WHEN_REQUIRED omits it
  // unless an operation genuinely needs one. The response setting likewise
  // drops x-amz-checksum-mode=ENABLED from presigned GETs.
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

const bucket = process.env.S3_BUCKET ?? 'damassets';

export async function getUploadUrl(key: string, contentType: string): Promise<string> {
  const command = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType });
  return getSignedUrl(client, command, { expiresIn: 300 });
}

export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  const command = new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType });
  await client.send(command);
}

export async function getDownloadUrl(key: string): Promise<string> {
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  return getSignedUrl(client, command, { expiresIn: 300 });
}

export async function getObject(key: string): Promise<Buffer> {
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  const response = await client.send(command);
  const bytes = await response.Body!.transformToByteArray();
  return Buffer.from(bytes);
}

export async function deleteObject(storageKey: string): Promise<void> {
  const command = new DeleteObjectCommand({ Bucket: bucket, Key: storageKey });
  await client.send(command);
}
