import Foundation

/// What a Supabase Auth deep link contains.
///
/// Supabase's implicit flow returns the session in the URL fragment
/// (`#access_token=…&refresh_token=…`); other flows return a `code` or a
/// `token_hash`. Parsing is separated from the SDK calls so the rules are
/// testable without a network or a real project.
enum AuthCallbackLink: Equatable {
    case accessToken(String, refreshToken: String, recovery: Bool)
    case code(String, recovery: Bool)
    case tokenHash(String, type: String, recovery: Bool)
    case error(String)
    /// Our scheme and host, but nothing usable in the link.
    case malformed
    /// Not this build's callback.
    case unhandled
}

enum AuthCallbackParser {
    static func parse(_ url: URL, callbackScheme: String) -> AuthCallbackLink {
        guard url.scheme?.lowercased() == callbackScheme.lowercased(),
              url.host?.lowercased() == "auth-callback"
        else {
            return .unhandled
        }

        var values: [String: String] = [:]
        if let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems {
            for item in query {
                if let value = item.value { values[item.name] = value }
            }
        }
        // The fragment carries the session in the implicit flow and takes
        // precedence over an identical query key.
        if let fragment = url.fragment,
           let items = URLComponents(string: "https://auth-callback.invalid?\(fragment)")?.queryItems {
            for item in items {
                if let value = item.value { values[item.name] = value }
            }
        }

        let type = values["type"]
        let recovery = type == "recovery"

        if let description = values["error_description"] ?? values["error"] {
            return .error(description == "access_denied" ? "Sign-in was cancelled." : description)
        }
        if let accessToken = values["access_token"], let refreshToken = values["refresh_token"] {
            return .accessToken(accessToken, refreshToken: refreshToken, recovery: recovery)
        }
        if let code = values["code"] {
            return .code(code, recovery: recovery)
        }
        if let tokenHash = values["token_hash"], let type {
            return .tokenHash(tokenHash, type: type, recovery: recovery)
        }
        return .malformed
    }
}
