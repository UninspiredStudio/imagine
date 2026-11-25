import mdx from "@astrojs/mdx";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";

export default defineConfig({
  trailingSlash: "always",
  integrations: [react(), mdx()],
  // Token colours come from the theme, in src/styles/global.css.
  markdown: { shikiConfig: { theme: "css-variables" } },
});
