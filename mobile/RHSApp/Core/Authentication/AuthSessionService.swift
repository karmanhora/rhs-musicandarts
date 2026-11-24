import Foundation
import Supabase

/// Session restoration and sign-out. Phase 2 adds the sign-in flows behind the
/// same interface, so the root view does not change.
@MainActor
protocol AuthSessionProviding {
    /// The persisted session's user, or `nil` when nobody is signed in. Throws
    /// when a stored session exists but cannot be refreshed — that is a failure
    /// to show, not a sign-out to fake.
    func currentUser() async throws -> AuthenticatedUser?

    func signOut() async throws
}

/// Supabase Auth is the identity provider. This service only reads the session
/// the SDK persists; it never stores a token of its own.
struct SupabaseAuthSessionService: AuthSessionProviding {
    private let client: SupabaseClient

    init(client: SupabaseClient) {
        self.client = client
    }

    func currentUser() async throws -> AuthenticatedUser? {
        // `currentSession` is the stored value and does not hit the network.
        // Checking it first keeps a signed-out launch from producing an error.
        guard client.auth.currentSession != nil else { return nil }

        // `session` refreshes if necessary and throws when the refresh is refused.
        let session = try await client.auth.session
        return AuthenticatedUser(
            id: session.user.id.uuidString,
            email: session.user.email
        )
    }

    func signOut() async throws {
        guard client.auth.currentSession != nil else { return }
        try await client.auth.signOut()
    }
}
