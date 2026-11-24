import SwiftUI

/// The one screen in Phase 1 that does something real: it shows the Supabase
/// identity the app is running as, states whether the backend has answered the
/// role question, links to notifications, and signs out.
struct ProfileView: View {
    let user: AuthenticatedUser

    @Environment(AppState.self) private var app
    @State private var confirmingSignOut = false

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    Text(user.email ?? "No email address")
                        .font(Typography.heading)
                        .foregroundStyle(Palette.ink)
                    Text(app.isDemoSession ? "Demo session" : "Supabase identity")
                        .font(Typography.label)
                        .tracking(1.2)
                        .textCase(.uppercase)
                        .foregroundStyle(Palette.secondaryInk)
                    Text(user.id)
                        .font(Typography.meta)
                        .foregroundStyle(Palette.secondaryInk)
                        .textSelection(.enabled)
                    if app.isDemoSession {
                        Text("Started with -RHSDemoRole. No Supabase account is signed in and no data is loaded; the tabs are a navigation preview.")
                            .font(Typography.meta)
                            .foregroundStyle(Palette.attention)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.vertical, Spacing.xs)
            } footer: {
                Text("This id is profiles.auth_user_id — the value every policy and RPC uses to resolve you. The app never sends an email address as identity.")
            }

            Section("Access") {
                LabeledContent("Role") {
                    Text(app.role?.title ?? (app.noProgramAccess ? "No program yet" : "Awaiting the server"))
                }
                LabeledContent("Program") {
                    Text("Chosen in the next phase")
                }
            }

            Section {
                NavigationLink {
                    NotificationsView()
                } label: {
                    Label("Notifications", systemImage: "bell")
                }
            }

            Section {
                Button(role: .destructive) {
                    confirmingSignOut = true
                } label: {
                    Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
                        .frame(minHeight: Layout.tapTarget, alignment: .leading)
                }
            } footer: {
                if let actionError = app.actionError {
                    Text(actionError)
                        .foregroundStyle(Palette.attention)
                } else if let host = app.backendHost {
                    Text("Connected to \(host)")
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Palette.canvas)
        .navigationTitle("Profile")
        .navigationBarTitleDisplayMode(.inline)
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
            Text("Your saved session is removed from this device's Keychain. Your program data stays with your account.")
        }
    }
}
