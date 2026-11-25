import { expect, test, describe, beforeAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { S3Client } from "bun";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql/postgres";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { repositories } from "./db/schema.ts";
import {
  OciError,
  appendBody,
  checkDeclaredLength,
  checkDigestAlgorithm,
  checkUploadOffset,
  createRegistry,
  digestFile,
  isJsonMediaType,
  parseName,
  parseReference,
  parseRoute,
  verifyDigest,
  type Authenticate,
  type RegistryDeps,
} from "./registry.ts";
import { createTokenCodec } from "./token.ts";

const ABC_SHA256 = "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const ABC_SHA512 =
  "sha512:ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f";
const ZERO_DIGEST = `sha256:${"0".repeat(64)}`;

function thrownBy(fn: () => unknown): OciError {
  try {
    fn();
  } catch (err) {
    if (err instanceof OciError) return err;
    throw err;
  }
  throw new Error("expected a throw");
}

async function rejectionOf(promise: Promise<unknown>): Promise<OciError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof OciError) return err;
    throw err;
  }
  throw new Error("expected a rejection");
}

// Runs a test body with a fresh temp dir, removed afterwards.
async function withSpool(run: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "imagine-test-"));
  try {
    await run(join(dir, "spool"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const bodyOf = (...parts: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    },
  });

// Pure helpers: no database or network needed.

test("repository names with slashes are parsed into the route name", () => {
  expect(parseRoute("/v2/team/app/blobs/uploads/")).toEqual({ kind: "uploadStart", name: "team/app" });
  expect(parseRoute("/v2/a/b/c/manifests/v1.0")).toEqual({ kind: "manifest", name: "a/b/c", reference: "v1.0" });
  expect(parseRoute("/v2/a/b/blobs/" + ZERO_DIGEST)).toEqual({ kind: "blob", name: "a/b", digest: ZERO_DIGEST });
  expect(parseRoute("/v2/team/app/tags/list")).toEqual({ kind: "tags", name: "team/app" });
  expect(parseRoute("/v2/")).toEqual({ kind: "version" });
  expect(parseRoute("/healthz")).toBeNull();
});

test("a repository whose name contains route words still reaches its own routes", () => {
  expect(parseRoute("/v2/a/blobs/uploads/manifests/v1")).toEqual({
    kind: "manifest",
    name: "a/blobs/uploads",
    reference: "v1",
  });
  expect(parseRoute("/v2/a/blobs/uploads/blobs/" + ZERO_DIGEST)).toEqual({
    kind: "blob",
    name: "a/blobs/uploads",
    digest: ZERO_DIGEST,
  });
  expect(parseRoute("/v2/a/blobs/uploads/blobs/uploads/0b8c4a0e-6f3e-4f5e-9d1c-2b7a6f1e5c3d")).toEqual({
    kind: "upload",
    name: "a/blobs/uploads",
    uuid: "0b8c4a0e-6f3e-4f5e-9d1c-2b7a6f1e5c3d",
  });
});

test("invalid repository names fail with NAME_INVALID", () => {
  expect(thrownBy(() => parseRoute("/v2/Team/app/manifests/v1")).code).toBe("NAME_INVALID");
  expect(thrownBy(() => parseRoute("/v2/team//app/tags/list")).code).toBe("NAME_INVALID");
  expect(thrownBy(() => parseRoute("/v2/-team/app/tags/list")).code).toBe("NAME_INVALID");
});

test("name validation on a long invalid name finishes quickly (no nested-quantifier backtracking)", () => {
  // The old pattern took about 190 ms at 24 characters and grows about 4x per two more.
  const started = performance.now();
  expect(() => parseName("a".repeat(64) + "!")).toThrow();
  expect(performance.now() - started).toBeLessThan(200);
});

test("references are tags or sha256/sha512 digests, anything else is rejected", () => {
  expect(parseReference("latest")).toEqual({ tag: "latest" });
  expect(parseReference(ABC_SHA256)).toEqual({ digest: ABC_SHA256 });
  expect(parseReference(ABC_SHA512)).toEqual({ digest: ABC_SHA512 });
  expect(parseReference("bad tag!")).toBeNull();
  expect(parseReference(`sha384:${"a".repeat(96)}`)).toBeNull();
});

test("manifest media types must be JSON", () => {
  expect(isJsonMediaType("application/json")).toBe(true);
  expect(isJsonMediaType("application/vnd.oci.image.manifest.v1+json")).toBe(true);
  expect(isJsonMediaType("text/html")).toBe(false);
  expect(isJsonMediaType("application/xhtml+xml")).toBe(false);
});

test("upload PATCH offsets must start where the stored bytes end, and the range must be well formed", () => {
  expect(checkUploadOffset(undefined, 42)).toBeUndefined();
  expect(checkUploadOffset("0-99", 0)).toBe(100);
  expect(checkUploadOffset("100-199", 100)).toBe(100);

  const mismatch = thrownBy(() => checkUploadOffset("10-19", 0));
  expect(mismatch.status).toBe(416);
  expect(mismatch.headers.Range).toBe("0-0");

  const afterData = thrownBy(() => checkUploadOffset("0-99", 100));
  expect(afterData.status).toBe(416);
  expect(afterData.headers.Range).toBe("0-99");

  expect(thrownBy(() => checkUploadOffset("9-5", 9)).status).toBe(400);
});

test("a spool file whose digest differs from the claimed digest is rejected, for both algorithms", async () => {
  await withSpool(async (path) => {
    await writeFile(path, "abc");
    expect(await digestFile(path, "sha256")).toBe(ABC_SHA256);
    expect(await digestFile(path, "sha512")).toBe(ABC_SHA512);

    expect(() => verifyDigest(ABC_SHA512, ABC_SHA512)).not.toThrow();
    const mismatch = thrownBy(() => verifyDigest(ZERO_DIGEST, ABC_SHA256));
    expect(mismatch.code).toBe("DIGEST_INVALID");
    expect(mismatch.status).toBe(400);
  });
});

test("a digest must use the algorithm the upload declared", () => {
  expect(() => checkDigestAlgorithm(null, ABC_SHA512)).not.toThrow();
  expect(() => checkDigestAlgorithm("sha512", ABC_SHA512)).not.toThrow();
  expect(thrownBy(() => checkDigestAlgorithm("sha256", ABC_SHA512)).code).toBe("DIGEST_INVALID");
});

test("a declared Content-Length over the manifest cap is rejected before the body is read", () => {
  expect(() => checkDeclaredLength(new Headers({ "content-length": "5" }), 5)).not.toThrow();
  const tooLarge = thrownBy(() => checkDeclaredLength(new Headers({ "content-length": "6" }), 5));
  expect(tooLarge.status).toBe(413);
  expect(tooLarge.code).toBe("SIZE_INVALID");
});

test("a streamed body over the whole-blob limit is cut back to the bytes stored before the request", async () => {
  await withSpool(async (path) => {
    await writeFile(path, "abc");
    // The first chunk brings the blob to 7 bytes, past the limit of 5, so this request's bytes are removed.
    const req = new Request("http://localhost/v2/x/blobs/uploads/y", { method: "PATCH", body: bodyOf("0123", "456789") });
    const error = await rejectionOf(appendBody(req, path, { maxBlobBytes: 5 }));
    expect(error.status).toBe(413);
    expect(error.code).toBe("SIZE_INVALID");
    expect(await Bun.file(path).text()).toBe("abc");
  });
});

test("the limit counts the whole blob, so bytes already stored are included", async () => {
  await withSpool(async (path) => {
    await writeFile(path, "abcdef");
    const req = new Request("http://localhost/v2/x/blobs/uploads/y", { method: "PATCH", body: bodyOf("0123") });
    const error = await rejectionOf(appendBody(req, path, { maxBlobBytes: 9 }));
    expect(error.status).toBe(413);
    expect(await Bun.file(path).text()).toBe("abcdef");
  });
});

test("a streamed body within the limit is appended in full", async () => {
  await withSpool(async (path) => {
    await writeFile(path, "abc");
    const req = new Request("http://localhost/v2/x/blobs/uploads/y", { method: "PATCH", body: bodyOf("0123", "456789") });
    await appendBody(req, path, { maxBlobBytes: 13 });
    expect(await Bun.file(path).text()).toBe("abc0123456789");
  });
});

test("a body whose length disagrees with its Content-Range is rejected and cut back", async () => {
  await withSpool(async (path) => {
    await writeFile(path, "abc");
    const req = new Request("http://localhost/v2/x/blobs/uploads/y", { method: "PATCH", body: bodyOf("0123") });
    const error = await rejectionOf(appendBody(req, path, { maxBlobBytes: 100, span: 5 }));
    expect(error.status).toBe(416);
    expect(error.headers.Range).toBe("0-2");
    expect(await Bun.file(path).text()).toBe("abc");
  });
});

test("a missing spool is an unknown upload, not a server error, and is not recreated", async () => {
  await withSpool(async (path) => {
    const req = new Request("http://localhost/v2/x/blobs/uploads/y", { method: "PATCH", body: bodyOf("0123") });
    const error = await rejectionOf(appendBody(req, path, { maxBlobBytes: 100 }));
    expect(error.status).toBe(404);
    expect(error.code).toBe("BLOB_UPLOAD_UNKNOWN");
    expect(await Bun.file(path).exists()).toBe(false);
  });
});

// Route-level tests need Postgres. They run when TEST_DATABASE_URL is set, for example against a throwaway container.

const databaseUrl = process.env.TEST_DATABASE_URL;

// The app is served through its fetch handler, so Bun's server timeout hook is a no-op stub here.
const testServer = { timeout() {} } as unknown as import("bun").Server<undefined>;
const fakeStorage = { write: async () => {} } as unknown as S3Client;
// Stands in for the better-auth check, so these tests run without an auth database.
const granted: Authenticate = async () => ({ kind: "user", userId: "test-user", actions: ["pull", "push"] });
const noCredentials: Authenticate = async () => ({ kind: "none" });
const tokens = createTokenCodec("registry-test-secret-registry-test-secret");
// For routes that never reach the database: the challenge and the token endpoint need only the codec and the public URL.
const offline = (authenticate: Authenticate) =>
  createRegistry({ publicUrl: "http://registry.test", authenticate, tokens } as unknown as RegistryDeps);

describe.skipIf(!databaseUrl)("registry routes", () => {
  let registry: ReturnType<typeof createRegistry>;
  let deps: RegistryDeps;
  let db: BunSQLDatabase;
  let spoolDir: string;

  beforeAll(async () => {
    db = drizzle(databaseUrl!);
    await migrate(db, { migrationsFolder: join(import.meta.dir, "../drizzle") });
    spoolDir = await mkdtemp(join(tmpdir(), "imagine-route-test-"));
    deps = {
      db,
      storage: fakeStorage,
      // Presigning is local, so a dummy endpoint is enough.
      publicStorage: new Bun.S3Client({
        accessKeyId: "a",
        secretAccessKey: "b",
        bucket: "bkt",
        region: "us-east-1",
        endpoint: "http://127.0.0.1:9",
      }),
      spoolDir,
      publicUrl: "http://registry.test",
      presignTtlSeconds: 60,
      maxBlobBytes: 10,
      authenticate: granted,
      tokens,
    };
    registry = createRegistry(deps);
  });

  const send = (req: Request) => registry.fetch(req, { server: testServer });
  const repo = (label: string) => `${label}-${crypto.randomUUID().slice(0, 8)}`;
  const location = (res: Response) => new URL(res.headers.get("location")!).pathname;

  test("mount and read isolation: a blob is readable only through a repository that links it", async () => {
    const source = repo("src");
    const other = repo("dst");
    const unlinked = repo("none");

    const put = await send(
      new Request(`http://r/v2/${source}/blobs/uploads/?digest=${ABC_SHA256}`, { method: "POST", body: "abc" }),
    );
    expect(put.status).toBe(201);

    const before = await send(new Request(`http://r/v2/${other}/blobs/${ABC_SHA256}`));
    expect(before.status).toBe(404);
    expect(((await before.json()) as { errors: { code: string }[] }).errors[0].code).toBe("BLOB_UNKNOWN");

    const missingSource = await send(
      new Request(`http://r/v2/${other}/blobs/uploads/?mount=${ABC_SHA256}&from=${repo("gone")}`, { method: "POST" }),
    );
    expect(missingSource.status).toBe(202);

    const mounted = await send(
      new Request(`http://r/v2/${other}/blobs/uploads/?mount=${ABC_SHA256}&from=${source}`, { method: "POST" }),
    );
    expect(mounted.status).toBe(201);
    const after = await send(new Request(`http://r/v2/${other}/blobs/${ABC_SHA256}`));
    expect(after.status).toBe(307);

    // A manifest may only reference blobs its own repository links. The unlinked repository is refused.
    const manifest = JSON.stringify({
      schemaVersion: 2,
      config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: ABC_SHA256, size: 3 },
      layers: [],
    });
    const manifestHeaders = { "content-type": "application/vnd.oci.image.manifest.v1+json" };
    const refused = await send(
      new Request(`http://r/v2/${unlinked}/manifests/v1`, { method: "PUT", body: manifest, headers: manifestHeaders }),
    );
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { errors: { code: string }[] }).errors[0].code).toBe("MANIFEST_BLOB_UNKNOWN");
    const accepted = await send(
      new Request(`http://r/v2/${other}/manifests/v1`, { method: "PUT", body: manifest, headers: manifestHeaders }),
    );
    expect(accepted.status).toBe(201);
  });

  test("the whole-blob limit counts bytes already uploaded, across requests", async () => {
    const name = repo("limit");
    const start = await send(new Request(`http://r/v2/${name}/blobs/uploads/`, { method: "POST" }));
    const path = location(start);

    const first = await send(
      new Request(`http://r${path}`, { method: "PATCH", body: "123456", headers: { "content-range": "0-5" } }),
    );
    expect(first.status).toBe(202);

    // Each request is under the limit of 10 on its own, but 6 + 6 is not.
    const overall = await send(
      new Request(`http://r${path}`, { method: "PATCH", body: bodyOf("123456"), headers: { "content-range": "6-11" } }),
    );
    expect(overall.status).toBe(413);
    expect(((await overall.json()) as { errors: { code: string }[] }).errors[0].code).toBe("SIZE_INVALID");

    const status = await send(new Request(`http://r${path}`));
    expect(status.headers.get("range")).toBe("0-5");
  });

  test("a second writer on an upload that is still being written is refused, not queued", async () => {
    const name = repo("race");
    const start = await send(new Request(`http://r/v2/${name}/blobs/uploads/`, { method: "POST" }));
    const path = location(start);

    // Hold a PATCH open: its body has started but not finished.
    let finishBody!: () => void;
    const held = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("abc"));
        finishBody = () => controller.close();
      },
    });
    const patch = send(new Request(`http://r${path}`, { method: "PATCH", body: held }));
    await Bun.sleep(150);

    // The final PUT would hash the spool while the PATCH is still appending, so it must be refused.
    const put = await send(new Request(`http://r${path}?digest=${ABC_SHA256}`, { method: "PUT" }));
    expect(put.status).toBe(409);

    finishBody();
    expect((await patch).status).toBe(202);

    const committed = await send(new Request(`http://r${path}?digest=${ABC_SHA256}`, { method: "PUT" }));
    expect(committed.status).toBe(201);
  });

  test("anonymous reads reach a public repository only, and anonymous writes never", async () => {
    const name = repo("visibility");
    const pushed = await send(
      new Request(`http://r/v2/${name}/blobs/uploads/?digest=${ABC_SHA256}`, { method: "POST", body: "abc" }),
    );
    expect(pushed.status).toBe(201);
    const manifest = JSON.stringify({
      schemaVersion: 2,
      config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: ABC_SHA256, size: 3 },
      layers: [],
    });
    const manifestHeaders = { "content-type": "application/vnd.oci.image.manifest.v1+json" };
    const put = await send(
      new Request(`http://r/v2/${name}/manifests/v1`, { method: "PUT", body: manifest, headers: manifestHeaders }),
    );
    expect(put.status).toBe(201);

    const anonymous = createRegistry({ ...deps, authenticate: noCredentials });
    const privatePull = await anonymous.fetch(new Request(`http://r/v2/${name}/manifests/v1`), { server: testServer });
    expect(privatePull.status).toBe(401);
    expect(privatePull.headers.get("www-authenticate")).toContain(`scope="repository:${name}:pull"`);

    await db.update(repositories).set({ visibility: "public" }).where(eq(repositories.name, name));
    const publicPull = await anonymous.fetch(new Request(`http://r/v2/${name}/manifests/v1`), { server: testServer });
    expect(publicPull.status).toBe(200);

    const anonymousPush = await anonymous.fetch(new Request(`http://r/v2/${name}/blobs/uploads/`, { method: "POST" }), {
      server: testServer,
    });
    expect(anonymousPush.status).toBe(401);
  });
});

