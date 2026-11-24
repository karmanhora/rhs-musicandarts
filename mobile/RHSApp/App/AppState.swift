import Foundation
import Observation

/// The app's single piece of top-level state: whether the build is configured,
/// whether somebody is signed in, and what the backend says they can reach.
///
/// It never decides a role from a local preference. A signed-in person waits on
/// the membership answer, and a person on no roster is told that rather than
/// being given a shell they have no rights in.
@MainActor
@Observable
final class AppState {
    enum Phase: Equatable {
        case loading
        /// Build configuration is absent or invalid; `message` says what to fix.
        case configurationRequired(String)
        case signedOut
        case signedIn(AuthenticatedUser)
        /// A request failed. Shows the failure rather than an empty screen.
        case failed(String)
    }

    private(set) var phase: Phase = .loading
    /// `nil` until the backend answers. See `RoleResolving`.
    private(set) var role: AppRole?
    /// Signed in, but on no active roster.
    private(set) var noProgramAccess = false
    /// A recovery link was followed: set a new password before anything else.
    private(set) var recoveryInProgress = false
    /// The most recent auth deep link this build accepted.
    private(set) var lastAuthCallback: URL?
    /// A problem with a link or a callback, shown on the auth screen.
    private(set) var authError: String?
    /// A failure from an action (sign-out), shown by the screen that started it.
    private(set) var actionError: String?
    /// True only for a Debug build launched with `-RHSDemoRole`.
    private(set) var isDemoSession = false

    private let dependencies: AppDependencies
    private var auth: (any AuthServicing)? { dependencies.auth }

    init(dependencies: AppDependencies) {
        self.dependencies = dependencies
    }

    var configuration: AppConfiguration? { dependencies.configuration }

    /// The Supabase project host, for the status line. Never the key.
    var backendHost: String? { dependencies.configuration?.supabaseURL.host() }

    /// Reads the stored session. A persisted Supabase session is restored here,
    /// and the SDK refreshes it when needed; a launch with no session settles on
    /// `.signedOut`.
    func start() async {
        actionError = nil
        isDemoSession = false

        guard dependencies.configuration != nil else {
            phase = .configurationRequired(
                dependencies.configurationError ?? "The app has no Supabase configuration."
            )
            return
        }

        // Debug-only navigation preview. It is deliberately an explicit,
        // labelled demo session rather than a fabricated Supabase identity:
        // nothing is written, and Profile says it is not a real account.
        if let demoRole = dependencies.demoRole {
            isDemoSession = true
            role = demoRole
            phase = .signedIn(AuthenticatedUser(id: "demo-session", email: nil))
            return
        }

        guard let auth, dependencies.roleResolver != nil else {
            phase = .configurationRequired("This build could not create a Supabase client.")
            return
        }

        phase = .loading
        do {
            if let user = try await auth.currentUser() {
                await adopt(user)
            } else {
                role = nil
                noProgramAccess = false
                phase = .signedOut
            }
        } catch {
            phase = .failed(ErrorMessage.text(for: error))
        }
    }

    // MARK: - Email and password

    func signIn(email: String, password: String) async throws {
        guard let auth else { throw AuthUnavailable() }
        let user = try await auth.signIn(email: email, password: password)
        await adopt(user)
    }

    func signUp(
        email: String,
        password: String,
        audience: AuthAudience,
        displayName: String?
    ) async throws -> SignUpOutcome {
        guard let auth else { throw AuthUnavailable() }
        let outcome = try await auth.signUp(
            email: email,
            password: password,
            audience: audience,
            displayName: displayName
        )
        if case .signedIn(let user) = outcome { await adopt(user) }
        return outcome
    }

    /// Confirms with the code from the signup email. A confirmed address has a
    /// session, so this adopts the user like a sign-in.
    func confirmEmail(email: String, code: String) async throws {
        guard let auth else { throw AuthUnavailable() }
        if let user = try await auth.confirmEmail(email: email, code: code) {
            await adopt(user)
        } else if let user = try await auth.currentUser() {
            await adopt(user)
        }
    }

    func resendConfirmation(email: String) async throws {
        guard let auth else { throw AuthUnavailable() }
        try await auth.resendConfirmation(email: email)
    }

    func requestPasswordReset(email: String) async throws {
        guard let auth else { throw AuthUnavailable() }
        try await auth.requestPasswordReset(email: email)
    }

    func updatePassword(_ password: String) async throws {
        guard let auth else { throw AuthUnavailable() }
        try await auth.updatePassword(password)
        recoveryInProgress = false
        if let user = try await auth.currentUser() { await adopt(user) }
    }

    func dismissRecovery() {
        recoveryInProgress = false
    }

    // MARK: - Session

    func signOut() async {
        actionError = nil
        do {
            try await auth?.signOut()
            role = nil
            noProgramAccess = false
            recoveryInProgress = false
            isDemoSession = false
            phase = .signedOut
        } catch {
            actionError = ErrorMessage.text(for: error)
        }
    }

    /// Accepts only this build's registered callback. The scheme is derived from
    /// the bundle identifier, so the dev and production builds cannot consume
    /// each other's links.
    func handleIncomingURL(_ url: URL) {
        guard let configuration = dependencies.configuration else { return }
        guard url.scheme?.lowercased() == configuration.authCallbackURL.scheme,
              url.host?.lowercased() == "auth-callback"
        else {
            return
        }
        lastAuthCallback = url
        Task { await completeAuthentication(from: url) }
    }

    func completeAuthentication(from url: URL) async {
        guard let auth else { return }
        do {
            switch try await auth.completeAuthentication(from: url) {
            case .unhandled:
                return
            case .failure(let message):
                authError = message
            case .completed(let recovery):
                authError = nil
                if let user = try await auth.currentUser() { await adopt(user) }
                if recovery { recoveryInProgress = true }
            }
        } catch {
            authError = AuthMessages.readable(error)
        }
    }

    func clearAuthError() {
        authError = nil
    }

    func clearActionError() {
        actionError = nil
    }

    // MARK: - Access

    private func adopt(_ user: AuthenticatedUser) async {
        phase = .signedIn(user)
        role = nil
        noProgramAccess = false

        if let demoRole = dependencies.demoRole {
            isDemoSession = true
            role = demoRole
            return
        }

        guard let resolver = dependencies.roleResolver else { return }
        do {
            switch try await resolver.resolveRole(for: user) {
            case .shell(let shell):
                role = shell
            case .noProgramAccess:
                noProgramAccess = true
            }
        } catch {
            phase = .failed(ErrorMessage.text(for: error))
        }
    }
}
