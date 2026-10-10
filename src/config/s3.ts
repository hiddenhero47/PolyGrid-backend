import { S3Client } from "@aws-sdk/client-s3";

// Lazy, memoized — same reasoning as config/stripe.ts: this file is pulled
// in transitively by app.ts (via digitalProductController.ts), so
// constructing the client eagerly would mean the entire app fails to boot
// whenever the AWS env vars aren't set, not just the digital-product
// routes that actually need S3.
let client: S3Client | null = null;

export const getS3Client = (): S3Client => {
  if (!client) {
    if (
      !process.env.AWS_ACCESS_KEY_ID ||
      !process.env.AWS_SECRET_ACCESS_KEY ||
      !process.env.AWS_REGION ||
      !process.env.S3_BUCKET
    ) {
      throw new Error(
        "S3 is not configured — set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, and S3_BUCKET",
      );
    }

    client = new S3Client({
      region: process.env.AWS_REGION,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
  }

  return client;
};

export const S3_BUCKET = process.env.S3_BUCKET as string;
