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
  /** Required master playlist, exactly one, at the archive root. */
  masterPlaylist: "index.m3u8",
  /** Only these extensions may appear in an HLS bundle. */
  allowedExtensions: [".m3u8", ".ts", ".m4s", ".mp4", ".vtt"] as const,
} as const;

export type ZipRejectionCode =
  | "too_many_files"
  | "too_large"
  | "empty_archive"
  | "disallowed_extension"
  | "unsafe_path"
  | "symlink"
  | "missing_master_playlist"
  | "multiple_master_playlists";

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
export function planExtraction(entries: ZipEntryInfo[]): ZipPlan | ZipRejection {
  const files = entries.filter((e) => !isDirectoryEntry(e.fileName));

  if (files.length === 0) {
    return { code: "empty_archive", message: "Archive contains no files" };
  }
  if (files.length > ZIP_LIMITS.maxFiles) {
    return {
      code: "too_many_files",
      message: `Archive contains ${String(files.length)} files (limit ${String(ZIP_LIMITS.maxFiles)})`,
    };
  }

  const planned: { entry: ZipEntryInfo; path: string }[] = [];
  let declaredTotalBytes = 0;
  const masters: string[] = [];

  for (const entry of files) {
    if (isSymlink(entry.externalFileAttributes)) {
      return { code: "symlink", message: `Symbolic links are not allowed: ${entry.fileName}` };
    }
    const path = safeEntryPath(entry.fileName);
    if (path === null) {
      return { code: "unsafe_path", message: `Unsafe path in archive: ${entry.fileName}` };
    }
    const ext = extensionOf(path);
    if (!(ZIP_LIMITS.allowedExtensions as readonly string[]).includes(ext)) {
      return {
        code: "disallowed_extension",
        message: `File type not allowed in an HLS bundle: ${entry.fileName}`,
      };
    }

    declaredTotalBytes += entry.uncompressedSize;
    // Declared sizes can lie, so extraction re-checks cumulatively; this catches
    // the honest-but-oversized case before any bytes move.
    if (declaredTotalBytes > ZIP_LIMITS.maxTotalBytes) {
      return {
        code: "too_large",
        message: `Archive expands beyond the ${String(
          ZIP_LIMITS.maxTotalBytes / (1024 * 1024 * 1024),
        )} GB limit`,
      };
    }

    if (path === ZIP_LIMITS.masterPlaylist) masters.push(path);
    planned.push({ entry, path });
  }

  if (masters.length === 0) {
    return {
      code: "missing_master_playlist",
      message: `Archive must contain ${ZIP_LIMITS.masterPlaylist} at its root`,
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
