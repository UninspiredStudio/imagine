import type { Server, S3Client } from "bun";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { constants } from "node:fs";
import { open, rm, stat, truncate, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql/postgres";
import { z } from "zod";
import { blobs, manifestReferences, manifests, repositories, repositoryBlobs, tags, uploads } from "./db/schema.ts";
import { TOKEN_TTL_SECONDS, type TokenCodec } from "./token.ts";

// ponytail: manifests are read into memory, so cap them at the 4 MiB the spec asks registries to accept.
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

export type OciErrorCode =
  | "BLOB_UNKNOWN"
  | "BLOB_UPLOAD_INVALID"
  | "BLOB_UPLOAD_UNKNOWN"
  | "DIGEST_INVALID"
  | "MANIFEST_BLOB_UNKNOWN"
  | "MANIFEST_INVALID"
  | "MANIFEST_UNKNOWN"
  | "NAME_INVALID"
  | "NAME_UNKNOWN"
  | "SIZE_INVALID"
  | "UNAUTHORIZED"
  | "UNSUPPORTED"
  | "UNKNOWN";

// Thrown anywhere in a handler; the app's onError turns it into the OCI error JSON body.
export class OciError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: OciErrorCode,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export type DigestAlgorithm = "sha256" | "sha512";

export const nameSchema = z
  .string()
  .max(255)
  .regex(/^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/);
export const digestSchema = z.string().regex(/^(sha256:[a-f0-9]{64}|sha512:[a-f0-9]{128})$/);
const digestAlgorithmSchema = z.enum(["sha256", "sha512"]);
export const tagSchema = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/);
const uploadIdSchema = z.uuid();
const tagPageSchema = z.coerce.number().int().nonnegative();

const descriptorSchema = z.object({
  mediaType: z.string(),
  digest: digestSchema,
  size: z.number().int().nonnegative(),
  urls: z.array(z.string()).optional(),
});
const manifestSchema = z.object({
  schemaVersion: z.literal(2),
  mediaType: z.string().optional(),
  // Postgres text cannot hold a NUL.
  artifactType: z
    .string()
    .refine((value) => !value.includes("\0"))
    .optional(),
  config: descriptorSchema.optional(),
  layers: z.array(descriptorSchema).optional(),
  manifests: z.array(descriptorSchema).optional(),
  subject: descriptorSchema.optional(),
});
type Descriptor = z.infer<typeof descriptorSchema>;

export type Reference = { digest: string } | { tag: string };

// Name validation happens here so every route gets the same NAME_INVALID error.
export type Route =
  | { kind: "version" }
  | { kind: "tags"; name: string }
  | { kind: "manifest"; name: string; reference: string }
  | { kind: "uploadStart"; name: string }
  | { kind: "upload"; name: string; uuid: string }
  | { kind: "blob"; name: string; digest: string };

export function parseName(raw: string): string {
  const parsed = nameSchema.safeParse(raw);
  if (!parsed.success) throw new OciError(400, "NAME_INVALID", `invalid repository name ${raw}`);
  return parsed.data;
}

export function parseDigest(raw: string | undefined): string {
  const parsed = digestSchema.safeParse(raw);
  if (!parsed.success) throw new OciError(400, "DIGEST_INVALID", `invalid digest ${raw}`);
  return parsed.data;
}

export function parseReference(raw: string): Reference | null {
  if (digestSchema.safeParse(raw).success) return { digest: raw };
  if (tagSchema.safeParse(raw).success) return { tag: raw };
  return null;
}

const algorithmOf = (digest: string): DigestAlgorithm => (digest.startsWith("sha512:") ? "sha512" : "sha256");

// Repository names contain slashes, so the routes are matched with regexes instead of path params.
export function parseRoute(path: string): Route | null {
  if (path === "/v2" || path === "/v2/") return { kind: "version" };
  if (!path.startsWith("/v2/")) return null;
  const rest = path.slice("/v2/".length);

  // Matched from the end of the path, so a repository whose name contains a route word (e.g. "a/blobs/uploads") still reaches its own routes.
  let m: RegExpExecArray | null;
  if ((m = /^(.+)\/manifests\/([^/]+)$/.exec(rest))) return { kind: "manifest", name: parseName(m[1]), reference: m[2] };
  if ((m = /^(.+)\/blobs\/uploads\/([^/]+)$/.exec(rest))) return { kind: "upload", name: parseName(m[1]), uuid: m[2] };
  if ((m = /^(.+)\/blobs\/uploads\/?$/.exec(rest))) return { kind: "uploadStart", name: parseName(m[1]) };
  if ((m = /^(.+)\/blobs\/([^/]+)$/.exec(rest))) return { kind: "blob", name: parseName(m[1]), digest: m[2] };
  if ((m = /^(.+)\/tags\/list$/.exec(rest))) return { kind: "tags", name: parseName(m[1]) };
  return null;
}

