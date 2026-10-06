import { describe, expect, it } from "vitest";
import { isRelativeUri, rewritePlaylist, withToken } from "../src/playlist.ts";

const T = "v1.1.cHJlZml4Lw.sig";

describe("withToken", () => {
  it("appends the token to relative URIs, joining an existing query", () => {
    expect(withToken("uhd8k/playlist.m3u8", T)).toBe(`uhd8k/playlist.m3u8?token=${T}`);
    expect(withToken("seg.ts?x=1", T)).toBe(`seg.ts?x=1&token=${T}`);
    expect(withToken("seg.ts#frag", T)).toBe(`seg.ts?token=${T}#frag`);
  });

  it("leaves absolute URLs alone", () => {
    for (const abs of ["https://cdn.example/x.ts", "//cdn.example/x.ts", "data:text/plain,hi"]) {
      expect(isRelativeUri(abs)).toBe(false);
      expect(withToken(abs, T)).toBe(abs);
    }
  });

  it("URL-encodes a token that needs it", () => {
    expect(withToken("a.ts", "with space&amp")).toBe("a.ts?token=with%20space%26amp");
  });
});

describe("rewritePlaylist", () => {
  it("rewrites every reference of a master playlist", () => {
    const master = [
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="JA",LANGUAGE="ja",URI="subtitles/ja/subtitle.m3u8"',
      '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,URI="uhd8k/iframes.m3u8"',
      '#EXT-X-SESSION-DATA:DATA-ID="com.example.title",URI="meta/title.json"',
      '#EXT-X-STREAM-INF:BANDWIDTH=48000000,RESOLUTION=7680x4320,SUBTITLES="subs"',
      "uhd8k/playlist.m3u8",
      "#EXT-X-STREAM-INF:BANDWIDTH=16000000,RESOLUTION=3840x2160",
      "uhd4k/playlist.m3u8",
      "",
    ].join("\n");
    expect(rewritePlaylist(master, T)).toBe(
      [
        "#EXTM3U",
        "#EXT-X-VERSION:7",
        `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="JA",LANGUAGE="ja",URI="subtitles/ja/subtitle.m3u8?token=${T}"`,
        `#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,URI="uhd8k/iframes.m3u8?token=${T}"`,
        `#EXT-X-SESSION-DATA:DATA-ID="com.example.title",URI="meta/title.json?token=${T}"`,
        '#EXT-X-STREAM-INF:BANDWIDTH=48000000,RESOLUTION=7680x4320,SUBTITLES="subs"',
        `uhd8k/playlist.m3u8?token=${T}`,
        "#EXT-X-STREAM-INF:BANDWIDTH=16000000,RESOLUTION=3840x2160",
        `uhd4k/playlist.m3u8?token=${T}`,
        "",
      ].join("\n"),
    );
  });

  it("rewrites segments and init sections of a media playlist, keeping CRLF", () => {
    const media = [
      "#EXTM3U",
      "#EXT-X-TARGETDURATION:6",
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"',
      "#EXTINF:6.0,",
      "segment-00001.m4s",
      "#EXTINF:6.0,",
      "segment-00002.m4s",
      "#EXT-X-ENDLIST",
      "",
    ].join("\r\n");
    const out = rewritePlaylist(media, T);
    expect(out).toContain(`#EXT-X-MAP:URI="init.mp4?token=${T}",BYTERANGE="720@0"\r\n`);
    expect(out).toContain(`segment-00001.m4s?token=${T}\r\n`);
    expect(out).toContain(`segment-00002.m4s?token=${T}\r\n`);
    expect(out.endsWith("#EXT-X-ENDLIST\r\n")).toBe(true);
  });

  it("does not touch comments, blank lines, or tags without a URI", () => {
    const text = "#EXTM3U\n# produced by the encoder\n\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0, title with uhd8k/x.ts\nseg.ts\n";
    expect(rewritePlaylist(text, T)).toBe(
      `#EXTM3U\n# produced by the encoder\n\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0, title with uhd8k/x.ts\nseg.ts?token=${T}\n`,
    );
  });

  it("leaves absolute references untouched", () => {
    const text = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://elsewhere.example/p.m3u8\n";
    expect(rewritePlaylist(text, T)).toBe(text);
  });
});
