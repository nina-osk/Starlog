// Builds the generated contract bindings in packages/ (their dist/ is not committed),
// so `npm install` in apps/web leaves estela-escrow / -pass / -stamps importable.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packages = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages");

for (const name of ["estela-escrow", "estela-pass", "estela-stamps"]) {
  const dir = join(packages, name);
  if (!existsSync(join(dir, "node_modules"))) {
    execSync("npm install --no-audit --no-fund", { cwd: dir, stdio: "inherit" });
  }
  execSync("npm run build", { cwd: dir, stdio: "inherit" });
}
