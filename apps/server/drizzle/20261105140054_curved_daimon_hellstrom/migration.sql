CREATE TYPE "visibility" AS ENUM('private', 'public');--> statement-breakpoint
CREATE TABLE "blobs" (
	"digest" text PRIMARY KEY,
	"size" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "manifest_references" (
	"repository" text,
	"manifest_digest" text,
	"referenced_digest" text,
	CONSTRAINT "manifest_references_pkey" PRIMARY KEY("repository","manifest_digest","referenced_digest")
);
--> statement-breakpoint
CREATE TABLE "manifests" (
	"repository" text,
	"digest" text,
	"media_type" text NOT NULL,
	"bytes" bytea NOT NULL,
	"subject_digest" text,
	"artifact_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manifests_pkey" PRIMARY KEY("repository","digest")
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"name" text PRIMARY KEY,
	"visibility" "visibility" DEFAULT 'private'::"visibility" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repository_blobs" (
	"repository" text,
	"blob_digest" text,
	CONSTRAINT "repository_blobs_pkey" PRIMARY KEY("repository","blob_digest")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"repository" text,
	"name" text,
	"manifest_digest" text NOT NULL,
	CONSTRAINT "tags_pkey" PRIMARY KEY("repository","name")
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"repository" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "manifest_references" ADD CONSTRAINT "manifest_references_fWpC9KvnN4Ch_fkey" FOREIGN KEY ("repository","manifest_digest") REFERENCES "manifests"("repository","digest");--> statement-breakpoint
ALTER TABLE "manifests" ADD CONSTRAINT "manifests_repository_repositories_name_fkey" FOREIGN KEY ("repository") REFERENCES "repositories"("name");--> statement-breakpoint
ALTER TABLE "repository_blobs" ADD CONSTRAINT "repository_blobs_repository_repositories_name_fkey" FOREIGN KEY ("repository") REFERENCES "repositories"("name");--> statement-breakpoint
ALTER TABLE "repository_blobs" ADD CONSTRAINT "repository_blobs_blob_digest_blobs_digest_fkey" FOREIGN KEY ("blob_digest") REFERENCES "blobs"("digest");--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_hdea3Ks98Tvy_fkey" FOREIGN KEY ("repository","manifest_digest") REFERENCES "manifests"("repository","digest");--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_repository_repositories_name_fkey" FOREIGN KEY ("repository") REFERENCES "repositories"("name");