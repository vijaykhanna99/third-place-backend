import Foundation

/// Build-time configuration, injected from Config/*.xcconfig through Info.plist
/// (see project.yml). Debug points at the API and MinIO on this Mac; Release
/// at the production hosts.
struct AppConfig: Sendable {
    let apiBaseURL: URL
    let appKey: String
    let mediaOrigin: URL?

    static let current: AppConfig = {
        let info = Bundle.main.infoDictionary ?? [:]
        func string(_ key: String) -> String? {
            guard let raw = info[key] as? String, !raw.isEmpty else { return nil }
            return raw
        }
        let base = string("TPAPIBaseURL").flatMap(URL.init(string:)) ?? URL(string: "http://127.0.0.1:3000")!
        return AppConfig(
            apiBaseURL: base,
            appKey: string("TPAppKey") ?? "dev-app-key",
            mediaOrigin: string("TPMediaOrigin").flatMap(URL.init(string:))
        )
    }()
}
