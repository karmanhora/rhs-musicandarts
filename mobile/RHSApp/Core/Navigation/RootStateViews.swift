import SwiftUI

/// A first tick, while the stored session is read.
struct LoadingView: View {
    var body: some View {
        VStack(spacing: Spacing.md) {
            BrandMark()
            ProgressView()
                .tint(Palette.brand)
            Text("Restoring your session")
                .font(Typography.meta)
                .foregroundStyle(Palette.secondaryInk)
        }
    }
}

/// Shown when Config/Local.xcconfig is absent or invalid. It names the file and
/// the two public values instead of leaving a blank screen.
struct ConfigurationRequiredView: View {
    let message: String
    let backendHost: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                BrandMark()

                VStack(alignment: .leading, spacing: Spacing.sm) {
                    Text("Setup required")
                        .font(Typography.label)
                        .tracking(1.4)
                        .textCase(.uppercase)
                        .foregroundStyle(Palette.secondaryInk)
                    Text("This build has no Supabase project.")
                        .font(Typography.title)
                        .foregroundStyle(Palette.ink)
                    Text(message)
                        .font(Typography.body)
                        .foregroundStyle(Palette.secondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Rectangle()
                    .fill(Palette.separator)
                    .frame(height: Layout.hairline)

                VStack(alignment: .leading, spacing: Spacing.sm) {
                    Text("One file to create")
                        .font(Typography.heading)
                        .foregroundStyle(Palette.ink)
                    Text("Copy mobile/Config/Local.example.xcconfig to mobile/Config/Local.xcconfig, then fill in the same public values the website uses in .env.local. Local.xcconfig is gitignored.")
                        .font(Typography.body)
                        .foregroundStyle(Palette.secondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("Use only the anon / publishable key. The app refuses a service-role key.")
                        .font(Typography.meta)
                        .foregroundStyle(Palette.secondaryInk)
                }

                if let backendHost {
                    Text("Configured host: \(backendHost)")
                        .font(Typography.meta)
                        .foregroundStyle(Palette.secondaryInk)
                }
            }
            .padding(.horizontal, Layout.screenPadding)
            .padding(.vertical, Spacing.xl)
        }
    }
}

/// Signed in, but the membership answer has not arrived yet. It is a brief
/// state; the app never fills it with a guessed role.
struct RolePendingView: View {
    let user: AuthenticatedUser

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                VStack(alignment: .leading, spacing: Spacing.sm) {
                    Text("Signed in")
                        .font(Typography.label)
                        .tracking(1.4)
                        .textCase(.uppercase)
                        .foregroundStyle(Palette.secondaryInk)
                    Text("Looking up your program access")
                        .font(Typography.title)
                        .foregroundStyle(Palette.ink)
                    Text(user.email ?? "This account has no email address.")
                        .font(Typography.body)
                        .foregroundStyle(Palette.secondaryInk)
                }

                Rectangle()
                    .fill(Palette.separator)
                    .frame(height: Layout.hairline)

                HStack(spacing: Spacing.sm) {
                    ProgressView()
                        .tint(Palette.brand)
                    Text("Asking the database which programs you belong to and what you may do in them.")
                        .font(Typography.body)
                        .foregroundStyle(Palette.secondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.horizontal, Layout.screenPadding)
            .padding(.vertical, Spacing.xl)
        }
    }
}

/// Signed in, but on no active roster. Joining is a director's join code, and
/// that flow is not built yet — so this screen says so instead of offering a
/// form the backend would refuse.
struct NoProgramAccessView: View {
    let user: AuthenticatedUser

    @Environment(AppState.self) private var app
    @State private var confirmingSignOut = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                BrandMark()

                VStack(alignment: .leading, spacing: Spacing.sm) {
                    Text("Signed in")
                        .font(Typography.label)
                        .tracking(1.4)
                        .textCase(.uppercase)
                        .foregroundStyle(Palette.secondaryInk)
                    Text("You're not on a program yet.")
                        .font(Typography.title)
                        .foregroundStyle(Palette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(user.email ?? "This account has no email address.")
                        .font(Typography.body)
                        .foregroundStyle(Palette.secondaryInk)
                }

                Rectangle()
                    .fill(Palette.separator)
                    .frame(height: Layout.hairline)

                Text("Your account exists, but no program's roster includes it. Students join with the code their director gives them; teachers redeem an invitation code from the school. Those two screens arrive in the next phase — neither flow can be shortcut from here.")
                    .font(Typography.body)
                    .foregroundStyle(Palette.secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)

                Button(role: .destructive) {
                    confirmingSignOut = true
                } label: {
                    Text("Sign out")
                        .font(Typography.bodyEmphasis)
                        .frame(maxWidth: .infinity, minHeight: Layout.tapTarget)
                }
                .buttonStyle(.bordered)

                if let actionError = app.actionError {
                    Text(actionError)
                        .font(Typography.meta)
                        .foregroundStyle(Palette.attention)
                }
            }
            .padding(.horizontal, Layout.screenPadding)
            .padding(.vertical, Spacing.xl)
        }
        .background(Palette.canvas)
        .confirmationDialog(
            "Sign out of this device?",
            isPresented: $confirmingSignOut,
            titleVisibility: .visible
        ) {
            Button("Sign out", role: .destructive) {
                Task { await app.signOut() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Your saved session is removed from this device's Keychain.")
        }
    }
}

/// A real failure, shown as one. Never replaced by an empty state.
struct FailureView: View {
    let message: String
    @Environment(AppState.self) private var app

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            Text("Something went wrong")
                .font(Typography.title)
                .foregroundStyle(Palette.ink)
            Text(message)
                .font(Typography.body)
                .foregroundStyle(Palette.secondaryInk)
                .fixedSize(horizontal: false, vertical: true)
            Button {
                Task { await app.start() }
            } label: {
                Text("Try again")
                    .font(Typography.bodyEmphasis)
                    .frame(maxWidth: .infinity, minHeight: Layout.tapTarget)
            }
            .buttonStyle(.borderedProminent)
            .tint(Palette.brand)
        }
        .padding(Layout.screenPadding)
    }
}
