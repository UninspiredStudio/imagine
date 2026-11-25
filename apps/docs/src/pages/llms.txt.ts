import type { APIRoute } from "astro";
import { markdownHref, respond } from "../markdown";
import { getNav } from "../nav";

// https://llmstxt.org: an index of the Markdown pages for agents.
export const GET: APIRoute = async () => {
  const { sections } = await getNav();
  const lists = sections.map(
    ({ label, pages }) =>
      `## ${label || "Start here"}\n\n${pages
        .map((doc) => `- [${doc.data.title}](${markdownHref(doc)}): ${doc.data.description}`)
        .join("\n")}`,
  );
  const intro = "# Imagine documentation\n\n> Imagine is a self-hosted Docker and OCI registry for one organization.\n\nAll pages in one file: [llms-full.txt](/llms-full.txt)\n\nSource code: https://github.com/UninspiredStudio/imagine";
  return respond(`${[intro, ...lists].join("\n\n")}\n`, "plain");
};
