import XCTest
@testable import RHSApp

@MainActor
final class AppStateTests: XCTestCase {
    private let student = AuthenticatedUser(id: "11111111-1111-4111-8111-111111111111", email: "student@example.com")

    func testSignedOutLaunchSettlesOnSignedOut() async throws {
        let state = makeState(auth: FakeAuthSession(user: nil))
        await state.start()

        XCTAssertEqual(state.phase, .signedOut)
        XCTAssertNil(state.role)
    }

    func testStoredSessionRestoresTheUserWithoutADecidedRole() async throws {
        let state = makeState(
            auth: FakeAuthSession(user: student),
            resolver: StubRoleResolver(role: nil)
        )
        await state.start()

        XCTAssertEqual(state.phase, .signedIn(student))
        XCTAssertNil(state.role, "No role may be invented when the backend has no answer")
    }

    func testBackendRoleIsApplied() async throws {
        let state = makeState(
            auth: FakeAuthSession(user: student),
            resolver: StubRoleResolver(role: .teacher)
        )
        await state.start()

        XCTAssertEqual(state.role, .teacher)
    }

    func testDemoRoleShowsTheShellWithoutASupabaseSession() async throws {
        let state = makeState(auth: FakeAuthSession(user: nil), demoRole: .student)
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
            auth: FakeAuthSession(user: student),
            resolver: StubRoleResolver(role: .student),
            demoRole: .teacher
        )
        await state.start()

        XCTAssertEqual(state.role, .teacher)
    }

    func testRefreshFailureIsShownNotTreatedAsSignedOut() async throws {
        let state = makeState(auth: FakeAuthSession(user: student, error: RefusedSession()))
        await state.start()

        XCTAssertEqual(state.phase, .failed("The session could not be refreshed."))
    }

    func testSignOutClearsTheRoleAndTheSession() async throws {
        let auth = FakeAuthSession(user: student)
        let state = makeState(auth: auth, resolver: StubRoleResolver(role: .student))
        await state.start()
        XCTAssertEqual(state.role, .student)

        await state.signOut()

        XCTAssertEqual(state.phase, .signedOut)
        XCTAssertNil(state.role)
        XCTAssertTrue(auth.didSignOut)
    }

    func testMissingConfigurationIsNamed() async {
        let state = AppState(
            dependencies: AppDependencies(
                configuration: nil,
                configurationError: "SupabaseURL is not set.",
                authSession: nil,
                roleResolver: PendingRoleResolver(),
                demoRole: nil
            )
        )
        await state.start()

        XCTAssertEqual(state.phase, .configurationRequired("SupabaseURL is not set."))
    }

    func testThisBuildAcceptsItsOwnCallbackSchemeOnly() async throws {
        let state = makeState(auth: FakeAuthSession(user: nil))

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
        auth: FakeAuthSession,
        resolver: StubRoleResolver = StubRoleResolver(role: nil),
        demoRole: AppRole? = nil
    ) -> AppState {
        AppState(
            dependencies: AppDependencies(
                configuration: try? AppConfiguration.preview(),
                configurationError: nil,
                authSession: auth,
                roleResolver: resolver,
                demoRole: demoRole
            )
        )
    }
}

@MainActor
private final class FakeAuthSession: AuthSessionProviding {
    private let user: AuthenticatedUser?
    private let error: Error?
    private(set) var didSignOut = false

    init(user: AuthenticatedUser?, error: Error? = nil) {
        self.user = user
        self.error = error
    }

    func currentUser() async throws -> AuthenticatedUser? {
        if let error { throw error }
        return user
    }

    func signOut() async throws {
        didSignOut = true
    }
}

private struct StubRoleResolver: RoleResolving {
    let role: AppRole?

    func resolveRole(for user: AuthenticatedUser) async throws -> AppRole? {
        role
    }
}

private struct RefusedSession: LocalizedError {
    var errorDescription: String? { "The session could not be refreshed." }
}
