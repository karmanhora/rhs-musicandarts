import SwiftUI

struct ScannerView: View {
    var body: some View {
        PlaceholderScreen(
            kicker: "Scanner",
            title: "Open a check-in for an event.",
            summary: "Staff start a session for one event; students scan the code it produces. Every mark is written by the server against the caller's program.",
            symbol: "barcode.viewfinder",
            planned: [
                "Start and close a check-in session for an event the caller may manage.",
                "A full-screen code for students to scan, and a live count of who has checked in.",
                "Manual marking for anyone whose phone is not working."
            ]
        )
        .navigationTitle("Scanner")
        .navigationBarTitleDisplayMode(.inline)
    }
}
