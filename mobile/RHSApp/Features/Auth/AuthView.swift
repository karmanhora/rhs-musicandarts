import SwiftUI

/// The signed-out surface: email and password sign-in, account creation, the
/// confirmation code, and password recovery.
///
/// Signup records the student/teacher choice as `account_type` metadata, which
/// migration 023 records server-side. It creates no profile and no membership:
/// joining a program is still a director's join code, and teacher access is
/// still a redeemed invitation code.
struct AuthView: View {
    private enum Mode: Hashable {
        case signIn
        case signUp
        case confirm(String)
        case reset
    }

    @Environment(AppState.self) private var app

    @State private var mode: Mode = .signIn
    @State private var email = ""
    @State private var password = ""
    @State private var displayName = ""
    @State private var audience: AuthAudience = .student
    @State private var code = ""
    @State private var busy = false
    @State private var errorText: String?
    @State private var notice: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                BrandMark()
                header
                if mode == .signIn || mode == .signUp { modePicker }
                form
            }
            .padding(.horizontal, Layout.screenPadding)
            .padding(.vertical, Spacing.xl)
        }
        .background(Palette.canvas)
        .scrollDismissesKeyboard(.interactively)
        .onAppear {
            if let authError = app.authError {
                errorText = authError
                app.clearAuthError()
            }
        }
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text(app.configuration?.displayName ?? "RHS Music & Arts")
                .font(Typography.label)
                .tracking(1.4)
                .textCase(.uppercase)
                .foregroundStyle(Palette.secondaryInk)
            Text(title)
                .font(Typography.title)
                .foregroundStyle(Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
            Text(subtitle)
                .font(Typography.body)
                .foregroundStyle(Palette.secondaryInk)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var title: String {
        switch mode {
        case .signIn: return "Welcome back."
        case .signUp: return "Create your account."
        case .confirm: return "Check your email."
        case .reset: return "Reset your password."
        }
    }

    private var subtitle: String {
        switch mode {
        case .signIn:
            return "Sign in with the account you use for your program."
        case .signUp:
            return "Choose how you're joining. Your program controls what you can see; this choice only starts the right onboarding."
        case .confirm:
            return "Confirm your address to finish creating the account."
        case .reset:
            return "We'll email you a link that lets you choose a new password."
        }
    }

    private var modePicker: some View {
        Picker("Account action", selection: $mode) {
            Text("Sign in").tag(Mode.signIn)
            Text("Create account").tag(Mode.signUp)
        }
        .pickerStyle(.segmented)
        .onChange(of: mode) { _, _ in clearMessages() }
    }

    // MARK: - Forms

    @ViewBuilder
    private var form: some View {
        switch mode {
        case .signIn:
            signInForm
        case .signUp:
            signUpForm
        case .confirm(let address):
            confirmForm(address)
        case .reset:
            resetForm
        }
    }

    private var signInForm: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            AuthField("Email") {
                TextField("you@school.org", text: $email)
                    .textContentType(.username)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .disabled(busy)
            }
            AuthField("Password") {
                SecureField("Password", text: $password)
                    .textContentType(.password)
                    .disabled(busy)
            }

            messages

            primaryButton("Sign in") { submitSignIn() }

            Button("Forgot your password?") {
                clearMessages()
                mode = .reset
            }
            .buttonStyle(.plain)
            .font(Typography.meta)
            .foregroundStyle(Palette.brand)
            .frame(minHeight: Layout.tapTarget, alignment: .leading)
        }
    }

    private var signUpForm: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            AuthField("Name (optional)") {
                TextField("Your name", text: $displayName)
                    .textContentType(.name)
                    .textInputAutocapitalization(.words)
                    .disabled(busy)
            }
            AuthField("Email") {
                TextField("you@school.org", text: $email)
                    .textContentType(.username)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .disabled(busy)
            }
            AuthField("Password") {
                SecureField("At least 6 characters", text: $password)
                    .textContentType(.newPassword)
                    .disabled(busy)
            }

            VStack(alignment: .leading, spacing: Spacing.xs) {
                Text("I'm joining as")
                    .font(Typography.label)
                    .tracking(1.2)
                    .textCase(.uppercase)
                    .foregroundStyle(Palette.secondaryInk)
                Picker("Joining as", selection: $audience) {
                    ForEach(AuthAudience.allCases) { choice in
                        Text(choice.title).tag(choice)
                    }
                }
                .pickerStyle(.segmented)
                .disabled(busy)
                Text(audience.explanation)
                    .font(Typography.meta)
                    .foregroundStyle(Palette.secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }

            messages

            primaryButton("Create account") { submitSignUp() }
        }
    }

    private func confirmForm(_ address: String) -> some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            Text("We sent a confirmation link and a code to \(address). Open the link on this phone, or enter the code below.")
                .font(Typography.body)
                .foregroundStyle(Palette.secondaryInk)
                .fixedSize(horizontal: false, vertical: true)

            AuthField("Confirmation code") {
                TextField("Code from the email", text: $code)
                    .textContentType(.oneTimeCode)
                    .keyboardType(.asciiCapable)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .disabled(busy)
            }

            messages

            primaryButton("Confirm email") { submitConfirmation(address) }

            Button("Send it again") { resend(to: address) }
                .buttonStyle(.plain)
                .font(Typography.meta)
                .foregroundStyle(Palette.brand)
                .frame(minHeight: Layout.tapTarget, alignment: .leading)

            Button("Use a different email") {
                clearMessages()
                mode = .signIn
            }
            .buttonStyle(.plain)
            .font(Typography.meta)
            .foregroundStyle(Palette.secondaryInk)
            .frame(minHeight: Layout.tapTarget, alignment: .leading)
        }
    }

    private var resetForm: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            AuthField("Email") {
                TextField("you@school.org", text: $email)
                    .textContentType(.username)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .disabled(busy)
            }

            messages

            primaryButton("Send reset link") { submitReset() }

            Button("Back to sign in") {
                clearMessages()
                mode = .signIn
            }
            .buttonStyle(.plain)
            .font(Typography.meta)
            .foregroundStyle(Palette.secondaryInk)
            .frame(minHeight: Layout.tapTarget, alignment: .leading)
        }
    }

    @ViewBuilder
    private var messages: some View {
        if let errorText {
            Text(errorText)
                .font(Typography.meta)
                .foregroundStyle(Palette.attention)
                .fixedSize(horizontal: false, vertical: true)
        }
        if let notice {
            Text(notice)
                .font(Typography.meta)
                .foregroundStyle(Palette.brand)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func primaryButton(_ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Group {
                if busy {
                    ProgressView()
                        .tint(Palette.onBrand)
                } else {
                    Text(label)
                        .font(Typography.bodyEmphasis)
                }
            }
            .frame(maxWidth: .infinity, minHeight: Layout.tapTarget)
        }
        .buttonStyle(.borderedProminent)
        .tint(Palette.brand)
        .disabled(busy)
    }

    // MARK: - Actions

    private func submitSignIn() {
        clearMessages()
        guard let address = validatedEmail() else { return }
        guard !password.isEmpty else {
            errorText = "Enter your password."
            return
        }

        busy = true
        Task {
            do {
                try await app.signIn(email: address, password: password)
            } catch {
                errorText = AuthMessages.readable(error)
            }
            busy = false
        }
    }

    private func submitSignUp() {
        clearMessages()
        guard let address = validatedEmail() else { return }
        guard password.count >= 6 else {
            errorText = "Choose a password with at least 6 characters."
            return
        }

        busy = true
        Task {
            do {
                switch try await app.signUp(
                    email: address,
                    password: password,
                    audience: audience,
                    displayName: displayName
                ) {
                case .signedIn:
                    break
                case .needsEmailConfirmation:
                    mode = .confirm(address)
                    notice = "We sent a confirmation link and code to \(address)."
                case .existingAccount:
                    mode = .signIn
                    errorText = "That email already has an account. Sign in instead, or use Forgot your password."
                }
            } catch {
                errorText = AuthMessages.readable(error)
            }
            busy = false
        }
    }

    private func submitConfirmation(_ address: String) {
        clearMessages()
        let entered = code.replacingOccurrences(of: " ", with: "")
        guard !entered.isEmpty else {
            errorText = "Enter the code from the email."
            return
        }

        busy = true
        Task {
            do {
                try await app.confirmEmail(email: address, code: entered)
            } catch {
                errorText = AuthMessages.readable(error)
            }
            busy = false
        }
    }

    private func resend(to address: String) {
        clearMessages()
        busy = true
        Task {
            do {
                try await app.resendConfirmation(email: address)
                notice = "Sent again. It can take a minute to arrive."
            } catch {
                errorText = AuthMessages.readable(error)
            }
            busy = false
        }
    }

    private func submitReset() {
        clearMessages()
        guard let address = validatedEmail() else { return }

        busy = true
        Task {
            do {
                try await app.requestPasswordReset(email: address)
                notice = "If that address has an account, a reset link is on its way. Open it on this phone to choose a new password."
            } catch {
                errorText = AuthMessages.readable(error)
            }
            busy = false
        }
    }

    // MARK: - Helpers

    private func validatedEmail() -> String? {
        let address = email.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = address.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty, parts[1].contains("."), !parts[1].hasSuffix(".") else {
            errorText = "Enter an email address."
            return nil
        }
        return address
    }

    private func clearMessages() {
        errorText = nil
        notice = nil
    }
}
