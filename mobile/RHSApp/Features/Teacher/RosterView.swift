import SwiftUI

struct RosterView: View {
    var body: some View {
        PlaceholderScreen(
            kicker: "Roster",
            title: "Who is in this program.",
            summary: "Members, their sections and their roles, read through the same membership and capability rules the website enforces.",
            symbol: "person.2",
            planned: [
                "A roster grouped by section, with each member's roles.",
                "The join code, for directors allowed to read and rotate it.",
                "Removing somebody, scoped to this program, with a confirmation that says exactly what is deleted."
            ]
        )
        .navigationTitle("Roster")
        .navigationBarTitleDisplayMode(.inline)
    }
}
