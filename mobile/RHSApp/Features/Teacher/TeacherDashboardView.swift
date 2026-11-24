import SwiftUI

struct TeacherDashboardView: View {
    var body: some View {
        PlaceholderScreen(
            kicker: "Dashboard",
            title: "The roll, before the rehearsal.",
            summary: "The staff view of a program: who is expected, what is recorded, and what needs a decision.",
            symbol: "square.grid.2x2",
            planned: [
                "Today's events and their check-in state, for the program on screen.",
                "Unrecorded attendance and absences waiting for a decision.",
                "A way to switch programs for staff who belong to more than one."
            ]
        )
        .navigationTitle("Dashboard")
        .navigationBarTitleDisplayMode(.inline)
    }
}
