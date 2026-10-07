import Foundation
import Observation
import ThirdPlaceAPI

/// Signed-in state for the Account tab. Wraps `AccountClient` (which owns the
/// tokens) with the loaded profile and the flags the screens need.
@MainActor
@Observable
final class AccountModel {
    enum Status: Equatable {
        case unknown
        case signedOut
        case signedIn(Account)
    }

    private let client: AccountClient
    private(set) var status: Status = .unknown
    private(set) var isBusy = false
    /// One-line confirmation after an action ("Verification email sent").
    var notice: String?

    init(client: AccountClient) {
        self.client = client
    }

    var account: Account? {
        if case .signedIn(let a) = status { return a }
        return nil
    }

    /// Restores the session from the Keychain and loads the profile.
    func restore() async {
        switch await client.state {
        case .signedOut:
            status = .signedOut
        case .signedIn:
            await reload()
        }
    }

    func reload() async {
        do {
            status = .signedIn(try await client.account())
        } catch let error as APIError where error.isUnauthenticated {
            status = .signedOut
        } catch {
            // Keep whatever we had; the screen shows the error.
            if case .unknown = status { status = .signedOut }
            notice = error.userMessage
        }
    }

    func signIn(identifier: String, password: String) async throws {
        try await busy {
            try await client.signIn(identifier: identifier, password: password)
            status = .signedIn(try await client.account())
        }
    }

    func signUp(handle: String, email: String, password: String, displayName: String) async throws {
        try await busy {
            _ = try await client.register(handle: handle, email: email, password: password, displayName: displayName)
            status = .signedIn(try await client.account())
            notice = "We sent a verification link to \(email)."
        }
    }

    func signOut() async {
        await client.signOut()
        status = .signedOut
        notice = nil
    }

    func resendVerification() async throws {
        try await busy {
            try await client.requestEmailVerification()
            notice = "Verification email sent."
        }
    }

    func requestPasswordReset(identifier: String) async throws {
        try await busy {
            try await client.requestPasswordReset(identifier: identifier)
            notice = "If that account exists, a reset link is on its way."
        }
    }

    func update(_ update: AccountUpdate) async throws {
        try await busy {
            status = .signedIn(try await client.updateAccount(update))
            notice = update.password == nil ? "Saved." : "Password changed; other devices were signed out."
        }
    }

    func deleteAccount(password: String) async throws {
        try await busy {
            _ = try await client.deleteAccount(password: password)
            status = .signedOut
            notice = "Your account was deleted."
        }
    }

    func sessions() async throws -> [AccountSession] {
        try await client.sessions()
    }

    func revokeSession(id: String) async throws {
        try await client.revokeSession(id: id)
    }

    private func busy(_ work: () async throws -> Void) async throws {
        isBusy = true
        defer { isBusy = false }
        try await work()
    }
}
