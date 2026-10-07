import Foundation
import Observation
import ThirdPlaceAPI

/// App-wide dependencies: one API client (with the app key) shared by every
/// view, and the telemetry reporter factory the player uses.
@MainActor
@Observable
final class AppModel {
    let config: AppConfig
    let api: APIClient
    /// Viewer account (optional for watching); tokens live in the Keychain.
    let account: AccountModel

    init(config: AppConfig = .current, tokenStore: TokenStore = KeychainTokenStore()) {
        self.config = config
        self.api = APIClient(baseURL: config.apiBaseURL, appKey: config.appKey)
        self.account = AccountModel(client: AccountClient(api: api, store: tokenStore))
    }

    func makePlayer(for episodeID: String) -> PlayerCoordinator {
        PlayerCoordinator(api: api, episodeID: episodeID)
    }
}

/// Generic async-load state for list and detail screens.
enum LoadState<Value: Equatable>: Equatable {
    case idle
    case loading
    case loaded(Value)
    case failed(String)

    var value: Value? {
        if case .loaded(let v) = self { return v }
        return nil
    }
}

extension Error {
    /// Human-readable message for a failed request, keeping the contract's
    /// error code visible so support can map it back to the server.
    var userMessage: String {
        guard let api = self as? APIError else { return localizedDescription }
        switch api {
        case .server(_, let code, let message):
            switch code {
            case "rate_limited": return "Too many requests — please wait a moment."
            case "not_found": return "This content is no longer available."
            case "app_key_required": return "This build is not authorised to use the service (\(code))."
            default: return "\(message) (\(code))"
            }
        case .unexpectedStatus(let status): return "The service answered unexpectedly (HTTP \(status))."
        case .decoding: return "The service answered in an unexpected format."
        case .transport(let detail): return "Network problem: \(detail)"
        }
    }
}
