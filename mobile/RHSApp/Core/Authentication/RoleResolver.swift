import Foundation
import Supabase

/// What the backend says this account can reach.
enum RoleResolution: Equatable {
    /// A navigation shell. Presentation only — the server still authorises
    /// every read and write.
    case shell(AppRole)
    /// Signed in, but on no active roster. The join flow (a director's code) is
    /// the next phase; nothing is assumed.
    case noProgramAccess
}

/// Decides which shell a signed-in person sees, from the database.
///
/// This is the first slice of the capability layer: it reads the person's own
/// profile, their active memberships and `is_program_admin()`. It treats staff
/// system roles as the staff shell. Program-scoped capability resolution
/// (`my_permissions()` per program, custom roles, the program switcher) arrives
/// with the program layer; until then a custom-role-only staff member sees the
/// student shell, which is narrower than their rights and never wider.
@MainActor
protocol RoleResolving {
    func resolveRole(for user: AuthenticatedUser) async throws -> RoleResolution
}

struct SupabaseRoleResolver: RoleResolving {
    let client: SupabaseClient

    private struct ProfileRow: Decodable {
        let id: UUID
    }

    private struct MembershipRow: Decodable {
        let roles: [String]
    }

    private nonisolated static let staffRoles: Set<String> = ["director", "secretary", "section_leader"]

    func resolveRole(for user: AuthenticatedUser) async throws -> RoleResolution {
        // `auth_user_id` is not in the public profile columns; it is only the
        // lookup key, and RLS limits this select to rows the caller may see.
        let profiles: [ProfileRow] = try await client
            .from("profiles")
            .select("id")
            .eq("auth_user_id", value: user.id)
            .limit(1)
            .execute()
            .value

        guard let profile = profiles.first else {
            // No profile yet: `join_program()` creates it on the first join.
            return .noProgramAccess
        }

        let memberships: [MembershipRow] = try await client
            .from("memberships")
            .select("roles")
            .eq("user_id", value: profile.id.uuidString)
            .eq("active", value: true)
            .execute()
            .value

        guard !memberships.isEmpty else { return .noProgramAccess }

        let isProgramAdmin: Bool = try await client
            .rpc("is_program_admin")
            .execute()
            .value

        return Self.resolution(roles: memberships.flatMap(\.roles), isProgramAdmin: isProgramAdmin)
    }

    /// Pure mapping, kept separate so the rule is testable without a database.
    nonisolated static func resolution(roles: [String], isProgramAdmin: Bool) -> RoleResolution {
        if isProgramAdmin { return .shell(.teacher) }
        return roles.contains(where: staffRoles.contains) ? .shell(.teacher) : .shell(.student)
    }
}
