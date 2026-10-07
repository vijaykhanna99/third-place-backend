import type { CreateProgramRequest, StreamInput } from "../api/types";
import { isUUID, localKey } from "../lib/ids";
import { localInputToISO } from "../lib/format";
import { initialUploadState, type UploadState } from "../upload/uploadMachine";

/**
 * Client-side representation of a program being composed in the wizard (and of an
 * episode's replacement angle set in the editor). Validation mirrors the
 * constraints in CreateProgramRequest so the API rarely has to say no.
 */
export type AngleSource = "zip" | "existing";

export interface AngleDraft {
  key: string;
  name: string;
  source: AngleSource;
  /** An uploadID typed in by the operator (source = existing). */
  existingUploadID: string;
  /** Progress of a ZIP pushed through the browser (source = zip). */
  upload: UploadState;
}

export interface EpisodeDraft {
  key: string;
  number: number;
  title: string;
  description: string;
  /** <input type="datetime-local"> value. */
  publishedAt: string;
  thumbnailURL: string;
  angles: AngleDraft[];
}

export interface SeasonDraft {
  key: string;
  number: number;
  title: string;
  description: string;
  episodes: EpisodeDraft[];
}

export interface ProgramDraft {
  title: string;
  description: string;
  genreIDs: string[];
  thumbnailURL: string;
  seasons: SeasonDraft[];
}

export const MAX_ANGLES = 8;
export const MIN_ANGLES = 1;
export const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 5000;
export const ANGLE_NAME_MAX = 50;

export function newAngle(name = "Main", source: AngleSource = "zip"): AngleDraft {
  return { key: localKey("angle"), name, source, existingUploadID: "", upload: initialUploadState };
}

export function newEpisode(number: number): EpisodeDraft {
  return {
    key: localKey("episode"),
    number,
    title: "",
    description: "",
    publishedAt: "",
    thumbnailURL: "",
    angles: [newAngle("Main")],
  };
}

export function newSeason(number: number): SeasonDraft {
  return { key: localKey("season"), number, title: "", description: "", episodes: [newEpisode(1)] };
}

export function emptyDraft(): ProgramDraft {
  return { title: "", description: "", genreIDs: [], thumbnailURL: "", seasons: [newSeason(1)] };
}

/** The uploadID an angle resolves to, or null while it is not usable yet. */
export function angleUploadID(angle: AngleDraft): string | null {
  if (angle.source === "existing") {
    const id = angle.existingUploadID.trim();
    return isUUID(id) ? id.toLowerCase() : null;
  }
  return angle.upload.phase === "ready" ? angle.upload.uploadID : null;
}

