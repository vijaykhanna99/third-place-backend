/**
 * Quality tier enum (spec §5.4). Fixed for v1; device-facing labels are the
 * client's concern. Used by upload declarations and playback telemetry; a
 * 16K-per-eye tier is added as a new value when Apple Immersive Video support
 * lands (deferred).
 */
export const QUALITIES = ["uhd8k", "uhd4k", "hd"] as const;

export type Quality = (typeof QUALITIES)[number];

export function isQuality(value: unknown): value is Quality {
  return typeof value === "string" && (QUALITIES as readonly string[]).includes(value);
}

/** JSON-schema fragment for route validation, kept identical to the contract's enum. */
export const qualitySchema = { type: "string", enum: [...QUALITIES] } as const;
