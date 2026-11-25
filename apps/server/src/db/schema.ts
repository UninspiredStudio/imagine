import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  bytea,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const visibility = pgEnum("visibility", ["private", "public"]);
export const inviteRole = pgEnum("invite_role", ["user", "admin"]);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const repositories = pgTable("repositories", {
  name: text("name").primaryKey(),
  visibility: visibility("visibility").notNull().default("private"),
  createdAt: createdAt(),
});

export const blobs = pgTable("blobs", {
  digest: text("digest").primaryKey(),
  size: bigint("size", { mode: "number" }).notNull(),
  createdAt: createdAt(),
});

// A blob is readable through a repository only if a row links them.
export const repositoryBlobs = pgTable(
  "repository_blobs",
  {
    repository: text("repository")
      .notNull()
      .references(() => repositories.name),
    blobDigest: text("blob_digest")
      .notNull()
      .references(() => blobs.digest),
  },
  (t) => [primaryKey({ columns: [t.repository, t.blobDigest] })],
);

export const manifests = pgTable(
  "manifests",
  {
    repository: text("repository")
      .notNull()
      .references(() => repositories.name),
    digest: text("digest").notNull(),
    mediaType: text("media_type").notNull(),
    bytes: bytea("bytes").notNull(),
    subjectDigest: text("subject_digest"),
    artifactType: text("artifact_type"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.repository, t.digest] })],
);

// Blobs and child manifests that a manifest points at. The sweep reads this table.
export const manifestReferences = pgTable(
  "manifest_references",
  {
    repository: text("repository").notNull(),
    manifestDigest: text("manifest_digest").notNull(),
    referencedDigest: text("referenced_digest").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.repository, t.manifestDigest, t.referencedDigest] }),
    foreignKey({
      columns: [t.repository, t.manifestDigest],
      foreignColumns: [manifests.repository, manifests.digest],
    }),
    // The sweep checks whether any manifest references a blob, once per candidate blob.
    index("manifest_references_referenced_digest_idx").on(t.referencedDigest),
  ],
);

export const tags = pgTable(
  "tags",
  {
    repository: text("repository").notNull(),
    name: text("name").notNull(),
    manifestDigest: text("manifest_digest").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.repository, t.name] }),
    foreignKey({
      columns: [t.repository, t.manifestDigest],
      foreignColumns: [manifests.repository, manifests.digest],
    }),
  ],
);

// One row per in-progress blob upload. The bytes live in a spool file named after the id.
// digest_algorithm is the digest-algorithm the client declared at POST, if any; the final digest must match it.
export const uploads = pgTable("uploads", {
  id: uuid("id").primaryKey().defaultRandom(),
  repository: text("repository")
    .notNull()
    .references(() => repositories.name),
  digestAlgorithm: text("digest_algorithm"),
  createdAt: createdAt(),
});

// better-auth's tables, generated from src/auth.ts by auth@1.7.15. Regenerate when its plugins change.
// Timestamps are timestamptz, like the rest of this file.
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
  role: text("role"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires", { withTimezone: true }),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    impersonatedBy: text("impersonated_by"),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

// An invitation to create an account with a role. Only the SHA-256 of its token is stored.
// Accepting it sets acceptedAt. An invite is pending while acceptedAt is null and expiresAt is in the future.
export const invites = pgTable("invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  role: inviteRole("role").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  invitedBy: text("invited_by")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
  expiresAt: timestamp("expires_at", { withTimezone: true })
    .notNull()
    .default(sql`now() + interval '7 days'`),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
});

export const apikey = pgTable(
  "apikey",
  {
    id: text("id").primaryKey(),
    configId: text("config_id").default("default").notNull(),
    name: text("name"),
    start: text("start"),
    // The owner. Removing a user removes their keys, so a deleted user's key cannot verify.
    referenceId: text("reference_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    prefix: text("prefix"),
    key: text("key").notNull(),
    refillInterval: integer("refill_interval"),
    refillAmount: integer("refill_amount"),
    lastRefillAt: timestamp("last_refill_at", { withTimezone: true }),
    enabled: boolean("enabled").default(true),
    rateLimitEnabled: boolean("rate_limit_enabled").default(true),
    rateLimitTimeWindow: integer("rate_limit_time_window").default(86400000),
    rateLimitMax: integer("rate_limit_max").default(10),
    requestCount: integer("request_count").default(0),
    remaining: integer("remaining"),
    lastRequest: timestamp("last_request", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    permissions: text("permissions"),
    metadata: text("metadata"),
  },
  (table) => [
    index("apikey_configId_idx").on(table.configId),
    index("apikey_referenceId_idx").on(table.referenceId),
    index("apikey_key_idx").on(table.key),
  ],
);
