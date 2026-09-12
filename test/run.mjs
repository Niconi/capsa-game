// Runs the whole local suite: build the room bundle, then the game-room
// checks and the client render checks.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const steps = [
  ["build the Durable Object bundle", "test/build.mjs"],
  ["game room (rules, turns, points, host, timers)", "test/harness.mjs"],
  ["client rendering", "test/ui.mjs"],
];

let failed = 0;
for (const [label, file] of steps) {
  console.log(`\n▶ ${label}`);
  const res = spawnSync(process.execPath, [join(root, file)], { stdio: "inherit", cwd: root });
  if (res.status !== 0) {
    console.log(`\n✗ stopped at: ${label}`);
    failed = res.status ?? 1;
    break;
  }
}

if (!failed) {
  console.log("\n▶ typecheck");
  const tsc = spawnSync("npx", ["tsc", "-p", "tsconfig.json"], { stdio: "inherit", cwd: root });
  if (tsc.status !== 0) {
    console.log("\n✗ typecheck failed");
    failed = tsc.status ?? 1;
  }
}

console.log(failed ? "\n❌ suite failed" : "\n✅ suite passed");
process.exit(failed ? 1 : 0);
