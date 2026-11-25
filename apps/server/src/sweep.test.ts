import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { S3Client } from "bun";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql/postgres";
import { blobs, manifestReferences, manifests, repositories, repositoryBlobs, uploads } from "./db/schema.ts";
import { type Authenticate, blobKey, createRegistry, lockBlob } from "./registry.ts";
import { sweep } from "./sweep.ts";
import { createTokenCodec } from "./token.ts";

// Needs TEST_DATABASE_URL and a database of its own: like the auth suite, each test starts by emptying the registry tables.
const databaseUrl = process.env.TEST_DATABASE_URL;
const OLD = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
const MANIFEST_TYPE = "application/vnd.oci.image.manifest.v1+json";

const testServer = { timeout() {} } as unknown as import("bun").Server<undefined>;
const granted: Authenticate = async () => ({ kind: "user", userId: "test-user", actions: ["pull", "push"] });
const digestOf = (text: string) => `sha256:${new Bun.CryptoHasher("sha256").update(text).digest("hex")}`;

// Records object writes and deletes in memory. A key listed in refuse fails its delete, as a flaky S3 would.
function recordingStorage(refuse: string[] = []) {
  const writes: string[] = [];
  const deletes: string[] = [];
  const client = {
    write: async (key: string) => {
      writes.push(key);
    },
    delete: async (key: string) => {
      if (refuse.includes(key)) throw new Error(`S3 refused the delete of ${key}`);
      deletes.push(key);
    },
  };
  return { client: client as unknown as S3Client, writes, deletes };
}

