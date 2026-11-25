import { glob } from "astro/loaders";
import { z } from "astro/zod";
import { defineCollection } from "astro:content";

const docs = defineCollection({
  loader: glob({ base: "./src/content/docs", pattern: "**/*.mdx" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    // Sidebar group. Pages without one come first.
    section: z.string().optional(),
    // Position in the whole sidebar. A section sits where its first page does.
    order: z.number(),
  }),
});

export const collections = { docs };
