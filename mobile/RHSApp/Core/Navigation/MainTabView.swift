import SwiftUI

/// One native `TabView` per role. Each tab owns its own `NavigationStack`, so a
/// detail screen pushes within the tab the person is using.
///
/// The five destinations are the product decision from Phase 1. Staff get a
/// dashboard, events, scanner, roster and profile; students get home, events,
/// check-in, attendance and profile.
struct MainTabView: View {
    let role: AppRole
    let user: AuthenticatedUser

    @State private var selection: RoleTab

    init(role: AppRole, user: AuthenticatedUser) {
        self.role = role
        self.user = user
        _selection = State(initialValue: role.tabs.first ?? .home)
    }

    var body: some View {
        TabView(selection: $selection) {
            ForEach(role.tabs) { tab in
                NavigationStack {
                    screen(for: tab)
                }
                .tabItem {
                    Label(tab.title, systemImage: tab.systemImage)
                }
                .tag(tab)
            }
        }
        .onChange(of: selection) { _, _ in
            Haptics.selection()
        }
    }

    @ViewBuilder
    private func screen(for tab: RoleTab) -> some View {
        switch tab {
        case .home:
            HomeView()
        case .events:
            EventsView()
        case .checkIn:
            CheckInView()
        case .attendance:
            AttendanceView()
        case .profile:
            ProfileView(user: user)
        case .dashboard:
            TeacherDashboardView()
        case .scanner:
            ScannerView()
        case .roster:
            RosterView()
        }
    }
}