export async function digestFile(path: string, algorithm: DigestAlgorithm): Promise<string> {
  const hasher = new Bun.CryptoHasher(algorithm);
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return `${algorithm}:${hasher.digest("hex")}`;
}

const hashBytes = (algorithm: DigestAlgorithm, bytes: Uint8Array) =>
  `${algorithm}:${new Bun.CryptoHasher(algorithm).update(bytes).digest("hex")}`;

export function verifyDigest(expected: string, actual: string): void {
  if (expected !== actual) {
    throw new OciError(400, "DIGEST_INVALID", `digest mismatch: expected ${expected}, got ${actual}`);
  }
}

// A client's digest-algorithm must match the digest it uploads with.
export function checkDigestAlgorithm(declared: string | null | undefined, digest: string): void {
  if (declared && declared !== algorithmOf(digest)) {
    throw new OciError(400, "DIGEST_INVALID", `digest ${digest} does not use the declared algorithm ${declared}`);
  }
}

// Range covers the bytes stored so far. An empty upload reports "0-0", as the spec's examples do.
export const byteRange = (size: number) => (size > 0 ? `0-${size - 1}` : "0-0");

// A PATCH or final PUT must start exactly where the stored bytes end, or the client gets a 416 with the stored range.
// Returns the chunk length the Content-Range declares, so the body can be checked against it.
export function checkUploadOffset(contentRange: string | undefined, stored: number): number | undefined {
  if (contentRange === undefined) return undefined;
  const match = /^(\d+)-(\d+)$/.exec(contentRange);
  if (!match) throw new OciError(400, "BLOB_UPLOAD_INVALID", `invalid Content-Range ${contentRange}`);
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (end < start) throw new OciError(400, "BLOB_UPLOAD_INVALID", `invalid Content-Range ${contentRange}`);
  if (start !== stored) {
    throw new OciError(416, "BLOB_UPLOAD_INVALID", `chunk must start at offset ${stored}, not ${start}`, {
      Range: byteRange(stored),
    });
  }
  return end - start + 1;
}

// Only JSON manifests are stored. Anything else replayed with its own Content-Type could be rendered by a browser.
export const isJsonMediaType = (mediaType: string) => /^application\/(json|[a-z0-9.+-]+\+json)$/i.test(mediaType);

const APPEND_TO_EXISTING = constants.O_WRONLY | constants.O_APPEND;
const blobTooLarge = (maxBlobBytes: number) => new OciError(413, "SIZE_INVALID", `blob exceeds ${maxBlobBytes} bytes`);
const rangeMismatch = (stored: number) =>
  new OciError(416, "BLOB_UPLOAD_INVALID", "chunk length does not match its Content-Range", { Range: byteRange(stored) });

// Manifests are read whole, so they have their own fixed cap, separate from the blob limit.
export function checkDeclaredLength(headers: Headers, maxBytes: number): void {
  const declared = headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    throw new OciError(413, "SIZE_INVALID", `request body exceeds ${maxBytes} bytes`);
  }
}

export type Access = "pull" | "push";
export type Grant = { name: string; actions: Access[] };
// "user" actions apply to every repository (a personal access token or a session). "token" grants are per repository.
// "invalid" covers credentials that do not verify and owners that are banned or removed.
export type Principal =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "user"; userId: string; actions: Access[] }
  | { kind: "token"; grants: Grant[] };
export type Authenticate = (req: Request) => Promise<Principal>;

export type RegistryDeps = {
  db: BunSQLDatabase;
  // Turns the request's credentials into a Principal. dispatch and /token both apply it.
  authenticate: Authenticate;
  // Issues the registry tokens that /token hands out, and reads them back in authenticate.
  tokens: TokenCodec;
  // Writes go to the internal endpoint; presigned URLs use the public one because the signature covers the host.
  storage: S3Client;
  publicStorage: S3Client;
  spoolDir: string;
  publicUrl: string;
  presignTtlSeconds: number;
  // Limits the whole blob, counting bytes already in the spool, not each request.
  maxBlobBytes: number;
};
type Ctx = Context<{ Bindings: { server: Server<undefined> } }>;

