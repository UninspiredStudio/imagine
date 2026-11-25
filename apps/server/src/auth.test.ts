import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { S3Client } from "bun";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql/postgres";
import { createApi } from "./api.ts";
import { anyUser, createAuth, createAuthenticate, isActive } from "./auth.ts";
import * as schema from "./db/schema.ts";
import type { Mail } from "./mail.ts";
import { createRegistry, deleteRepository, type RegistryDeps } from "./registry.ts";
import { createTokenCodec } from "./token.ts";

// Real better-auth, real API keys, real tokens, all against TEST_DATABASE_URL. Without it the suite is skipped.
// The database must be empty: the first sign-in on an empty registry becomes admin, and the suite depends on that.
const databaseUrl = process.env.TEST_DATABASE_URL;
const SECRET = "auth-test-secret-auth-test-secret-0123";
const PUBLIC = "http://registry.test";
const ABC_SHA256 = "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const MANIFEST = JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json" });
const MANIFEST_HEADERS = { "content-type": "application/vnd.oci.image.manifest.v1+json" };

const testServer = { timeout() {} } as unknown as import("bun").Server<undefined>;
// Keeps written objects in memory, so image configs can be read back.
const objects = new Map<string, ArrayBuffer>();
const fakeStorage = {
  write: async (key: string, body: Blob) => {
    objects.set(key, await body.arrayBuffer());
  },
  file: (key: string) => ({
    arrayBuffer: async () => {
      const object = objects.get(key);
      if (!object) throw new Error(`no object ${key}`);
      return object;
    },
  }),
} as unknown as S3Client;

const suffix = () => crypto.randomUUID().slice(0, 8);
const basic = (password: string) => `Basic ${Buffer.from(`anyone:${password}`).toString("base64")}`;
const bearer = (token: string) => `Bearer ${token}`;
const claimsOf = (jwt: string) =>
  JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8")) as {
    sub: string | null;
    access: { type: string; name: string; actions: string[] }[];
  };

// Pure rule, so it needs no database.
test("a ban locks a user out until its expiry, and for good when it has none", () => {
  expect(isActive({ banned: false, banExpires: null })).toBe(true);
  expect(isActive({ banned: true, banExpires: null })).toBe(false);
  expect(isActive({ banned: true, banExpires: new Date(Date.now() + 60_000) })).toBe(false);
  expect(isActive({ banned: true, banExpires: new Date(Date.now() - 60_000) })).toBe(true);
});

