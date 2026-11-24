import SwiftUI

/// Shown after a password-recovery link. The link has already signed the person
/// in, so this screen only sets the new password — nothing else is reachable
/// until it is saved or dismissed.
struct SetNewPasswordView: View {
    @Environment(AppState.self) private var app

    @State private var password = ""
    @State private var confirmation = ""
    @State private var busy = false
    @State private var errorText: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                BrandMark()

                VStack(alignment: .leading, spacing: Spacing.sm) {
                    Text("Password recovery")
                        .font(Typography.label)
                        .tracking(1.4)
                        .textCase(.uppercase)
                        .foregroundStyle(Palette.secondaryInk)
                    Text("Choose a new password.")
                        .font(Typography.title)
                        .foregroundStyle(Palette.ink)
                    Text("You're signed in from the recovery link. This replaces the password for this account.")
                        .font(Typography.body)
                        .foregroundStyle(Palette.secondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Rectangle()
                    .fill(Palette.separator)
                    .frame(height: Layout.hairline)

                AuthField("New password") {
                    SecureField("At least 6 characters", text: $password)
                        .textContentType(.newPassword)
                        .disabled(busy)
                }
                AuthField("Confirm new password") {
                    SecureField("Same password again", text: $confirmation)
                        .textContentType(.newPassword)
                        .disabled(busy)
                }

                if let errorText {
                    Text(errorText)
                        .font(Typography.meta)
                        .foregroundStyle(Palette.attention)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Button {
                    submit()
                } label: {
                    Group {
                        if busy {
                            ProgressView()
                                .tint(Palette.onBrand)
                        } else {
                            Text("Save password")
                                .font(Typography.bodyEmphasis)
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: Layout.tapTarget)
                }
                .buttonStyle(.borderedProminent)
                .tint(Palette.brand)
                .disabled(busy)

                Button("Not now") {
                    app.dismissRecovery()
                }
                .buttonStyle(.plain)
                .font(Typography.meta)
                .foregroundStyle(Palette.secondaryInk)
                .frame(minHeight: Layout.tapTarget, alignment: .leading)
            }
            .padding(.horizontal, Layout.screenPadding)
            .padding(.vertical, Spacing.xl)
        }
        .background(Palette.canvas)
        .scrollDismissesKeyboard(.interactively)
    }

    private func submit() {
        errorText = nil
        guard password.count >= 6 else {
            errorText = "Choose a password with at least 6 characters."
            return
        }
        guard password == confirmation else {
            errorText = "The two passwords don't match."
            return
        }

        busy = true
        Task {
            do {
                try await app.updatePassword(password)
            } catch {
                errorText = AuthMessages.readable(error)
            }
            busy = false
        }
    }
}
