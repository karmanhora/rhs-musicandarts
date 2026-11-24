import SwiftUI

struct EventsView: View {
    var body: some View {
        PlaceholderScreen(
            kicker: "Events",
            title: "The calendar, in your pocket.",
            summary: "Every rehearsal, performance and meeting for your program, read from the same events table the website uses.",
            symbol: "calendar",
            planned: [
                "A month view and a chronological agenda, grouped by day.",
                "Each event's type, requirement and start time, with the program it belongs to.",
                "Staff-only actions on the same events: create, edit, and open check-in."
            ]
        )
        .navigationTitle("Events")
        .navigationBarTitleDisplayMode(.inline)
    }
}
