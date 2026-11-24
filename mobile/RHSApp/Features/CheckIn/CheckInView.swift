import SwiftUI

struct CheckInView: View {
    var body: some View {
        PlaceholderScreen(
            kicker: "Check-in",
            title: "Scan the code. That's the roll.",
            summary: "A check-in belongs to a specific event, and the server decides whether it is open and whether you are on that program's roster.",
            symbol: "qrcode.viewfinder",
            planned: [
                "Scan an event's QR code with the camera, or enter its short code.",
                "Confirmation from the server that the mark was recorded — never an optimistic success.",
                "A clear message when the code is wrong, closed, or not for a program you belong to."
            ]
        )
        .navigationTitle("Check-in")
        .navigationBarTitleDisplayMode(.inline)
    }
}
