// Copies the backend's OpenAPI contract into contract/ when the backend
// checkout sits next to this repository. Run `pnpm contract:types` afterwards.
import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// The console lives inside the backend repository (console/), so the contract
// is one directory up; a sibling checkout is accepted for the day it is split out.
const candidates = [
  resolve(process.cwd(), "../openapi.yaml"),
  resolve(process.cwd(), "../third-place-backend/openapi.yaml"),
];
const target = resolve(process.cwd(), "contract/openapi.yaml");

const source = candidates.find((path) => existsSync(path));
if (!source) {
  console.log(`contract:sync: no backend contract found next to this project; keeping the checked-in contract/openapi.yaml`);
  process.exit(0);
}
copyFileSync(source, target);
console.log(`contract:sync: copied ${source} -> ${target}`);