export function isHttpURL(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export interface DraftIssue {
  /** Dotted path, e.g. `title`, `seasons.0.episodes.1.angles.0.name`. */
  path: string;
  message: string;
}

export function validateAngles(angles: AngleDraft[], pathPrefix = "angles"): DraftIssue[] {
  const issues: DraftIssue[] = [];
  if (angles.length < MIN_ANGLES) issues.push({ path: pathPrefix, message: "Each episode needs at least one camera angle." });
  if (angles.length > MAX_ANGLES) issues.push({ path: pathPrefix, message: `An episode can carry at most ${MAX_ANGLES} angles.` });
  const names = new Set<string>();
  const ids = new Set<string>();
  angles.forEach((angle, i) => {
    const p = `${pathPrefix}.${i}`;
    const name = angle.name.trim();
    if (name === "") issues.push({ path: `${p}.name`, message: "Angle name is required." });
    else if (name.length > ANGLE_NAME_MAX) issues.push({ path: `${p}.name`, message: `Angle name is limited to ${ANGLE_NAME_MAX} characters.` });
    else if (names.has(name.toLowerCase())) issues.push({ path: `${p}.name`, message: `Angle name "${name}" is used twice.` });
    names.add(name.toLowerCase());

    const uploadID = angleUploadID(angle);
    if (angle.source === "existing") {
      if (angle.existingUploadID.trim() === "") issues.push({ path: `${p}.uploadID`, message: "Enter the uploadID of a ready upload." });
      else if (!uploadID) issues.push({ path: `${p}.uploadID`, message: "uploadID must be a UUID." });
    } else if (angle.upload.phase === "idle" || angle.upload.phase === "cancelled") {
      issues.push({ path: `${p}.upload`, message: "Choose a ZIP archive for this angle." });
    } else if (angle.upload.phase === "failed") {
      issues.push({ path: `${p}.upload`, message: `Upload failed: ${angle.upload.error}` });
    } else if (angle.upload.phase !== "ready") {
      issues.push({ path: `${p}.upload`, message: "Upload is still in progress." });
    }
    if (uploadID) {
      if (ids.has(uploadID)) issues.push({ path: `${p}.uploadID`, message: "The same upload is used for two angles." });
      ids.add(uploadID);
    }
  });
  return issues;
}

export function validateDraft(draft: ProgramDraft): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const title = draft.title.trim();
  if (title === "") issues.push({ path: "title", message: "Title is required." });
  else if (title.length > TITLE_MAX) issues.push({ path: "title", message: `Title is limited to ${TITLE_MAX} characters.` });
  if (draft.description.length > DESCRIPTION_MAX) issues.push({ path: "description", message: `Description is limited to ${DESCRIPTION_MAX} characters.` });
  if (draft.genreIDs.length === 0) issues.push({ path: "genreIDs", message: "Pick at least one genre." });
  if (draft.thumbnailURL.trim() === "") issues.push({ path: "thumbnailURL", message: "A thumbnail URL is required." });
  else if (!isHttpURL(draft.thumbnailURL.trim())) issues.push({ path: "thumbnailURL", message: "Thumbnail must be an http(s) URL." });

  if (draft.seasons.length === 0) issues.push({ path: "seasons", message: "Add at least one season." });
  const seasonNumbers = new Set<number>();
  draft.seasons.forEach((season, si) => {
    const sp = `seasons.${si}`;
    if (!Number.isInteger(season.number) || season.number < 1) issues.push({ path: `${sp}.number`, message: "Season number must be a positive integer." });
    else if (seasonNumbers.has(season.number)) issues.push({ path: `${sp}.number`, message: `Season number ${season.number} is used twice.` });
    seasonNumbers.add(season.number);
    if (season.title.length > TITLE_MAX) issues.push({ path: `${sp}.title`, message: `Season title is limited to ${TITLE_MAX} characters.` });
    if (season.episodes.length === 0) issues.push({ path: `${sp}.episodes`, message: `Season ${season.number} needs at least one episode.` });
    const episodeNumbers = new Set<number>();
    season.episodes.forEach((episode, ei) => {
      const ep = `${sp}.episodes.${ei}`;
      if (!Number.isInteger(episode.number) || episode.number < 1) issues.push({ path: `${ep}.number`, message: "Episode number must be a positive integer." });
      else if (episodeNumbers.has(episode.number)) issues.push({ path: `${ep}.number`, message: `Episode number ${episode.number} is used twice in season ${season.number}.` });
      episodeNumbers.add(episode.number);
      if (episode.title.trim() === "") issues.push({ path: `${ep}.title`, message: "Episode title is required." });
      else if (episode.title.trim().length > TITLE_MAX) issues.push({ path: `${ep}.title`, message: `Episode title is limited to ${TITLE_MAX} characters.` });
      if (episode.description.length > DESCRIPTION_MAX) issues.push({ path: `${ep}.description`, message: `Episode description is limited to ${DESCRIPTION_MAX} characters.` });
      if (episode.publishedAt === "" || localInputToISO(episode.publishedAt) === null) issues.push({ path: `${ep}.publishedAt`, message: "Publish date is required." });
      if (episode.thumbnailURL.trim() !== "" && !isHttpURL(episode.thumbnailURL.trim())) issues.push({ path: `${ep}.thumbnailURL`, message: "Episode thumbnail must be an http(s) URL." });
      issues.push(...validateAngles(episode.angles, `${ep}.angles`));
    });
  });
  return issues;
}

/** True when every angle in the draft resolves to a ready upload. */
export function allAnglesReady(draft: ProgramDraft): boolean {
  return draft.seasons.every((s) => s.episodes.every((e) => e.angles.length > 0 && e.angles.every((a) => angleUploadID(a) !== null)));
}

export function anglesToStreams(angles: AngleDraft[]): StreamInput[] {
  return angles.map((angle) => {
    const uploadID = angleUploadID(angle);
    if (!uploadID) throw new Error(`Angle "${angle.name}" has no ready upload`);
    return { name: angle.name.trim(), uploadID };
  });
}

/** Converts a validated draft into the create request body. Throws when the draft is invalid. */
export function toCreateProgramRequest(draft: ProgramDraft): CreateProgramRequest {
  const issues = validateDraft(draft);
  if (issues.length > 0) throw new Error(`Draft is not valid: ${issues[0]!.message}`);
  return {
    title: draft.title.trim(),
    description: draft.description,
    genreIDs: [...new Set(draft.genreIDs)],
    thumbnailURL: draft.thumbnailURL.trim(),
    season: draft.seasons.map((season) => ({
      number: season.number,
      title: season.title,
      description: season.description,
      episodes: season.episodes.map((episode) => {
        const thumb = episode.thumbnailURL.trim();
        return {
          number: episode.number,
          title: episode.title.trim(),
          description: episode.description,
          publishedAt: localInputToISO(episode.publishedAt)!,
          ...(thumb ? { thumbnailURL: thumb } : {}),
          streams: anglesToStreams(episode.angles),
        };
      }),
    })),
  };
}

export function issuesFor(issues: DraftIssue[], path: string): string | null {
  return issues.find((i) => i.path === path)?.message ?? null;
}

export function issuesUnder(issues: DraftIssue[], prefix: string): DraftIssue[] {
  return issues.filter((i) => i.path === prefix || i.path.startsWith(`${prefix}.`));
}
