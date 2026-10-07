import Foundation
import Security

/// What survives an app restart: the refresh token and who it belongs to.
/// The access token is short-lived and kept in memory only.
public struct StoredSession: Codable, Hashable, Sendable {
    public let refreshToken: String
    public let did: String
    public let handle: String

    public init(refreshToken: String, did: String, handle: String) {
        self.refreshToken = refreshToken
        self.did = did
        self.handle = handle
    }
}

/// Persistence for the signed-in session. The app uses the Keychain; tests
/// use memory.
public protocol TokenStore: Sendable {
    func load() -> StoredSession?
    func save(_ session: StoredSession) throws
    func clear()
}

public final class InMemoryTokenStore: TokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var session: StoredSession?

    public init(_ session: StoredSession? = nil) {
        self.session = session
    }

    public func load() -> StoredSession? {
        lock.lock()
        defer { lock.unlock() }
        return session
    }

    public func save(_ session: StoredSession) throws {
        lock.lock()
        defer { lock.unlock() }
        self.session = session
    }

    public func clear() {
        lock.lock()
        defer { lock.unlock() }
        session = nil
    }
}

/// Keychain-backed store: one generic-password item per service name, readable
/// after the first unlock so a background refresh can run. Never synchronised
/// to iCloud — a refresh token is bound to the device that logged in.
public final class KeychainTokenStore: TokenStore, @unchecked Sendable {
    public struct KeychainError: Error, Equatable, Sendable {
        public let status: OSStatus
    }

    private let service: String
    private let account = "session"

    public init(service: String = "jp.co.3rd-place.ThirdPlace.session") {
        self.service = service
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    public func load() -> StoredSession? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(StoredSession.self, from: data)
    }

    public func save(_ session: StoredSession) throws {
        let data = try JSONEncoder().encode(session)
        var attributes = baseQuery
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        _ = SecItemDelete(baseQuery as CFDictionary)
        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    public func clear() {
        _ = SecItemDelete(baseQuery as CFDictionary)
    }
}
