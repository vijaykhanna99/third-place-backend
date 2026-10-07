import SwiftUI
import ThirdPlaceAPI

/// Account tab: sign in / create an account when signed out, the profile when signed in.
struct AccountView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var account = model.account
        Group {
            switch account.status {
            case .unknown:
                LoadingView()
            case .signedOut:
                SignedOutView()
            case .signedIn(let profile):
                ProfileView(profile: profile)
            }
        }
        .navigationTitle("Account")
        .task { if account.status == .unknown { await account.restore() } }
        .overlay(alignment: .bottom) {
            if let notice = account.notice {
                Text(notice)
                    .padding(.horizontal, 20).padding(.vertical, 12)
                    .background(.regularMaterial, in: Capsule())
                    .padding(.bottom, 24)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .task {
                        try? await Task.sleep(for: .seconds(4))
                        if account.notice == notice { account.notice = nil }
                    }
            }
        }
        .animation(.default, value: account.notice)
    }
}

// MARK: - Signed out

private struct SignedOutView: View {
    @Environment(AppModel.self) private var model
    @State private var identifier = ""
    @State private var password = ""
    @State private var error: String?
    @State private var showSignUp = false
    @State private var showReset = false

    var body: some View {
        VStack(spacing: 28) {
            VStack(spacing: 8) {
                Image(systemName: "person.crop.circle").font(.system(size: 56)).foregroundStyle(.secondary)
                Text("Sign in to Third Place").font(.title.weight(.bold))
                Text("Watching does not need an account. Sign in to keep your profile with you.")
                    .foregroundStyle(.secondary).multilineTextAlignment(.center)
            }
            Form {
                TextField("Handle or email", text: $identifier)
                    .textContentType(.username)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField("Password", text: $password)
                    .textContentType(.password)
                if let error { Text(error).foregroundStyle(.red).font(.callout) }
            }
            .formStyle(.grouped)
            .frame(maxWidth: 520, maxHeight: 220)

            HStack(spacing: 16) {
                Button("Sign in") { Task { await signIn() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(identifier.isEmpty || password.isEmpty || model.account.isBusy)
                Button("Create account") { showSignUp = true }
                Button("Forgot password?") { showReset = true }.buttonStyle(.plain).foregroundStyle(.secondary)
            }
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .sheet(isPresented: $showSignUp) { SignUpView() }
        .sheet(isPresented: $showReset) { PasswordResetView(identifier: identifier) }
    }

    private func signIn() async {
        error = nil
        do {
            try await model.account.signIn(identifier: identifier.trimmingCharacters(in: .whitespaces), password: password)
            password = ""
        } catch {
            self.error = error.signInMessage
        }
    }
}

private struct SignUpView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var handle = ""
    @State private var displayName = ""
    @State private var email = ""
    @State private var password = ""
    @State private var error: String?

    private var handleIsValid: Bool {
        (3...32).contains(handle.count) && handle.allSatisfy { $0.isLowercase || $0.isNumber || $0 == "-" }
    }
    private var canSubmit: Bool {
        handleIsValid && !displayName.isEmpty && email.contains("@") && password.count >= 10 && !model.account.isBusy
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Handle (letters, numbers, dashes)", text: $handle)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .onChange(of: handle) { _, value in handle = value.lowercased() }
                    TextField("Display name", text: $displayName)
                    TextField("Email", text: $email)
                        .textContentType(.emailAddress).keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("Password (10 characters or more)", text: $password)
                        .textContentType(.newPassword)
                } footer: {
                    Text("We email a link to confirm your address. You can watch without confirming.")
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Create account")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") { Task { await submit() } }.disabled(!canSubmit)
                }
            }
        }
        .frame(minWidth: 560, minHeight: 480)
    }

    private func submit() async {
        error = nil
        do {
            try await model.account.signUp(
                handle: handle, email: email.trimmingCharacters(in: .whitespaces), password: password, displayName: displayName
            )
            dismiss()
        } catch {
            self.error = error.signUpMessage
        }
    }
}

private struct PasswordResetView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State var identifier: String
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Handle or email", text: $identifier)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                } footer: {
                    Text("We email a link that is valid for 30 minutes. Open it on any device.")
                }
                if let error { Section { Text(error).foregroundStyle(.red) } }
            }
            .navigationTitle("Reset password")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send link") { Task { await submit() } }
                        .disabled(identifier.isEmpty || model.account.isBusy)
                }
            }
        }
        .frame(minWidth: 520, minHeight: 300)
    }

    private func submit() async {
        error = nil
        do {
            try await model.account.requestPasswordReset(identifier: identifier.trimmingCharacters(in: .whitespaces))
            dismiss()
        } catch {
            self.error = error.userMessage
        }
    }
}

// MARK: - Signed in

private struct ProfileView: View {
    @Environment(AppModel.self) private var model
    let profile: Account
    @State private var displayName = ""
    @State private var showPasswordChange = false
    @State private var showDelete = false
    @State private var showSessions = false
    @State private var error: String?

