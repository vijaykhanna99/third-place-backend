import { describe, expect, it } from "vitest";
import {
  ZIP_LIMITS,
  isDirectoryEntry,
  isRejection,
  isSymlink,
  planExtraction,
  safeEntryPath,
  type ZipEntryInfo,
} from "../src/lib/zip.js";

/**
 * These are the checks standing between an operator-supplied archive and our
 * storage bucket, so they are tested exhaustively and in isolation.
 */
const entry = (fileName: string, over: Partial<ZipEntryInfo> = {}): ZipEntryInfo => ({
  fileName,
  uncompressedSize: 1024,
  externalFileAttributes: 0,
  ...over,
});

/** A minimal archive that should pass every rule. */
const validEntries = (): ZipEntryInfo[] => [
  entry("index.m3u8"),
  entry("uhd8k/playlist.m3u8"),
  entry("uhd8k/segment-00001.ts"),
];

describe("safeEntryPath — Zip Slip and friends", () => {
  it("accepts ordinary relative paths and normalizes them", () => {
    expect(safeEntryPath("index.m3u8")).toBe("index.m3u8");
    expect(safeEntryPath("./uhd8k/playlist.m3u8")).toBe("uhd8k/playlist.m3u8");
    expect(safeEntryPath("a//b///c.ts")).toBe("a/b/c.ts");
    // Traversal that stays inside the root is fine.
    expect(safeEntryPath("a/b/../c.ts")).toBe("a/c.ts");
  });

  it("rejects traversal that escapes the extraction root", () => {
    for (const bad of [
      "../evil.ts",
      "../../etc/passwd",
      "a/../../evil.ts",
      "a/b/../../../evil.ts",
    ]) {
      expect(safeEntryPath(bad), bad).toBeNull();
    }
  });

  it("rejects absolute, drive-letter, and UNC paths", () => {
    for (const bad of ["/etc/passwd", "//server/share/x.ts", "C:/Windows/x.ts", "c:\\Windows\\x.ts"]) {
      expect(safeEntryPath(bad), bad).toBeNull();
    }
  });

  it("treats backslashes as separators so Windows-style traversal cannot slip past", () => {
    expect(safeEntryPath("..\\..\\evil.ts")).toBeNull();
    expect(safeEntryPath("a\\b\\c.ts")).toBe("a/b/c.ts");
  });

  it("rejects NUL bytes and empty names", () => {
    expect(safeEntryPath("a\0b.ts")).toBeNull();
    expect(safeEntryPath("")).toBeNull();
    expect(safeEntryPath("./")).toBeNull();
  });
});

describe("isSymlink", () => {
  it("detects unix symlink mode in external attributes", () => {
    // S_IFLNK (0xA000) in the high 16 bits.
    expect(isSymlink(0xa1ff0000)).toBe(true);
    // Regular file (S_IFREG, 0x8000).
    expect(isSymlink(0x81a40000)).toBe(false);
    expect(isSymlink(0)).toBe(false);
  });
});

describe("isDirectoryEntry", () => {
  it("recognizes trailing-slash entries", () => {
    expect(isDirectoryEntry("uhd8k/")).toBe(true);
    expect(isDirectoryEntry("uhd8k/playlist.m3u8")).toBe(false);
  });
});

describe("planExtraction", () => {
  it("accepts a well-formed HLS bundle and finds the master playlist", () => {
    const plan = planExtraction([entry("uhd8k/"), ...validEntries()]);
    expect(isRejection(plan)).toBe(false);
    if (isRejection(plan)) return;
    expect(plan.masterPath).toBe("index.m3u8");
    // Directory entries are not extracted.
    expect(plan.files).toHaveLength(3);
  });

  it("requires exactly one root master playlist", () => {
    const none = planExtraction([entry("uhd8k/playlist.m3u8"), entry("uhd8k/a.ts")]);
    expect(isRejection(none) && none.code).toBe("missing_master_playlist");

    // A nested index.m3u8 does not satisfy the root requirement.
    const nested = planExtraction([entry("inner/index.m3u8"), entry("inner/a.ts")]);
    expect(isRejection(nested) && nested.code).toBe("missing_master_playlist");
  });

  it("rejects an empty archive", () => {
    const result = planExtraction([entry("dir/")]);
    expect(isRejection(result) && result.code).toBe("empty_archive");
  });

  it("rejects disallowed file types", () => {
    for (const bad of ["evil.sh", "notes.txt", "payload.zip", "lib.so", "index.m3u8.exe"]) {
      const result = planExtraction([...validEntries(), entry(bad)]);
      expect(isRejection(result) && result.code, bad).toBe("disallowed_extension");
    }
  });

  it("rejects symlinks before anything is extracted", () => {
    const result = planExtraction([
      ...validEntries(),
      entry("link.ts", { externalFileAttributes: 0xa1ff0000 }),
    ]);
    expect(isRejection(result) && result.code).toBe("symlink");
  });

  it("rejects unsafe paths", () => {
    const result = planExtraction([...validEntries(), entry("../../escape.ts")]);
    expect(isRejection(result) && result.code).toBe("unsafe_path");
  });

  it("enforces the file-count limit", () => {
    const many = [
      entry("index.m3u8"),
      ...Array.from({ length: ZIP_LIMITS.maxFiles }, (_, i) =>
        entry(`uhd8k/segment-${String(i)}.ts`),
      ),
    ];
    const result = planExtraction(many);
    expect(isRejection(result) && result.code).toBe("too_many_files");
  });

  it("rejects an archive whose declared size exceeds the cap (ZIP bomb, honest header)", () => {
    const result = planExtraction([
      entry("index.m3u8"),
      entry("uhd8k/huge.ts", { uncompressedSize: ZIP_LIMITS.maxTotalBytes + 1 }),
    ]);
    expect(isRejection(result) && result.code).toBe("too_large");
  });

  it("sums sizes across entries rather than checking each in isolation", () => {
    const half = Math.floor(ZIP_LIMITS.maxTotalBytes / 2) + 1;
    const result = planExtraction([
      entry("index.m3u8"),
      entry("uhd8k/a.ts", { uncompressedSize: half }),
      entry("uhd8k/b.ts", { uncompressedSize: half }),
    ]);
    expect(isRejection(result) && result.code).toBe("too_large");
  });
});
