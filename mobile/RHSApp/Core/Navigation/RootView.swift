import SwiftUI

/// The app's root. It renders exactly one state, and it never guesses a role: a
/// signed-in account waits for the database's membership answer.
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
        if app.recoveryInProgress, case .signedIn = app.phase {
            SetNewPasswordView()
        } else {
            switch app.phase {
            case .loading:
                LoadingView()
            case .configurationRequired(let message):
                ConfigurationRequiredView(message: message, backendHost: app.backendHost)
            case .signedOut:
                AuthView()
            case .signedIn(let user):
                if let role = app.role {
                    MainTabView(role: role, user: user)
                } else if app.noProgramAccess {
                    NoProgramAccessView(user: user)
                } else {
                    RolePendingView(user: user)
                }
            case .failed(let message):
                FailureView(message: message)
            }
        }
    }
}
