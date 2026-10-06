import Foundation

/// Helpers for the stream URLs the API issues (spec §5.2). The client never
/// mints or validates tokens — it only needs to know when they expire so it can
/// ask for fresh ones before AVPlayer's next playlist fetch fails with 403.
public enum StreamURLs {
    /// Refresh this long before `expiresAt`; comfortably more than one segment duration.
    public static let refreshLeadTime: TimeInterval = 60

    /// When to call `/stream` again for a response received now.
    public static func refreshDate(for response: StreamsResponse, now: Date = Date()) -> Date {
        max(now.addingTimeInterval(1), response.expiresAt.addingTimeInterval(-refreshLeadTime))
    }

    /// The `token` query parameter of a stream URL, if present.
    public static func token(in url: URL) -> String? {
        URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first { $0.name == "token" }?.value
    }

    /// Two URLs point at the same object when only their tokens differ.
    public static func sameObject(_ a: URL, _ b: URL) -> Bool {
        func strip(_ url: URL) -> String {
            var c = URLComponents(url: url, resolvingAgainstBaseURL: false)
            c?.queryItems = c?.queryItems?.filter { $0.name != "token" }
            if c?.queryItems?.isEmpty == true { c?.queryItems = nil }
            return c?.string ?? url.absoluteString
        }
        return strip(a) == strip(b)
    }
}
