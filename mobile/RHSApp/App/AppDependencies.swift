import Foundation

/// The app's composition root.
///
/// Every dependency is created once, here, and handed to `AppState`. Repositories
/// arrive as protocols, so a screen or a test never constructs a Supabase client
/// of its own and swapping an implementation cannot reach into the UI.
struct AppDependencies {
    let configuration: AppConfiguration?
    /// Why the configuration could not be loaded, phrased for the person holding
    /// the phone (it names the file to fix).
    let configurationError: String?
    let authSession: (any AuthSessionProviding)?
    let roleResolver: any RoleResolving
    /// Debug-only: a role forced by launch argument, for Simulator navigation.
    let demoRole: AppRole?

    @MainActor
    static func live(
        bundle: Bundle = .main,
        arguments: [String] = ProcessInfo.processInfo.arguments
    ) -> AppDependencies {
        let options = LaunchOptions(arguments: arguments)

        let configuration: AppConfiguration?
        var configurationError: String?

        if options.usesPreviewConfiguration {
            do {
                configuration = try AppConfiguration.preview()
            } catch {
                configuration = nil
                configurationError = ErrorMessage.text(for: error)
            }
        } else {
            do {
                configuration = try AppConfiguration.load(bundle: bundle)
            } catch {
                configuration = nil
                configurationError = ErrorMessage.text(for: error)
            }
        }

        guard let configuration else {
            return AppDependencies(
                configuration: nil,
                configurationError: configurationError,
                authSession: nil,
                roleResolver: PendingRoleResolver(),
                demoRole: options.demoRole
            )
        }

        let container = SupabaseContainer(configuration: configuration)

        return AppDependencies(
            configuration: configuration,
            configurationError: nil,
            authSession: SupabaseAuthSessionService(client: container.client),
            roleResolver: PendingRoleResolver(),
            demoRole: options.demoRole
        )
    }
}
