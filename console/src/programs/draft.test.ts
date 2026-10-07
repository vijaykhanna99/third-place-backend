import { MAX_ANGLES, allAnglesReady, angleUploadID, emptyDraft, newAngle, newEpisode, toCreateProgramRequest, validateAngles, validateDraft, type AngleDraft, type ProgramDraft } from "./draft";

const GENRE = "01890a5d-ac96-774b-b111-000000000001";
const UPLOAD_A = "01890a5d-ac96-774b-b111-000000000801";
const UPLOAD_B = "01890a5d-ac96-774b-b111-000000000802";

function readyAngle(name: string, uploadID: string): AngleDraft {
  return { ...newAngle(name, "zip"), upload: { phase: "ready", fileName: `${name}.zip`, byteSize: 10, uploadID, durationSec: 60 } };
}

function validDraft(): ProgramDraft {
  const draft = emptyDraft();
  draft.title = "Neon Nights";
  draft.description = "Immersive concerts";
  draft.genreIDs = [GENRE];
  draft.thumbnailURL = "https://cdn.example/thumb.jpg";
  const episode = draft.seasons[0]!.episodes[0]!;
  episode.title = "Opening Night";
  episode.publishedAt = "2026-07-01T12:00";
  episode.angles = [readyAngle("Main", UPLOAD_A), { ...newAngle("Side", "existing"), existingUploadID: UPLOAD_B.toUpperCase() }];
  return draft;
}

describe("validateDraft", () => {
  it("lists what an empty draft is missing", () => {
    const messages = validateDraft(emptyDraft()).map((i) => i.path);
    expect(messages).toEqual(
      expect.arrayContaining(["title", "genreIDs", "thumbnailURL", "seasons.0.episodes.0.title", "seasons.0.episodes.0.publishedAt", "seasons.0.episodes.0.angles.0.upload"]),
    );
  });

  it("accepts a complete draft whose angles are all ready", () => {
    const draft = validDraft();
    expect(validateDraft(draft)).toEqual([]);
    expect(allAnglesReady(draft)).toBe(true);
  });

  it("blocks creation while a ZIP upload is still running", () => {
    const draft = validDraft();
    draft.seasons[0]!.episodes[0]!.angles[0]!.upload = { phase: "uploading", fileName: "main.zip", byteSize: 10, checksum: "x", uploadID: UPLOAD_A, bytesSent: 5 };
    const issues = validateDraft(draft);
    expect(issues).toEqual([{ path: "seasons.0.episodes.0.angles.0.upload", message: "Upload is still in progress." }]);
    expect(allAnglesReady(draft)).toBe(false);
  });

  it("surfaces a failed upload's error", () => {
    const draft = validDraft();
    draft.seasons[0]!.episodes[0]!.angles[0]!.upload = { phase: "failed", fileName: "main.zip", byteSize: 10, uploadID: null, stage: "initiating", error: "validation_failed: bad checksum" };
    expect(validateDraft(draft)[0]).toMatchObject({ message: "Upload failed: validation_failed: bad checksum" });
  });

  it("rejects non-UUID uploadIDs and duplicate uploads", () => {
    const angles = [{ ...newAngle("Main", "existing"), existingUploadID: "not-a-uuid" }, { ...newAngle("Side", "existing"), existingUploadID: UPLOAD_A }, readyAngle("Top", UPLOAD_A)];
    const issues = validateAngles(angles);
    expect(issues).toEqual([
      { path: "angles.0.uploadID", message: "uploadID must be a UUID." },
      { path: "angles.2.uploadID", message: "The same upload is used for two angles." },
    ]);
  });

  it("requires unique, non-empty angle names", () => {
    const angles = [readyAngle("Main", UPLOAD_A), readyAngle("main", UPLOAD_B), { ...readyAngle("", UPLOAD_B), name: "  " }];
    const paths = validateAngles(angles).map((i) => `${i.path}: ${i.message}`);
    expect(paths).toContain('angles.1.name: Angle name "main" is used twice.');
    expect(paths).toContain("angles.2.name: Angle name is required.");
  });

  it(`caps an episode at ${MAX_ANGLES} angles and needs at least one`, () => {
    const many = Array.from({ length: MAX_ANGLES + 1 }, (_, i) => readyAngle(`A${i}`, `01890a5d-ac96-774b-b111-0000000008${String(i).padStart(2, "0")}`));
    expect(validateAngles(many)[0]).toMatchObject({ path: "angles", message: `An episode can carry at most ${MAX_ANGLES} angles.` });
    expect(validateAngles([])[0]).toMatchObject({ path: "angles", message: "Each episode needs at least one camera angle." });
  });

  it("rejects duplicate season and episode numbers", () => {
    const draft = validDraft();
    const season = draft.seasons[0]!;
    const second = newEpisode(1);
    second.title = "Dup";
    second.publishedAt = "2026-07-02T12:00";
    second.angles = [readyAngle("Main", "01890a5d-ac96-774b-b111-000000000899")];
    season.episodes.push(second);
    expect(validateDraft(draft)).toEqual([{ path: "seasons.0.episodes.1.number", message: "Episode number 1 is used twice in season 1." }]);
  });

  it("requires http(s) thumbnails", () => {
    const draft = validDraft();
    draft.thumbnailURL = "ftp://cdn.example/x.jpg";
    expect(validateDraft(draft)).toEqual([{ path: "thumbnailURL", message: "Thumbnail must be an http(s) URL." }]);
  });
});

describe("toCreateProgramRequest", () => {
  it("produces the contract body with streams in presentation order", () => {
    const body = toCreateProgramRequest(validDraft());
    expect(body).toEqual({
      title: "Neon Nights",
      description: "Immersive concerts",
      genreIDs: [GENRE],
      thumbnailURL: "https://cdn.example/thumb.jpg",
      season: [
        {
          number: 1,
          title: "",
          description: "",
          episodes: [
            {
              number: 1,
              title: "Opening Night",
              description: "",
              publishedAt: new Date("2026-07-01T12:00").toISOString(),
              streams: [
                { name: "Main", uploadID: UPLOAD_A },
                { name: "Side", uploadID: UPLOAD_B },
              ],
            },
          ],
        },
      ],
    });
  });

  it("throws for an invalid draft", () => {
    expect(() => toCreateProgramRequest(emptyDraft())).toThrow(/Title is required/);
  });

  it("resolves an existing uploadID case-insensitively", () => {
    expect(angleUploadID({ ...newAngle("x", "existing"), existingUploadID: ` ${UPLOAD_A.toUpperCase()} ` })).toBe(UPLOAD_A);
    expect(angleUploadID(newAngle("x", "zip"))).toBeNull();
  });
});