// Digests look like "sha256:<hex>", so the S3 key is blobs/sha256/<hex>.
export const blobKey = (digest: string) => `blobs/${digest.replace(":", "/")}`;
// Held by whoever changes a blob row's lifetime: commitBlob and mountBlob refresh it, and the sweep deletes it.
// The sweep's row delete and object delete both happen under it, so a refresh can't land between them.
export async function lockBlob(db: Pick<BunSQLDatabase, "execute">, digest: string): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${digest}, 0))`);
}
const spoolPath = (deps: RegistryDeps, id: string) => join(deps.spoolDir, id);
const location = (deps: RegistryDeps, path: string) => `${deps.publicUrl.replace(/\/+$/, "")}${path}`;
const unknownUpload = () => new OciError(404, "BLOB_UPLOAD_UNKNOWN", "blob upload unknown to registry");
// A spool file that has vanished means the upload is gone, so it reports as an unknown upload rather than a server error.
const spoolError = (err: unknown) => ((err as { code?: string }).code === "ENOENT" ? unknownUpload() : err);
const spoolSize = async (path: string) => {
  try {
    return (await stat(path)).size;
  } catch (err) {
    throw spoolError(err);
  }
};

// ponytail: single replica only. This Set serialises writers inside one process; several replicas would need a row lock on uploads.
const busyUploads = new Set<string>();
// A second writer on the same upload is refused rather than queued, so it can't change the bytes a commit is hashing.
async function claimUpload<T>(id: string, work: () => Promise<T>): Promise<T> {
  if (busyUploads.has(id)) {
    throw new OciError(409, "BLOB_UPLOAD_INVALID", "another request is still writing this upload");
  }
  busyUploads.add(id);
  try {
    return await work();
  } finally {
    busyUploads.delete(id);
  }
}

function uploadHeaders(deps: RegistryDeps, name: string, id: string, size: number): Record<string, string> {
  return {
    Location: location(deps, `/v2/${name}/blobs/uploads/${id}`),
    Range: byteRange(size),
    "Docker-Upload-UUID": id,
  };
}

function blobCreatedHeaders(deps: RegistryDeps, name: string, digest: string): Record<string, string> {
  return {
    Location: location(deps, `/v2/${name}/blobs/${digest}`),
    "Docker-Content-Digest": digest,
  };
}

// Appends the request body to the spool. The limit covers the whole blob, so bytes already stored count too.
// A body that breaks the limit, or whose length disagrees with its Content-Range, is cut back to the stored size.
// A client that disconnects keeps what it sent, so it can resume from the Range the registry reports.
export async function appendBody(
  req: Request,
  path: string,
  limits: { maxBlobBytes: number; span?: number },
): Promise<void> {
  const before = await spoolSize(path);
  const declared = req.headers.get("content-length");
  if (declared !== null && before + Number(declared) > limits.maxBlobBytes) throw blobTooLarge(limits.maxBlobBytes);
  if (declared !== null && limits.span !== undefined && Number(declared) !== limits.span) throw rangeMismatch(before);

  let handle: FileHandle;
  try {
    // No O_CREAT: a spool removed since spoolSize must not be recreated as an empty file.
    handle = await open(path, APPEND_TO_EXISTING);
  } catch (err) {
    throw spoolError(err);
  }
  const chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array> = req.body ?? [];
  let received = 0;
  let writeFailed = false;
  let failure: unknown;
  try {
    for await (const chunk of chunks) {
      received += chunk.byteLength;
      if (before + received > limits.maxBlobBytes) throw blobTooLarge(limits.maxBlobBytes);
      try {
        await handle.appendFile(chunk);
      } catch (err) {
        writeFailed = true;
        throw err;
      }
    }
    if (limits.span !== undefined && received !== limits.span) throw rangeMismatch(before);
  } catch (err) {
    failure = err;
  } finally {
    await handle.close();
  }
  if (failure === undefined) return;
  if (writeFailed) {
    // Disk errors (e.g. ENOSPC) are the server's fault: say so generically and leave no partial bytes behind.
    await truncate(path, before);
    throw new OciError(500, "UNKNOWN", "upload could not be written");
  }
  if (failure instanceof OciError) {
    await truncate(path, before);
    throw failure;
  }
  throw new OciError(400, "BLOB_UPLOAD_INVALID", "upload body was interrupted");
}

// Reads a manifest body, stopping as soon as it passes maxBytes.
async function readBoundedBody(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new OciError(413, "SIZE_INVALID", `manifest exceeds ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Creates the repository if needed and keeps it from being deleted until the transaction ends. Pushes share this lock, so
// they don't wait for each other.
async function holdRepository(tx: Pick<BunSQLDatabase, "insert" | "select">, name: string): Promise<void> {
  for (;;) {
    await tx.insert(repositories).values({ name }).onConflictDoNothing();
    const [held] = await tx
      .select({ name: repositories.name })
      .from(repositories)
      .where(eq(repositories.name, name))
      .for("key share");
    // Nothing is left if a delete committed between the two statements. The next insert then creates it again.
    if (held) return;
  }
}

async function createUpload(deps: RegistryDeps, name: string, digestAlgorithm: DigestAlgorithm | null): Promise<string> {
  const [row] = await deps.db.transaction(async (tx) => {
    await holdRepository(tx, name);
    return tx.insert(uploads).values({ repository: name, digestAlgorithm }).returning({ id: uploads.id });
  });
  await Bun.write(spoolPath(deps, row.id), "");
  return row.id;
}

