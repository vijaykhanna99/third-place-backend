export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUUID(value: string): boolean {
  return UUID_PATTERN.test(value.trim());
}

let counter = 0;
/** Stable client-side keys for list items (not sent to the API). */
export function localKey(prefix = "k"): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}
