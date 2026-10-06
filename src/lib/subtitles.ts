import type { MasterPlaylist } from "./hls.js";
import { resolveRelative } from "./hls.js";

/**
 * Subtitle rules from spec §8.4: tracks are declared by EXT-X-MEDIA
 * TYPE=SUBTITLES entries, one per language, live in a directory named after
 * their BCP 47 tag, and carry no WebVTT positioning — placement is decided by
 * the client in the headset, not baked into the file.
 *
 * Pure functions over parsed playlist data and text, so every rule is
 * unit-tested without an archive.
 */

export type SubtitleRejectionCode =
  | "subtitle_language_missing"
  | "subtitle_language_invalid"
  | "subtitle_language_duplicate"
  | "subtitle_directory_mismatch"
  | "subtitle_cue_positioning"
  | "invalid_subtitle";

export interface SubtitleRejection {
  code: SubtitleRejectionCode;
  message: string;
}

export interface SubtitleTrack {
  language: string;
  /** Archive path of the track's media playlist. */
  playlistPath: string;
}

/**
 * Deliberately simple BCP 47 shape: a 2–3 letter language followed by any
 * number of 1–8 character alphanumeric subtags (`ja`, `en-US`, `zh-Hant-TW`).
 * Validating against the IANA registry would be more than an upload gate needs.
 */
const BCP47 = /^[a-z]{2,3}(-[a-z0-9]{1,8})*$/i;

export function isBcp47(tag: string): boolean {
  return BCP47.test(tag);
}

/** Cue settings that fix where a cue is drawn — none of them may appear. */
const POSITIONING_SETTINGS = ["position", "line", "align", "vertical", "size"] as const;
const CUE_TIMING = /-->/;

/**
 * Checks the EXT-X-MEDIA subtitle declarations of a master playlist. The
 * referenced playlist's existence is checked by the caller against the
 * archive; this validates the declarations themselves.
 */
export function validateSubtitleTracks(
  media: MasterPlaylist["media"],
  masterPath: string,
): SubtitleTrack[] | SubtitleRejection {
  const tracks: SubtitleTrack[] = [];
  const seen = new Set<string>();
  for (const entry of media) {
    if (entry.type.toUpperCase() !== "SUBTITLES") continue;
    if (!entry.language) {
      return {
        code: "subtitle_language_missing",
        message: `Subtitle track ${entry.uri} declares no LANGUAGE`,
      };
    }
    if (!isBcp47(entry.language)) {
      return {
        code: "subtitle_language_invalid",
        message: `Subtitle LANGUAGE is not a BCP 47 tag: ${entry.language}`,
      };
    }
    const key = entry.language.toLowerCase();
    if (seen.has(key)) {
      return {
        code: "subtitle_language_duplicate",
        message: `More than one subtitle track for language ${entry.language}`,
      };
    }
    seen.add(key);

    const playlistPath = resolveRelative(masterPath, entry.uri);
    const dir = playlistPath?.includes("/") ? playlistPath.slice(0, playlistPath.lastIndexOf("/")) : "";
    const dirName = dir.slice(dir.lastIndexOf("/") + 1);
    if (playlistPath === null || dirName.toLowerCase() !== key) {
      return {
        code: "subtitle_directory_mismatch",
        message: `Subtitle track for ${entry.language} must live in a directory named ${entry.language}: ${entry.uri}`,
      };
    }
    tracks.push({ language: entry.language, playlistPath });
  }
  return tracks;
}

/**
 * Scans a WebVTT file for positioning cue settings. Only the settings part of
 * a cue timing line is inspected (after the end timestamp), so cue text that
 * happens to contain "line:" is not a violation.
 */
export function findCuePositioning(vtt: string): string | null {
  for (const raw of vtt.split(/\r?\n/)) {
    if (!CUE_TIMING.test(raw)) continue;
    const settings = raw.slice(raw.indexOf("-->") + 3).trim().split(/\s+/).slice(1);
    for (const setting of settings) {
      const name = setting.slice(0, setting.indexOf(":")).toLowerCase();
      if ((POSITIONING_SETTINGS as readonly string[]).includes(name)) return raw.trim();
    }
  }
  return null;
}

/** Validates one .vtt file's contents: a WebVTT signature and no positioning. */
export function validateWebVtt(path: string, vtt: string): SubtitleRejection | null {
  const body = vtt.charCodeAt(0) === 0xfeff ? vtt.slice(1) : vtt;
  if (!/^WEBVTT(\s|$)/.test(body)) {
    return { code: "invalid_subtitle", message: `Not a WebVTT file: ${path}` };
  }
  const cue = findCuePositioning(body);
  if (cue !== null) {
    return {
      code: "subtitle_cue_positioning",
      message: `WebVTT positioning is not allowed (display position is client-controlled) in ${path}: ${cue}`,
    };
  }
  return null;
}

export function isSubtitleRejection(
  result: SubtitleTrack[] | SubtitleRejection,
): result is SubtitleRejection {
  return "code" in result;
}