async function requireUpload(deps: RegistryDeps, name: string, rawId: string) {
  const parsed = uploadIdSchema.safeParse(rawId);
  if (!parsed.success) throw unknownUpload();
  const [row] = await deps.db
    .select({ id: uploads.id, digestAlgorithm: uploads.digestAlgorithm })
    .from(uploads)
    .where(and(eq(uploads.id, parsed.data), eq(uploads.repository, name)))
    .limit(1);
  if (!row) throw unknownUpload();
  return row;
}

async function discardUpload(deps: RegistryDeps, id: string): Promise<void> {
  await deps.db.delete(uploads).where(eq(uploads.id, id));
  await rm(spoolPath(deps, id), { force: true });
}

// Hashes the spool, writes it to S3, then links it. The S3 write finishes before the 201, so a pull can't redirect to a missing object.
// The blobs row is upserted first, with a fresh created_at, and the repository link comes last. Reads and manifest checks
// go through repository_blobs, so a row whose S3 write failed is never readable.
async function commitBlob(deps: RegistryDeps, c: Ctx, name: string, id: string, digest: string): Promise<Response> {
  const path = spoolPath(deps, id);
  let actual: string;
  try {
    actual = await digestFile(path, algorithmOf(digest));
  } catch (err) {
    throw spoolError(err);
  }
  try {
    verifyDigest(digest, actual);
  } catch (err) {
    await discardUpload(deps, id);
    throw err;
  }
  const size = await spoolSize(path);
  // Under the blob lock, so the sweep can't delete the row between this upsert and the S3 write and leave a row with no object.
  await deps.db.transaction(async (tx) => {
    await lockBlob(tx, digest);
    await tx
      .insert(blobs)
      .values({ digest, size })
      .onConflictDoUpdate({ target: blobs.digest, set: { createdAt: sql`now()` } });
  });
  await deps.storage.write(blobKey(digest), Bun.file(path), { type: "application/octet-stream" });
  await deps.db.transaction(async (tx) => {
    // The repository is locked before the upload row, the same order as deleteRepository, so the two can't deadlock.
    await tx.select({ name: repositories.name }).from(repositories).where(eq(repositories.name, name)).for("key share");
    const [upload] = await tx.delete(uploads).where(eq(uploads.id, id)).returning({ id: uploads.id });
    // Deleting the repository ends its uploads, even one that is being committed.
    if (!upload) throw unknownUpload();
    await tx.insert(repositoryBlobs).values({ repository: name, blobDigest: digest }).onConflictDoNothing();
  });
  await rm(path, { force: true });
  return c.body(null, 201, blobCreatedHeaders(deps, name, digest));
}

function parseDigestAlgorithm(raw: string | undefined): DigestAlgorithm | null {
  if (raw === undefined) return null;
  const parsed = digestAlgorithmSchema.safeParse(raw);
  if (!parsed.success) throw new OciError(400, "DIGEST_INVALID", `unsupported digest algorithm ${raw}`);
  return parsed.data;
}

async function startUpload(deps: RegistryDeps, c: Ctx, name: string, principal: Principal): Promise<Response> {
  const rawDigest = c.req.query("digest");
  const digest = rawDigest === undefined ? undefined : parseDigest(rawDigest);
  const digestAlgorithm = parseDigestAlgorithm(c.req.query("digest-algorithm"));
  if (digest !== undefined) checkDigestAlgorithm(digestAlgorithm, digest);
  const mount = c.req.query("mount");
  const from = c.req.query("from");
  // A mount is only done for a caller who could pull from "from". Otherwise it falls through to a normal upload, which
  // reveals nothing about whether the digest exists there.
  if (mount !== undefined && from !== undefined && (await mayAccess(deps, principal, parseName(from), "pull"))) {
    const mounted = await mountBlob(deps, name, parseDigest(mount), parseName(from));
    if (mounted) return c.body(null, 201, blobCreatedHeaders(deps, name, mount));
  }

  const id = await createUpload(deps, name, digestAlgorithm);
  if (digest === undefined) return c.body(null, 202, uploadHeaders(deps, name, id, 0));
  c.env.server.timeout(c.req.raw, 0);
  return claimUpload(id, async () => {
    try {
      await appendBody(c.req.raw, spoolPath(deps, id), { maxBlobBytes: deps.maxBlobBytes });
      return await commitBlob(deps, c, name, id, digest);
    } catch (err) {
      // A monolithic POST creates its session in this request, so a failure should leave no session behind.
      await discardUpload(deps, id);
      throw err;
    }
  });
}

