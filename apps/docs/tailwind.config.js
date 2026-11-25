import subframePreset from "@imagine/components/tailwind-config";

/** @type {import('tailwindcss').Config} */
export default {
  // The Subframe components live in packages/components, so Tailwind must scan them too.
  content: ["./src/**/*.{astro,md,mdx,ts,tsx}", "../../packages/components/ui/**/*.{ts,tsx,js,jsx}"],
  presets: [subframePreset],
};
