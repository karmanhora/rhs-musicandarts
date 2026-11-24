import SwiftUI

struct HomeView: View {
    var body: some View {
        PlaceholderScreen(
            kicker: "Home",
            title: "Your program, at a glance.",
            summary: "The next rehearsal or performance, whether you are expected, and the one thing worth doing before it starts.",
            symbol: "house",
            planned: [
                "The next event for the program you are in, with its call time and requirement.",
                "Your attendance standing for the current term, computed by the database.",
                "One prompt when something needs you: an absence request, a correction, or a check-in that is open."
            ]
        )
        .navigationTitle("Home")
        .navigationBarTitleDisplayMode(.inline)
    }
}
