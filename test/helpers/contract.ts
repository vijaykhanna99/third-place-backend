import { readFileSync } from "node:fs";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import formatsModule from "ajv-formats";
import { parse } from "yaml";

// ajv-formats ships CommonJS; under NodeNext the callable is the `default` export.
const addFormats = formatsModule.default;

/**
 * Validates real API responses against `openapi.yaml`, the contract the client
 * team builds against. Integration tests call `expectContract(...)` on the
 * bodies they receive, so any drift between the server and the contract
 * (a renamed field, a missing `required`, a wrong type) fails the suite
 * instead of surfacing in the visionOS app.
 */
const DOC_KEY = "openapi.yaml";

type Json = Record<string, unknown>;

const doc = parse(readFileSync(new URL("../../openapi.yaml", import.meta.url), "utf8")) as Json;

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
// Strict mode stays on for the schemas themselves (a typo in a keyword is a
// contract bug), so the OpenAPI-only keywords Ajv meets on the way to them are
// declared as inert: the document's top level, and `example` inside schemas.
for (const keyword of ["openapi", "info", "servers", "tags", "security", "paths", "components", "example"]) {
  ajv.addKeyword(keyword);
}
ajv.addSchema(doc, DOC_KEY);

const compiled = new Map<string, ValidateFunction>();

/** JSON-pointer escaping (RFC 6901). */
const escape = (segment: string) => segment.replace(/~/g, "~0").replace(/\//g, "~1");

function at(pointer: string): unknown {
  let node: unknown = doc;
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Json)[key];
  }
  return node;
}

/**
 * Pointer to the JSON schema of one operation's response body, following a
 * `$ref` to `components/responses` when the operation uses a shared response.
 */
function responseSchemaPointer(method: string, path: string, status: number): string {
  const operation = `/paths/${escape(path)}/${method.toLowerCase()}`;
  if (at(operation) === undefined) throw new Error(`${method} ${path} is not in ${DOC_KEY}`);
  let response = `${operation}/responses/${String(status)}`;
  const node = at(response) as { $ref?: string } | undefined;
  if (node === undefined) {
    // The conventions section declares 429 and 500 globally rather than per operation.
    if (status === 429 || status === 500) return "/components/schemas/Error";
    throw new Error(`${method} ${path} declares no ${String(status)} response`);
  }
  if (typeof node.$ref === "string") response = node.$ref.replace(/^#/, "");
  const schema = `${response}/content/${escape("application/json")}/schema`;
  if (at(schema) === undefined) {
    throw new Error(`${method} ${path} ${String(status)} declares no application/json schema`);
  }
  return schema;
}

function validatorFor(method: string, path: string, status: number): ValidateFunction {
  const pointer = responseSchemaPointer(method, path, status);
  let validate = compiled.get(pointer);
  if (!validate) {
    validate = ajv.getSchema(`${DOC_KEY}#${pointer}`);
    if (!validate) throw new Error(`could not compile ${pointer}`);
    compiled.set(pointer, validate);
  }
  return validate;
}

/**
 * Asserts `body` matches the contract's schema for `method path → status`.
 * `path` is the templated contract path (`/api/v1/uploads/{uploadID}`), not
 * the concrete URL. Throws with every schema violation listed.
 */
export function expectContract(method: string, path: string, status: number, body: unknown): void {
  const validate = validatorFor(method, path, status);
  if (!validate(body)) {
    throw new Error(
      `${method} ${path} ${String(status)} response violates ${DOC_KEY}:\n` +
        ajv.errorsText(validate.errors, { separator: "\n", dataVar: "body" }) +
        `\n\nbody: ${JSON.stringify(body, null, 2)}`,
    );
  }
}

/** The error codes the contract's conventions section documents. */
export function documentedErrorCodes(): string[] {
  const description = (doc.info as { description: string }).description;
  return [...description.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!);
}
