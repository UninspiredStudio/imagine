import { drizzle } from "drizzle-orm/bun-sql";
import { z } from "zod";
import { sweep } from "./sweep.ts";

// Only what the sweep needs. This process never migrates or serves, so the server's other settings are not read.
const config = z
  .object({
    DATABASE_URL: z.string().min(1),
    SPOOL_DIR: z.string().default("/spool"),
    SWEEP_SCHEDULE: z.string().default("0 * * * *"),
    S3_BUCKET: z.string().min(1),
    S3_REGION: z.string().min(1).default("us-east-1"),
    S3_ENDPOINT: z.url(),
    AWS_ACCESS_KEY_ID: z.string().min(1),
    AWS_SECRET_ACCESS_KEY: z.string().min(1),
  })
  .parse(process.env);

const db = drizzle(config.DATABASE_URL);
const storage = new Bun.S3Client({
  accessKeyId: config.AWS_ACCESS_KEY_ID,
  secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
  bucket: config.S3_BUCKET,
  region: config.S3_REGION,
  endpoint: config.S3_ENDPOINT,
});

// Returns true only when the run finished with no failures. A run that throws is logged and does not stop the schedule.
async function runSweep(): Promise<boolean> {
  try {
    const counts = await sweep({ db, storage, spoolDir: config.SPOOL_DIR });
    console.log(
      `sweep: uploads=${counts.uploads} spoolFiles=${counts.spoolFiles} blobs=${counts.blobs} failures=${counts.failures}`,
    );
    return counts.failures === 0;
  } catch (err) {
    console.error("sweep: run failed", err);
    return false;
  }
}

if (process.argv.includes("--once")) {
  process.exit((await runSweep()) ? 0 : 1);
}

// Exits at once. A sweep interrupted during an object delete can leave one orphaned object.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => process.exit(0));
}

// Bun.cron waits for runSweep to settle before it schedules the next run, so runs never overlap.
Bun.cron(config.SWEEP_SCHEDULE, runSweep);