// Deletes a repository with everything in it, and returns how many tags it had, or undefined if there is no such repository.
// Blobs are only unlinked. The sweep removes the ones nothing references any more.
export async function deleteRepository(db: BunSQLDatabase, name: string): Promise<number | undefined> {
  return db.transaction(async (tx) => {
    // Waits for pushes that hold the repository, and makes later ones wait for this transaction.
    const [repository] = await tx
      .select({ name: repositories.name })
      .from(repositories)
      .where(eq(repositories.name, name))
      .for("update");
    if (!repository) return undefined;
    const removed = await tx.delete(tags).where(eq(tags.repository, name)).returning({ name: tags.name });
    await tx.delete(manifestReferences).where(eq(manifestReferences.repository, name));
    await tx.delete(manifests).where(eq(manifests.repository, name));
    // The sweep removes the spool files of these uploads.
    await tx.delete(uploads).where(eq(uploads.repository, name));
    await tx.delete(repositoryBlobs).where(eq(repositoryBlobs.repository, name));
    await tx.delete(repositories).where(eq(repositories.name, name));
    return removed.length;
  });
}

async function mountBlob(deps: RegistryDeps, name: string, digest: string, from: string): Promise<boolean> {
  return deps.db.transaction(async (tx) => {
    await lockBlob(tx, digest);
    // Checked under the lock. A blob row can exist without its object (a commit in progress), but a link never does.
    const [source] = await tx
      .select({ digest: repositoryBlobs.blobDigest })
      .from(repositoryBlobs)
      .where(and(eq(repositoryBlobs.repository, from), eq(repositoryBlobs.blobDigest, digest)))
      .limit(1);
    if (!source) return false;
    // Refreshing created_at restarts the sweep's grace period for a blob that is now referenced again.
    await tx.update(blobs).set({ createdAt: sql`now()` }).where(eq(blobs.digest, digest));
    await holdRepository(tx, name);
    await tx.insert(repositoryBlobs).values({ repository: name, blobDigest: digest }).onConflictDoNothing();
    return true;
  });
}

async function uploadStatus(deps: RegistryDeps, c: Ctx, name: string, rawId: string): Promise<Response> {
  const upload = await requireUpload(deps, name, rawId);
  return c.body(null, 204, uploadHeaders(deps, name, upload.id, await spoolSize(spoolPath(deps, upload.id))));
}

async function patchUpload(deps: RegistryDeps, c: Ctx, name: string, rawId: string): Promise<Response> {
  c.env.server.timeout(c.req.raw, 0);
  const { id } = await requireUpload(deps, name, rawId);
  return claimUpload(id, async () => {
    const path = spoolPath(deps, id);
    const span = checkUploadOffset(c.req.header("content-range"), await spoolSize(path));
    await appendBody(c.req.raw, path, { maxBlobBytes: deps.maxBlobBytes, span });
    return c.body(null, 202, uploadHeaders(deps, name, id, await spoolSize(path)));
  });
}

async function finalizeUpload(deps: RegistryDeps, c: Ctx, name: string, rawId: string): Promise<Response> {
  c.env.server.timeout(c.req.raw, 0);
  const digest = parseDigest(c.req.query("digest"));
  const upload = await requireUpload(deps, name, rawId);
  checkDigestAlgorithm(upload.digestAlgorithm, digest);
  return claimUpload(upload.id, async () => {
    const path = spoolPath(deps, upload.id);
    const span = checkUploadOffset(c.req.header("content-range"), await spoolSize(path));
    await appendBody(c.req.raw, path, { maxBlobBytes: deps.maxBlobBytes, span });
    return commitBlob(deps, c, name, upload.id, digest);
  });
}

async function getBlob(deps: RegistryDeps, c: Ctx, name: string, rawDigest: string): Promise<Response> {
  const digest = parseDigest(rawDigest);
  const [row] = await deps.db
    .select({ size: blobs.size })
    .from(repositoryBlobs)
    .innerJoin(blobs, eq(blobs.digest, repositoryBlobs.blobDigest))
    .where(and(eq(repositoryBlobs.repository, name), eq(repositoryBlobs.blobDigest, digest)))
    .limit(1);
  if (!row) throw new OciError(404, "BLOB_UNKNOWN", "blob unknown to registry");

  if (c.req.method === "HEAD") {
    return c.body(null, 200, {
      "Docker-Content-Digest": digest,
      "Content-Length": String(row.size),
      "Content-Type": "application/octet-stream",
    });
  }
  const url = deps.publicStorage.presign(blobKey(digest), { method: "GET", expiresIn: deps.presignTtlSeconds });
  c.header("Docker-Content-Digest", digest);
  return c.redirect(url, 307);
}

