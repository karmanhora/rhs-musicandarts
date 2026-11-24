import Foundation

/// The authenticated identity, as Supabase Auth knows it.
///
/// `id` is `auth.users.id` — the same value stored in `profiles.auth_user_id`
/// (migration 021). That is how every RLS policy and RPC resolves the caller, so
/// no screen may substitute an email address, a display name or a local id.
struct AuthenticatedUser: Identifiable, Equatable, Sendable {
    let id: String
    let email: String?
}
