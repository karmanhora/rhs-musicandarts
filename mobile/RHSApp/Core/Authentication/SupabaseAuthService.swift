import Foundation
import Supabase

/// Supabase Auth is the identity provider. Every method here ends in the same
/// `auth.users` row, which the database maps to `profiles.auth_user_id`
/// (migration 021). Nothing in this file creates a profile, writes a
/// membership, or links accounts by email address.
struct SupabaseAuthService: AuthServicing {
    private let client: SupabaseClient
    private let configuration: AppConfiguration

    init(client: SupabaseClient, configuration: AppConfiguration) {
        self.client = client
        self.configuration = configuration
    }

    func currentUser() async throws -> AuthenticatedUser? {
        // The stored session, without a network call. Checking it first keeps a
        // signed-out launch from producing an error.
        guard client.auth.currentSession != nil else { return nil }
        // This refreshes if necessary and throws when the refresh is refused.
        let session = try await client.auth.session
        return Self.user(from: session.user)
    }

    func signIn(email: String, password: String) async throws -> AuthenticatedUser {
        let session = try await client.auth.signIn(email: Self.clean(email), password: password)
        return Self.user(from: session.user)
    }

    func signUp(
        email: String,
        password: String,
        audience: AuthAudience,
        displayName: String?
    ) async throws -> SignUpOutcome {
        // `account_type` is what migration 023's auth.users trigger records. The
        // name is metadata only; the profile is created later by joining.
        var data: [String: AnyJSON] = ["account_type": .string(audience.rawValue)]
        let name = displayName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !name.isEmpty { data["full_name"] = .string(name) }

        let response = try await client.auth.signUp(
            email: Self.clean(email),
            password: password,
            data: data,
            redirectTo: configuration.authCallbackURL
        )

        if let session = response.session {
            return .signedIn(Self.user(from: session.user))
        }
        // With confirmation on, an address that already exists comes back with
        // no session and an empty identity list — and no email is sent. Saying
        // "check your email" there would leave somebody waiting forever.
        if let identities = response.user.identities, identities.isEmpty {
            return .existingAccount
        }
        return .needsEmailConfirmation
    }

    func confirmEmail(email: String, code: String) async throws -> AuthenticatedUser? {
        let token = code.replacingOccurrences(of: " ", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
        let response = try await client.auth.verifyOTP(
            email: Self.clean(email),
            token: token,
            type: .signup
        )
        if let session = response.session { return Self.user(from: session.user) }
        return try await currentUser()
    }

    func resendConfirmation(email: String) async throws {
        try await client.auth.resend(
            email: Self.clean(email),
            type: .signup,
            emailRedirectTo: configuration.authCallbackURL
        )
    }

    func requestPasswordReset(email: String) async throws {
        try await client.auth.resetPasswordForEmail(
            Self.clean(email),
            redirectTo: configuration.authCallbackURL
        )
    }

    func updatePassword(_ password: String) async throws {
        _ = try await client.auth.update(user: UserAttributes(password: password))
    }

    func completeAuthentication(from url: URL) async throws -> AuthCallbackResult {
        switch AuthCallbackParser.parse(url, callbackScheme: configuration.authCallbackURL.scheme ?? "") {
        case .unhandled:
            return .unhandled
        case .malformed:
            return .failure("The sign-in link did not include a session.")
        case .error(let message):
            return .failure(AuthMessages.readable(message))
        case .accessToken(let token, let refreshToken, let recovery):
            _ = try await client.auth.setSession(accessToken: token, refreshToken: refreshToken)
            return .completed(recovery: recovery)
        case .code(let code, let recovery):
            _ = try await client.auth.exchangeCodeForSession(authCode: code)
            return .completed(recovery: recovery)
        case .tokenHash(let hash, let type, let recovery):
            guard let otpType = EmailOTPType(rawValue: type) else {
                return .failure("That sign-in link has a type this app does not support.")
            }
            _ = try await client.auth.verifyOTP(tokenHash: hash, type: otpType)
            return .completed(recovery: recovery)
        }
    }

    func signOut() async throws {
        guard client.auth.currentSession != nil else { return }
        try await client.auth.signOut()
    }

    private static func user(from user: User) -> AuthenticatedUser {
        AuthenticatedUser(id: user.id.uuidString, email: user.email)
    }

    private static func clean(_ email: String) -> String {
        email.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
