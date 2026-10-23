import "dotenv/config";

const nodeEnv = process.env.NODE_ENV ?? "development";
const port = Number(process.env.PORT ?? 4000);

export const env = {
  nodeEnv,
  port,
  staffKey: process.env.STAFF_API_KEY ?? "",
  corsOrigins: (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
  returnWindowDays: Number(process.env.RETURN_WINDOW_DAYS ?? 7),
  publicUrl: (process.env.API_PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? `http://localhost:${port}`).replace(/\/$/, ""),
  s3: {
    bucket: process.env.S3_BUCKET ?? "",
    endpoint: process.env.AWS_ENDPOINT_URL_S3 ?? "",
    region: process.env.AWS_REGION ?? "us-east-1",
  },
};

if (nodeEnv === "production") {
  if (!env.staffKey) throw new Error("STAFF_API_KEY must be set in production");
  if (!env.s3.bucket || !env.s3.endpoint) throw new Error("S3_BUCKET and AWS_ENDPOINT_URL_S3 must be set in production");
}
