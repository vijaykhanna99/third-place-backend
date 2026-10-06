import Foundation

// MARK: - Catalog (openapi.yaml components/schemas)

/// `GenreRef`
public struct GenreRef: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let name: String
}

/// `Genre` — `GET /api/v1/genres`
public struct Genre: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let description: String
    public let thumbnailURL: URL?
    public let programCount: Int
}

/// `ProgramSummary` — genre listings.
public struct ProgramSummary: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let description: String
    public let thumbnailURL: URL
    public let genre: [GenreRef]
    public let updatedAt: Date
}

/// `Stream` — one camera angle. `streamURL` carries a 15-minute token.
public struct Stream: Codable, Hashable, Sendable {
    public let name: String
    public let streamURL: URL
}

/// `Episode` — inside program detail; `streams` has at least one angle, index 0 is the default.
public struct Episode: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let number: Int
    public let title: String
    public let description: String
    public let durationSec: Int
    public let thumbnailURL: URL?
    public let streams: [Stream]
    public let publishedAt: Date
}

/// `EpisodeSummary` — search results (no stream URLs; fetch via `/stream`).
public struct EpisodeSummary: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let seasonNumber: Int
    public let number: Int
    public let title: String
    public let description: String
    public let durationSec: Int
    public let thumbnailURL: URL?
    public let publishedAt: Date
}

/// `Season`
public struct Season: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let number: Int
    public let title: String
    public let description: String
    public let episodes: [Episode]
}

/// `Owner`
public struct Owner: Codable, Hashable, Sendable {
    public let did: String
    public let handle: String
    public let displayName: String
    public let avatarURL: URL?
}

/// `Viewer` — always false in v1 (no end-user accounts).
public struct Viewer: Codable, Hashable, Sendable {
    public let isFollowing: Bool
    public let isFavorited: Bool
}

/// `Program` — `GET /api/v1/programs/{programID}`
public struct Program: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let description: String
    public let thumbnailURL: URL
    public let genre: [GenreRef]
    public let createdAt: Date
    public let updatedAt: Date
    public let viewCount: Int
    public let owner: Owner
    public let viewer: Viewer
    public let season: [Season]

    /// Every episode across seasons, in catalog order.
    public var allEpisodes: [Episode] { season.flatMap(\.episodes) }
}

/// `SearchProgramResult`
public struct SearchProgramResult: Codable, Hashable, Identifiable, Sendable {
    public enum MatchedBy: String, Codable, Sendable {
        case program
        case episode
    }

    public let id: String
    public let title: String
    public let description: String
    public let thumbnailURL: URL
    public let genre: [GenreRef]
    public let matchedBy: MatchedBy
    public let episodes: [EpisodeSummary]
}

// MARK: - Responses

public struct GenresResponse: Codable, Sendable {
    public let genres: [Genre]
}

public struct ProgramsByGenreResponse: Codable, Sendable {
    public let genreID: String
    public let total: Int
    public let nextCursor: String?
    public let programs: [ProgramSummary]
}

public struct EpisodeSearchResponse: Codable, Sendable {
    public let query: String
    public let programID: String
    public let total: Int
    public let nextCursor: String?
    public let episodes: [EpisodeSummary]
}

public struct SearchResponse: Codable, Sendable {
    public let query: String
    public let total: Int
    public let nextCursor: String?
    public let programs: [SearchProgramResult]
}

/// `GET /api/v1/episodes/{episodeID}/stream`
public struct StreamsResponse: Codable, Hashable, Sendable {
    public let episodeID: String
    public let streams: [Stream]
    /// Every `streamURL` token dies at this instant; refresh before then.
    public let expiresAt: Date
}

// MARK: - Metrics (spec §9)

/// `quality` enum, fixed for v1.
public enum Quality: String, Codable, CaseIterable, Sendable {
    case uhd8k
    case uhd4k
    case hd
}

/// `POST /api/v1/metrics/playback` body.
public struct PlaybackEvent: Codable, Hashable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case start
        case progress
        case complete
        case error
    }

    public let episodeID: String
    public let event: Kind
    public let positionSec: Double
    public let quality: Quality?
    public let sessionUUID: String

    public init(episodeID: String, event: Kind, positionSec: Double, quality: Quality?, sessionUUID: String) {
        self.episodeID = episodeID
        self.event = event
        self.positionSec = positionSec
        self.quality = quality
        self.sessionUUID = sessionUUID
    }

    // `quality` is `null`, never omitted, so the wire body matches the contract example exactly.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(episodeID, forKey: .episodeID)
        try c.encode(event, forKey: .event)
        try c.encode(positionSec, forKey: .positionSec)
        try c.encode(quality, forKey: .quality)
        try c.encode(sessionUUID, forKey: .sessionUUID)
    }
}

// MARK: - Errors (spec §2.3)

/// `{ "error": { "code", "message" } }`
public struct ErrorEnvelope: Codable, Hashable, Sendable {
    public struct Body: Codable, Hashable, Sendable {
        public let code: String
        public let message: String
    }

    public let error: Body
}
