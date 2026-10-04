import argon2 from "argon2";

/**
 * Argon2id with OWASP-recommended parameters (19 MiB, t=2, p=1).
 * Spec §4 requires Argon2id; never store plain text.
 */
const OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, OPTIONS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

/**
 * A real Argon2id hash of an unguessable value, verified against when the
 * account does not exist — login then costs the same time either way, so
 * response timing does not reveal account existence (spec §4: uniform errors).
 */
export const DUMMY_HASH = await hashPassword(`dummy-${Math.random().toString(36)}`);
