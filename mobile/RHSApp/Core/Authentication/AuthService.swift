import Foundation

/// The choice a person makes when creating an account. It is self-declared and
/// grants nothing on its own: the database records it at signup (migration 023),
/// students still need a director's join code, and teacher access still needs a
/// redeemed invitation code.
enum AuthAudience: String, CaseIterable, Identifiable, Sendable {
    case student
    case teacher

    var id: String { rawValue }

    var title: String {
        switch self {
        case .student: return "Student"
        case .teacher: return "Teacher"
        }
    }

    var explanation: String {
        switch self {
        case .student:
            return "Join your program with the code your director gives you."
        case .teacher:
            return "Teacher accounts verify with an invitation code from the school before starting a program."
        }
    }
}

enum SignUpOutcome: Equatable {
    /// Email confirmation is off, or this was an already-confirmed session.
    case signedIn(AuthenticatedUser)
    /// Confirmation is on: the account exists but has no session until the
    /// emailed link or code is used.
    case needsEmailConfirmation
    /// Supabase's anti-enumeration answer for an address that already has an
    /// account: no session, and no email was sent.
    case existingAccount
}

enum AuthCallbackResult: Equatable {
    /// Not an auth callback for this build.
    case unhandled
    /// The link was ours but could not complete; the message is showable.
    case failure(String)
    case completed(recovery: Bool)
}

/// Everything the app may do with identity. One protocol, because every method
/// ends in the same Supabase identity — there is no second account system.
///
/// Not here yet, deliberately: Google OAuth and Sign in with Apple. Both need
/// provider configuration outside this repository (registered redirect URLs,
/// an Apple key and entitlement), and shipping Google without Apple would breach
/// App Store guideline 4.8. Email/password is the verified slice.
@MainActor
protocol AuthServicing {
    func currentUser() async throws -> AuthenticatedUser?
    func signIn(email: String, password: String) async throws -> AuthenticatedUser
    func signUp(
        email: String,
        password: String,
        audience: AuthAudience,
        displayName: String?
    ) async throws -> SignUpOutcome
    func confirmEmail(email: String, code: String) async throws -> AuthenticatedUser?
    func resendConfirmation(email: String) async throws
    func requestPasswordReset(email: String) async throws
    func updatePassword(_ password: String) async throws
    func completeAuthentication(from url: URL) async throws -> AuthCallbackResult
    func signOut() async throws
}

/// Raised only when a build has no Supabase client at all, which the root view
/// already prevents. It exists so no flow silently pretends to work.
struct AuthUnavailable: LocalizedError {
    var errorDescription: String? { "This build has no Supabase client." }
}
