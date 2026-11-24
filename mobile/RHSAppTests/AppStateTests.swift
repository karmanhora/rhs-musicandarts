import XCTest
@testable import RHSApp

@MainActor
final class AppStateTests: XCTestCase {
    private let student = AuthenticatedUser(id: "11111111-1111-4111-8111-111111111111", email: "student@example.com")

    func testSignedOutLaunchSettlesOnSignedOut() async throws {
        let state = makeState(auth: FakeAuth(user: nil))
        await state.start()

        XCTAssertEqual(state.phase, .signedOut)
        XCTAssertNil(state.role)
    }

    func testStoredSessionWithNoProgramIsToldSo() async throws {
        let state = makeState(
            auth: FakeAuth(user: student),
            resolver: StubRoleResolver(resolution: .noProgramAccess)
        )
        await state.start()

        XCTAssertEqual(state.phase, .signedIn(student))
        XCTAssertNil(state.role, "No shell may be shown without a roster")
        XCTAssertTrue(state.noProgramAccess)
    }

    func testStoredSessionAdoptsTheBackendShell() async throws {
        let state = makeState(
            auth: FakeAuth(user: student),
            resolver: StubRoleResolver(resolution: .shell(.teacher))
        )
        await state.start()

        XCTAssertEqual(state.role, .teacher)
        XCTAssertFalse(state.noProgramAccess)
    }

    func testSignInAdoptsTheUserAndTheBackendAnswer() async throws {
        let auth = FakeAuth(user: student)
        let state = makeState(auth: auth, resolver: StubRoleResolver(resolution: .shell(.student)))

        try await state.signIn(email: "student@example.com", password: "secret")

        XCTAssertEqual(auth.signedInEmail, "student@example.com")
        XCTAssertEqual(state.phase, .signedIn(student))
        XCTAssertEqual(state.role, .student)
    }

    func testDemoRoleShowsTheShellWithoutASupabaseSession() async throws {
        let state = makeState(auth: FakeAuth(user: nil), demoRole: .student)
        await state.start()

        XCTAssertEqual(state.role, .student)
        XCTAssertTrue(state.isDemoSession)
        guard case .signedIn(let user) = state.phase else {
            return XCTFail("Expected a demo signed-in phase, got \(state.phase)")
        }
        XCTAssertEqual(user.id, "demo-session")
    }

    func testDemoRoleOverridesTheResolver() async throws {
        let state = makeState(
            auth: FakeAuth(user: student),
            resolver: StubRoleResolver(resolution: .shell(.student)),
            demoRole: .teacher
        )
        await state.start()

        XCTAssertEqual(state.role, .teacher)
    }

    func testRefreshFailureIsShownNotTreatedAsSignedOut() async throws {
        let state = makeState(auth: FakeAuth(user: student, error: RefusedSession()))
        await state.start()

        XCTAssertEqual(state.phase, .failed("The session could not be refreshed."))
    }

    func testSignOutClearsTheRoleAndTheSession() async throws {
        let auth = FakeAuth(user: student)
        let state = makeState(auth: auth, resolver: StubRoleResolver(resolution: .shell(.student)))
        await state.start()
        XCTAssertEqual(state.role, .student)

        await state.signOut()

        XCTAssertEqual(state.phase, .signedOut)
        XCTAssertNil(state.role)
        XCTAssertTrue(auth.didSignOut)
    }

    func testRecoveryCallbackShowsTheNewPasswordScreen() async throws {
        let auth = FakeAuth(user: student)
        auth.callbackResult = .completed(recovery: true)
        let state = makeState(auth: auth, resolver: StubRoleResolver(resolution: .shell(.student)))

        await state.completeAuthentication(
            from: URL(string: "org.rhsattendance.native.dev://auth-callback#access_token=x&refresh_token=y&type=recovery")!
        )

        XCTAssertTrue(state.recoveryInProgress)
        XCTAssertEqual(state.phase, .signedIn(student))
    }

    func testMissingConfigurationIsNamed() async {
        let state = AppState(
            dependencies: AppDependencies(
                configuration: nil,
                configurationError: "SupabaseURL is not set.",
                auth: nil,
                roleResolver: nil,
                demoRole: nil
            )
        )
        await state.start()

        XCTAssertEqual(state.phase, .configurationRequired("SupabaseURL is not set."))
    }

    func testThisBuildAcceptsItsOwnCallbackSchemeOnly() async throws {
        let state = makeState(auth: FakeAuth(user: nil))

        state.handleIncomingURL(URL(string: "org.rhsattendance.native.dev://auth-callback#access_token=x")!)
        XCTAssertNotNil(state.lastAuthCallback)

        state.handleIncomingURL(URL(string: "org.rhsattendance.app://auth-callback#access_token=x")!)
        XCTAssertEqual(
            state.lastAuthCallback?.scheme,
            "org.rhsattendance.native.dev",
            "The Capacitor app's callback must not be consumed here"
        )
    }

    // MARK: - Helpers

    private func makeState(
        auth: FakeAuth,
        resolver: StubRoleResolver = StubRoleResolver(resolution: .noProgramAccess),
        demoRole: AppRole? = nil
    ) -> AppState {
        AppState(
            dependencies: AppDependencies(
                configuration: try? AppConfiguration.preview(),
                configurationError: nil,
                auth: auth,
                roleResolver: resolver,
                demoRole: demoRole
            )
        )
    }
}

@MainActor
private final class FakeAuth: AuthServicing {
    var user: AuthenticatedUser?
    var error: Error?
    var signUpOutcome: SignUpOutcome = .needsEmailConfirmation
    var callbackResult: AuthCallbackResult = .unhandled
    private(set) var didSignOut = false
    private(set) var signedInEmail: String?

    init(user: AuthenticatedUser?, error: Error? = nil) {
        self.user = user
        self.error = error
    }

    func currentUser() async throws -> AuthenticatedUser? {
        if let error { throw error }
        return user
    }

    func signIn(email: String, password: String) async throws -> AuthenticatedUser {
        if let error { throw error }
        guard let user else { throw RefusedSession() }
        signedInEmail = email
        return user
    }

    func signUp(
        email: String,
        password: String,
        audience: AuthAudience,
        displayName: String?
    ) async throws -> SignUpOutcome {
        if let error { throw error }
        if case .signedIn(let signedIn) = signUpOutcome { user = signedIn }
        return signUpOutcome
    }

    func confirmEmail(email: String, code: String) async throws -> AuthenticatedUser? {
        if let error { throw error }
        return user
    }

    func resendConfirmation(email: String) async throws {}

    func requestPasswordReset(email: String) async throws {}

    func updatePassword(_ password: String) async throws {}

    func completeAuthentication(from url: URL) async throws -> AuthCallbackResult {
        callbackResult
    }

    func signOut() async throws {
        didSignOut = true
        user = nil
    }
}

private struct StubRoleResolver: RoleResolving {
    let resolution: RoleResolution

    func resolveRole(for user: AuthenticatedUser) async throws -> RoleResolution {
        resolution
    }
}

private struct RefusedSession: LocalizedError {
    var errorDescription: String? { "The session could not be refreshed." }
}
