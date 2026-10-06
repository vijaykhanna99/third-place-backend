import { describe, expect, it } from "vitest";
import { publicMediaPath, publicMediaUrl } from "../src/lib/media-url.js";

describe("public media URLs", () => {
  it("strips the storage-only media/ prefix from keys", () => {
    expect(publicMediaPath("media/uploads/u1/index.m3u8")).toBe("uploads/u1/index.m3u8");
    expect(publicMediaPath("media/images/i1.png")).toBe("images/i1.png");
    // Keys outside the media area are passed through untouched.
    expect(publicMediaPath("tmp/uploads/u1.zip")).toBe("tmp/uploads/u1.zip");
  });

  it("joins onto the base URL without doubling slashes", () => {
    expect(publicMediaUrl("https://media.example", "media/uploads/u1/index.m3u8")).toBe(
      "https://media.example/uploads/u1/index.m3u8",
    );
    expect(publicMediaUrl("http://127.0.0.1:9000/bucket/media/", "media/images/i1.png")).toBe(
      "http://127.0.0.1:9000/bucket/media/images/i1.png",
    );
  });
});
