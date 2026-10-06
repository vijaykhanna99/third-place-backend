/**
 * Hardening rules for operator-supplied ZIP archives (spec §8.4).
 *
 * Everything here is pure and synchronous so it can be unit-tested exhaustively
 * without touching a filesystem, a network, or a real archive — these are the
 * checks standing between an uploaded file and our storage bucket.
 */

export const ZIP_LIMITS = {
  /** Max entries in the archive. */
  maxFiles: 5_000,
  /** Max total uncompressed bytes, enforced cumulatively during extraction. */
  maxTotalBytes: 10 * 1024 * 1024 * 1024,
  /** Max uncompressed bytes for a single entry (env UPLOAD_MAX_ENTRY_BYTES overrides). */
  maxEntryBytes: 2 * 1024 * 1024 * 1024,
  /** Max bytes for an entry that is parsed in memory (playlists, subtitles). */
  maxTextBytes: 16 * 1024 * 1024,
  /** Required master playlist, exactly one, at the archive root. */
  masterPlaylist: "index.m3u8",
  /** Only these extensions may appear in an HLS bundle. */
  allowedExtensions: [".m3u8", ".ts", ".m4s", ".mp4", ".vtt"] as const,
} as const;

/** The numeric limits, overridable per deployment; the rest of ZIP_LIMITS is fixed policy. */
export interface ZipLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxEntryBytes: number;
  maxTextBytes: number;
}

export type ZipRejectionCode =
  | "too_many_files"
  | "too_large"
  | "empty_archive"
  | "disallowed_extension"
  | "unsafe_path"
  | "symlink"
  | "duplicate_entry"
  | "missing_master_playlist"
  | "multiple_master_playlists"
  | "nested_master_playlist";

export interface ZipRejection {
  code: ZipRejectionCode;
  message: string;
}

export interface ZipEntryInfo {
  /** Raw entry name exactly as stored in the archive. */
  fileName: string;
  /** Uncompressed size declared in the central directory. */
  uncompressedSize: number;
  /** External attributes, used to detect symlinks on unix-created archives. */
  externalFileAttributes: number;
}

/** Unix mode S_IFLNK — a symlink entry must never be extracted. */
export function isSymlink(externalFileAttributes: number): boolean {
  const unixMode = (externalFileAttributes >>> 16) & 0xffff;
  return (unixMode & 0xf000) === 0xa000;
}

export function isDirectoryEntry(fileName: string): boolean {
  return fileName.endsWith("/");
}

/**
 * Normalizes an archive entry name to a safe, relative, in-tree path.
 * Returns null for anything that must not be extracted (Zip Slip and friends).
 *
 * Rejects: absolute paths, Windows drive letters, UNC paths, backslash
 * separators, `..` traversal that escapes the root, and NUL bytes.
 */
export function safeEntryPath(fileName: string): string | null {
  if (fileName.length === 0) return null;
  if (fileName.includes("\0")) return null;
  // Backslashes are a path separator on Windows; normalize so `..\..\x` cannot
  // slip past a check that only understands forward slashes.
  const normalized = fileName.replace(/\\/g, "/");
  if (normalized.startsWith("/")) return null; // absolute
  if (/^[a-zA-Z]:/.test(normalized)) return null; // C:\...
  if (normalized.startsWith("//")) return null; // UNC

  const parts: string[] = [];
  for (const segment of normalized.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null; // escapes the extraction root
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  if (parts.length === 0) return null;
  return parts.join("/");
}

function extensionOf(path: string): string {
  const slash = path.lastIndexOf("/");
  const name = slash === -1 ? path : path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

export interface ZipPlan {
  /** Entries to extract, with their validated destination paths. */
  files: { entry: ZipEntryInfo; path: string }[];
  /** Path of the single master playlist. */
  masterPath: string;
  declaredTotalBytes: number;
}

/**
 * Pre-extraction validation: decides, from the central directory alone, whether
 * the archive may be extracted at all. Nothing is written before this passes.
 */
export function planExtraction(
  entries: ZipEntryInfo[],
  limits: ZipLimits = ZIP_LIMITS,
): ZipPlan | ZipRejection {
  const files = entries.filter((e) => !isDirectoryEntry(e.fileName));

  if (files.length === 0) {
    return { code: "empty_archive", message: "Archive contains no files" };
  }
  if (files.length > limits.maxFiles) {
    return {
      code: "too_many_files",
      message: `Archive contains ${String(files.length)} files (limit ${String(limits.maxFiles)})`,
    };
  }

  const planned: { entry: ZipEntryInfo; path: string }[] = [];
  let declaredTotalBytes = 0;
  const masters: string[] = [];
  const nested: string[] = [];
  const seen = new Set<string>();

  for (const entry of files) {
    if (isSymlink(entry.externalFileAttributes)) {
      return { code: "symlink", message: `Symbolic links are not allowed: ${entry.fileName}` };
    }
    const path = safeEntryPath(entry.fileName);
    if (path === null) {
      return { code: "unsafe_path", message: `Unsafe path in archive: ${entry.fileName}` };
    }
    // Two raw names normalizing to one path (`a/b.ts` and `./a//b.ts`, or a
    // literal repeat) would otherwise have the later entry silently replace
    // the earlier one in storage.
    if (seen.has(path)) {
      return { code: "duplicate_entry", message: `Archive contains ${path} more than once` };
    }
    seen.add(path);
    const ext = extensionOf(path);
    if (!(ZIP_LIMITS.allowedExtensions as readonly string[]).includes(ext)) {
      return {
        code: "disallowed_extension",
        message: `File type not allowed in an HLS bundle: ${entry.fileName}`,
      };
    }

    if (entry.uncompressedSize > limits.maxEntryBytes) {
      return {
        code: "too_large",
        message: `Entry exceeds the per-file limit of ${String(limits.maxEntryBytes)} bytes: ${entry.fileName}`,
      };
    }
    declaredTotalBytes += entry.uncompressedSize;
    // Declared sizes can lie, so extraction re-checks cumulatively; this catches
    // the honest-but-oversized case before any bytes move.
    if (declaredTotalBytes > limits.maxTotalBytes) {
      return {
        code: "too_large",
        message: `Archive expands beyond the ${String(
          limits.maxTotalBytes / (1024 * 1024 * 1024),
        )} GB limit`,
      };
    }

    if (path === ZIP_LIMITS.masterPlaylist) masters.push(path);
    else if (path.endsWith(`/${ZIP_LIMITS.masterPlaylist}`)) nested.push(path);
    planned.push({ entry, path });
  }

  if (masters.length === 0) {
    return {
      code: "missing_master_playlist",
      message: `Archive must contain ${ZIP_LIMITS.masterPlaylist} at its root`,
    };
  }
  // One upload is one camera angle: a second master playlist below the root
  // would be published as an ordinary media playlist, never validated as a
  // master, and is a sign the operator zipped several angles together.
  if (nested.length > 0) {
    return {
      code: "nested_master_playlist",
      message: `${ZIP_LIMITS.masterPlaylist} may only appear at the archive root: ${nested[0]!}`,
    };
  }
  if (masters.length > 1) {
    return {
      code: "multiple_master_playlists",
      message: `Archive must contain exactly one ${ZIP_LIMITS.masterPlaylist}`,
    };
  }

  return { files: planned, masterPath: masters[0]!, declaredTotalBytes };
}

export function isRejection(result: ZipPlan | ZipRejection): result is ZipRejection {
  return "code" in result;
}
