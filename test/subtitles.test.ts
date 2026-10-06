import { describe, expect, it } from "vitest";
import {
  findCuePositioning,
  isBcp47,
  isSubtitleRejection,
  validateSubtitleTracks,
  validateWebVtt,
} from "../src/lib/subtitles.js";

const sub = (over: Partial<{ uri: string; type: string; language: string | null }>) => ({
  uri: "subtitles/ja/subtitle.m3u8",
  type: "SUBTITLES",
  language: "ja" as string | null,
  ...over,
});

describe("isBcp47", () => {
  it("accepts common tags", () => {
    for (const ok of ["ja", "en", "en-US", "pt-BR", "zh-Hant-TW", "sr-Latn", "es-419", "ast"]) {
      expect(isBcp47(ok), ok).toBe(true);
    }
  });

  it("rejects things that are not language tags", () => {
    for (const bad of ["", "j", "japanese", "en_US", "en-", "-en", "en US", "123", "en-US-"]) {
      expect(isBcp47(bad), bad).toBe(false);
    }
  });
});

describe("validateSubtitleTracks", () => {
  it("accepts one track per language in a matching directory", () => {
    const result = validateSubtitleTracks(
      [sub({}), sub({ uri: "subtitles/en-US/subtitle.m3u8", language: "en-US" })],
      "index.m3u8",
    );
    expect(isSubtitleRejection(result)).toBe(false);
    if (isSubtitleRejection(result)) return;
    expect(result).toEqual([
      { language: "ja", playlistPath: "subtitles/ja/subtitle.m3u8" },
      { language: "en-US", playlistPath: "subtitles/en-US/subtitle.m3u8" },
    ]);
  });

  it("ignores non-subtitle media entries", () => {
    const result = validateSubtitleTracks(
      [{ uri: "audio/en/playlist.m3u8", type: "AUDIO", language: null }],
      "index.m3u8",
    );
    expect(result).toEqual([]);
  });

  it("requires LANGUAGE", () => {
    const r = validateSubtitleTracks([sub({ language: null })], "index.m3u8");
    expect(isSubtitleRejection(r) && r.code).toBe("subtitle_language_missing");
  });

  it("requires a BCP 47 LANGUAGE", () => {
    const r = validateSubtitleTracks([sub({ language: "japanese" })], "index.m3u8");
    expect(isSubtitleRejection(r) && r.code).toBe("subtitle_language_invalid");
  });

  it("allows only one track per language, case-insensitively", () => {
    const r = validateSubtitleTracks(
      [sub({}), sub({ uri: "subtitles/JA/forced.m3u8", language: "JA" })],
      "index.m3u8",
    );
    expect(isSubtitleRejection(r) && r.code).toBe("subtitle_language_duplicate");
  });

  it("requires the playlist's directory to be named after the language", () => {
    for (const uri of [
      "subtitles/en/subtitle.m3u8", // wrong language dir
      "subtitles/subtitle.m3u8", // parent is not a language
      "subtitle.m3u8", // at the root
      "../ja/subtitle.m3u8", // escapes the upload
    ]) {
      const r = validateSubtitleTracks([sub({ uri })], "index.m3u8");
      expect(isSubtitleRejection(r) && r.code, uri).toBe("subtitle_directory_mismatch");
    }
    // Case differences between tag and directory are fine (BCP 47 is case-insensitive).
    const ok = validateSubtitleTracks(
      [sub({ uri: "subtitles/en-us/subtitle.m3u8", language: "en-US" })],
      "index.m3u8",
    );
    expect(isSubtitleRejection(ok)).toBe(false);
  });
});

describe("findCuePositioning", () => {
  const cue = (settings: string) =>
    `WEBVTT\n\n00:00.000 --> 00:06.000${settings}\nhello\n`;

  it("flags position, line, align, vertical and size settings", () => {
    for (const s of [" position:10%", " line:0", " align:start", " vertical:rl", " size:50%", " line:-1 align:end"]) {
      expect(findCuePositioning(cue(s)), s).not.toBeNull();
    }
  });

  it("accepts cues without settings and ignores cue text", () => {
    expect(findCuePositioning(cue(""))).toBeNull();
    // Words that look like settings inside the caption text are not settings.
    expect(findCuePositioning("WEBVTT\n\n00:00.000 --> 00:06.000\nthe line: align: position: of it\n")).toBeNull();
    // Hour-form timestamps and CRLF are handled.
    expect(findCuePositioning("WEBVTT\r\n\r\n00:00:00.000 --> 00:00:06.000\r\nhi\r\n")).toBeNull();
  });
});

describe("validateWebVtt", () => {
  it("accepts a plain WebVTT file, with or without a BOM", () => {
    expect(validateWebVtt("a.vtt", "WEBVTT\n\n00:00.000 --> 00:01.000\nhi\n")).toBeNull();
    expect(validateWebVtt("a.vtt", "﻿WEBVTT - notes\n\n00:00.000 --> 00:01.000\nhi\n")).toBeNull();
  });

  it("rejects a file without the WebVTT signature", () => {
    expect(validateWebVtt("a.vtt", "1\n00:00:00,000 --> 00:00:01,000\nsrt\n")?.code).toBe(
      "invalid_subtitle",
    );
  });

  it("rejects positioned cues with a message naming the cue", () => {
    const r = validateWebVtt("subtitles/ja/seg.vtt", "WEBVTT\n\n00:00.000 --> 00:01.000 line:0\nhi\n");
    expect(r?.code).toBe("subtitle_cue_positioning");
    expect(r?.message).toContain("subtitles/ja/seg.vtt");
    expect(r?.message).toContain("line:0");
  });
});