    var body: some View {
        Form {
            Section("Profile") {
                LabeledContent("Handle", value: "@\(profile.handle)")
                TextField("Display name", text: $displayName)
                LabeledContent("Email") {
                    HStack(spacing: 8) {
                        Text(profile.email)
                        if profile.isEmailVerified {
                            Label("Verified", systemImage: "checkmark.seal.fill").labelStyle(.iconOnly).foregroundStyle(.green)
                        } else {
                            Button("Resend verification") { Task { await run { try await model.account.resendVerification() } } }
                                .font(.callout)
                        }
                    }
                }
                LabeledContent("Member since") { Text(profile.createdAt, style: .date) }
                Button("Save") {
                    Task { await run { try await model.account.update(AccountUpdate(displayName: displayName)) } }
                }
                .disabled(displayName.isEmpty || displayName == profile.displayName || model.account.isBusy)
            }
            Section("Security") {
                Button("Change password") { showPasswordChange = true }
                Button("Devices signed in") { showSessions = true }
                Button("Sign out") { Task { await model.account.signOut() } }
            }
            Section {
                Button("Delete account", role: .destructive) { showDelete = true }
            } footer: {
                Text("Deleting removes your profile and signs out every device. Watching stays free without an account.")
            }
            if let error { Section { Text(error).foregroundStyle(.red) } }
        }
        .formStyle(.grouped)
        .frame(maxWidth: 720)
        .onAppear { displayName = profile.displayName }
        .onChange(of: profile.displayName) { _, value in displayName = value }
        .sheet(isPresented: $showPasswordChange) { PasswordChangeView() }
        .sheet(isPresented: $showSessions) { SessionsView() }
        .sheet(isPresented: $showDelete) { DeleteAccountView() }
    }

    private func run(_ work: () async throws -> Void) async {
        error = nil
        do { try await work() } catch { self.error = error.userMessage }
    }
}

private struct PasswordChangeView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var current = ""
    @State private var next = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                SecureField("Current password", text: $current).textContentType(.password)
                SecureField("New password (10 characters or more)", text: $next).textContentType(.newPassword)
                if let error { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle("Change password")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Change") { Task { await submit() } }
                        .disabled(current.isEmpty || next.count < 10 || model.account.isBusy)
                }
            }
        }
        .frame(minWidth: 520, minHeight: 300)
    }

    private func submit() async {
        error = nil
        do {
            try await model.account.update(AccountUpdate(password: .init(current: current, next: next)))
            dismiss()
        } catch {
            self.error = error.userMessage
        }
    }
}

private struct DeleteAccountView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var password = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField("Password", text: $password).textContentType(.password)
                } footer: {
                    Text("This cannot be undone.")
                }
                if let error { Section { Text(error).foregroundStyle(.red) } }
            }
            .navigationTitle("Delete account")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .destructiveAction) {
                    Button("Delete", role: .destructive) { Task { await submit() } }
                        .disabled(password.isEmpty || model.account.isBusy)
                }
            }
        }
        .frame(minWidth: 520, minHeight: 280)
    }

    private func submit() async {
        error = nil
        do {
            try await model.account.deleteAccount(password: password)
            dismiss()
        } catch {
            self.error = error.userMessage
        }
    }
}

private struct SessionsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var state: LoadState<[AccountSession]> = .idle

    var body: some View {
        NavigationStack {
            Group {
                switch state {
                case .idle, .loading:
                    LoadingView()
                case .failed(let message):
                    ErrorView(message: message) { Task { await load() } }
                case .loaded(let sessions):
                    List(sessions) { session in
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(session.deviceInfo ?? "Unknown device").font(.headline)
                                Text("Last used \(session.lastUsedAt, style: .relative) ago").font(.callout).foregroundStyle(.secondary)
                            }
                            Spacer()
                            if session.isCurrent {
                                Text("This device").font(.callout).foregroundStyle(.secondary)
                            } else {
                                Button("Sign out") { Task { await revoke(session.id) } }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Devices signed in")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { if state == .idle { await load() } }
        }
        .frame(minWidth: 600, minHeight: 420)
    }

    private func load() async {
        state = .loading
        do { state = .loaded(try await model.account.sessions()) } catch { state = .failed(error.userMessage) }
    }

    private func revoke(_ id: String) async {
        do {
            try await model.account.revokeSession(id: id)
            await load()
        } catch {
            state = .failed(error.userMessage)
        }
    }
}

// MARK: - Messages

extension Error {
    var signInMessage: String {
        if let api = self as? APIError, case .server(_, let code, _) = api {
            switch code {
            case "unauthenticated", "invalid_token": return "That handle or password is not right."
            case "rate_limited": return "Too many attempts — please wait a few minutes."
            default: break
            }
        }
        return userMessage
    }

    var signUpMessage: String {
        if let api = self as? APIError, case .server(_, let code, _) = api {
            switch code {
            case "handle_taken": return "That handle or email is already in use."
            case "registration_closed": return "Sign-ups are not open yet."
            case "validation_failed": return "Please check the handle, email and password."
            default: break
            }
        }
        return userMessage
    }
}
