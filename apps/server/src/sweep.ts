import type { Stats } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { S3Client } from "bun";
import { and, eq, notExists, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql/postgres";
import { z } from "zod";
import { blobs, manifestReferences, repositoryBlobs, uploads } from "./db/schema.ts";
import { blobKey, lockBlob } from "./registry.ts";

// Nothing younger than this is removed. An upload resumed after a longer idle time can lose to the sweep, and the client
// then has to start that upload again.
const GRACE_SECONDS = 24 * 60 * 60;
const GRACE_MS = GRACE_SECONDS * 1000;
// Blob age is measured on the database clock, the same clock that stamps blobs.created_at.
const blobExpired = sql`${blobs.createdAt} < now() - make_interval(secs => ${GRACE_SECONDS}::float8)`;
const uuidSchema = z.uuid();

export type SweepDeps = { db: BunSQLDatabase; storage: S3Client; spoolDir: string };
export type SweepCounts = { uploads: number; spoolFiles: number; blobs: number; failures: number };

// One item's failure is logged and counted, and the sweep moves on to the next item.
async function attempt(counts: SweepCounts, label: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    counts.failures++;
    console.error(`sweep: ${label} failed`, err);
  }
}

// undefined when there is no file at that path.
async function statOf(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return undefined;
    throw err;
  }
}

export async function sweep({ db, storage, spoolDir }: SweepDeps): Promise<SweepCounts> {
  const counts: SweepCounts = { uploads: 0, spoolFiles: 0, blobs: 0, failures: 0 };

  // ponytail: every upload row and every candidate blob is loaded at once; page them if either table grows large.
  for (const upload of await db.select({ id: uploads.id, createdAt: uploads.createdAt }).from(uploads)) {
    await attempt(counts, `upload ${upload.id}`, async () => {
      const path = join(spoolDir, upload.id);
      // An upload that is still being written has a fresh file. Without a file, the row's age is the idle time.
      const idleSince = (await statOf(path))?.mtime ?? upload.createdAt;
      if (Date.now() - idleSince.getTime() <= GRACE_MS) return;
      await db.delete(uploads).where(eq(uploads.id, upload.id));
      await rm(path, { force: true });
      counts.uploads++;
    });
  }

  for (const name of await readdir(spoolDir)) {
    if (!uuidSchema.safeParse(name).success) continue;
    await attempt(counts, `spool file ${name}`, async () => {
      const path = join(spoolDir, name);
      const stats = await statOf(path);
      if (!stats?.isFile() || Date.now() - stats.mtime.getTime() <= GRACE_MS) return;
      // Read after listing: createUpload inserts the row before it creates the file, so a listed file always has its row.
      const [row] = await db.select({ id: uploads.id }).from(uploads).where(eq(uploads.id, name)).limit(1);
      if (row) return;
      await rm(path, { force: true });
      counts.spoolFiles++;
    });
  }

  const candidates = await db
    .select({ digest: blobs.digest })
    .from(blobs)
    .where(
      and(
        blobExpired,
        notExists(
          db
            .select({ digest: manifestReferences.referencedDigest })
            .from(manifestReferences)
            .where(eq(manifestReferences.referencedDigest, blobs.digest)),
        ),
      ),
    );
  for (const { digest } of candidates) {
    await attempt(counts, `blob ${digest}`, async () => {
      if (await removeBlob(db, storage, digest)) counts.blobs++;
    });
  }

  return counts;
}

// Logs a run's outcome. Returns true only when it finished with no failures. Never rejects, because an unhandled rejection
// would end the server.
export async function runSweep(deps: SweepDeps): Promise<boolean> {
  try {
    const counts = await sweep(deps);
    console.log(
      `sweep: uploads=${counts.uploads} spoolFiles=${counts.spoolFiles} blobs=${counts.blobs} failures=${counts.failures}`,
    );
    return counts.failures === 0;
  } catch (err) {
    console.error("sweep: run failed", err);
    return false;
  }
}

// The row is deleted and committed before the object is deleted. If the object delete fails, the blob row is put back
// without links, so it stays unreadable and the next sweep retries it. The blob lock keeps commitBlob from re-inserting the row in between.
async function removeBlob(db: BunSQLDatabase, storage: S3Client, digest: string): Promise<boolean> {
  return db.transaction(async (lock) => {
    await lockBlob(lock, digest);
    // A separate transaction, on its own connection, so the lock above spans both the row delete and the object delete.
    const removed = await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(blobs)
        .where(and(eq(blobs.digest, digest), blobExpired))
        .for("update")
        .limit(1);
      if (!row) return undefined;
      // A separate statement, so READ COMMITTED takes a fresh snapshot. It then sees manifests committed while the row lock was waited for.
      const [referenced] = await tx
        .select({ digest: manifestReferences.referencedDigest })
        .from(manifestReferences)
        .where(eq(manifestReferences.referencedDigest, digest))
        .limit(1);
      if (referenced) return undefined;
      await tx.delete(repositoryBlobs).where(eq(repositoryBlobs.blobDigest, digest));
      await tx.delete(blobs).where(eq(blobs.digest, digest));
      return row;
    });
    if (!removed) return false;
    try {
      await storage.delete(blobKey(digest));
    } catch (err) {
      // Some stores answer 404 for an object that is already gone.
      if ((err as { code?: string }).code !== "NoSuchKey") {
        await db.insert(blobs).values(removed).onConflictDoNothing();
        throw err;
      }
    }
    return true;
  });
}
