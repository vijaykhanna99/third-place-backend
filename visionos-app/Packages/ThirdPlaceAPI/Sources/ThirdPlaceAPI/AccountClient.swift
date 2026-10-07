import Foundation

/// Viewer accounts (spec §4): registration, sign-in with refresh rotation,
/// profile, sessions, and the emailed verification / reset requests.
///
/// The client owns the token pair. Every authenticated call sends the access
/// token; on a 401 it refreshes once (rotating the refresh token) and retries,
/// and when the refresh itself fails the session is cleared — the app then
/// shows the sign-in screen. Refresh is serialised so two concurrent 401s
/// cannot both rotate the same refresh token, which would kill the chain.
public actor AccountClient {
    public enum State: Equatable, Sendable {
        case signedOut
        case signedIn(did: String, handle: String)
    }

    private let api: APIClient
    private let store: TokenStore
    private var accessToken: String?
    private var session: StoredSession?
    private var refreshTask: Task<String, Error>?

    public init(api: APIClient, store: TokenStore) {
        self.api = api
        self.store = store
        self.session = store.load()
    }

    public var state: State {
        guard let session else { return .signedOut }
        return .signedIn(did: session.did, handle: session.handle)
    }

    // MARK: Sign up / in / out

    public func register(handle: String, email: String, password: String, displayName: String) async throws -> RegisterResponse {
        let response: RegisterResponse = try await api.post(
            "/api/v1/auth/register",
            body: ["handle": handle, "email": email, "password": password, "displayName": displayName]
        )
        try adopt(response.tokens)
        return response
    }

    public func signIn(identifier: String, password: String) async throws {
        let tokens: TokenResponse = try await api.post(
            "/api/v1/auth/login",
            body: ["identifier": identifier, "password": password]
        )
        try adopt(tokens)
    }

    /// Revokes the current session on the server (best effort) and forgets it locally.
    public func signOut() async {
        if let session {
            _ = try? await api.postNoContent("/api/v1/auth/logout", body: ["refreshToken": session.refreshToken])
        }
        forget()
    }

    /// Sent to the address on file; no-op server side once verified.
    public func requestEmailVerification() async throws {
        try await authorized { token in
            try await self.api.postNoContent("/api/v1/auth/email/verify-request", bearer: token)
        }
    }

    /// Public: answers 202 whether or not the identifier exists.
    public func requestPasswordReset(identifier: String) async throws {
        try await api.postNoContent("/api/v1/auth/password/reset-request", body: ["identifier": identifier])
    }

    // MARK: Account

    public func account() async throws -> Account {
        try await authorized { token in try await self.api.get(Account.self, "/api/v1/account", bearer: token) }
    }

    public func updateAccount(_ update: AccountUpdate) async throws -> Account {
        try await authorized { token in
            try await self.api.post("/api/v1/account", body: update, bearer: token)
        }
    }

    public func deleteAccount(password: String) async throws -> AccountDeleted {
        let result: AccountDeleted = try await authorized { token in
            try await self.api.post("/api/v1/account/delete", body: ["password": password], bearer: token)
        }
        forget()
        return result
    }

    public func sessions() async throws -> [AccountSession] {
        struct Envelope: Decodable { let sessions: [AccountSession] }
        return try await authorized { token in
            try await self.api.get(Envelope.self, "/api/v1/auth/sessions", bearer: token).sessions
        }
    }

    public func revokeSession(id: String) async throws {
        try await authorized { token in
            try await self.api.postNoContent("/api/v1/auth/sessions/\(id)/revoke", bearer: token)
        }
    }

    // MARK: Token handling

    private func adopt(_ tokens: TokenResponse) throws {
        let stored = StoredSession(refreshToken: tokens.refreshToken, did: tokens.did, handle: tokens.handle)
        try store.save(stored)
        session = stored
        accessToken = tokens.accessToken
    }

    private func forget() {
        store.clear()
        session = nil
        accessToken = nil
        refreshTask?.cancel()
        refreshTask = nil
    }

    /// Runs `operation` with a valid access token, refreshing once on 401.
    private func authorized<T: Sendable>(_ operation: @Sendable (String) async throws -> T) async throws -> T {
        guard session != nil else { throw APIError.server(status: 401, code: "unauthenticated", message: "Not signed in") }
        let token: String
        if let accessToken {
            token = accessToken
        } else {
            token = try await refresh()
        }
        do {
            return try await operation(token)
        } catch let error as APIError where error.isUnauthenticated {
            let fresh = try await refresh()
            return try await operation(fresh)
        }
    }

    /// Rotates the refresh token. Concurrent callers share one in-flight rotation.
    private func refresh() async throws -> String {
        if let refreshTask { return try await refreshTask.value }
        guard let current = session else {
            throw APIError.server(status: 401, code: "unauthenticated", message: "Not signed in")
        }
        let api = self.api
        let task = Task<String, Error> {
            let tokens: TokenResponse = try await api.post(
                "/api/v1/auth/refresh",
                body: ["refreshToken": current.refreshToken]
            )
            return try await self.finishRefresh(tokens)
        }
        refreshTask = task
        defer { refreshTask = nil }
        do {
            return try await task.value
        } catch let error as APIError where error.isUnauthenticated {
            // The chain is dead (reuse, revocation, expiry): sign out locally.
            forget()
            throw error
        }
    }

    private func finishRefresh(_ tokens: TokenResponse) throws -> String {
        try adopt(tokens)
        return tokens.accessToken
    }
}

extension APIError {
    /// 401 of either flavour (`unauthenticated`, `invalid_token`).
    public var isUnauthenticated: Bool {
        if case .server(let status, _, _) = self { return status == 401 }
        return false
    }
}
