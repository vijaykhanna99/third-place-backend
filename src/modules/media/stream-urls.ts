import { mediaPrefixFor } from "../../jobs/keys.js";
import { publicMediaUrl } from "../../lib/media-url.js";
import { signStreamToken, streamPrefixForUpload } from "../../lib/stream-token.js";

export interface IssuedStreamUrl {
  url: string;
  expiresAt: Date;
}

/**
 * Mints the tokenised master-playlist URL for one camera angle (spec §5.2/§5.3).
 * Every stream URL the API returns — program detail and the stream endpoint —
 * comes from here, so the token format and TTL live in exactly one place.
 *
 * Without a STREAM_TOKEN_SECRET (local development against MinIO, where no
 * Worker validates anything) the URL is issued unsigned; the production
 * configuration check in env.ts makes the secret mandatory there.
 */
export class StreamUrlIssuer {
  constructor(
    private readonly mediaBaseUrl: string,
    private readonly secret: string | undefined,
    private readonly ttlSec: number,
  ) {}

  get signing(): boolean {
    return this.secret !== undefined;
  }

  /** Expiry for tokens minted at `now`: whole seconds, so the token and `expiresAt` agree exactly. */
  expiresAt(now: Date = new Date()): Date {
    return new Date((Math.floor(now.getTime() / 1000) + this.ttlSec) * 1000);
  }

  issue(uploadId: string, now: Date = new Date()): IssuedStreamUrl {
    const expiresAt = this.expiresAt(now);
    const url = publicMediaUrl(this.mediaBaseUrl, `${mediaPrefixFor(uploadId)}/index.m3u8`);
    if (this.secret === undefined) return { url, expiresAt };
    const token = signStreamToken(this.secret, {
      pathPrefix: streamPrefixForUpload(uploadId),
      exp: Math.floor(expiresAt.getTime() / 1000),
    });
    return { url: `${url}?token=${token}`, expiresAt };
  }
}
