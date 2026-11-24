import Foundation

/// Which of the two builds is running.
///
/// It comes from the build configuration (`RHS_BUILD_ENVIRONMENT` in
/// Config/Dev.xcconfig and Config/Prod.xcconfig), never from a runtime toggle,
/// so a production build cannot be switched into development behaviour.
enum BuildEnvironment: String, Sendable {
    case development
    case production
}

/// The app's validated configuration: the Supabase project and this build's
/// identity.
///
/// The two Supabase values are public by design — the same values the website
/// ships. The anon/publishable key grants nothing on its own because every table
/// is behind RLS, and identity is resolved server-side from the JWT `sub` claim
/// (`profiles.auth_user_id`, migration 021). No service-role key may ever reach
/// this app: `validatePublishableKey` refuses one outright.
struct AppConfiguration: Equatable, Sendable {
    enum Failure: LocalizedError, Equatable {
        case missingValue(String)
        case unknownEnvironment(String)
        case invalidSupabaseURL(String)
        case insecureSupabaseURL(String)
        case invalidPublishableKey(String)
        case serviceRoleKey
        case invalidBundleIdentifier(String)

        var errorDescription: String? {
            switch self {
            case .missingValue(let key):
                return "\(key) is not set. Copy mobile/Config/Local.example.xcconfig to mobile/Config/Local.xcconfig and fill in the public Supabase values."
            case .unknownEnvironment(let value):
                return "Unknown build environment “\(value)”. Expected development or production."
            case .invalidSupabaseURL(let value):
                return "“\(value)” is not a usable Supabase project URL. It must be an origin such as https://project.supabase.co, with no path or query."
            case .insecureSupabaseURL(let host):
                return "Supabase at “\(host)” must use https. Plain http is allowed only for a loopback development server."
            case .invalidPublishableKey(let reason):
                return "The Supabase key cannot be used by an app: \(reason)"
            case .serviceRoleKey:
                return "That is a service-role key. It bypasses every RLS policy and must never ship in an app bundle."
            case .invalidBundleIdentifier(let value):
                return "“\(value)” is not a usable bundle identifier, so the auth callback scheme cannot be derived."
            }
        }
    }

    let environment: BuildEnvironment
    let supabaseURL: URL
    let supabaseAnonKey: String
    let bundleIdentifier: String
    let displayName: String
    let authCallbackURL: URL

    init(
        environment: BuildEnvironment,
        supabaseURL: URL,
        supabaseAnonKey: String,
        bundleIdentifier: String,
        displayName: String
    ) throws {
        let identifier = bundleIdentifier.trimmingCharacters(in: .whitespacesAndNewlines)
        guard identifier.contains("."), !identifier.contains(" "), !identifier.contains("/") else {
            throw Failure.invalidBundleIdentifier(bundleIdentifier)
        }

        try Self.validate(url: supabaseURL, environment: environment)
        let key = supabaseAnonKey.trimmingCharacters(in: .whitespacesAndNewlines)
        try Self.validatePublishableKey(key)

        guard let callback = URL(string: "\(identifier)://auth-callback") else {
            throw Failure.invalidBundleIdentifier(identifier)
        }

        self.environment = environment
        self.supabaseURL = supabaseURL
        self.supabaseAnonKey = key
        self.bundleIdentifier = identifier
        self.displayName = displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? "RHS Music & Arts"
            : displayName
        self.authCallbackURL = callback
    }

