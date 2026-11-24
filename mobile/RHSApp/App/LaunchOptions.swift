import Foundation

/// Development-only launch arguments.
///
/// These exist so the Simulator can show the foundation without a real Supabase
/// project, and so navigation can be exercised before the backend role query is
/// written. A Release build ignores both flags: production behaviour is decided
/// by the build configuration and the server, never by a launch argument.
struct LaunchOptions: Equatable {
    /// Use the non-secret preview configuration (Debug only).
    let usesPreviewConfiguration: Bool
    /// Show a role's tab bar before the backend role query exists (Debug only).
    let demoRole: AppRole?

    init(arguments: [String]) {
        #if DEBUG
        usesPreviewConfiguration = arguments.contains("-RHSPreviewConfiguration")
        demoRole = Self.value(after: "-RHSDemoRole", in: arguments).flatMap(AppRole.init(rawValue:))
        #else
        usesPreviewConfiguration = false
        demoRole = nil
        #endif
    }

    private static func value(after flag: String, in arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: flag), arguments.indices.contains(index + 1) else {
            return nil
        }
        return arguments[index + 1]
    }
}
