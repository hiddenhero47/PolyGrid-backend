import crypto from "crypto";
import { PutObjectCommand, CopyObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getS3Client, S3_BUCKET } from "../../config/s3";
import { detectAndValidateFile } from "../../helpers/fileStorage";
import { IDigitalFile } from "../../models/digitalFile";
import { DigitalStorageProviderAdapter, DigitalStorageUploadOutcome } from "./types";

// The AWS-backed DigitalStorageProviderAdapter — selected via
// DIGITAL_STORAGE_PROVIDER=aws (see providers/digitalStorageProviders/index.ts).
// Not the default: requires real AWS credentials, which this project
// doesn't have set up yet. See internalStorageProvider.ts for the local-disk
// default used until then. This whole module is `jest.mock`'d in tests at
// the index.ts dispatch layer, the same way helpers/emailSender.ts is for
// Mailgun — no real AWS calls in CI, no AWS SDK mocking library needed.

const DOWNLOAD_URL_TTL_SECONDS = 10 * 60;

const safeName = (originalName: string): string =>
  originalName.replace(/\s+/g, "").replace(/[^a-zA-Z0-9.\-_]/g, "") || "file";

export const s3StorageProvider: DigitalStorageProviderAdapter = {
  async uploadDigitalFiles(
    files: Express.Multer.File[],
    keyPrefix: string,
    allowedMimeTypes: string[],
  ): Promise<DigitalStorageUploadOutcome> {
    const results: IDigitalFile[] = [];
    const errorLogs: string[] = [];

    for (const file of files) {
      try {
        const detected = detectAndValidateFile(file.buffer, file.originalname, allowedMimeTypes);

        if (!detected.ok) {
          errorLogs.push(detected.error);
          continue;
        }

        const key = `${keyPrefix}/${crypto.randomUUID()}-${safeName(file.originalname)}`;

        await getS3Client().send(
          new PutObjectCommand({
            Bucket: S3_BUCKET,
            Key: key,
            Body: file.buffer,
            ContentType: detected.mime,
          }),
        );

        results.push({ fileName: file.originalname, key, mime: detected.mime, size: file.buffer.length });
      } catch (err) {
        errorLogs.push(`Error processing file ${file.originalname}: ${(err as Error).message}`);
      }
    }

    return { results, errorLogs };
  },

  async copyDigitalFile(sourceKey: string, destKey: string): Promise<void> {
    await getS3Client().send(
      new CopyObjectCommand({
        Bucket: S3_BUCKET,
        CopySource: `${S3_BUCKET}/${encodeURIComponent(sourceKey)}`,
        Key: destKey,
      }),
    );
  },

  async deleteDigitalFile(key: string): Promise<void> {
    await getS3Client().send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  },

  async getDigitalFileDownloadUrl(key: string, fileName: string, mime: string): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${fileName.replace(/"/g, "")}"`,
      ResponseContentType: mime,
    });

    return getSignedUrl(getS3Client(), command, { expiresIn: DOWNLOAD_URL_TTL_SECONDS });
  },
};
