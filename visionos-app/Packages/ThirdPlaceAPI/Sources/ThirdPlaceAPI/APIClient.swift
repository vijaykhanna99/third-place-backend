import Foundation

/// Failures surfaced to the app. Server errors keep the contract's machine-readable code.
public enum APIError: Error, Equatable, Sendable {
    /// Non-2xx with the contract's error envelope (`not_found`, `app_key_required`, `rate_limited`, …).
    case server(status: Int, code: String, message: String)
    /// Non-2xx without a parseable envelope (a proxy page, an empty body).
    case unexpectedStatus(Int)
    /// The body was not what the contract promises.
    case decoding(String)
    /// URLSession failure (offline, timeout, TLS).
    case transport(String)

    public var isRateLimited: Bool {
        if case .server(_, let code, _) = self { return code == "rate_limited" }
        return false
    }

    public var isNotFound: Bool {
        if case .server(let status, _, _) = self { return status == 404 }
        return false
    }
}

/// Minimal surface of URLSession used by the client, so tests can stub transport.
/// Named `send` rather than `data(for:)`: Foundation's method carries a defaulted
/// `delegate:` parameter and so cannot witness a protocol requirement directly.
public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, URLResponse)
}

extension URLSession: HTTPTransport {
    public func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
        try await data(for: request)
    }
}

/// Client for the public (app-key gated) surface of the Third Place API.
/// Account endpoints live in `AccountClient`, which layers the bearer token on
/// top of this client's plumbing.
///
/// - Every request carries `X-App-Key` (spec §2.2, Decision D5).
/// - Timestamps are ISO 8601 UTC, with or without fractional seconds.
/// - Non-2xx responses are mapped to `APIError.server` from the error envelope.
// `@unchecked`: JSONDecoder/JSONEncoder are configured once in init and never
// mutated afterwards; the compiler cannot see that, we guarantee it.
public final class APIClient: @unchecked Sendable {
    public let baseURL: URL
    private let appKey: String
    private let transport: HTTPTransport
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    public init(baseURL: URL, appKey: String, transport: HTTPTransport = URLSession.shared) {
        self.baseURL = baseURL
        self.appKey = appKey
        self.transport = transport
        self.decoder = APIClient.makeDecoder()
        self.encoder = JSONEncoder()
    }

    // MARK: Catalog (spec §6)

    public func genres() async throws -> [Genre] {
        try await get(GenresResponse.self, "/api/v1/genres").genres
    }

    public func programs(inGenre genreID: String, limit: Int = 20, cursor: String? = nil) async throws
        -> ProgramsByGenreResponse
    {
        try await get(
            ProgramsByGenreResponse.self,
            "/api/v1/genres/\(genreID)/programs",
            query: ["limit": String(limit), "cursor": cursor]
        )
    }

    public func program(id: String, seasonNumber: Int? = nil) async throws -> Program {
        try await get(
            Program.self,
            "/api/v1/programs/\(id)",
            query: ["seasonNumber": seasonNumber.map(String.init)]
        )
    }

    public func searchEpisodes(programID: String, query: String, limit: Int = 20, cursor: String? = nil)
        async throws -> EpisodeSearchResponse
    {
        try await get(
            EpisodeSearchResponse.self,
            "/api/v1/programs/\(programID)/episodes/search",
            query: ["query": query, "limit": String(limit), "cursor": cursor]
        )
    }

    public func search(query: String, limit: Int = 20, cursor: String? = nil) async throws -> SearchResponse {
        try await get(
            SearchResponse.self,
            "/api/v1/search",
            query: ["query": query, "limit": String(limit), "cursor": cursor]
        )
    }

    // MARK: Media (spec §5.3)

    /// Fresh tokenised master-playlist URLs for every camera angle of an episode.
    public func streams(episodeID: String) async throws -> StreamsResponse {
        try await get(StreamsResponse.self, "/api/v1/episodes/\(episodeID)/stream")
    }

