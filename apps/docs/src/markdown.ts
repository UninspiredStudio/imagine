import type { Doc } from "./nav";

export const markdownHref = (doc: Doc) => `/${doc.id}.md`;

/**
 * A page as plain Markdown for agents. Links to other pages point at their Markdown versions.
 * ponytail: the MDX source is sent as is, so a page that imports components shows its JSX. Render to Markdown if one does.
 */
export function toMarkdown({ data, body = "" }: Doc) {
  const linked = body.replace(/\]\(\/([a-z0-9/-]+?)\/(#[^)]*)?\)/g, "](/$1.md$2)");
  return `# ${data.title}\n\n> ${data.description}\n\n${linked.trim()}\n`;
}

export const respond = (text: string, type: "markdown" | "plain") =>
  new Response(text, { headers: { "Content-Type": `text/${type}; charset=utf-8` } });