test("a JSON-only manifest type is required, and responses are marked non-sniffable", async () => {
  // Route checks that need no database: the media type is refused before any lookup.
  const noDb = offline(granted);
  const version = await noDb.fetch(new Request("http://r/v2/"), { server: testServer });
  expect(version.status).toBe(200);
  expect(version.headers.get("x-content-type-options")).toBe("nosniff");
  expect(version.headers.get("content-security-policy")).toBe("sandbox");

  const html = await noDb.fetch(
    new Request(`http://r/v2/x/manifests/v1`, { method: "PUT", body: "<script>alert(1)</script>", headers: { "content-type": "text/html" } }),
    { server: testServer },
  );
  expect(html.status).toBe(400);
  expect(((await html.json()) as { errors: { code: string }[] }).errors[0].code).toBe("MANIFEST_INVALID");
});

test("without credentials, /v2/ answers 401 with a Bearer challenge that names the token service", async () => {
  const res = await offline(noCredentials).fetch(new Request("http://r/v2/"), { server: testServer });
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate")).toBe('Bearer realm="http://registry.test/token",service="registry.test"');
  expect(((await res.json()) as { errors: { code: string }[] }).errors[0].code).toBe("UNAUTHORIZED");
});

test("a pull-only principal cannot push, and the 401 names the scope Docker must request", async () => {
  const pullOnly: Authenticate = async () => ({ kind: "user", userId: "test-user", actions: ["pull"] });
  const registry = offline(pullOnly);
  const push = await registry.fetch(new Request("http://r/v2/x/blobs/uploads/", { method: "POST" }), {
    server: testServer,
  });
  expect(push.status).toBe(401);
  expect(push.headers.get("www-authenticate")).toBe(
    'Bearer realm="http://registry.test/token",service="registry.test",scope="repository:x:pull,push"',
  );
  expect(((await push.json()) as { errors: { code: string }[] }).errors[0].code).toBe("UNAUTHORIZED");

  const version = await registry.fetch(new Request("http://r/v2/"), { server: testServer });
  expect(version.status).toBe(200);
});

test("a token grants only the repositories and actions it names", async () => {
  const forY: Authenticate = async () => ({ kind: "token", grants: [{ name: "y", actions: ["pull"] }] });
  const registry = offline(forY);
  const push = await registry.fetch(new Request("http://r/v2/x/blobs/uploads/", { method: "POST" }), {
    server: testServer,
  });
  expect(push.status).toBe(401);
  expect(push.headers.get("www-authenticate")).toContain('scope="repository:x:pull,push"');
});

test("the token endpoint answers anonymous callers with a signed token that grants nothing without a scope", async () => {
  const res = await offline(noCredentials).fetch(new Request("http://r/token"), { server: testServer });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string; access_token: string; expires_in: number; issued_at: string };
  expect(body.access_token).toBe(body.token);
  expect(body.expires_in).toBe(300);
  expect(Date.parse(body.issued_at)).not.toBeNaN();
  expect(tokens.read(body.token)).toEqual({ sub: null, access: [] });
});