async function findManifest(deps: RegistryDeps, name: string, reference: Reference) {
  const columns = { digest: manifests.digest, mediaType: manifests.mediaType, bytes: manifests.bytes };
  const [row] =
    "digest" in reference
      ? await deps.db
          .select(columns)
          .from(manifests)
          .where(and(eq(manifests.repository, name), eq(manifests.digest, reference.digest)))
          .limit(1)
      : await deps.db
          .select(columns)
          .from(tags)
          .innerJoin(manifests, and(eq(manifests.repository, tags.repository), eq(manifests.digest, tags.manifestDigest)))
          .where(and(eq(tags.repository, name), eq(tags.name, reference.tag)))
          .limit(1);
  return row;
}

async function getManifest(deps: RegistryDeps, c: Ctx, name: string, rawReference: string): Promise<Response> {
  const reference = parseReference(rawReference);
  const found = reference && (await findManifest(deps, name, reference));
  if (!found) throw new OciError(404, "MANIFEST_UNKNOWN", "manifest unknown to registry");
  const headers = {
    "Content-Type": found.mediaType,
    "Content-Length": String(found.bytes.byteLength),
    "Docker-Content-Digest": found.digest,
  };
  if (c.req.method === "HEAD") return c.body(null, 200, headers);
  return c.body(new Uint8Array(found.bytes), 200, headers);
}

