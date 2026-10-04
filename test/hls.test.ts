import { describe, expect, it } from "vitest";
import { isMasterPlaylist, parseMaster, parseMedia, resolveRelative } from "../src/lib/hls.js";

const MASTER = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="日本語",LANGUAGE="ja",URI="subtitles/ja/subtitle.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",FORCED=NO,URI="subtitles/en/subtitle.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=48000000,RESOLUTION=7680x4320,SUBTITLES="subs"
uhd8k/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=16000000,RESOLUTION=3840x2160,SUBTITLES="subs"
uhd4k/playlist.m3u8
`;

const MEDIA = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6.0,
segment-00001.m4s
#EXTINF:6.0,
segment-00002.m4s
#EXTINF:4.5,
segment-00003.m4s
#EXT-X-ENDLIST
`;

describe("parseMaster", () => {
  it("extracts variant and media URIs", () => {
    const m = parseMaster(MASTER);
    expect(m.variants).toEqual(["uhd8k/playlist.m3u8", "uhd4k/playlist.m3u8"]);
    expect(m.media.map((x) => x.uri)).toEqual([
      "subtitles/ja/subtitle.m3u8",
      "subtitles/en/subtitle.m3u8",
    ]);
    expect(m.media[0]!.type).toBe("SUBTITLES");
    expect(m.media[0]!.language).toBe("ja");
  });

  it("handles CRLF line endings and blank lines between tag and URI", () => {
    const m = parseMaster("#EXTM3U\r\n#EXT-X-STREAM-INF:BANDWIDTH=1\r\n\r\nhd/playlist.m3u8\r\n");
    expect(m.variants).toEqual(["hd/playlist.m3u8"]);
  });

  it("does not mistake a comment for a variant URI", () => {
    const m = parseMaster("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n#EXT-X-COMMENT\n");
    expect(m.variants).toEqual([]);
  });
});

describe("parseMedia", () => {
  it("extracts segments, init segments, and total duration", () => {
    const p = parseMedia(MEDIA);
    expect(p.segments).toEqual(["segment-00001.m4s", "segment-00002.m4s", "segment-00003.m4s"]);
    expect(p.initSegments).toEqual(["init.mp4"]);
    expect(p.durationSec).toBe(17); // 6 + 6 + 4.5 → rounded
  });

  it("returns zero-length results for an empty playlist", () => {
    const p = parseMedia("#EXTM3U\n#EXT-X-ENDLIST\n");
    expect(p.segments).toEqual([]);
    expect(p.durationSec).toBe(0);
  });
});

describe("isMasterPlaylist", () => {
  it("distinguishes master from media playlists", () => {
    expect(isMasterPlaylist(MASTER)).toBe(true);
    expect(isMasterPlaylist(MEDIA)).toBe(false);
  });
});

describe("resolveRelative", () => {
  it("resolves against the referring playlist's directory", () => {
    expect(resolveRelative("index.m3u8", "uhd8k/playlist.m3u8")).toBe("uhd8k/playlist.m3u8");
    expect(resolveRelative("uhd8k/playlist.m3u8", "segment-1.ts")).toBe("uhd8k/segment-1.ts");
    expect(resolveRelative("subtitles/ja/subtitle.m3u8", "seg.vtt")).toBe("subtitles/ja/seg.vtt");
    expect(resolveRelative("uhd8k/playlist.m3u8", "../shared/init.mp4")).toBe("shared/init.mp4");
  });

  it("refuses to escape the upload root", () => {
    expect(resolveRelative("index.m3u8", "../other/index.m3u8")).toBeNull();
    expect(resolveRelative("uhd8k/playlist.m3u8", "../../escape.ts")).toBeNull();
  });

  it("refuses absolute paths and remote URLs", () => {
    // A playlist must never point outside its own upload — including at
    // another origin, which would make us a hotlinking proxy.
    expect(resolveRelative("index.m3u8", "/etc/passwd")).toBeNull();
    expect(resolveRelative("index.m3u8", "https://evil.example/x.m3u8")).toBeNull();
    expect(resolveRelative("index.m3u8", "//evil.example/x.m3u8")).toBeNull();
    expect(resolveRelative("index.m3u8", "file:///etc/passwd")).toBeNull();
  });
});
