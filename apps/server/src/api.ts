import type { S3Client } from "bun";
import { isAPIError } from "better-auth/api";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql/postgres";
import { Hono, type Context, type Next } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { validator } from "hono/validator";
import { z } from "zod";
import { anyUser, isActive, isAdminRole, type Auth } from "./auth.ts";
import {
  apikey,
  blobs,
  invites,
  inviteRole,
  manifests,
  repositories,
  repositoryBlobs,
  session,
  tags,
  user,
  visibility,
} from "./db/schema.ts";
import { hashInviteToken, isPending, newInviteToken, pendingInviteForToken } from "./invites.ts";
import type { SendMail } from "./mail.ts";
import { platformsOf } from "./platforms.ts";
import { deleteRepository, digestSchema, nameSchema, tagSchema } from "./registry.ts";

type Env = { Variables: { userId: string; role: string | null | undefined } };

const nameQuery = z.object({ name: nameSchema });
const tagQuery = z.object({ name: nameSchema, tag: tagSchema });
// One page of tags at a time, because each single-platform image costs a read from storage.
const MAX_PLATFORM_DIGESTS = 25;
const platformsQuery = z.object({
  name: nameSchema,
  // A single digest arrives as a string.
  digest: z.preprocess(
    (value) => (typeof value === "string" ? [value] : value),
    z.array(digestSchema).min(1).max(MAX_PLATFORM_DIGESTS),
  ),
});
const visibilityBody = z.object({ name: nameSchema, visibility: z.enum(visibility.enumValues) });
const tokenBody = z.object({
  name: z.string().min(1).max(32).optional(),
  expiresIn: z.number().int().positive().optional(),
  access: z.enum(["read", "read-write"]),
});
// better-auth accepts permissions only from the server, so this route is how a read-only personal access token is made.
const tokenPermissions = { read: { registry: ["read"] }, "read-write": { registry: ["read", "write"] } };
const inviteBody = z.object({ email: z.email(), role: z.enum(inviteRole.enumValues) });
const inviteQuery = z.object({ id: z.uuid() });

// better-auth answers a rate-limited request with X-Retry-After, in seconds. Add the standard Retry-After, and put the
// seconds in the body as retryAfter, because the better-auth client exposes only the body and status.
async function withStandardRetryAfter(res: Response): Promise<Response> {
  const seconds = res.headers.get("x-retry-after");
  if (res.status !== 429 || !seconds) return res;
  const body = await res.json().catch(() => ({}));
  const headers = new Headers(res.headers);
  headers.set("retry-after", seconds);
  headers.delete("content-length");
  return Response.json({ ...body, retryAfter: Number(seconds) }, { status: 429, headers });
}

