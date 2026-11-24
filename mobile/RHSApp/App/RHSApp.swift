import SwiftUI

@main
struct RHSApp: App {
    /// The single composition root. Everything below it receives its
    /// dependencies rather than reaching for a global.
    @State private var appState = AppState(dependencies: .live())

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(appState)
                .tint(Palette.brand)
                .task { await appState.start() }
                // Supabase Auth returns through this app's own URL scheme. Phase 1
                // accepts and records the callback; Phase 2 exchanges it for a session.
                .onOpenURL { appState.handleIncomingURL($0) }
        }
    }
}
