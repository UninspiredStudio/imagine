import subframePreset from "@imagine/components/tailwind-config";

/** @type {import('tailwindcss').Config} */
export default {
  // The Subframe components live in packages/components, so Tailwind must scan them too.
  content: ["./index.html", "./src/**/*.{ts,tsx}", "../../packages/components/ui/**/*.{ts,tsx,js,jsx}"],
  presets: [subframePreset],
};
