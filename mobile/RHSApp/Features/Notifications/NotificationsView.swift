import SwiftUI

struct NotificationsView: View {
    var body: some View {
        PlaceholderScreen(
            kicker: "Notifications",
            title: "What changed since you last looked.",
            summary: "The same in-app notification centre the website shows: event changes, absence decisions, and staff actions that concern you.",
            symbol: "bell",
            planned: [
                "An unread-first list, with each notification opening the thing it is about.",
                "Mark as read, and a badge on Profile until the inbox is clear.",
                "No push permission in this phase — email and the in-app bell remain the channels."
            ]
        )
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
    }
}
