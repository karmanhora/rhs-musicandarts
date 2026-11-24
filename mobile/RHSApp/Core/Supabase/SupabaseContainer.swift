import Foundation
import Supabase

/// Owns the one `SupabaseClient` this app uses.
///
/// Nothing else constructs a client. Reads and writes will arrive through
/// repositories that receive this client, matching the website's rule that no
/// screen talks to Supabase directly.
struct SupabaseContainer {
    let client: SupabaseClient

    init(configuration: AppConfiguration) {
        // The SDK's Apple-platform default storage is `KeychainLocalStorage`, so
        // a restored session is kept in the Keychain, not in user defaults. Its
        // default `autoRefresh` keeps the token fresh on the SDK's own schedule.
        // The project URL and anon key are public; see AppConfiguration.
        client = SupabaseClient(
            supabaseURL: configuration.supabaseURL,
            supabaseKey: configuration.supabaseAnonKey
        )
    }
}