function parseManifest(bytes: Uint8Array): z.infer<typeof manifestSchema> {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new OciError(400, "MANIFEST_INVALID", "manifest is not valid JSON");
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new OciError(400, "MANIFEST_INVALID", parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  return parsed.data;
}

// Foreign and nondistributable layers are allowed to be absent, so they are not checked.
// Only a descriptor that has urls and a nondistributable media type may be absent. Every other descriptor must exist.
const isExternal = (d: Descriptor) => (d.urls?.length ?? 0) > 0 && d.mediaType.includes("nondistributable");
const unique = (values: string[]) => [...new Set(values)];

function missingFrom(wanted: string[], found: string[]): string[] {
  return wanted.filter((digest) => !found.includes(digest));
}

async function putManifest(deps: RegistryDeps, c: Ctx, name: string, rawReference: string): Promise<Response> {
  const reference = parseReference(rawReference);
  if (!reference) throw new OciError(400, "MANIFEST_INVALID", `invalid reference ${rawReference}`);
  const mediaType = c.req.header("content-type")?.split(";")[0]?.trim();
  if (!mediaType) throw new OciError(400, "MANIFEST_INVALID", "Content-Type header is required");
  if (!isJsonMediaType(mediaType)) {
    throw new OciError(400, "MANIFEST_INVALID", "manifest Content-Type must be a JSON media type");
  }

  // A manifest pushed by digest is hashed with that digest's algorithm. A manifest pushed by tag gets sha256.
  const algorithm = "digest" in reference ? algorithmOf(reference.digest) : "sha256";
  checkDeclaredLength(c.req.raw.headers, MAX_MANIFEST_BYTES);
  const bytes = await readBoundedBody(c.req.raw.body, MAX_MANIFEST_BYTES);
  const digest = hashBytes(algorithm, bytes);
  if ("digest" in reference) verifyDigest(reference.digest, digest);
  const manifest = parseManifest(bytes);
  if (manifest.mediaType !== undefined && manifest.mediaType !== mediaType) {
    throw new OciError(400, "MANIFEST_INVALID", "body mediaType does not match Content-Type");
  }

  const blobDescriptors = [manifest.config, ...(manifest.layers ?? [])].filter((d): d is Descriptor => d !== undefined);
  const childDescriptors = manifest.manifests ?? [];
  const blobDigests = unique(blobDescriptors.map((d) => d.digest));
  const childDigests = unique(childDescriptors.map((d) => d.digest));
  const requiredBlobs = unique(blobDescriptors.filter((d) => !isExternal(d)).map((d) => d.digest));
  const requiredChildren = unique(childDescriptors.filter((d) => !isExternal(d)).map((d) => d.digest));
  const tagName = "tag" in reference ? reference.tag : undefined;

  await deps.db.transaction(async (tx) => {
    await holdRepository(tx, name);
    // Blobs that exist are recorded as references even when they are optional, so the sweep keeps them.
    let linkedBlobs: string[] = [];
    if (blobDigests.length > 0) {
      // Locks the blob rows until the commit, so the sweep can't delete a blob this manifest is claiming.
      const linked = await tx
        .select({ digest: blobs.digest })
        .from(repositoryBlobs)
        .innerJoin(blobs, eq(blobs.digest, repositoryBlobs.blobDigest))
        .where(and(eq(repositoryBlobs.repository, name), inArray(repositoryBlobs.blobDigest, blobDigests)))
        .for("share", { of: blobs });
      linkedBlobs = linked.map((row) => row.digest);
      const missing = missingFrom(requiredBlobs, linkedBlobs);
      if (missing.length > 0) {
        throw new OciError(400, "MANIFEST_BLOB_UNKNOWN", `unknown blobs: ${missing.join(", ")}`);
      }
    }
    let linkedChildren: string[] = [];
    if (childDigests.length > 0) {
      const found = await tx
        .select({ digest: manifests.digest })
        .from(manifests)
        .where(and(eq(manifests.repository, name), inArray(manifests.digest, childDigests)));
      linkedChildren = found.map((row) => row.digest);
      const missing = missingFrom(requiredChildren, linkedChildren);
      if (missing.length > 0) {
        throw new OciError(400, "MANIFEST_BLOB_UNKNOWN", `unknown manifests: ${missing.join(", ")}`);
      }
    }
    const references = unique([...linkedBlobs, ...linkedChildren]);

    await tx
      .insert(manifests)
      .values({
        repository: name,
        digest,
        mediaType,
        bytes: Buffer.from(bytes),
        subjectDigest: manifest.subject?.digest,
        artifactType: manifest.artifactType,
      })
      .onConflictDoNothing();
    if (references.length > 0) {
      await tx
        .insert(manifestReferences)
        .values(references.map((referencedDigest) => ({ repository: name, manifestDigest: digest, referencedDigest })))
        .onConflictDoNothing();
    }
    if (tagName !== undefined) {
      await tx
        .insert(tags)
        .values({ repository: name, name: tagName, manifestDigest: digest })
        .onConflictDoUpdate({ target: [tags.repository, tags.name], set: { manifestDigest: digest } });
    }
  });

  return c.body(null, 201, {
    Location: location(deps, `/v2/${name}/manifests/${digest}`),
    "Docker-Content-Digest": digest,
  });
}

async function listTags(deps: RegistryDeps, c: Ctx, name: string): Promise<Response> {
  const rawPageSize = c.req.query("n");
  let pageSize: number | undefined;
  if (rawPageSize !== undefined) {
    const parsed = tagPageSchema.safeParse(rawPageSize);
    if (!parsed.success) throw new OciError(400, "UNSUPPORTED", `invalid n ${rawPageSize}`);
    pageSize = parsed.data;
  }
  const last = c.req.query("last");

  const [repo] = await deps.db
    .select({ name: repositories.name })
    .from(repositories)
    .where(eq(repositories.name, name))
    .limit(1);
  if (!repo) throw new OciError(404, "NAME_UNKNOWN", "repository name not known to registry");
  if (pageSize === 0) return c.json({ name, tags: [] }, 200);

  // COLLATE "C" makes the database order match the spec's lexicographic order, and the `last` cursor.
  const byName = sql`${tags.name} COLLATE "C"`;
  const query = deps.db
    .select({ name: tags.name })
    .from(tags)
    .where(and(eq(tags.repository, name), last === undefined ? undefined : gt(byName, last)))
    .orderBy(byName);
  const rows = await (pageSize === undefined ? query : query.limit(pageSize + 1));

  const page = pageSize === undefined ? rows : rows.slice(0, pageSize);
  const headers: Record<string, string> = {};
  if (pageSize !== undefined && rows.length > pageSize) {
    const nextLast = encodeURIComponent(page[page.length - 1]?.name ?? "");
    headers.Link = `</v2/${name}/tags/list?n=${pageSize}&last=${nextLast}>; rel="next"`;
  }
  return c.json({ name, tags: page.map((row) => row.name) }, 200, headers);
}

async function isPublic(deps: RegistryDeps, name: string): Promise<boolean> {
  const [repo] = await deps.db
    .select({ visibility: repositories.visibility })
    .from(repositories)
    .where(eq(repositories.name, name))
    .limit(1);
  return repo?.visibility === "public";
}

// Whether the caller may do `access` on `repository`. With no repository (GET /v2/) any valid credential is enough.
// Without credentials, only pulls from public repositories are allowed. A missing repository is refused like a private one.
async function mayAccess(
  deps: RegistryDeps,
  principal: Principal,
  repository: string | undefined,
  access: Access,
): Promise<boolean> {
  switch (principal.kind) {
    case "invalid":
      return false;
    case "user":
      return repository === undefined || principal.actions.includes(access);
    case "token":
      return (
        repository === undefined ||
        principal.grants.some((grant) => grant.name === repository && grant.actions.includes(access))
      );
    case "none":
      return repository !== undefined && access === "pull" && (await isPublic(deps, repository));
  }
}

// Docker reads this header to find the token service and the scope to ask for, then retries with the token it gets.
// The scope is omitted when no repository is involved (GET /v2/).
function challenge(deps: RegistryDeps, repository: string | undefined, access: Access, message: string): OciError {
  const params = [`realm="${location(deps, "/token")}"`, `service="${new URL(deps.publicUrl).host}"`];
  if (repository !== undefined) {
    params.push(`scope="repository:${repository}:${access === "push" ? "pull,push" : "pull"}"`);
  }
  return new OciError(401, "UNAUTHORIZED", message, { "WWW-Authenticate": `Bearer ${params.join(",")}` });
}

// Runs once per request, before any route handler. A signed-in caller who lacks the action gets 401 with the scope,
// not 403, because that is the response that makes Docker request a token with the scope it needs.
async function checkAccess(
  deps: RegistryDeps,
  principal: Principal,
  repository: string | undefined,
  access: Access,
): Promise<void> {
  if (await mayAccess(deps, principal, repository, access)) return;
  const insufficient = principal.kind === "user" || principal.kind === "token";
  throw challenge(deps, repository, access, insufficient ? "insufficient scope" : "authentication required");
}

// Docker asks for one "repository:<name>:<actions>" scope per repository. Other scope types are not repository access.
function parseScopes(values: string[]): { name: string; actions: string[] }[] {
  const parsed: { name: string; actions: string[] }[] = [];
  for (const scope of values.flatMap((value) => value.split(" "))) {
    const match = /^repository:([^:]+):([a-z,]+)$/.exec(scope);
    if (match) parsed.push({ name: parseName(match[1]), actions: match[2].split(",") });
  }
  return parsed;
}

// The token step. Each requested action is granted only if the caller could do it, so a read-only key gets a pull-only token.
async function issueToken(deps: RegistryDeps, c: Ctx): Promise<Response> {
  const principal = await deps.authenticate(c.req.raw);
  if (principal.kind === "invalid" || principal.kind === "token") {
    throw new OciError(401, "UNAUTHORIZED", "credentials are not valid", { "WWW-Authenticate": 'Basic realm="imagine"' });
  }
  const grants: Grant[] = [];
  for (const { name, actions } of parseScopes(c.req.queries("scope") ?? [])) {
    const granted: Access[] = [];
    for (const action of actions) {
      if (action !== "pull" && action !== "push") continue;
      if (await mayAccess(deps, principal, name, action)) granted.push(action);
    }
    if (granted.length > 0) grants.push({ name, actions: granted });
  }
  const token = deps.tokens.issue(principal.kind === "user" ? principal.userId : null, grants);
  return c.json({
    token,
    access_token: token,
    expires_in: TOKEN_TTL_SECONDS,
    issued_at: new Date().toISOString(),
  });
}

async function dispatch(deps: RegistryDeps, c: Ctx): Promise<Response> {
  const route = parseRoute(c.req.path);
  if (!route) throw new OciError(404, "UNSUPPORTED", `no route for ${c.req.path}`);
  const method = c.req.method;
  const read = method === "GET" || method === "HEAD";
  const principal = await deps.authenticate(c.req.raw);
  await checkAccess(deps, principal, route.kind === "version" ? undefined : route.name, read ? "pull" : "push");

  switch (route.kind) {
    case "version":
      if (read) return c.body(null, 200, { "Docker-Distribution-API-Version": "registry/2.0" });
      break;
    case "tags":
      if (read) return listTags(deps, c, route.name);
      break;
    case "manifest":
      if (read) return getManifest(deps, c, route.name, route.reference);
      if (method === "PUT") return putManifest(deps, c, route.name, route.reference);
      break;
    case "uploadStart":
      if (method === "POST") return startUpload(deps, c, route.name, principal);
      break;
    case "upload":
      if (read) return uploadStatus(deps, c, route.name, route.uuid);
      if (method === "PATCH") return patchUpload(deps, c, route.name, route.uuid);
      if (method === "PUT") return finalizeUpload(deps, c, route.name, route.uuid);
      break;
    case "blob":
      if (read) return getBlob(deps, c, route.name, route.digest);
      break;
  }
  throw new OciError(405, "UNSUPPORTED", `${method} is not supported for ${c.req.path}`);
}

export function createRegistry(deps: RegistryDeps) {
  const registry = new Hono<{ Bindings: { server: Server<undefined> } }>();

  // "/v2/*" also matches "/v2" in Hono, so one route covers both.
  registry.use("*", async (c, next) => {
    // Registry responses are JSON or blob redirects. Forbid sniffing and keep any document sandboxed.
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Content-Security-Policy", "sandbox");
    await next();
  });
  registry.all("/v2/*", (c) => dispatch(deps, c));
  registry.get("/token", (c) => issueToken(deps, c));

  registry.onError((err, c) => {
    if (err instanceof OciError) {
      return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status, err.headers);
    }
    console.error(err);
    return c.json({ errors: [{ code: "UNKNOWN", message: "internal error" }] }, 500);
  });
  registry.notFound((c) => c.json({ errors: [{ code: "UNSUPPORTED", message: "not found" }] }, 404));

  return registry;
}
