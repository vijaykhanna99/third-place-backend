import { deflateRawSync } from "node:zlib";
import { crc32 } from "node:zlib";

/**
 * Minimal ZIP writer for tests.
 *
 * Hand-rolled because the point is to produce archives a normal library will
 * not create: `../` traversal entries, symlink attributes, lying size headers.
 * Those are exactly the inputs the extraction hardening must reject, so the
 * tests have to be able to build them.
 *
 * Emits a plain (non-ZIP64) archive with the local-header + central-directory
 * layout yauzl expects.
 */
export interface ZipInput {
  path: string;
  content: string | Buffer;
  /** Raw external file attributes — set the symlink bits to test rejection. */
  externalFileAttributes?: number;
  /** Override the declared uncompressed size, to simulate a lying header. */
  declaredSize?: number;
  store?: boolean;
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

export function makeZip(entries: ZipInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.path, "utf8");
    const raw = Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content, "utf8");
    const store = e.store ?? false;
    const compressed = store ? raw : deflateRawSync(raw);
    const method = store ? 0 : 8;
    const crc = crc32(raw);
    const uncompressedSize = e.declaredSize ?? raw.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(0x031e, 4); // version made by: unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(e.externalFileAttributes ?? 0x81a40000, 38); // regular file 0644
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/** External attributes marking a unix symlink (S_IFLNK | 0777). */
export const SYMLINK_ATTRS = 0xa1ff0000;
