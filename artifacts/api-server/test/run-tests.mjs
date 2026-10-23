import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const testBundle = join(tmpdir(), "stockroom-api-server-tests.mjs");

await build({
  entryPoints: ["test/stocks-service.test.mjs"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: testBundle,
});

const result = spawnSync(process.execPath, ["--test", testBundle], {
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
