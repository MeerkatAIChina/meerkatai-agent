import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const payload = join(root, "deploy/layers/meerkat/desktop/payload");

const banner = {
  js: [
    "import { createRequire as __meerkatCreateRequire } from 'node:module';",
    "import { dirname as __meerkatDirname } from 'node:path';",
    "import { fileURLToPath as __meerkatFileURLToPath } from 'node:url';",
    "const require = __meerkatCreateRequire(import.meta.url);",
    "const __filename = __meerkatFileURLToPath(import.meta.url);",
    "const __dirname = __meerkatDirname(__filename);",
  ].join(" "),
};

const shared = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  banner,
  logLevel: "info",
};

await build({
  ...shared,
  entryPoints: [join(root, "src/index.ts")],
  outfile: join(payload, "core/dist/index.mjs"),
  external: ["pg"],
});

await build({
  ...shared,
  entryPoints: [join(root, "plugins/web-ui/server/index.ts")],
  outfile: join(payload, "web-ui/dist-server/index.mjs"),
});

const require = createRequire(import.meta.url);
const esbuildVersion = require("esbuild/package.json").version;
console.log(`bundled with esbuild ${esbuildVersion}`);
