import type { S3Client } from "bun";
import { and, eq, inArray } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql/postgres";
import { z } from "zod";
import { blobs, manifests, repositoryBlobs } from "./db/schema.ts";
import { blobKey } from "./registry.ts";

// Image configs are a few KB. Anything larger is not read into memory.
const MAX_CONFIG_BYTES = 1024 * 1024;

const platformSchema = z.object({ os: z.string().min(1), architecture: z.string().min(1), variant: z.string().optional() });
const indexSchema = z.object({ manifests: z.array(z.object({ platform: z.unknown().optional() })) });
const imageSchema = z.object({ config: z.object({ digest: z.string() }) });

function formatPlatform(value: unknown): string | undefined {
  const parsed = platformSchema.safeParse(value);
  // BuildKit lists its attestations as unknown/unknown. They are not something to run.
  if (!parsed.success || parsed.data.os === "unknown") return undefined;
  const { os, architecture, variant } = parsed.data;
  return [os, architecture, variant].filter(Boolean).join("/");
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

// Platforms by manifest digest. An index names its platforms. A single image names its one platform in its config blob.
// A digest whose platforms cannot be read gets an empty list, so a storage problem never hides the tag itself.
export async function platformsOf(
  db: BunSQLDatabase,
  storage: S3Client,
  repository: string,
  digests: string[],
): Promise<Record<string, string[]>> {
  const rows = await db
    .select({ digest: manifests.digest, bytes: manifests.bytes })
    .from(manifests)
    .where(and(eq(manifests.repository, repository), inArray(manifests.digest, digests)));

  const found = await Promise.all(
    rows.map(async ({ digest, bytes }): Promise<[string, string[]]> => {
      const manifest = parseJson(bytes);
      const index = indexSchema.safeParse(manifest);
      if (index.success) {
        const platforms = index.data.manifests.map((child) => formatPlatform(child.platform));
        return [digest, [...new Set(platforms.filter((platform) => platform !== undefined))]];
      }
      const image = imageSchema.safeParse(manifest);
      if (!image.success) return [digest, []];
      // Read only through this repository's links, like every other blob read.
      const [config] = await db
        .select({ size: blobs.size })
        .from(repositoryBlobs)
        .innerJoin(blobs, eq(blobs.digest, repositoryBlobs.blobDigest))
        .where(and(eq(repositoryBlobs.repository, repository), eq(repositoryBlobs.blobDigest, image.data.config.digest)))
        .limit(1);
      if (!config || config.size > MAX_CONFIG_BYTES) return [digest, []];
      try {
        const content = parseJson(new Uint8Array(await storage.file(blobKey(image.data.config.digest)).arrayBuffer()));
        const platform = formatPlatform(content);
        return [digest, platform === undefined ? [] : [platform]];
      } catch (err) {
        console.error(`could not read the config of ${repository}@${digest}`, err);
        return [digest, []];
      }
    }),
  );
  return Object.fromEntries(found);
}
