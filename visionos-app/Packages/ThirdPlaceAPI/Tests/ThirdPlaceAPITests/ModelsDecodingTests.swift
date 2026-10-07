import Foundation
import XCTest
@testable import ThirdPlaceAPI

/// Decodes the contract's own examples (copied verbatim from openapi.yaml into
/// Fixtures/). If the contract changes shape, these fail before the app does.
final class ModelsDecodingTests: XCTestCase {
    private let decoder = APIClient.makeDecoder()

    private func fixture(_ name: String) throws -> Data {
        let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
        return try Data(contentsOf: url)
    }

    func testProgramDetail() throws {
        let program = try decoder.decode(Program.self, from: fixture("program"))
        XCTAssertEqual(program.title, "Neon Nights — Immersive Live")
        XCTAssertEqual(program.season.count, 2)
        XCTAssertEqual(program.allEpisodes.count, 6)
        XCTAssertEqual(program.viewer.isFollowing, false)
        let first = try XCTUnwrap(program.season.first?.episodes.first)
        XCTAssertEqual(first.streams.first?.name, "Main")
        XCTAssertTrue(first.streams.allSatisfy { $0.streamURL.path.hasSuffix("/index.m3u8") })
        XCTAssertNotNil(StreamURLs.token(in: first.streams[0].streamURL))
        XCTAssertEqual(program.createdAt, ISO8601DateFormatter().date(from: "2026-06-01T09:00:00Z"))
    }

    func testGenresAndProgramsByGenre() throws {
        let genres = try decoder.decode(GenresResponse.self, from: fixture("genres")).genres
        XCTAssertEqual(genres.first?.name, "Music")
        XCTAssertEqual(genres.first?.programCount, 1)
        let page = try decoder.decode(ProgramsByGenreResponse.self, from: fixture("programsByGenre"))
        XCTAssertNil(page.nextCursor)
        XCTAssertEqual(page.programs.first?.genre.first?.name, "Music")
    }

    func testSearchShapes() throws {
        let search = try decoder.decode(SearchResponse.self, from: fixture("search"))
        XCTAssertEqual(search.programs.first?.matchedBy, .episode)
        XCTAssertFalse(search.programs.first?.episodes.isEmpty ?? true)
        let scoped = try decoder.decode(EpisodeSearchResponse.self, from: fixture("episodeSearch"))
        XCTAssertEqual(scoped.episodes.first?.seasonNumber, 1)
    }

    func testStreamsResponse() throws {
        let streams = try decoder.decode(StreamsResponse.self, from: fixture("streams"))
        XCTAssertEqual(streams.streams.map(\.name), ["Main", "Side"])
        XCTAssertEqual(StreamURLs.token(in: streams.streams[0].streamURL), "v1.tok301m.fresh")
        let refresh = StreamURLs.refreshDate(for: streams, now: streams.expiresAt.addingTimeInterval(-900))
        XCTAssertEqual(refresh, streams.expiresAt.addingTimeInterval(-StreamURLs.refreshLeadTime))
        // Already past the lead time: refresh "now", never in the past.
        let now = streams.expiresAt.addingTimeInterval(-10)
        XCTAssertEqual(StreamURLs.refreshDate(for: streams, now: now), now.addingTimeInterval(1))
    }

    func testErrorEnvelope() throws {
        let envelope = try decoder.decode(ErrorEnvelope.self, from: fixture("error"))
        XCTAssertEqual(envelope.error.code, "app_key_required")
    }

    func testFractionalSecondsFromTheRealServer() throws {
        let json = #"{"name":"Main","uploadID":"01890a5d-ac96-774b-b111-000000000801","streamURL":"https://m.example/uploads/x/index.m3u8?token=t"}"#
        XCTAssertNoThrow(try decoder.decode(StreamAngle.self, from: Data(json.utf8)))
        let dated = #"{"episodeID":"01890a5d-ac96-774b-b111-000000000301","streams":[],"expiresAt":"2026-08-06T04:35:00.123Z"}"#
        let decoded = try decoder.decode(StreamsResponse.self, from: Data(dated.utf8))
        XCTAssertEqual(decoded.expiresAt.timeIntervalSince1970, 1_785_990_900.123, accuracy: 0.001)
    }

    func testPlaybackEventEncodesNullQuality() throws {
        let event = PlaybackEvent(episodeID: "e", event: .progress, positionSec: 421.5, quality: nil, sessionUUID: "s")
        let json = try XCTUnwrap(String(data: JSONEncoder().encode(event), encoding: .utf8))
        XCTAssertTrue(json.contains(#""quality":null"#), json)
        XCTAssertTrue(json.contains(#""event":"progress""#), json)
    }

    func testSameObjectIgnoresOnlyTheToken() throws {
        let a = try XCTUnwrap(URL(string: "https://m.example/uploads/x/index.m3u8?token=aaa"))
        let b = try XCTUnwrap(URL(string: "https://m.example/uploads/x/index.m3u8?token=bbb"))
        let c = try XCTUnwrap(URL(string: "https://m.example/uploads/y/index.m3u8?token=aaa"))
        XCTAssertTrue(StreamURLs.sameObject(a, b))
        XCTAssertFalse(StreamURLs.sameObject(a, c))
    }
}
