// `bun test` would run this repo's Vitest files under Bun's own runner: many fail, then it hangs.
console.error("This repo uses Vitest: run `bun run test`");
process.exit(1);
