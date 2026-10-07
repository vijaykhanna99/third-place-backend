import type { Page } from "@playwright/test";

export const MOCK_API = "http://127.0.0.1:4100";
export const APP_KEY = "e2e-app-key";
export const OPERATOR = { handle: "ops", password: "operator-password-1" };
export const VALID_VERIFY_TOKEN = "valid-verify-token";
export const VALID_RESET_TOKEN = "valid-reset-token";

/** Serve a runtime config that points the bundle at the mock API. */
export async function configureConsole(page: Page): Promise<void> {
  await page.route("**/config.js", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `window.__TP_CONFIG__ = ${JSON.stringify({ apiBaseURL: MOCK_API, appKey: APP_KEY })};`,
    }),
  );
}

export async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(/Handle or email/).fill(OPERATOR.handle);
  await page.getByLabel(/^Password/).fill(OPERATOR.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("heading", { name: "Catalog" }).waitFor();
}

// ---- tiny ZIP writer (store-only) so tests can build archives in memory
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  path: string;
  content: string;
}

/** Builds an uncompressed ZIP archive with the given entries. */
export function makeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const data = Buffer.from(entry.content, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // utf-8 names
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}

const MASTER = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-STREAM-INF:BANDWIDTH=48000000,RESOLUTION=7680x4320\nuhd8k/playlist.m3u8\n";
const MEDIA = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nsegment-00001.ts\n#EXTINF:6.0,\nsegment-00002.ts\n#EXT-X-ENDLIST\n";

/** A minimal HLS bundle: master playlist at the root, one rendition, two fragments. */
export function hlsBundle(tag: string): Buffer {
  return makeZip([
    { path: "index.m3u8", content: MASTER },
    { path: "uhd8k/playlist.m3u8", content: MEDIA },
    { path: "uhd8k/segment-00001.ts", content: `segment-one-${tag}-${"x".repeat(2048)}` },
    { path: "uhd8k/segment-00002.ts", content: `segment-two-${tag}-${"y".repeat(2048)}` },
  ]);
}

/** An archive the extraction worker rejects (no master playlist). */
export function brokenBundle(): Buffer {
  return makeZip([{ path: "readme.txt", content: "not an hls bundle" }]);
}