    // MARK: Metrics (spec §9)

    /// Fire-and-forget telemetry; the server answers 202 whatever the payload.
    /// Throws only on transport failure or a non-2xx status (e.g. a missing app key).
    public func record(_ event: PlaybackEvent) async throws {
        var request = makeRequest(path: "/api/v1/metrics/playback", query: [:])
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(event)
        let (data, response) = try await send(request)
        try Self.ensureSuccess(data: data, response: response, decoder: decoder)
    }

    // MARK: Plumbing (shared with AccountClient, which adds the bearer token)

    func get<T: Decodable>(_ type: T.Type, _ path: String, query: [String: String?] = [:], bearer: String? = nil) async throws -> T {
        let request = makeRequest(path: path, query: query, bearer: bearer)
        let (data, response) = try await send(request)
        try Self.ensureSuccess(data: data, response: response, decoder: decoder)
        return try decode(T.self, from: data, path: path)
    }

    /// JSON POST expecting a JSON body back.
    func post<T: Decodable, B: Encodable>(_ path: String, body: B, bearer: String? = nil) async throws -> T {
        let request = try makeJSONRequest(path: path, body: body, bearer: bearer)
        let (data, response) = try await send(request)
        try Self.ensureSuccess(data: data, response: response, decoder: decoder)
        return try decode(T.self, from: data, path: path)
    }

    /// JSON POST where only the status matters (202 Accepted endpoints).
    func postNoContent<B: Encodable>(_ path: String, body: B, bearer: String? = nil) async throws {
        let request = try makeJSONRequest(path: path, body: body, bearer: bearer)
        let (data, response) = try await send(request)
        try Self.ensureSuccess(data: data, response: response, decoder: decoder)
    }

    /// Bodiless POST where only the status matters.
    func postNoContent(_ path: String, bearer: String? = nil) async throws {
        var request = makeRequest(path: path, query: [:], bearer: bearer)
        request.httpMethod = "POST"
        let (data, response) = try await send(request)
        try Self.ensureSuccess(data: data, response: response, decoder: decoder)
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data, path: String) throws -> T {
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decoding("\(path): \(error)")
        }
    }

    private func makeJSONRequest<B: Encodable>(path: String, body: B, bearer: String?) throws -> URLRequest {
        var request = makeRequest(path: path, query: [:], bearer: bearer)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(body)
        return request
    }

    private func makeRequest(path: String, query: [String: String?], bearer: String? = nil) -> URLRequest {
        var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        let items = query.compactMap { key, value in value.map { URLQueryItem(name: key, value: $0) } }
            .sorted { $0.name < $1.name }
        components.queryItems = items.isEmpty ? nil : items
        var request = URLRequest(url: components.url!)
        request.setValue(appKey, forHTTPHeaderField: "X-App-Key")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let bearer { request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
        request.timeoutInterval = 20
        return request
    }

    private func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await transport.send(request)
            guard let http = response as? HTTPURLResponse else { throw APIError.transport("non-HTTP response") }
            return (data, http)
        } catch let error as APIError {
            throw error
        } catch {
            throw APIError.transport(error.localizedDescription)
        }
    }

    private static func ensureSuccess(data: Data, response: HTTPURLResponse, decoder: JSONDecoder) throws {
        guard !(200..<300).contains(response.statusCode) else { return }
        if let envelope = try? decoder.decode(ErrorEnvelope.self, from: data) {
            throw APIError.server(status: response.statusCode, code: envelope.error.code, message: envelope.error.message)
        }
        throw APIError.unexpectedStatus(response.statusCode)
    }

    /// ISO 8601 with optional fractional seconds — the server emits `toISOString()` (fractional),
    /// the contract examples do not.
    static func makeDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let raw = try container.decode(String.self)
            if let date = fractional.date(from: raw) ?? plain.date(from: raw) { return date }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Not an ISO 8601 date: \(raw)")
        }
        return decoder
    }
}
