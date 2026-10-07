import Foundation
import XCTest
@testable import ThirdPlaceAPI

/// Transport stub: records the request, answers with a canned status and body.
private final class StubTransport: HTTPTransport, @unchecked Sendable {
    var status = 200
    var body = Data()
    private(set) var requests: [URLRequest] = []

    func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
        requests.append(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        return (body, response)
    }
}

final class APIClientTests: XCTestCase {
    private let base = URL(string: "https://api.test.example")!

    private func client(_ transport: StubTransport) -> APIClient {
        APIClient(baseURL: base, appKey: "test-app-key", transport: transport)
    }

    func testSendsTheAppKeyAndBuildsQueries() async throws {
        let transport = StubTransport()
        transport.body = Data(#"{"query":"tokyo","total":0,"nextCursor":null,"programs":[]}"#.utf8)
        let result = try await client(transport).search(query: "tokyo", limit: 5, cursor: "abc")
        XCTAssertEqual(result.total, 0)
        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-App-Key"), "test-app-key")
        XCTAssertEqual(request.url?.path, "/api/v1/search")
        XCTAssertEqual(request.url?.query, "cursor=abc&limit=5&query=tokyo")
    }

    func testOmitsAbsentQueryParameters() async throws {
        let transport = StubTransport()
        transport.body = Data(#"{"genres":[]}"#.utf8)
        _ = try await client(transport).genres()
        XCTAssertNil(transport.requests.first?.url?.query)
    }

    func testMapsTheErrorEnvelope() async {
        let transport = StubTransport()
        transport.status = 403
        transport.body = Data(#"{"error":{"code":"app_key_required","message":"Missing or invalid app key"}}"#.utf8)
        do {
            _ = try await client(transport).genres()
            XCTFail("expected an error")
        } catch let error as APIError {
            XCTAssertEqual(error, .server(status: 403, code: "app_key_required", message: "Missing or invalid app key"))
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    func testNotFoundAndRateLimitedAreRecognisable() async {
        let transport = StubTransport()
        transport.status = 404
        transport.body = Data(#"{"error":{"code":"not_found","message":"Episode not found"}}"#.utf8)
        do {
            _ = try await client(transport).streams(episodeID: "x")
            XCTFail("expected an error")
        } catch let error as APIError {
            XCTAssertTrue(error.isNotFound)
            XCTAssertFalse(error.isRateLimited)
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    func testUnexpectedStatusWithoutEnvelope() async {
        let transport = StubTransport()
        transport.status = 502
        transport.body = Data("<html>bad gateway</html>".utf8)
        do {
            _ = try await client(transport).genres()
            XCTFail("expected an error")
        } catch let error as APIError {
            XCTAssertEqual(error, .unexpectedStatus(502))
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    func testDecodingFailureNamesThePath() async {
        let transport = StubTransport()
        transport.body = Data(#"{"genres":"not an array"}"#.utf8)
        do {
            _ = try await client(transport).genres()
            XCTFail("expected an error")
        } catch let error as APIError {
            if case .decoding(let detail) = error {
                XCTAssertTrue(detail.contains("/api/v1/genres"))
            } else {
                XCTFail("unexpected \(error)")
            }
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    func testRecordPostsJSONAndAcceptsA202() async throws {
        let transport = StubTransport()
        transport.status = 202
        let event = PlaybackEvent(episodeID: "e", event: .start, positionSec: 0, quality: .uhd8k, sessionUUID: "s")
        try await client(transport).record(event)
        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let sent = try JSONDecoder().decode(PlaybackEvent.self, from: XCTUnwrap(request.httpBody))
        XCTAssertEqual(sent, event)
    }
}