describe.skipIf(!databaseUrl)("storage sweep", () => {
  let db: BunSQLDatabase;
  let spoolDir: string;

  beforeAll(async () => {
    db = drizzle(databaseUrl!);
    await migrate(db, { migrationsFolder: join(import.meta.dir, "../drizzle") });
  });

  beforeEach(async () => {
    await db.execute(
      sql`truncate table tags, manifest_references, manifests, repository_blobs, uploads, blobs, repositories`,
    );
    spoolDir = await mkdtemp(join(tmpdir(), "imagine-sweep-test-"));
  });

  afterEach(async () => {
    await rm(spoolDir, { recursive: true, force: true });
  });

  async function seedRepository(name: string) {
    await db.insert(repositories).values({ name }).onConflictDoNothing();
  }

  // A blob row, linked to each named repository. createdAt sets its age.
  async function seedBlob(digest: string, { createdAt = new Date(), linkedTo = [] as string[] } = {}) {
    await db.insert(blobs).values({ digest, size: 3, createdAt });
    for (const name of linkedTo) {
      await seedRepository(name);
      await db.insert(repositoryBlobs).values({ repository: name, blobDigest: digest });
    }
  }

  // A manifest in `repository` that references `digest`, so the blob is in use.
  async function seedReference(repository: string, digest: string) {
    const manifestDigest = digestOf(`manifest for ${digest} in ${repository}`);
    await db
      .insert(manifests)
      .values({ repository, digest: manifestDigest, mediaType: MANIFEST_TYPE, bytes: Buffer.from("{}") });
    await db.insert(manifestReferences).values({ repository, manifestDigest, referencedDigest: digest });
  }

  const blobRows = (digest: string) => db.select().from(blobs).where(eq(blobs.digest, digest));
  const linkRows = (digest: string) => db.select().from(repositoryBlobs).where(eq(repositoryBlobs.blobDigest, digest));

  // A spool file in the test's spool directory, with its mtime set to `mtime` when given.
  async function spoolFile(name: string, mtime?: Date): Promise<string> {
    const path = join(spoolDir, name);
    await writeFile(path, "abc");
    if (mtime) await utimes(path, mtime, mtime);
    return path;
  }
  const exists = (path: string) => Bun.file(path).exists();

  const sweepWith = (storage: S3Client) => sweep({ db, storage, spoolDir });

  // Resolves once another session waits on an advisory lock, so the race under test has really started.
  async function untilWaitingOnLock(): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const [row] = await db.execute<{ waiting: number }>(sql`
        select count(*)::int as waiting from pg_locks
        where locktype = 'advisory' and not granted
          and database = (select oid from pg_database where datname = current_database())`);
      if (row.waiting > 0) return;
      await Bun.sleep(10);
    }
    throw new Error("no session started waiting on the advisory lock");
  }

  // Each race test runs the registry against the same database and storage as the sweep.
  function registryWith(storage: S3Client) {
    return createRegistry({
      db,
      storage,
      publicStorage: storage,
      spoolDir,
      publicUrl: "http://registry.test",
      presignTtlSeconds: 60,
      maxBlobBytes: 1024,
      authenticate: granted,
      tokens: createTokenCodec("sweep-test-secret-sweep-test-secret"),
    });
  }

  test("an old blob that no manifest references is removed with its row, its links and its object", async () => {
    const digest = digestOf("unreferenced");
    await seedBlob(digest, { createdAt: OLD, linkedTo: ["app"] });
    const s3 = recordingStorage();

    expect(await sweepWith(s3.client)).toEqual({ uploads: 0, spoolFiles: 0, blobs: 1, failures: 0 });
    expect(s3.deletes).toEqual([blobKey(digest)]);
    expect(await blobRows(digest)).toEqual([]);
    expect(await linkRows(digest)).toEqual([]);
  });

  test("a young blob is kept, even though nothing references it", async () => {
    const digest = digestOf("young");
    await seedBlob(digest, { linkedTo: ["app"] });
    const s3 = recordingStorage();

    expect(await sweepWith(s3.client)).toEqual({ uploads: 0, spoolFiles: 0, blobs: 0, failures: 0 });
    expect(s3.deletes).toEqual([]);
    expect(await blobRows(digest)).toHaveLength(1);
  });

  test("an old blob stays while a manifest in any repository references it", async () => {
    const digest = digestOf("shared");
    await seedBlob(digest, { createdAt: OLD, linkedTo: ["app", "other"] });
    await seedReference("other", digest);
    const s3 = recordingStorage();

    expect(await sweepWith(s3.client)).toEqual({ uploads: 0, spoolFiles: 0, blobs: 0, failures: 0 });
    expect(s3.deletes).toEqual([]);
    expect(await blobRows(digest)).toHaveLength(1);
    expect(await linkRows(digest)).toHaveLength(2);
  });

  test("a refused object delete is counted, retried by the next sweep, and does not stop the other blobs", async () => {
    const refused = digestOf("refused");
    const removable = digestOf("removable");
    await seedBlob(refused, { createdAt: OLD, linkedTo: ["app"] });
    await seedBlob(removable, { createdAt: OLD, linkedTo: ["app"] });
    const s3 = recordingStorage([blobKey(refused)]);

    expect(await sweepWith(s3.client)).toEqual({ uploads: 0, spoolFiles: 0, blobs: 1, failures: 1 });
    expect(s3.deletes).toEqual([blobKey(removable)]);
    // The row is back without its link, so nothing can read it, and it is still due.
    expect(await blobRows(refused)).toHaveLength(1);
    expect(await linkRows(refused)).toEqual([]);
    expect(await blobRows(removable)).toEqual([]);

    const recovered = recordingStorage();
    expect(await sweepWith(recovered.client)).toEqual({ uploads: 0, spoolFiles: 0, blobs: 1, failures: 0 });
    expect(recovered.deletes).toEqual([blobKey(refused)]);
    expect(await blobRows(refused)).toEqual([]);
  });

  test("an object that is already gone counts as removed", async () => {
    const digest = digestOf("gone");
    await seedBlob(digest, { createdAt: OLD });
    const storage = {
      delete: async () => {
        throw Object.assign(new Error("missing"), { code: "NoSuchKey" });
      },
    } as unknown as S3Client;

    expect(await sweepWith(storage)).toEqual({ uploads: 0, spoolFiles: 0, blobs: 1, failures: 0 });
    expect(await blobRows(digest)).toEqual([]);
  });

  test("an upload goes by its spool file's idle time, and an upload with no file goes by its created_at", async () => {
    await seedRepository("app");
    const [idle] = await db.insert(uploads).values({ repository: "app", createdAt: OLD }).returning({ id: uploads.id });
    const [active] = await db.insert(uploads).values({ repository: "app", createdAt: OLD }).returning({ id: uploads.id });
    // This row has no spool file at all.
    await db.insert(uploads).values({ repository: "app", createdAt: OLD });
    const idlePath = await spoolFile(idle.id, OLD);
    // Created two days ago, but written a moment ago, so it is still in use.
    const activePath = await spoolFile(active.id);

    expect(await sweepWith(recordingStorage().client)).toEqual({ uploads: 2, spoolFiles: 0, blobs: 0, failures: 0 });
    expect(await db.select({ id: uploads.id }).from(uploads)).toEqual([{ id: active.id }]);
    expect(await exists(idlePath)).toBe(false);
    expect(await exists(activePath)).toBe(true);
  });

  test("a day-old UUID spool file with no upload row is removed, while other names and fresh files stay", async () => {
    const orphan = await spoolFile(crypto.randomUUID(), OLD);
    const fresh = await spoolFile(crypto.randomUUID());
    const notes = await spoolFile("notes.txt", OLD);

    expect(await sweepWith(recordingStorage().client)).toEqual({ uploads: 0, spoolFiles: 1, blobs: 0, failures: 0 });
    expect(await exists(orphan)).toBe(false);
    expect(await exists(fresh)).toBe(true);
    expect(await exists(notes)).toBe(true);
  });

  test("a commit that refreshes a blob while the sweep waits for its lock keeps the blob", async () => {
    const digest = digestOf("refreshed");
    await seedBlob(digest, { createdAt: OLD, linkedTo: ["app"] });
    // Stands in for commitBlob's upsert: it holds the blob lock until released.
    let refreshed!: () => void;
    const refreshedNow = new Promise<void>((resolve) => (refreshed = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const commit = db.transaction(async (tx) => {
      await lockBlob(tx, digest);
      await tx
        .insert(blobs)
        .values({ digest, size: 3 })
        .onConflictDoUpdate({ target: blobs.digest, set: { createdAt: sql`now()` } });
      refreshed();
      await released;
    });
    await refreshedNow;

    const s3 = recordingStorage();
    const swept = sweepWith(s3.client);
    await untilWaitingOnLock();
    release();
    await commit;

    expect(await swept).toEqual({ uploads: 0, spoolFiles: 0, blobs: 0, failures: 0 });
    expect(s3.deletes).toEqual([]);
    expect(await blobRows(digest)).toHaveLength(1);
  });

  test("a commit that waits for the sweep's lock writes the blob back after the sweep", async () => {
    const payload = "written back after the sweep";
    const digest = digestOf(payload);
    await seedBlob(digest, { createdAt: OLD });
    // The object delete waits until the test lets it finish, so the commit below arrives mid-sweep.
    let deleting!: () => void;
    const deleteStarted = new Promise<void>((resolve) => (deleting = resolve));
    let finishDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => (finishDelete = resolve));
    const writes: string[] = [];
    const deletes: string[] = [];
    const storage = {
      write: async (key: string) => {
        writes.push(key);
      },
      delete: async (key: string) => {
        deleting();
        await deleteGate;
        deletes.push(key);
      },
    } as unknown as S3Client;

    const swept = sweepWith(storage);
    await deleteStarted;
    const committing = registryWith(storage).fetch(
      new Request(`http://r/v2/app/blobs/uploads/?digest=${digest}`, { method: "POST", body: payload }),
      { server: testServer },
    );
    await untilWaitingOnLock();
    finishDelete();

    expect(await swept).toEqual({ uploads: 0, spoolFiles: 0, blobs: 1, failures: 0 });
    expect((await committing).status).toBe(201);
    expect(deletes).toEqual([blobKey(digest)]);
    expect(writes).toEqual([blobKey(digest)]);
    expect(await blobRows(digest)).toHaveLength(1);
    expect(await linkRows(digest)).toHaveLength(1);
  });

  test("a mount whose blob the sweep removes meanwhile falls back to an upload, not a foreign-key error", async () => {
    const digest = digestOf("mounted");
    await seedBlob(digest, { linkedTo: ["source"] });
    // Removes the blob the way the sweep does, and holds the lock until released. The mount's source check runs first.
    let removed!: () => void;
    const removedNow = new Promise<void>((resolve) => (removed = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const removing = db.transaction(async (tx) => {
      await lockBlob(tx, digest);
      await tx.delete(repositoryBlobs).where(eq(repositoryBlobs.blobDigest, digest));
      await tx.delete(blobs).where(eq(blobs.digest, digest));
      removed();
      await released;
    });
    await removedNow;

    const mounting = registryWith(recordingStorage().client).fetch(
      new Request(`http://r/v2/target/blobs/uploads/?mount=${digest}&from=source`, { method: "POST" }),
      { server: testServer },
    );
    await untilWaitingOnLock();
    release();
    await removing;

    expect((await mounting).status).toBe(202);
    expect(await blobRows(digest)).toEqual([]);
    expect(await linkRows(digest)).toEqual([]);
  });
});