// The web UI's API, served under /api. better-auth serves sign-in, users and personal access tokens under /api/auth.
export function createApi(deps: {
  db: BunSQLDatabase;
  auth: Auth;
  sendMail: SendMail;
  storage: S3Client;
  publicUrl: string;
}) {
  const api = new Hono<Env>().basePath("/api");
  const baseUrl = deps.publicUrl.replace(/\/+$/, "");

  // Auth calls run one at a time, so two first-run sign-ins cannot both see an empty user table.
  // ponytail: one replica only, because the queue is in-process. Two replicas could both make an admin; use a database lock for more.
  let authQueue: Promise<unknown> = Promise.resolve();
  api.all("/auth/*", (c) => {
    const response = authQueue.then(() => deps.auth.handler(c.req.raw)).then(withStandardRetryAfter);
    authQueue = response.catch(() => {});
    return response;
  });

  // Repository and token routes need a browser session. Personal access tokens are not accepted here.
  const signedIn = async (c: Context<Env>, next: Next) => {
    const session = await deps.auth.api.getSession({ headers: c.req.raw.headers });
    if (!session || !isActive(session.user)) return c.json({ error: "sign in required" }, 401);
    c.set("userId", session.user.id);
    c.set("role", session.user.role);
    await next();
  };
  // A middleware rather than a check in the handler, so a non-admin gets 403 before the body is validated.
  const adminOnly = async (c: Context<Env>, next: Next) => {
    if (!isAdminRole(c.get("role"))) return c.json({ error: "admin role required" }, 403);
    await next();
  };
  api.use("/repositories/*", signedIn);
  api.use("/tokens", signedIn);
  api.use("/invites", signedIn, adminOnly);
  api.use("/users", signedIn, adminOnly);

  // The routes are chained so that their types reach the client through ApiType. Keep new routes in this chain.
  return api
    .get("/meta", async (c) =>
      c.json({ host: new URL(deps.publicUrl).host, needsSetup: !(await anyUser(deps.db)) }),
    )

    .get("/repositories", async (c) => {
      const rows = await deps.db
        .select({
          name: repositories.name,
          visibility: repositories.visibility,
          createdAt: repositories.createdAt,
          // Each blob is linked once per repository, so shared layers count once.
          size: sql<number>`(select coalesce(sum(${blobs.size}), 0) from ${repositoryBlobs} join ${blobs} on ${blobs.digest} = ${repositoryBlobs.blobDigest} where ${repositoryBlobs.repository} = ${repositories.name})`.mapWith(
            Number,
          ),
          tagCount: sql<number>`(select count(*) from ${tags} where ${tags.repository} = ${repositories.name})`.mapWith(
            Number,
          ),
          lastPushedAt: sql<Date | null>`(select max(${manifests.createdAt}) from ${manifests} where ${manifests.repository} = ${repositories.name})`,
        })
        .from(repositories)
        .orderBy(repositories.name);
      return c.json(rows);
    })

    // The repository name contains slashes, so it goes in the query string.
    // pushedAt is when the manifest was first pushed, not when the tag last moved.
    .get(
      "/repositories/tags",
      validator("query", (value, c) => {
        const query = nameQuery.safeParse(value);
        return query.success ? query.data : c.json({ error: "a valid name is required" }, 400);
      }),
      async (c) => {
        const { name } = c.req.valid("query");
        const rows = await deps.db
          .select({
            tag: tags.name,
            digest: manifests.digest,
            mediaType: manifests.mediaType,
            pushedAt: manifests.createdAt,
          })
          .from(tags)
          .innerJoin(
            manifests,
            and(eq(manifests.repository, tags.repository), eq(manifests.digest, tags.manifestDigest)),
          )
          .where(eq(tags.repository, name))
          .orderBy(tags.name);
        // Follows each tagged manifest to its children and blobs. The union drops repeats, so a layer that several
        // platforms share counts once.
        const sizes = await deps.db.execute<{ root: string; size: string }>(sql`
          with recursive reach(root, digest) as (
            select manifest_digest, manifest_digest from tags where repository = ${name}
            union
            select reach.root, refs.referenced_digest
            from reach
            join manifest_references refs on refs.repository = ${name} and refs.manifest_digest = reach.digest
          )
          select reach.root, sum(blobs.size)::text as size
          from reach join blobs on blobs.digest = reach.digest
          group by reach.root`);
        const sizeOf = new Map([...sizes].map((row) => [row.root, Number(row.size)]));
        return c.json(rows.map((row) => ({ ...row, size: sizeOf.get(row.digest) ?? 0 })));
      },
    )

    // Separate from the tag list, because a single-platform image names its platform only in its config blob in storage.
    .get(
      "/repositories/platforms",
      validator("query", (value, c) => {
        const query = platformsQuery.safeParse(value);
        return query.success
          ? query.data
          : c.json({ error: `a valid name and 1 to ${MAX_PLATFORM_DIGESTS} digests are required` }, 400);
      }),
      async (c) => {
        const { name, digest } = c.req.valid("query");
        return c.json(await platformsOf(deps.db, deps.storage, name, digest));
      },
    )

    .delete(
      "/repositories",
      adminOnly,
      validator("query", (value, c) => {
        const query = nameQuery.safeParse(value);
        return query.success ? query.data : c.json({ error: "a valid name is required" }, 400);
      }),
      async (c) => {
        const { name } = c.req.valid("query");
        const tagCount = await deleteRepository(deps.db, name);
        if (tagCount === undefined) return c.json({ error: "repository not found" }, 404);
        return c.json({ name, tagCount });
      },
    )

    // Only the tag goes. Its manifest stays and can still be pulled by digest.
    .delete(
      "/repositories/tags",
      adminOnly,
      validator("query", (value, c) => {
        const query = tagQuery.safeParse(value);
        return query.success ? query.data : c.json({ error: "a valid name and tag are required" }, 400);
      }),
      async (c) => {
        const { name, tag } = c.req.valid("query");
        const [row] = await deps.db
          .delete(tags)
          .where(and(eq(tags.repository, name), eq(tags.name, tag)))
          .returning({ tag: tags.name, digest: tags.manifestDigest });
        if (!row) return c.json({ error: "tag not found" }, 404);
        return c.json(row);
      },
    )

    .patch(
      "/repositories/visibility",
      adminOnly,
      validator("json", (value, c) => {
        const body = visibilityBody.safeParse(value);
        return body.success ? body.data : c.json({ error: "body must be { name, visibility }" }, 400);
      }),
      async (c) => {
        const body = c.req.valid("json");
        const [row] = await deps.db
          .update(repositories)
          .set({ visibility: body.visibility })
          .where(eq(repositories.name, body.name))
          .returning({ name: repositories.name, visibility: repositories.visibility });
        if (!row) return c.json({ error: "repository not found" }, 404);
        return c.json(row);
      },
    )

    .post(
      "/tokens",
      validator("json", (value, c) => {
        const body = tokenBody.safeParse(value);
        return body.success
          ? body.data
          : c.json({ error: "body must be { access: 'read' | 'read-write', name?, expiresIn? }" }, 400);
      }),
      async (c) => {
        const body = c.req.valid("json");
        try {
          const key = await deps.auth.api.createApiKey({
            body: {
              userId: c.get("userId"),
              name: body.name,
              expiresIn: body.expiresIn,
              permissions: tokenPermissions[body.access],
            },
          });
          return c.json(key);
        } catch (err) {
          // better-auth rejects an out-of-range expiresIn with an APIError. Its message and status are passed through.
          if (isAPIError(err)) return c.json({ error: err.message }, err.statusCode as ContentfulStatusCode);
          throw err;
        }
      },
    )

    // Role changes and removal go through better-auth's admin routes, which enforce the last-admin rule (see auth.ts).
    // better-auth refreshes a session at most once a day, so lastActiveAt can lag web use by a day. API key use is exact.
    .get("/users", async (c) => {
      const rows = await deps.db
        .select({
          id: user.id,
          email: user.email,
          role: user.role,
          banned: user.banned,
          banExpires: user.banExpires,
          createdAt: user.createdAt,
          lastActiveAt: sql<Date | null>`greatest((select max(${session.updatedAt}) from ${session} where ${session.userId} = ${user.id}), (select max(${apikey.lastRequest}) from ${apikey} where ${apikey.referenceId} = ${user.id}))`,
        })
        .from(user)
        .orderBy(user.createdAt);
      return c.json(
        rows.map(({ banned, banExpires, ...row }) => ({ ...row, active: isActive({ banned, banExpires }) })),
      );
    })

    // Public. The invite page reads the email and role from its token before the person signs in.
    .get("/invites/lookup", async (c) => {
      const invite = await pendingInviteForToken(deps.db, c.req.query("token") ?? "");
      return invite ? c.json(invite) : c.json({ error: "invite not found" }, 404);
    })

    .get("/invites", async (c) => {
      const rows = await deps.db
        .select({
          id: invites.id,
          email: invites.email,
          role: invites.role,
          invitedBy: user.email,
          createdAt: invites.createdAt,
          expiresAt: invites.expiresAt,
        })
        .from(invites)
        .innerJoin(user, eq(user.id, invites.invitedBy))
        .where(isPending())
        .orderBy(desc(invites.createdAt));
      return c.json(rows);
    })

    // The mail goes out before the invite is stored, so a failed send leaves nothing behind and the admin can retry.
    // A new invite replaces any invite for the same email that has not been accepted.
    .post(
      "/invites",
      validator("json", (value, c) => {
        const body = inviteBody.safeParse(value);
        return body.success ? body.data : c.json({ error: "body must be { email, role: 'user' | 'admin' }" }, 400);
      }),
      async (c) => {
        const body = c.req.valid("json");
        const email = body.email.toLowerCase();
        const [existing] = await deps.db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
        if (existing) return c.json({ error: "a user with this email already exists" }, 409);

        const token = newInviteToken();
        try {
          await deps.sendMail({
            to: email,
            subject: "You're invited to Imagine",
            text: `You've been invited to Imagine as ${body.role}: ${baseUrl}/invite?token=${token}\n\nThe link works for 7 days.`,
          });
        } catch (err) {
          console.error(err);
          return c.json({ error: "could not send the invite email" }, 502);
        }

        const invite = await deps.db.transaction(async (tx) => {
          await tx.delete(invites).where(and(eq(invites.email, email), isNull(invites.acceptedAt)));
          const [row] = await tx
            .insert(invites)
            .values({ email, role: body.role, tokenHash: hashInviteToken(token), invitedBy: c.get("userId") })
            .returning({ id: invites.id, email: invites.email, role: invites.role, expiresAt: invites.expiresAt });
          return row;
        });
        return c.json(invite);
      },
    )

    .delete(
      "/invites",
      validator("query", (value, c) => {
        const query = inviteQuery.safeParse(value);
        return query.success ? query.data : c.json({ error: "id must be a UUID" }, 400);
      }),
      async (c) => {
        const { id } = c.req.valid("query");
        const [row] = await deps.db
          .delete(invites)
          .where(and(eq(invites.id, id), isNull(invites.acceptedAt)))
          .returning({ id: invites.id });
        if (!row) return c.json({ error: "invite not found" }, 404);
        return c.json({ id: row.id });
      },
    )

    .notFound((c) => c.json({ error: "not found" }, 404))
    .onError((err, c) => {
      // Hono's JSON validator throws a 400 for a body that is not valid JSON. Answer it in the same { error } shape.
      if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
      console.error(err);
      return c.json({ error: "internal error" }, 500);
    });
}

export type ApiType = ReturnType<typeof createApi>;
