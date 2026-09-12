// Bundles src/ into .test-build/bundle.mjs with the Workers runtime module
// aliased to a stub, so the real Durable Object class can run under Node.
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
mkdirSync(join(root, ".test-build"), { recursive: true });

await build({
  entryPoints: [join(here, "entry.ts")],
  outfile: join(root, ".test-build", "bundle.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  logLevel: "warning",
  alias: { "cloudflare:workers": join(here, "stub-workers.mjs") },
});

console.log("  built .test-build/bundle.mjs");
