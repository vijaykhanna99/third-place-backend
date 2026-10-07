import { streamUploadID } from "./streams";

describe("streamUploadID", () => {
  const id = "01890a5d-ac96-774b-b111-000000000801";
  const url = `https://media.3rd-place.example/uploads/${id}/index.m3u8?token=v1.abc`;

  it("prefers the uploadID field when the backend sends it", () => {
    expect(streamUploadID({ uploadID: "01890a5d-ac96-774b-b111-000000000999", streamURL: url })).toBe("01890a5d-ac96-774b-b111-000000000999");
  });

  it("falls back to the /uploads/{id}/index.m3u8 path", () => {
    expect(streamUploadID({ streamURL: url })).toBe(id);
    expect(streamUploadID({ uploadID: "", streamURL: url })).toBe(id);
  });

  it("returns null for URLs that do not carry an upload path", () => {
    expect(streamUploadID({ streamURL: "https://media.example/other/playlist.m3u8" })).toBeNull();
    expect(streamUploadID({ streamURL: "not a url" })).toBeNull();
  });
});
