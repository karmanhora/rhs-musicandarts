import SwiftUI

/// The app's root. It renders exactly one of five states, and it never guesses a
/// role: a signed-in account without a backend answer waits in `RolePendingView`.
struct RootView: View {
    @Environment(AppState.self) private var app

    var body: some View {
        ZStack {
            Palette.canvas.ignoresSafeArea()
            content
        }
        .animation(.easeOut(duration: 0.2), value: app.phase)
    }

    @ViewBuilder
    private var content: some View {
        switch app.phase {
        case .loading:
            LoadingView()
        case .configurationRequired(let message):
            ConfigurationRequiredView(message: message, backendHost: app.backendHost)
        case .signedOut:
            SignedOutView()
        case .signedIn(let user):
            if let role = app.role {
                MainTabView(role: role, user: user)
            } else {
                RolePendingView(user: user)
            }
        case .failed(let message):
            FailureView(message: message)
        }
    }
}