describe.skipIf(!databaseUrl)("real authentication", () => {
  let db: BunSQLDatabase;
  let auth: ReturnType<typeof createAuth>;
  let registry: ReturnType<typeof createRegistry>;
  let api: ReturnType<typeof createApi>;
  let spoolDir: string;
  let adminEmail: string;
  let adminCookie: string;
  let firstRun: { statuses: number[]; loserEmail: string; rejected: unknown };
  let dev: { id: string; email: string; cookie: string };
  let readWriteKey: string;
  let readOnlyKey: string;
  let writeOnlyKey: string;

  // Mail is captured instead of sent. Codes go out in the background, so a test waits for those tasks before reading the mail.
  const sent: Mail[] = [];
  const background: Promise<unknown>[] = [];
  const settle = async () => {
    await Promise.all(background.splice(0));
  };
  const codeFor = (email: string) => {
    const code = sent.findLast((m) => m.to === email)?.text.match(/sign-in code: (\d{6})/)?.[1];
    if (!code) throw new Error(`no sign-in code was sent to ${email}`);
    return code;
  };
  const inviteTokenFor = (email: string) => {
    const token = sent.findLast((m) => m.to === email)?.text.match(/token=([A-Za-z0-9_-]+)/)?.[1];
    if (!token) throw new Error(`no invite was mailed to ${email}`);
    return token;
  };

  // Each call is a new client address, so the per-address limits on /api/auth never bite across tests.
  let clientSeq = 0;
  const newClient = (): Record<string, string> => ({
    "x-forwarded-for": `10.${(++clientSeq >> 16) & 255}.${(clientSeq >> 8) & 255}.${clientSeq & 255}`,
  });

  const send = (req: Request) => registry.fetch(req, { server: testServer });
  const get = (path: string, authorization?: string) =>
    send(new Request(`${PUBLIC}${path}`, { headers: authorization ? { authorization } : {} }));
  const putManifest = (name: string, reference: string, authorization?: string) =>
    send(
      new Request(`${PUBLIC}/v2/${name}/manifests/${reference}`, {
        method: "PUT",
        body: MANIFEST,
        headers: { ...MANIFEST_HEADERS, ...(authorization ? { authorization } : {}) },
      }),
    );
  const json = (res: Response) => res.json() as Promise<Record<string, any>>;
  const cookieOf = (res: Response) =>
    res.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; ");

  // Calls the web API the way a browser does. A cookie makes it a signed-in call.
  const web = (
    method: string,
    path: string,
    options: { body?: unknown; cookie?: string; client?: Record<string, string> } = {},
  ) =>
    api.fetch(
      new Request(`${PUBLIC}${path}`, {
        method,
        headers: {
          origin: PUBLIC,
          ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
          ...(options.cookie ? { cookie: options.cookie } : {}),
          ...(options.client ?? newClient()),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      }),
    );

  // Asks for a sign-in code. The reply is the same whether or not a code is sent.
  const requestCode = (email: string, client?: Record<string, string>) =>
    web("POST", "/api/auth/email-otp/send-verification-otp", { body: { email, type: "sign-in" }, client });
  const submitCode = (email: string, otp: string, client?: Record<string, string>) =>
    web("POST", "/api/auth/sign-in/email-otp", { body: { email, otp }, client });

  // Signs in with a code through the real routes and returns the session cookie.
  async function signIn(email: string): Promise<string> {
    await requestCode(email);
    await settle();
    const res = await submitCode(email, codeFor(email));
    if (res.status !== 200) throw new Error(`sign-in failed with ${res.status}`);
    return cookieOf(res);
  }

  const idOf = async (email: string) => {
    const [row] = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, email)).limit(1);
    return row.id;
  };

  // Makes a member the way a person gets one: an admin invites the address, then the person signs in with a code.
  async function joinAsMember(label: string): Promise<{ id: string; email: string; cookie: string }> {
    const email = `${label}-${suffix()}@example.test`;
    const invited = await web("POST", "/api/invites", { body: { email, role: "user" }, cookie: adminCookie });
    expect(invited.status).toBe(200);
    const cookie = await signIn(email);
    return { id: await idOf(email), email, cookie };
  }

  const listInvites = async () =>
    (await web("GET", "/api/invites", { cookie: adminCookie })).json() as Promise<
      { id: string; email: string; role: string; invitedBy: string }[]
    >;

  // Makes an API key for a user. Without permissions it gets the plugin's defaults, which are read and write.
  const mintKey = async (userId: string, permissions?: Record<string, string[]>) =>
    (await auth.api.createApiKey({ body: { userId, name: "test", permissions } })).key;

  // Asks the token endpoint for a token. Without credentials the request is anonymous.
  const tokenFor = (scope: string, authorization?: string) => {
    const url = new URL(`${PUBLIC}/token`);
    url.searchParams.append("scope", scope);
    return send(new Request(url, { headers: authorization ? { authorization } : {} }));
  };

  beforeAll(async () => {
    db = drizzle(databaseUrl!);
    await migrate(db, { migrationsFolder: join(import.meta.dir, "../drizzle") });
    if (await anyUser(db)) throw new Error("TEST_DATABASE_URL must point at an empty database");
    spoolDir = await mkdtemp(join(tmpdir(), "imagine-auth-test-"));
    auth = createAuth({
      db,
      baseURL: PUBLIC,
      secret: SECRET,
      sendMail: async (mail) => {
        sent.push(mail);
      },
      runInBackground: (task) => {
        background.push(task);
      },
    });
    const tokens = createTokenCodec(SECRET);
    const deps: RegistryDeps = {
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
      publicUrl: PUBLIC,
      presignTtlSeconds: 60,
      maxBlobBytes: 1000,
      authenticate: createAuthenticate({ auth, db, tokens }),
      tokens,
    };
    registry = createRegistry(deps);
    api = createApi({
      db,
      auth,
      sendMail: async (mail) => {
        sent.push(mail);
      },
      storage: fakeStorage,
      publicUrl: PUBLIC,
    });

    // First run: two people sign in at once to an empty registry. Both codes are sent while nobody exists yet.
    const first = `first-${suffix()}@example.test`;
    const second = `second-${suffix()}@example.test`;
    await requestCode(first);
    await requestCode(second);
    await settle();
    const results = await Promise.all([submitCode(first, codeFor(first)), submitCode(second, codeFor(second))]);
    const winner = results.findIndex((res) => res.status === 200);
    adminEmail = [first, second][winner];
    adminCookie = cookieOf(results[winner]);
    firstRun = {
      statuses: results.map((res) => res.status).sort(),
      loserEmail: [first, second][1 - winner],
      rejected: await json(results[1 - winner]),
    };

    dev = await joinAsMember("dev");
    readWriteKey = await mintKey(dev.id);
    readOnlyKey = await mintKey(dev.id, { registry: ["read"] });
    writeOnlyKey = await mintKey(dev.id, { registry: ["write"] });
  });

  test("on an empty registry, two sign-ins at once make exactly one admin", async () => {
    expect(firstRun.statuses).toEqual([200, 403]);
    expect(firstRun.rejected).toEqual({ code: "INVITE_REQUIRED", message: "Sign-up is by invite only" });
    const accounts = await db.select({ email: schema.user.email, role: schema.user.role }).from(schema.user);
    expect(accounts.filter((a) => a.role === "admin")).toEqual([{ email: adminEmail, role: "admin" }]);
    expect(accounts.map((a) => a.email)).not.toContain(firstRun.loserEmail);
  });

  test("GET /api/meta reports the host and that setup is done once a user exists", async () => {
    expect(await json(await web("GET", "/api/meta"))).toEqual({ host: "registry.test", needsSetup: false });
  });

  test("an address with no account and no invite gets the same reply but no code, and cannot sign up", async () => {
    const stranger = `stranger-${suffix()}@example.test`;
    const reply = await requestCode(stranger);
    expect(reply.status).toBe(200);
    expect(await json(reply)).toEqual({ success: true });
    await settle();
    expect(sent.some((m) => m.to === stranger)).toBe(false);

    // With no code on record, a guess fails and no account is created.
    const guess = await submitCode(stranger, "123456");
    expect(guess.status).toBe(400);
    expect(await json(guess)).toEqual({ code: "INVALID_OTP", message: "Invalid OTP" });
    expect(await db.select().from(schema.user).where(eq(schema.user.email, stranger))).toEqual([]);
  });

  test("an invite is mailed, its token is not stored, and signing in makes an account with the invited role", async () => {
    for (const role of ["user", "admin"] as const) {
      const email = `${role}-invitee-${suffix()}@example.test`;
      const created = await web("POST", "/api/invites", { body: { email, role }, cookie: adminCookie });
      expect(created.status).toBe(200);
      const invite = await json(created);
      expect(invite).toEqual({ id: expect.any(String), email, role, expiresAt: expect.any(String) });

      const token = inviteTokenFor(email);
      const mailed = sent.findLast((m) => m.to === email)?.text ?? "";
      expect(mailed).toContain(`You've been invited to Imagine as ${role}: ${PUBLIC}/invite?token=`);
      expect(await json(await web("GET", `/api/invites/lookup?token=${token}`))).toEqual({ email, role });
      const [stored] = await db.select().from(schema.invites).where(eq(schema.invites.id, invite.id));
      expect(stored.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));

      const cookie = await signIn(email);
      const [account] = await db.select({ role: schema.user.role }).from(schema.user).where(eq(schema.user.email, email));
      expect(account.role).toBe(role);
      const [accepted] = await db
        .select({ acceptedAt: schema.invites.acceptedAt })
        .from(schema.invites)
        .where(eq(schema.invites.id, invite.id));
      expect(accepted.acceptedAt).not.toBeNull();

      // The invite is used up, and the account works.
      expect((await web("GET", `/api/invites/lookup?token=${token}`)).status).toBe(404);
      expect((await web("GET", "/api/repositories", { cookie })).status).toBe(200);
    }
  });

  test("only an admin may invite or list invites, and an existing account cannot be invited again", async () => {
    const target = `target-${suffix()}@example.test`;
    expect((await web("POST", "/api/invites", { body: { email: target, role: "user" }, cookie: dev.cookie })).status).toBe(403);
    expect((await web("GET", "/api/invites", { cookie: dev.cookie })).status).toBe(403);
    expect((await web("POST", "/api/invites", { body: { email: target, role: "user" } })).status).toBe(401);
    expect((await web("POST", "/api/invites", { body: { email: dev.email, role: "user" }, cookie: adminCookie })).status).toBe(409);
    expect((await web("POST", "/api/invites", { body: { email: target, role: "owner" }, cookie: adminCookie })).status).toBe(400);
  });

  test("a new invite replaces the pending one for that email, and revoking an invite ends it", async () => {
    const email = `replaced-${suffix()}@example.test`;
    await web("POST", "/api/invites", { body: { email, role: "user" }, cookie: adminCookie });
    const oldToken = inviteTokenFor(email);
    const replacement = await json(await web("POST", "/api/invites", { body: { email, role: "admin" }, cookie: adminCookie }));
    const newToken = inviteTokenFor(email);

    const pending = (await listInvites()).filter((i) => i.email === email);
    expect(pending).toEqual([expect.objectContaining({ id: replacement.id, role: "admin", invitedBy: adminEmail })]);
    expect((await web("GET", `/api/invites/lookup?token=${oldToken}`)).status).toBe(404);

    expect((await web("DELETE", `/api/invites?id=${replacement.id}`, { cookie: adminCookie })).status).toBe(200);
    expect((await web("GET", `/api/invites/lookup?token=${newToken}`)).status).toBe(404);
    expect((await web("DELETE", `/api/invites?id=${replacement.id}`, { cookie: adminCookie })).status).toBe(404);
    expect((await web("DELETE", "/api/invites?id=not-a-uuid", { cookie: adminCookie })).status).toBe(400);
  });

  test("an expired invite cannot be looked up, is not listed, and gets no code", async () => {
    const email = `expired-${suffix()}@example.test`;
    const invite = await json(await web("POST", "/api/invites", { body: { email, role: "user" }, cookie: adminCookie }));
    const token = inviteTokenFor(email);
    await db.update(schema.invites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.invites.id, invite.id));

    expect((await web("GET", `/api/invites/lookup?token=${token}`)).status).toBe(404);
    expect((await listInvites()).some((i) => i.id === invite.id)).toBe(false);

    const before = sent.length;
    expect((await requestCode(email)).status).toBe(200);
    await settle();
    expect(sent.slice(before).some((m) => m.to === email)).toBe(false);
    expect((await submitCode(email, "123456")).status).toBe(400);
  });

  test("a code expires ten minutes after it is sent", async () => {
    const member = await joinAsMember("expiry");
    await requestCode(member.email);
    await settle();
    const code = codeFor(member.email);

    const [stored] = await db
      .select({ expiresAt: schema.verification.expiresAt })
      .from(schema.verification)
      .where(eq(schema.verification.identifier, `sign-in-otp-${member.email}`));
    const ttl = stored.expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(590_000);
    expect(ttl).toBeLessThanOrEqual(600_000);

    await db
      .update(schema.verification)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.verification.identifier, `sign-in-otp-${member.email}`));
    const expired = await submitCode(member.email, code);
    expect(expired.status).toBe(400);
    expect(await json(expired)).toEqual({ code: "OTP_EXPIRED", message: "OTP expired" });
  });

  test("three wrong codes use up the code, so a fourth attempt is refused even with the right one", async () => {
    const member = await joinAsMember("guess");
    await requestCode(member.email);
    await settle();
    const right = codeFor(member.email);
    const wrong = right === "000000" ? "111111" : "000000";

    for (let i = 0; i < 3; i++) {
      const res = await submitCode(member.email, wrong);
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({ code: "INVALID_OTP", message: "Invalid OTP" });
    }
    const refused = await submitCode(member.email, right);
    expect(refused.status).toBe(403);
    expect(await json(refused)).toEqual({ code: "TOO_MANY_ATTEMPTS", message: "Too many attempts" });
  });

  test("a rate-limited auth request gets 429 with Retry-After in whole seconds, mirrored in X-Retry-After", async () => {
    const email = `burst-${suffix()}@example.test`;
    const client = { "x-forwarded-for": "10.9.9.9" };
    // The built-in limit allows three code requests a minute from one address.
    for (let i = 0; i < 3; i++) expect((await requestCode(email, client)).status).toBe(200);

    const limited = await requestCode(email, client);
    expect(limited.status).toBe(429);
    const retryAfter = limited.headers.get("retry-after");
    expect(retryAfter).toMatch(/^\d+$/);
    expect(Number(retryAfter)).toBeGreaterThan(0);
    expect(Number(retryAfter)).toBeLessThanOrEqual(60);
    expect(limited.headers.get("x-retry-after")).toBe(retryAfter);
    expect(((await limited.json()) as { retryAfter: number }).retryAfter).toBe(Number(retryAfter));
  });

  test("only an admin may change visibility, and the management API needs a session cookie", async () => {
    const repo = `vis-${suffix()}`;
    expect((await putManifest(repo, "v1", basic(readWriteKey))).status).toBe(201);
    const patch = (cookie: string | undefined) =>
      api.fetch(
        new Request(`${PUBLIC}/api/repositories/visibility`, {
          method: "PATCH",
          headers: { "content-type": "application/json", origin: PUBLIC, ...(cookie ? { cookie } : {}) },
          body: JSON.stringify({ name: repo, visibility: "public" }),
        }),
      );

    expect((await patch(dev.cookie)).status).toBe(403);
    expect((await patch(undefined)).status).toBe(401);
    const allowed = await patch(adminCookie);
    expect(allowed.status).toBe(200);
    expect(await json(allowed)).toEqual({ name: repo, visibility: "public" });

    // A personal access token is not accepted by the management API.
    const withKey = await api.fetch(new Request(`${PUBLIC}/api/repositories`, { headers: { "x-api-key": readWriteKey } }));
    expect(withKey.status).toBe(401);
  });

  test("POST /api/tokens makes a read-only key that can pull but not push", async () => {
    const create = (body: unknown) =>
      api.fetch(
        new Request(`${PUBLIC}/api/tokens`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: PUBLIC, cookie: dev.cookie },
          body: JSON.stringify(body),
        }),
      );

    const res = await create({ name: "ci", access: "read" });
    expect(res.status).toBe(200);
    const key = (await json(res)) as { key: string; permissions: unknown };
    expect(key.permissions).toEqual({ registry: ["read"] });

    const repo = `tok-${suffix()}`;
    expect((await putManifest(repo, "v1", basic(readWriteKey))).status).toBe(201);
    expect((await get(`/v2/${repo}/manifests/v1`, basic(key.key))).status).toBe(200);
    expect((await putManifest(repo, "v2", basic(key.key))).status).toBe(401);

    // better-auth refuses an expiry out of range. That refusal reaches the caller as a 400, not a server error.
    expect((await create({ access: "read", expiresIn: 60 })).status).toBe(400);
    expect((await create({ access: "admin" })).status).toBe(400);
  });

  test("anonymous callers get a pull token only for a public repository", async () => {
    const repo = `pub-${suffix()}`;
    expect((await putManifest(repo, "v1", basic(readWriteKey))).status).toBe(201);
    const scope = `repository:${repo}:pull,push`;

    // Anonymous token requests succeed, but a private repository gets no grant.
    const anonymousPrivate = await tokenFor(scope);
    expect(anonymousPrivate.status).toBe(200);
    const privateToken = (await json(anonymousPrivate)).token as string;
    expect(claimsOf(privateToken).access).toEqual([]);
    expect((await get(`/v2/${repo}/manifests/v1`)).status).toBe(401);

    await db.update(schema.repositories).set({ visibility: "public" }).where(eq(schema.repositories.name, repo));
    const publicToken = (await json(await tokenFor(scope))).token as string;
    expect(claimsOf(publicToken).access).toEqual([{ type: "repository", name: repo, actions: ["pull"] }]);
    expect((await get(`/v2/${repo}/manifests/v1`, bearer(publicToken))).status).toBe(200);
    expect((await get(`/v2/${repo}/manifests/v1`)).status).toBe(200);

    const push = await putManifest(repo, "v2", bearer(publicToken));
    expect(push.status).toBe(401);
    expect(push.headers.get("www-authenticate")).toContain(`scope="repository:${repo}:pull,push"`);
  });

  test("a read-only key gets a pull-only token, so a push is refused with the scope Docker must ask for", async () => {
    const repo = `ro-${suffix()}`;
    expect((await putManifest(repo, "v1", basic(readWriteKey))).status).toBe(201);

    const res = await tokenFor(`repository:${repo}:pull,push`, basic(readOnlyKey));
    expect(res.status).toBe(200);
    const token = (await json(res)).token as string;
    expect(claimsOf(token).access).toEqual([{ type: "repository", name: repo, actions: ["pull"] }]);
    expect((await get(`/v2/${repo}/manifests/v1`, bearer(token))).status).toBe(200);

    const denied = await putManifest(repo, "v2", bearer(token));
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain(`scope="repository:${repo}:pull,push"`);
    expect((await json(denied)).errors[0].code).toBe("UNAUTHORIZED");

    // Basic credentials sent straight to /v2 get the same limits as a token.
    expect((await putManifest(repo, "v3", basic(readOnlyKey))).status).toBe(401);
  });

  test("a token signed with another secret never grants access, even to a public repository", async () => {
    const repo = `forged-${suffix()}`;
    expect((await putManifest(repo, "v1", basic(readWriteKey))).status).toBe(201);
    await db.update(schema.repositories).set({ visibility: "public" }).where(eq(schema.repositories.name, repo));
    const forged = createTokenCodec("another-secret-another-secret-0000").issue(null, [
      { name: repo, actions: ["pull", "push"] },
    ]);
    expect((await get(`/v2/${repo}/manifests/v1`)).status).toBe(200);
    expect((await get(`/v2/${repo}/manifests/v1`, bearer(forged))).status).toBe(401);
  });

  test("a key and the tokens issued to it stop working when the owner is banned, and the key is gone once the user is removed", async () => {
    const victim = await joinAsMember("victim");
    const victimKey = await mintKey(victim.id);
    const repo = `owned-${suffix()}`;
    expect((await putManifest(repo, "v1", basic(readWriteKey))).status).toBe(201);

    const token = (await json(await tokenFor(`repository:${repo}:pull`, basic(victimKey)))).token as string;
    expect((await get(`/v2/${repo}/manifests/v1`, bearer(token))).status).toBe(200);
    expect((await get("/v2/", basic(victimKey))).status).toBe(200);

    const banAdmin = (path: string, body: unknown) => web("POST", `/api/auth${path}`, { body, cookie: adminCookie });
    expect((await banAdmin("/admin/ban-user", { userId: victim.id })).status).toBe(200);
    expect((await get("/v2/", basic(victimKey))).status).toBe(401);
    expect((await get(`/v2/${repo}/manifests/v1`, bearer(token))).status).toBe(401);
    expect((await tokenFor(`repository:${repo}:pull`, basic(victimKey))).status).toBe(401);
    expect((await api.fetch(new Request(`${PUBLIC}/api/repositories`, { headers: { cookie: victim.cookie } }))).status).toBe(401);

    // A banned user gets no sign-in code.
    const sentBefore = sent.length;
    await requestCode(victim.email);
    await settle();
    expect(sent.slice(sentBefore).some((m) => m.to === victim.email)).toBe(false);

    expect((await banAdmin("/admin/unban-user", { userId: victim.id })).status).toBe(200);
    expect((await get("/v2/", basic(victimKey))).status).toBe(200);

    expect((await banAdmin("/admin/remove-user", { userId: victim.id })).status).toBe(200);
    expect((await get("/v2/", basic(victimKey))).status).toBe(401);
    const left = await db.select({ id: schema.apikey.id }).from(schema.apikey).where(eq(schema.apikey.referenceId, victim.id));
    expect(left).toEqual([]);
  });

  test("a cross-repository mount needs pull on the source, so a write-only key gets a normal upload instead", async () => {
    const source = `src-${suffix()}`;
    const target = `dst-${suffix()}`;
    const seeded = await send(
      new Request(`${PUBLIC}/v2/${source}/blobs/uploads/?digest=${ABC_SHA256}`, {
        method: "POST",
        body: "abc",
        headers: { authorization: basic(readWriteKey) },
      }),
    );
    expect(seeded.status).toBe(201);

    const mountUrl = `${PUBLIC}/v2/${target}/blobs/uploads/?mount=${ABC_SHA256}&from=${source}`;
    const writeOnly = await send(new Request(mountUrl, { method: "POST", headers: { authorization: basic(writeOnlyKey) } }));
    expect(writeOnly.status).toBe(202);
    const readWrite = await send(new Request(mountUrl, { method: "POST", headers: { authorization: basic(readWriteKey) } }));
    expect(readWrite.status).toBe(201);
  });

  const sha256 = (content: string) => `sha256:${createHash("sha256").update(content).digest("hex")}`;
  const pushBlob = (repo: string, content: string) =>
    send(
      new Request(`${PUBLIC}/v2/${repo}/blobs/uploads/?digest=${sha256(content)}`, {
        method: "POST",
        body: content,
        headers: { authorization: basic(readWriteKey) },
      }),
    );
  const pushManifest = (repo: string, reference: string, body: object & { mediaType: string }) =>
    send(
      new Request(`${PUBLIC}/v2/${repo}/manifests/${reference}`, {
        method: "PUT",
        body: JSON.stringify(body),
        headers: { "content-type": body.mediaType, authorization: basic(readWriteKey) },
      }),
    );
  const descriptor = (content: string) => ({ mediaType: "application/octet-stream", digest: sha256(content), size: content.length });

  // Pushes a single-platform image and returns its digest and blob contents.
  async function pushImage(repo: string, reference: string | undefined, arch: string, layer: string) {
    const config = JSON.stringify({ os: "linux", architecture: arch });
    for (const blob of [config, layer]) expect((await pushBlob(repo, blob)).status).toBe(201);
    const manifest = {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: descriptor(config),
      layers: [descriptor(layer)],
    };
    const digest = sha256(JSON.stringify(manifest));
    expect((await pushManifest(repo, reference ?? digest, manifest)).status).toBe(201);
    return { digest, config, manifest };
  }

  test("sizes count shared layers once, and platforms come from the index or the image config", async () => {
    const repo = `sizes-${suffix()}`;
    const layer = `layer-${suffix()}`;
    const amd = await pushImage(repo, "single", "amd64", layer);
    const arm = await pushImage(repo, undefined, "arm64", layer);
    const child = (digest: string, platform?: object) => ({
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest,
      size: 1,
      platform,
    });
    const index = {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [
        child(amd.digest, { os: "linux", architecture: "amd64" }),
        child(arm.digest, { os: "linux", architecture: "arm64", variant: "v8" }),
        child(arm.digest, { os: "unknown", architecture: "unknown" }),
        child(arm.digest),
      ],
    };
    expect((await pushManifest(repo, "multi", index)).status).toBe(201);

    const both = layer.length + amd.config.length + arm.config.length;
    const tagRows = (await (
      await web("GET", `/api/repositories/tags?name=${repo}`, { cookie: dev.cookie })
    ).json()) as { tag: string; size: number; digest: string }[];
    expect(tagRows.map((t) => [t.tag, t.size])).toEqual([
      ["multi", both],
      ["single", layer.length + amd.config.length],
    ]);
    const repoRows = (await (await web("GET", "/api/repositories", { cookie: dev.cookie })).json()) as {
      name: string;
      size: number;
      createdAt: string;
    }[];
    expect(repoRows.find((row) => row.name === repo)).toMatchObject({ size: both, createdAt: expect.any(String) });

    const indexDigest = sha256(JSON.stringify(index));
    const platforms = (digests: string[], name = repo) =>
      web("GET", `/api/repositories/platforms?name=${name}&${digests.map((d) => `digest=${d}`).join("&")}`, {
        cookie: dev.cookie,
      });
    expect(await json(await platforms([indexDigest, amd.digest]))).toEqual({
      [indexDigest]: ["linux/amd64", "linux/arm64/v8"],
      [amd.digest]: ["linux/amd64"],
    });
    // Another repository's digests say nothing, and an unreadable config hides only the platform.
    expect(await json(await platforms([amd.digest], "elsewhere"))).toEqual({});
    objects.delete(`blobs/${sha256(amd.config).replace(":", "/")}`);
    expect(await json(await platforms([amd.digest]))).toEqual({ [amd.digest]: [] });
    expect((await platforms(Array(26).fill(indexDigest))).status).toBe(400);
    expect((await web("GET", `/api/repositories/platforms?name=${repo}&digest=${indexDigest}`)).status).toBe(401);
  });

  test("a NUL in a name, tag, digest or artifact type is refused as bad input", async () => {
    for (const [method, path] of [
      ["GET", "/api/repositories/tags?name=%00"],
      ["DELETE", "/api/repositories?name=%00"],
      ["DELETE", "/api/repositories/tags?name=a&tag=%00"],
      ["GET", "/api/repositories/platforms?name=a&digest=%00"],
    ]) {
      expect((await web(method, path, { cookie: adminCookie })).status).toBe(400);
    }
    const nul = { schemaVersion: 2, mediaType: MANIFEST_HEADERS["content-type"], artifactType: "\0" };
    expect((await pushManifest(`nul-${suffix()}`, "v1", nul)).status).toBe(400);
  });

  test("deleting a tag is for admins, and leaves its manifest and the other tags", async () => {
    const repo = `untag-${suffix()}`;
    const { digest, manifest } = await pushImage(repo, "v1", "amd64", "x");
    expect((await pushManifest(repo, "latest", manifest)).status).toBe(201);
    const remove = (tag: string, cookie?: string) =>
      web("DELETE", `/api/repositories/tags?name=${repo}&tag=${tag}`, { cookie });

    expect((await remove("v1")).status).toBe(401);
    expect((await remove("v1", dev.cookie)).status).toBe(403);
    expect(await json(await remove("v1", adminCookie))).toEqual({ tag: "v1", digest });
    expect((await remove("v1", adminCookie)).status).toBe(404);
    expect((await get(`/v2/${repo}/manifests/v1`, basic(readWriteKey))).status).toBe(404);
    expect((await get(`/v2/${repo}/manifests/latest`, basic(readWriteKey))).status).toBe(200);
    expect((await remove("latest", adminCookie)).status).toBe(200);
    expect((await get(`/v2/${repo}/manifests/${digest}`, basic(readWriteKey))).status).toBe(200);
  });

  test("deleting an image is for admins, removes all of it and nothing else, and the name can be pushed again as private", async () => {
    const repo = `gone-${suffix()}`;
    const other = `kept-${suffix()}`;
    const layer = `shared-${suffix()}`;
    const { digest } = await pushImage(repo, "v1", "amd64", layer);
    await pushImage(other, "v1", "amd64", layer);
    await web("PATCH", "/api/repositories/visibility", { body: { name: repo, visibility: "public" }, cookie: adminCookie });
    const started = await send(
      new Request(`${PUBLIC}/v2/${repo}/blobs/uploads/`, { method: "POST", headers: { authorization: basic(readWriteKey) } }),
    );
    const upload = new URL(started.headers.get("location")!, PUBLIC);
    const remove = (cookie?: string) => web("DELETE", `/api/repositories?name=${repo}`, { cookie });

    expect((await remove()).status).toBe(401);
    expect((await remove(dev.cookie)).status).toBe(403);
    expect(await json(await remove(adminCookie))).toEqual({ name: repo, tagCount: 1 });
    expect((await remove(adminCookie)).status).toBe(404);
    for (const path of ["manifests/v1", `manifests/${digest}`, `blobs/${sha256(layer)}`]) {
      expect((await get(`/v2/${repo}/${path}`, basic(readWriteKey))).status).toBe(404);
    }
    expect((await get(`/v2/${other}/blobs/${sha256(layer)}`, basic(readWriteKey))).status).toBe(307);
    expect((await get(`/v2/${other}/manifests/v1`, basic(readWriteKey))).status).toBe(200);

    // The open upload ended with the repository.
    const resumed = await send(
      new Request(upload, { method: "PATCH", body: "abc", headers: { authorization: basic(readWriteKey) } }),
    );
    expect(resumed.status).toBe(404);

    await pushImage(repo, "v2", "amd64", layer);
    expect((await get(`/v2/${repo}/manifests/v2`)).status).toBe(401);
  });

  test("pushes and deletes of the same repository at once never deadlock or fail with a server error", async () => {
    const repo = `race-${suffix()}`;
    const statuses: number[] = [];
    for (let round = 0; round < 15; round++) {
      const results = await Promise.all([
        pushBlob(repo, `a-${round}`),
        putManifest(repo, "v1", basic(readWriteKey)),
        deleteRepository(db, repo).then(() => new Response()),
        putManifest(repo, "v2", basic(readWriteKey)),
        pushBlob(repo, `b-${round}`),
      ]);
      statuses.push(...results.map((res) => res.status));
    }
    // A push that loses to the delete may find its upload gone.
    expect(statuses.filter((status) => ![200, 201, 404].includes(status))).toEqual([]);
  });

  test("the last working admin cannot be removed, demoted or banned, by any admin route", async () => {
    const adminId = await idOf(adminEmail);
    // Earlier tests made other admins. Only this one is left.
    await db.update(schema.user).set({ role: "user" }).where(eq(schema.user.role, "admin"));
    await db.update(schema.user).set({ role: "admin" }).where(eq(schema.user.id, adminId));
    const banned = await joinAsMember("banned-admin");
    await db.update(schema.user).set({ role: "admin", banned: true }).where(eq(schema.user.id, banned.id));
    const call = (path: string, body: unknown) => web("POST", `/api/auth/admin/${path}`, { body, cookie: adminCookie });

    for (const [path, body] of [
      ["set-role", { userId: adminId, role: "user" }],
      ["set-role", { userId: adminId, role: ["user"] }],
      ["update-user", { userId: adminId, data: { role: "user" } }],
      ["update-user", { userId: adminId, data: { banned: true } }],
      ["update-user", { userId: adminId, data: { banExpires: null } }],
      ["ban-user", { userId: adminId }],
      ["remove-user", { userId: adminId }],
    ] as const) {
      const res = await call(path, body);
      expect(res.status).toBe(400);
      expect((await json(res)).code).toBe("LAST_ADMIN");
    }

    // With a second admin, the first may step down.
    expect((await call("set-role", { userId: dev.id, role: "admin" })).status).toBe(200);
    expect((await call("set-role", { userId: adminId, role: "user" })).status).toBe(200);
    expect((await web("GET", "/api/users", { cookie: adminCookie })).status).toBe(403);
    await db.update(schema.user).set({ role: "admin" }).where(eq(schema.user.id, adminId));
    await db.update(schema.user).set({ role: "user" }).where(eq(schema.user.id, dev.id));
  });

  test("GET /api/users is for admins and reports when each user was last active", async () => {
    expect((await web("GET", "/api/users", { cookie: dev.cookie })).status).toBe(403);
    const rows = (await (await web("GET", "/api/users", { cookie: adminCookie })).json()) as {
      id: string;
      active: boolean;
      lastActiveAt: string | null;
    }[];
    const row = rows.find((user) => user.id === dev.id);
    expect(row).toMatchObject({ email: dev.email, role: "user", active: true });
    expect(Date.now() - Date.parse(row!.lastActiveAt!)).toBeLessThan(5 * 60_000);
  });
});
