import XCTest
@testable import RHSApp

final class AppConfigurationTests: XCTestCase {
    // MARK: - Keys

    func testAnonJWTIsAccepted() throws {
        let configuration = try makeConfiguration(key: jwt(role: "anon"))
        XCTAssertEqual(AppConfiguration.jwtRole(configuration.supabaseAnonKey), "anon")
    }

    func testPublishableKeyIsAccepted() throws {
        _ = try makeConfiguration(key: "sb_publishable_example-value")
    }

    func testServiceRoleKeyIsRefused() {
        XCTAssertThrowsError(try makeConfiguration(key: jwt(role: "service_role"))) { error in
            XCTAssertEqual(error as? AppConfiguration.Failure, .serviceRoleKey)
        }
    }

    func testUnexpectedJWTClaimIsRefused() {
        XCTAssertThrowsError(try makeConfiguration(key: jwt(role: "authenticated"))) { error in
            guard case .invalidPublishableKey = error as? AppConfiguration.Failure else {
                return XCTFail("Expected invalidPublishableKey, got \(error)")
            }
        }
    }

    func testGarbageKeyIsRefused() {
        XCTAssertThrowsError(try makeConfiguration(key: "not-a-key")) { error in
            guard case .invalidPublishableKey = error as? AppConfiguration.Failure else {
                return XCTFail("Expected invalidPublishableKey, got \(error)")
            }
        }
    }

    func testJWTPayloadWithoutRoleIsNotAKey() {
        XCTAssertNil(AppConfiguration.jwtRole("header.\(base64URL("{\"sub\":\"abc\"}")).signature"))
    }

    // MARK: - Project URL

    func testHTTPSProjectURLIsAccepted() throws {
        _ = try makeConfiguration(key: publishable, url: "https://sjiswrvhrnrxkrfhfjrp.supabase.co")
    }

    func testRemoteHTTPIsRefused() {
        XCTAssertThrowsError(try makeConfiguration(key: publishable, url: "http://project.supabase.co")) { error in
            guard case .insecureSupabaseURL = error as? AppConfiguration.Failure else {
                return XCTFail("Expected insecureSupabaseURL, got \(error)")
            }
        }
    }

    func testLoopbackHTTPIsAllowedOnlyInDevelopment() throws {
        _ = try makeConfiguration(
            key: publishable,
            url: "http://127.0.0.1:54321",
            environment: .development
        )

        XCTAssertThrowsError(
            try makeConfiguration(
                key: publishable,
                url: "http://127.0.0.1:54321",
                environment: .production
            )
        ) { error in
            guard case .insecureSupabaseURL = error as? AppConfiguration.Failure else {
                return XCTFail("Expected insecureSupabaseURL, got \(error)")
            }
        }
    }

    func testProjectURLWithAPathIsRefused() {
        XCTAssertThrowsError(
            try makeConfiguration(key: publishable, url: "https://project.supabase.co/rest/v1")
        ) { error in
            guard case .invalidSupabaseURL = error as? AppConfiguration.Failure else {
                return XCTFail("Expected invalidSupabaseURL, got \(error)")
            }
        }
    }

    // MARK: - Identity

    func testCallbackURLIsDerivedFromTheBundleIdentifier() throws {
        let configuration = try makeConfiguration(key: publishable)
        XCTAssertEqual(
            configuration.authCallbackURL.absoluteString,
            "org.rhsattendance.native.dev://auth-callback"
        )
    }

    func testBundleIdentifierWithoutADotIsRefused() {
        XCTAssertThrowsError(
            try AppConfiguration(
                environment: .development,
                supabaseURL: URL(string: "https://project.supabase.co")!,
                supabaseAnonKey: publishable,
                bundleIdentifier: "rhsapp",
                displayName: "Test"
            )
        ) { error in
            guard case .invalidBundleIdentifier = error as? AppConfiguration.Failure else {
                return XCTFail("Expected invalidBundleIdentifier, got \(error)")
            }
        }
    }

    func testPreviewConfigurationNeedsNoSecrets() throws {
        let configuration = try AppConfiguration.preview()
        XCTAssertEqual(configuration.environment, .development)
        XCTAssertEqual(configuration.supabaseURL.host(), "preview.supabase.co")
        XCTAssertTrue(configuration.supabaseAnonKey.hasPrefix("sb_publishable_"))
        XCTAssertEqual(configuration.bundleIdentifier, "org.rhsattendance.native.dev")
    }

    // MARK: - The built app

    /// Proves the build configuration actually reached the bundle: Debug must be
    /// the development identity with its own URL scheme, never the Capacitor app's.
    func testDebugBuildCarriesItsOwnIdentityAndEnvironment() {
        let bundle = Bundle.main
        XCTAssertEqual(bundle.bundleIdentifier, "org.rhsattendance.native.dev")
        XCTAssertEqual(
            bundle.object(forInfoDictionaryKey: "RHSBuildEnvironment") as? String,
            "development"
        )

        let urlTypes = bundle.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]]
        let schemes = urlTypes?.first?["CFBundleURLSchemes"] as? [String]
        XCTAssertEqual(schemes?.first, "org.rhsattendance.native.dev")

        XCTAssertNotNil(bundle.object(forInfoDictionaryKey: "SupabaseURL"))
        XCTAssertNotNil(bundle.object(forInfoDictionaryKey: "SupabaseAnonKey"))
    }

    func testCapacitorBundleIdentifierIsNotUsed() {
        XCTAssertNotEqual(Bundle.main.bundleIdentifier, "org.rhsattendance.app")
    }

    // MARK: - Helpers

    private let publishable = "sb_publishable_example-value"

    private func makeConfiguration(
        key: String,
        url: String = "https://project.supabase.co",
        environment: BuildEnvironment = .development
    ) throws -> AppConfiguration {
        try AppConfiguration(
            environment: environment,
            supabaseURL: URL(string: url)!,
            supabaseAnonKey: key,
            bundleIdentifier: "org.rhsattendance.native.dev",
            displayName: "Test"
        )
    }

    private func jwt(role: String) -> String {
        "\(base64URL("{\"alg\":\"HS256\",\"typ\":\"JWT\"}")).\(base64URL("{\"role\":\"\(role)\"}")).signature"
    }

    private func base64URL(_ string: String) -> String {
        Data(string.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
