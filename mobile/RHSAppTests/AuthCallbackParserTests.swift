import XCTest
@testable import RHSApp

final class AuthCallbackParserTests: XCTestCase {
    private let scheme = "org.rhsattendance.native.dev"

    func testImplicitSessionInTheFragment() {
        let url = URL(string: "\(scheme)://auth-callback#access_token=a&refresh_token=r&expires_in=3600&type=signup")!
        XCTAssertEqual(
            AuthCallbackParser.parse(url, callbackScheme: scheme),
            .accessToken("a", refreshToken: "r", recovery: false)
        )
    }

    func testRecoveryLinkIsMarkedRecovery() {
        let url = URL(string: "\(scheme)://auth-callback#access_token=a&refresh_token=r&type=recovery")!
        XCTAssertEqual(
            AuthCallbackParser.parse(url, callbackScheme: scheme),
            .accessToken("a", refreshToken: "r", recovery: true)
        )
    }

    func testCodeInTheQuery() {
        let url = URL(string: "\(scheme)://auth-callback?code=abc123")!
        XCTAssertEqual(
            AuthCallbackParser.parse(url, callbackScheme: scheme),
            .code("abc123", recovery: false)
        )
    }

    func testTokenHashAndType() {
        let url = URL(string: "\(scheme)://auth-callback?token_hash=hash&type=email_change")!
        XCTAssertEqual(
            AuthCallbackParser.parse(url, callbackScheme: scheme),
            .tokenHash("hash", type: "email_change", recovery: false)
        )
    }

    func testCancelledOAuthIsAShowableError() {
        let url = URL(string: "\(scheme)://auth-callback#error=access_denied&error_description=access_denied")!
        XCTAssertEqual(
            AuthCallbackParser.parse(url, callbackScheme: scheme),
            .error("Sign-in was cancelled.")
        )
    }

    func testForeignAppSchemeIsIgnored() {
        let url = URL(string: "org.rhsattendance.app://auth-callback#access_token=a&refresh_token=r")!
        XCTAssertEqual(AuthCallbackParser.parse(url, callbackScheme: scheme), .unhandled)
    }

    func testOtherHostOnThisSchemeIsIgnored() {
        let url = URL(string: "\(scheme)://elsewhere#access_token=a&refresh_token=r")!
        XCTAssertEqual(AuthCallbackParser.parse(url, callbackScheme: scheme), .unhandled)
    }

    func testOurCallbackWithoutCredentialsIsMalformed() {
        let url = URL(string: "\(scheme)://auth-callback")!
        XCTAssertEqual(AuthCallbackParser.parse(url, callbackScheme: scheme), .malformed)
    }
}
