import Foundation
import XCTest
@testable import ThirdPlaceAPI

/// Scripted transport: one canned answer per request, in order.
private final class ScriptedTransport: HTTPTransport, @unchecked Sendable {
    struct Answer {
        let status: Int
        let body: String
    }

    private let lock = NSLock()
    private var script: [Answer]
    private(set) var requests: [URLRequest] = []

    init(_ script: [Answer]) {
        self.script = script
    }

    func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
        lock.lock()
        defer { lock.unlock() }
        requests.append(request)
        guard !script.isEmpty else {
            XCTFail("unexpected request \(request.httpMethod ?? "") \(request.url?.path ?? "")")
            throw APIError.transport("no scripted answer")
        }
        let answer = script.removeFirst()
        let response = HTTPURLResponse(url: request.url!, statusCode: answer.status, httpVersion: nil, headerFields: nil)!
        return (Data(answer.body.utf8), response)
    }

    func path(_ index: Int) -> String? { requests.indices.contains(index) ? requests[index].url?.path : nil }
    func bearer(_ index: Int) -> String? {
        requests.indices.contains(index) ? requests[index].value(forHTTPHeaderField: "Authorization") : nil
    }
    func body(_ index: Int) -> [String: Any]? {
        guard requests.indices.contains(index), let data = requests[index].httpBody else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }
}

private let tokens = #"{"did":"did:tplace:1","handle":"viewer","accessToken":"ACCESS-1","refreshToken":"rft_1","expiresIn":900}"#
private let rotated = #"{"did":"did:tplace:1","handle":"viewer","accessToken":"ACCESS-2","refreshToken":"rft_2","expiresIn":900}"#
private let account = #"""
{"did":"did:tplace:1","handle":"viewer","email":"v@example.com","emailVerifiedAt":null,"displayName":"Viewer",
 "description":"","avatarURL":null,"createdAt":"2026-08-06T03:00:00.000Z","updatedAt":"2026-08-06T03:00:00.000Z"}
"""#
private let unauthenticated = #"{"error":{"code":"invalid_token","message":"Invalid or expired token"}}"#

final class AccountClientTests: XCTestCase {
    private func make(_ transport: ScriptedTransport, store: InMemoryTokenStore = InMemoryTokenStore()) -> AccountClient {
        let api = APIClient(baseURL: URL(string: "https://api.test.example")!, appKey: "k", transport: transport)
        return AccountClient(api: api, store: store)
    }

    func testRegisterStoresTheSessionAndSignsIn() async throws {
        let register = #"""
        {"did":"did:tplace:1","handle":"viewer","email":"v@example.com","displayName":"Viewer","avatarURL":null,
         "createdAt":"2026-08-06T03:00:00Z","accessToken":"ACCESS-1","refreshToken":"rft_1","expiresIn":900}
        """#
        let transport = ScriptedTransport([.init(status: 200, body: register), .init(status: 200, body: account)])
        let store = InMemoryTokenStore()
        let client = make(transport, store: store)

        let response = try await client.register(handle: "viewer", email: "v@example.com", password: "0123456789ab", displayName: "Viewer")
        XCTAssertEqual(response.handle, "viewer")
        XCTAssertEqual(store.load(), StoredSession(refreshToken: "rft_1", did: "did:tplace:1", handle: "viewer"))
        let state = await client.state
        XCTAssertEqual(state, .signedIn(did: "did:tplace:1", handle: "viewer"))
        XCTAssertEqual(transport.body(0)?["handle"] as? String, "viewer")
        XCTAssertEqual(transport.requests[0].value(forHTTPHeaderField: "X-App-Key"), "k")

        let me = try await client.account()
        XCTAssertEqual(me.handle, "viewer")
        XCTAssertFalse(me.isEmailVerified)
        XCTAssertEqual(transport.bearer(1), "Bearer ACCESS-1")
    }

    func testRestoredSessionRefreshesBeforeTheFirstCallAndRetriesOnceOn401() async throws {
        // Restart: only the refresh token survives, so the first call must refresh.
        let store = InMemoryTokenStore(StoredSession(refreshToken: "rft_1", did: "did:tplace:1", handle: "viewer"))
        let transport = ScriptedTransport([
            .init(status: 200, body: tokens),           // refresh (no access token yet)
            .init(status: 401, body: unauthenticated),  // account → expired access token
            .init(status: 200, body: rotated),          // refresh again
            .init(status: 200, body: account),          // retry succeeds
        ])
        let client = make(transport, store: store)
        let me = try await client.account()
        XCTAssertEqual(me.did, "did:tplace:1")
        XCTAssertEqual(transport.path(0), "/api/v1/auth/refresh")
        XCTAssertEqual(transport.body(0)?["refreshToken"] as? String, "rft_1")
        XCTAssertEqual(transport.bearer(1), "Bearer ACCESS-1")
        XCTAssertEqual(transport.body(2)?["refreshToken"] as? String, "rft_1")
        XCTAssertEqual(transport.bearer(3), "Bearer ACCESS-2")
        XCTAssertEqual(store.load()?.refreshToken, "rft_2")
    }

    func testFailedRefreshSignsOut() async {
        let store = InMemoryTokenStore(StoredSession(refreshToken: "rft_dead", did: "did:tplace:1", handle: "viewer"))
        let transport = ScriptedTransport([.init(status: 401, body: unauthenticated)])
        let client = make(transport, store: store)
        do {
            _ = try await client.account()
            XCTFail("expected an error")
        } catch let error as APIError {
            XCTAssertTrue(error.isUnauthenticated)
        } catch {
            XCTFail("unexpected \(error)")
        }
        XCTAssertNil(store.load())
        let state = await client.state
        XCTAssertEqual(state, .signedOut)
    }

    func testSignOutRevokesAndClears() async throws {
        let transport = ScriptedTransport([.init(status: 200, body: tokens), .init(status: 200, body: #"{"revoked":true}"#)])
        let store = InMemoryTokenStore()
        let client = make(transport, store: store)
        try await client.signIn(identifier: "viewer", password: "0123456789ab")
        XCTAssertNotNil(store.load())
        await client.signOut()
        XCTAssertEqual(transport.path(1), "/api/v1/auth/logout")
        XCTAssertEqual(transport.body(1)?["refreshToken"] as? String, "rft_1")
        XCTAssertNil(store.load())
        let state = await client.state
        XCTAssertEqual(state, .signedOut)
    }

    func testPublicRequestsNeedNoSession() async throws {
        let transport = ScriptedTransport([.init(status: 202, body: "")])
        let client = make(transport)
        try await client.requestPasswordReset(identifier: "viewer")
        XCTAssertEqual(transport.path(0), "/api/v1/auth/password/reset-request")
        XCTAssertNil(transport.bearer(0))
    }

    func testAccountUpdateOmitsUntouchedFields() async throws {
        let transport = ScriptedTransport([.init(status: 200, body: tokens), .init(status: 200, body: account)])
        let client = make(transport)
        try await client.signIn(identifier: "viewer", password: "0123456789ab")
        _ = try await client.updateAccount(AccountUpdate(displayName: "New Name"))
        let body = try XCTUnwrap(transport.body(1))
        XCTAssertEqual(body["displayName"] as? String, "New Name")
        XCTAssertNil(body["email"])
        XCTAssertNil(body["password"])
    }

    func testStoredSessionRoundTripsThroughTheKeychainShape() throws {
        let session = StoredSession(refreshToken: "rft_x", did: "did:tplace:9", handle: "h")
        let data = try JSONEncoder().encode(session)
        XCTAssertEqual(try JSONDecoder().decode(StoredSession.self, from: data), session)
    }
}
