import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { createRegistry } from "./registry.ts";
import { createAuth, createAuthenticate } from "./auth.ts";
import { createApi } from "./api.ts";
import { createMailer } from "./mail.ts";
import { runSweep } from "./sweep.ts";
import { createTokenCodec } from "./token.ts";

const config = z
  .object({
    DATABASE_URL: z.string().min(1),
    PUBLIC_URL: z.url(),
    PORT: z.coerce.number().int().default(8080),
    // Signs sessions and tokens. Changing it logs every user out.
    BETTER_AUTH_SECRET: z.string().min(32),
    // Comma-separated extra origins allowed to call /api/auth, e.g. the Vite dev server.
    TRUSTED_ORIGINS: z
      .string()
      .default("")
      .transform((v) => v.split(",").map((o) => o.trim()).filter(Boolean)),
    // Compose passes blank values for unset optional variables, so blank counts as unset.
    // Plunk is used if PLUNK_API_KEY is set. Otherwise SMTP is used if SMTP_URL is set. With neither, codes and
    // invite links are written to the log, which is for development only.
    PLUNK_API_KEY: z.string().or(z.literal("")).optional(),
    PLUNK_API_URL: z.url().default("https://next-api.useplunk.com"),
    SMTP_URL: z.url().or(z.literal("")).optional(),
    MAIL_FROM: z.email().or(z.literal("")).optional(),
    SPOOL_DIR: z.string().default("/spool"),
    SWEEP_SCHEDULE: z.string().default("0 * * * *"),
    // Limits each blob in full, counting bytes already uploaded, so a client can't grow the spool without bound.
    MAX_BLOB_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(16 * 1024 ** 3),
    PRESIGN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    S3_BUCKET: z.string().min(1),
    S3_REGION: z.string().min(1).default("us-east-1"),
    S3_ENDPOINT: z.url(),
    S3_PUBLIC_ENDPOINT: z.url(),
    AWS_ACCESS_KEY_ID: z.string().min(1),
    AWS_SECRET_ACCESS_KEY: z.string().min(1),
  })
  .refine((c) => !(c.PLUNK_API_KEY || c.SMTP_URL) || c.MAIL_FROM, {
    message: "MAIL_FROM is required when PLUNK_API_KEY or SMTP_URL is set",
    path: ["MAIL_FROM"],
  })
  .parse(process.env);

const db = drizzle(config.DATABASE_URL);
await migrate(db, { migrationsFolder: join(import.meta.dir, "../drizzle") });

// ponytail: one replica only, because the spool is a local volume. Use a shared volume or sticky routing for more.
await mkdir(config.SPOOL_DIR, { recursive: true });

const s3 = {
  accessKeyId: config.AWS_ACCESS_KEY_ID,
  secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
  bucket: config.S3_BUCKET,
  region: config.S3_REGION,
};
const sendMail = createMailer({
  plunkApiKey: config.PLUNK_API_KEY,
  plunkApiUrl: config.PLUNK_API_URL,
  smtpUrl: config.SMTP_URL,
  mailFrom: config.MAIL_FROM,
});
const auth = createAuth({
  db,
  baseURL: config.PUBLIC_URL,
  secret: config.BETTER_AUTH_SECRET,
  trustedOrigins: config.TRUSTED_ORIGINS,
  sendMail,
});
const tokens = createTokenCodec(config.BETTER_AUTH_SECRET);

const storage = new Bun.S3Client({ ...s3, endpoint: config.S3_ENDPOINT });

const sweepDeps = { db, storage, spoolDir: config.SPOOL_DIR };
// One sweep by hand, without serving.
if (process.argv.includes("--sweep")) process.exit((await runSweep(sweepDeps)) ? 0 : 1);
// Bun.cron waits for runSweep to settle before it schedules the next run, so scheduled runs never overlap.
Bun.cron(config.SWEEP_SCHEDULE, () => runSweep(sweepDeps));

const registry = createRegistry({
  db,
  storage,
  publicStorage: new Bun.S3Client({ ...s3, endpoint: config.S3_PUBLIC_ENDPOINT }),
  spoolDir: config.SPOOL_DIR,
  publicUrl: config.PUBLIC_URL,
  presignTtlSeconds: config.PRESIGN_TTL_SECONDS,
  maxBlobBytes: config.MAX_BLOB_BYTES,
  authenticate: createAuthenticate({ auth, db, tokens }),
  tokens,
});
const api = createApi({ db, auth, sendMail, storage, publicUrl: config.PUBLIC_URL });

Bun.serve({
  port: config.PORT,
  // Bun's own limit answers an over-limit body with a plain 413 that drops our response. The app enforces
  // MAX_BLOB_BYTES instead, so the client gets OCI error JSON.
  maxRequestBodySize: Number.MAX_SAFE_INTEGER,
  // /api has its own JSON error shape, so it is a separate app from the registry's OCI errors.
  fetch: (req, server) =>
    new URL(req.url).pathname.startsWith("/api/") ? api.fetch(req) : registry.fetch(req, { server }),
});
console.log(`imagine listening on :${config.PORT}`);
