import "dotenv/config";

const nodeEnv = process.env.NODE_ENV ?? "development";
const port = Number(process.env.PORT ?? 4000);
const configuredPublicUrl = process.env.API_PUBLIC_URL?.replace(/\/$/, "");
const renderExternalUrl = process.env.RENDER_EXTERNAL_URL?.replace(/\/$/, "");
const isLoopbackUrl = (value: string) => /^https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0)(?::|\/|$)/i.test(value);
const publicUrl = (
  nodeEnv === "production" && configuredPublicUrl && isLoopbackUrl(configuredPublicUrl)
    ? renderExternalUrl
    : configuredPublicUrl
) ?? renderExternalUrl ?? `http://localhost:${port}`;

export const env = {
  nodeEnv,
  port,
  corsOrigins: (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
  returnWindowDays: Number(process.env.RETURN_WINDOW_DAYS ?? 7),
  publicUrl,
  // Public address of the storefront, used to send shoppers back to their order after a payment.
  frontendUrl: (process.env.FRONTEND_URL ?? "").replace(/\/$/, ""),
  cashfree: {
    appId: process.env.CASHFREE_APP_ID ?? "",
    secretKey: process.env.CASHFREE_SECRET_KEY ?? "",
    environment: (process.env.CASHFREE_ENV ?? "sandbox").toLowerCase() === "production" ? ("production" as const) : ("sandbox" as const),
    apiVersion: process.env.CASHFREE_API_VERSION ?? "2025-01-01",
  },
  s3: {
    bucket: process.env.S3_BUCKET ?? "",
    endpoint: process.env.AWS_ENDPOINT_URL_S3 ?? "",
    region: process.env.AWS_REGION ?? "us-east-1",
  },
};

if (nodeEnv === "production") {
  if (!env.s3.bucket || !env.s3.endpoint) throw new Error("S3_BUCKET and AWS_ENDPOINT_URL_S3 must be set in production");
  if (isLoopbackUrl(env.publicUrl)) throw new Error("API_PUBLIC_URL must be publicly reachable in production");
}