    /// Reads this build's values from its Info.plist, which Xcode fills from the
    /// build configuration. A missing or placeholder value is an error the app
    /// shows, never a blank screen or a silent fallback.
    static func load(bundle: Bundle = .main) throws -> AppConfiguration {
        func value(_ key: String) throws -> String {
            guard let raw = bundle.object(forInfoDictionaryKey: key) as? String else {
                throw Failure.missingValue(key)
            }
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, !trimmed.contains("$("), !trimmed.contains("YOUR-") else {
                throw Failure.missingValue(key)
            }
            return trimmed
        }

        let environmentName = try value("RHSBuildEnvironment")
        guard let environment = BuildEnvironment(rawValue: environmentName) else {
            throw Failure.unknownEnvironment(environmentName)
        }

        let urlString = try value("SupabaseURL")
        guard let url = URL(string: urlString) else {
            throw Failure.invalidSupabaseURL(urlString)
        }

        let bundleIdentifier =
            bundle.bundleIdentifier
            ?? (bundle.object(forInfoDictionaryKey: "CFBundleIdentifier") as? String)
            ?? ""
        let displayName = try value("RHSDisplayName")

        return try AppConfiguration(
            environment: environment,
            supabaseURL: url,
            supabaseAnonKey: try value("SupabaseAnonKey"),
            bundleIdentifier: bundleIdentifier,
            displayName: displayName
        )
    }

    /// A non-secret configuration for the Simulator and for tests, activated only
    /// in a Debug build with the `-RHSPreviewConfiguration` launch argument. The
    /// key is a publishable-key-shaped placeholder; it authenticates nothing and
    /// points at no real project.
    static func preview(bundleIdentifier: String = "org.rhsattendance.native.dev") throws -> AppConfiguration {
        guard let url = URL(string: "https://preview.supabase.co") else {
            throw Failure.invalidSupabaseURL("https://preview.supabase.co")
        }
        return try AppConfiguration(
            environment: .development,
            supabaseURL: url,
            supabaseAnonKey: "sb_publishable_preview-not-a-real-key",
            bundleIdentifier: bundleIdentifier,
            displayName: "RHS Music & Arts Dev"
        )
    }

    // MARK: - Validation

    private static func validate(url: URL, environment: BuildEnvironment) throws {
        guard let scheme = url.scheme?.lowercased(), let host = url.host(), !host.isEmpty else {
            throw Failure.invalidSupabaseURL(url.absoluteString)
        }
        guard url.user == nil, url.password == nil else {
            throw Failure.invalidSupabaseURL(url.absoluteString)
        }
        let path = url.path
        guard path.isEmpty || path == "/", url.query == nil, url.fragment == nil else {
            throw Failure.invalidSupabaseURL(url.absoluteString)
        }

        switch scheme {
        case "https":
            return
        case "http" where environment == .development && isLoopback(host):
            return
        default:
            throw Failure.insecureSupabaseURL(host)
        }
    }

    private static func isLoopback(_ host: String) -> Bool {
        host == "localhost" || host == "127.0.0.1" || host == "::1"
    }

    /// Supabase issues either a legacy anon JWT (`"role": "anon"`) or a newer
    /// `sb_publishable_…` key. Everything else is refused — most importantly a
    /// service-role JWT, which would hand the bundle the power to bypass RLS.
    private static func validatePublishableKey(_ key: String) throws {
        guard !key.isEmpty else { throw Failure.missingValue("SupabaseAnonKey") }

        if key.hasPrefix("sb_publishable_") { return }

        if let role = jwtRole(key) {
            switch role {
            case "anon":
                return
            case "service_role":
                throw Failure.serviceRoleKey
            default:
                throw Failure.invalidPublishableKey("its JWT role is “\(role)”, not “anon”.")
            }
        }

        throw Failure.invalidPublishableKey(
            "it is neither a Supabase anon JWT nor a publishable key (sb_publishable_…)."
        )
    }

    /// Reads the `role` claim from a JWT's payload. It decodes only — it does not
    /// verify the signature, which is the server's job on every request.
    static func jwtRole(_ token: String) -> String? {
        let segments = token.split(separator: ".", omittingEmptySubsequences: false)
        guard segments.count == 3 else { return nil }

        var payload = String(segments[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while payload.count % 4 != 0 { payload.append("=") }

        guard let data = Data(base64Encoded: payload),
              let object = try? JSONSerialization.jsonObject(with: data),
              let claims = object as? [String: Any]
        else {
            return nil
        }
        return claims["role"] as? String
    }
}
