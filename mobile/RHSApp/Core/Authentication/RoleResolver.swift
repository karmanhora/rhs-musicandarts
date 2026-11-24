import Foundation

/// Decides which navigation shell a signed-in person sees.
///
/// The answer must come from the database, never from a local setting or from
/// the signup audience the person typed. The website's authority is
/// `public.has_permission(ensemble, code)` (migration 029) with `my_permissions()`
/// returning the caller's capabilities; Phase 2 resolves this interface through
/// that data, treating staff capability — not a role name — as "teacher".
@MainActor
protocol RoleResolving {
    /// `.student` or `.teacher` for this account, or `nil` while the answer is
    /// not available. Throwing means the question could not be asked.
    func resolveRole(for user: AuthenticatedUser) async throws -> AppRole?
}

/// Phase 1 deliberately answers "not yet".
///
/// Mapping a signed-in account to a program and its capabilities needs the
/// program switcher (a person can be a student in one program and staff in
/// another), which is Phase 2 work. Returning `nil` keeps the app honest: it
/// shows a "checking your access" screen instead of assuming student or teacher.
/// The Debug `-RHSDemoRole` launch argument is the only way to see a shell before
/// that query exists.
struct PendingRoleResolver: RoleResolving {
    func resolveRole(for user: AuthenticatedUser) async throws -> AppRole? {
        nil
    }
}
