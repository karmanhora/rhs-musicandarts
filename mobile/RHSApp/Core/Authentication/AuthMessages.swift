import Foundation

/// Turns Supabase's technical messages into the handful a student actually
/// meets, said the way the rest of the app talks. Anything unrecognised is
/// passed through untouched: hiding a real server or network fault behind
/// "something went wrong" is how a broken deployment looks like a wrong
/// password.
enum AuthMessages {
    static func readable(_ error: Error) -> String {
        let text = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        return readable(text)
    }

    static func readable(_ message: String) -> String {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return "Something went wrong. Try again." }

        if let match = text.range(of: #"password should be at least (\d+)"#, options: [.regularExpression, .caseInsensitive]) {
            let digits = text[match].filter(\.isNumber)
            if !digits.isEmpty {
                return "Your password needs to be at least \(digits) characters."
            }
        }

        let known: [(String, String)] = [
            ("invalid login credentials", "That email and password don't match. Check them and try again."),
            ("email not confirmed", "Confirm your email first — we sent you a link when you signed up."),
            ("user already registered", "That email already has an account. Sign in instead, or reset the password."),
            ("new password should be different", "That is your current password — pick a new one."),
            ("unable to validate email address", "That doesn't look like an email address."),
            ("invalid format", "That doesn't look like an email address."),
            ("email rate limit exceeded", "Too many emails just now — wait a minute and try again."),
            ("over_email_send_rate_limit", "Too many emails just now — wait a minute and try again."),
            ("token has expired", "That code has already been used, or it has expired. If your address is confirmed, sign in with your password."),
            ("otp_expired", "That code has already been used, or it has expired. If your address is confirmed, sign in with your password."),
            ("invalid", "That code isn't right. Check it and try again."),
            ("security purposes", "Just a moment — wait a few seconds before trying that again."),
            ("auth session missing", "Your sign-in link has expired. Ask for a new one."),
            ("error sending", "We couldn't send that email — that's on our side, not your account. Try again in a minute."),
        ]

        let lowered = text.lowercased()
        for (needle, friendly) in known where lowered.contains(needle) {
            return friendly
        }
        return text
    }
}
