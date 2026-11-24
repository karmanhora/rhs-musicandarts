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

/// Nobody is signed in. Phase 1 has no sign-in form yet, so this screen states
/// the plan and the live backend connection rather than offering a dead button.
struct SignedOutView: View {
    @Environment(AppState.self) private var app

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                BrandMark()

                VStack(alignment: .leading, spacing: Spacing.sm) {
                    Text(app.configuration?.displayName ?? "RHS Music & Arts")
                        .font(Typography.label)
                        .tracking(1.4)
                        .textCase(.uppercase)
                        .foregroundStyle(Palette.secondaryInk)
                    Text("Attendance, without the clipboard.")
                        .font(Typography.title)
                        .foregroundStyle(Palette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("A native app for Redmond High School's music and arts programs. Check in, see your record, and — for staff — run the roll.")
                        .font(Typography.body)
                        .foregroundStyle(Palette.secondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Rectangle()
                    .fill(Palette.separator)
                    .frame(height: Layout.hairline)

                VStack(alignment: .leading, spacing: Spacing.sm) {
                    Text("Sign-in arrives in the next phase")
                        .font(Typography.heading)
                        .foregroundStyle(Palette.ink)
                    Text("Email and password, Google, and — if App Store review requires it because Google is offered — Sign in with Apple. Every method resolves to the same Supabase identity and the existing profile and membership rows.")
                        .font(Typography.body)
                        .foregroundStyle(Palette.secondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let callback = app.lastAuthCallback {
                    Text("Auth callback received: \(callback.absoluteString)")
                        .font(Typography.meta)
                        .foregroundStyle(Palette.secondaryInk)
                        .padding(.top, Spacing.xs)
                }

                if let host = app.backendHost {
                    HStack(spacing: Spacing.xs) {
                        Circle()
                            .fill(Palette.brand)
                            .frame(width: 6, height: 6)
                        Text("Supabase client ready — \(host)")
                            .font(Typography.meta)
                            .foregroundStyle(Palette.secondaryInk)
                    }
                    .padding(.top, Spacing.sm)
                    .accessibilityElement(children: .combine)
                }

                PhaseNote()
            }
            .padding(.horizontal, Layout.screenPadding)
            .padding(.vertical, Spacing.xl)
        }
    }
}

/// Signed in, but the database has not said whether this account is a student or
/// staff. Saying so is the correct behaviour: the app must not assume.
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
                    Text("Checking your access")
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
                    Text("Waiting for the program and capability data that decides which shell opens.")
                        .font(Typography.body)
                        .foregroundStyle(Palette.secondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Text("The server decides, not this app. Role names live on memberships, and staff capability is resolved by the database's permission function, so a person can be a student in one program and staff in another.")
                    .font(Typography.meta)
                    .foregroundStyle(Palette.secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)

                PhaseNote()
            }
            .padding(.horizontal, Layout.screenPadding)
            .padding(.vertical, Spacing.xl)
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
