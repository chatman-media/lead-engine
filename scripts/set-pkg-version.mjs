// Set the "version" field of the package.json in the current working directory.
// Used by semantic-release (@semantic-release/exec prepareCmd) instead of
// @semantic-release/npm, because that plugin shells out to `npm`, which cannot
// parse bun's `workspace:*` dependency protocol (EUNSUPPORTEDPROTOCOL).
// `bun publish` (the publishCmd) resolves `workspace:*` to concrete versions.
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!version) {
  console.error("usage: set-pkg-version.mjs <version>");
  process.exit(1);
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
pkg.version = version;
writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`${pkg.name}@${version}`);
