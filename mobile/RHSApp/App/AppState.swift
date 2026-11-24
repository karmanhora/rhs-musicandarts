import Foundation
import Observation

/// The app's single piece of top-level state: whether the build is configured,
/// whether somebody is signed in, and — once the backend has answered — which
/// navigation shell to show.
///
/// It never decides a role from a local preference. A signed-in person stays at
/// `.signedIn` with no `role` until the server-backed resolver answers, and the
/// UI says so rather than guessing "student".
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
    /// `nil` while the backend has not told us the role. See `RoleResolving`.
    private(set) var role: AppRole?
    /// The most recent auth deep link this build accepted (Phase 1 records it;
    /// Phase 2 exchanges it for a session).
    private(set) var lastAuthCallback: URL?
    /// A failure from an action (sign-out), shown by the screen that started it.
    private(set) var actionError: String?
    /// True only for a Debug build launched with `-RHSDemoRole`. No Supabase
    /// account is signed in; the shell is being shown locally for navigation.
    private(set) var isDemoSession = false

    private let dependencies: AppDependencies

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

        guard let authSession = dependencies.authSession else {
            phase = .configurationRequired("This build could not create a Supabase client.")
            return
        }

        phase = .loading
        do {
            if let user = try await authSession.currentUser() {
                phase = .signedIn(user)
                try await resolveRole(for: user)
            } else {
                role = nil
                phase = .signedOut
            }
        } catch {
            phase = .failed(ErrorMessage.text(for: error))
        }
    }

    func signOut() async {
        actionError = nil
        do {
            try await dependencies.authSession?.signOut()
            role = nil
            isDemoSession = false
            phase = .signedOut
        } catch {
            actionError = ErrorMessage.text(for: error)
        }
    }

    func clearActionError() {
        actionError = nil
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
    }

    private func resolveRole(for user: AuthenticatedUser) async throws {
        if let demoRole = dependencies.demoRole {
            role = demoRole
            return
        }
        role = try await dependencies.roleResolver.resolveRole(for: user)
    }

}
