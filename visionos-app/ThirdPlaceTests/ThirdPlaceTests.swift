import XCTest
import ThirdPlaceAPI
@testable import ThirdPlace

/// App-target unit tests, run on the visionOS simulator in CI. They cover the
/// pure logic of the app (formatting, configuration, navigation values, error
/// mapping); the views themselves are exercised by building the target.
final class ThirdPlaceTests: XCTestCase {
    func testDurationLabels() {
        XCTAssertEqual(5400.durationLabel, "1h 30m")
        XCTAssertEqual(3600.durationLabel, "1h")
        XCTAssertEqual(90.durationLabel, "1m")
        XCTAssertEqual(45.durationLabel, "45s")
        XCTAssertEqual(0.durationLabel, "0s")
    }

    func testDebugConfigurationReachesTheLocalBackend() {
        // The test host is the Debug app, whose Info.plist is filled from Config/Debug.xcconfig.
        let config = AppConfig.current
        XCTAssertEqual(config.apiBaseURL.absoluteString, "http://127.0.0.1:3000")
        XCTAssertEqual(config.appKey, "dev-app-key")
        XCTAssertEqual(config.mediaOrigin?.absoluteString, "http://127.0.0.1:9000/tplace-media-dev/media")
    }

    func testPlayerRequestRoundTripsAsAWindowValue() throws {
        let request = PlayerRequest(episodeID: "01890a5d-ac96-774b-b111-000000000301", title: "Opening Night")
        let data = try JSONEncoder().encode(request)
        XCTAssertEqual(try JSONDecoder().decode(PlayerRequest.self, from: data), request)
    }

    @MainActor
    func testAccountModelStartsSignedOutWithoutAStoredSession() async {
        let model = AppModel(tokenStore: InMemoryTokenStore())
        XCTAssertEqual(model.account.status, .unknown)
        await model.account.restore()
        XCTAssertEqual(model.account.status, .signedOut)
        XCTAssertNil(model.account.account)
    }

    func testSignInMessagesStayFriendly() {
        XCTAssertEqual(APIError.server(status: 401, code: "unauthenticated", message: "x").signInMessage,
                       "That handle or password is not right.")
        XCTAssertEqual(APIError.server(status: 409, code: "handle_taken", message: "x").signUpMessage,
                       "That handle or email is already in use.")
        XCTAssertEqual(APIError.server(status: 403, code: "registration_closed", message: "x").signUpMessage,
                       "Sign-ups are not open yet.")
    }

    func testLoadStateExposesOnlyLoadedValues() {
        XCTAssertNil(LoadState<Int>.idle.value)
        XCTAssertNil(LoadState<Int>.loading.value)
        XCTAssertNil(LoadState<Int>.failed("x").value)
        XCTAssertEqual(LoadState<Int>.loaded(3).value, 3)
    }

    func testUserMessagesKeepTheContractCodeVisible() {
        XCTAssertEqual(APIError.server(status: 429, code: "rate_limited", message: "Too many requests").userMessage,
                       "Too many requests — please wait a moment.")
        XCTAssertEqual(APIError.server(status: 404, code: "not_found", message: "Episode not found").userMessage,
                       "This content is no longer available.")
        XCTAssertTrue(APIError.server(status: 409, code: "upload_not_ready", message: "Nope").userMessage.contains("upload_not_ready"))
        XCTAssertTrue(APIError.unexpectedStatus(502).userMessage.contains("502"))
    }

    @MainActor
    func testAppModelBuildsAPlayerPerEpisode() {
        let model = AppModel(config: AppConfig(apiBaseURL: URL(string: "https://api.test.example")!, appKey: "k", mediaOrigin: nil))
        let player = model.makePlayer(for: "01890a5d-ac96-774b-b111-000000000301")
        XCTAssertEqual(player.state, .loading)
        XCTAssertTrue(player.streams.isEmpty)
        XCTAssertNil(player.currentStream)
        player.stop()
    }
}
