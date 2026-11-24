import SwiftUI

struct AttendanceView: View {
    var body: some View {
        PlaceholderScreen(
            kicker: "Attendance",
            title: "Your record, without the spreadsheet.",
            summary: "Present, late, excused and not-recorded, straight from the attendance records your program keeps.",
            symbol: "checkmark.circle",
            planned: [
                "Your percentage for the term, with optional events separated from required ones.",
                "The events behind the number, newest first, each with its recorded status.",
                "Absence requests for an upcoming event, and their decision once staff review them."
            ]
        )
        .navigationTitle("Attendance")
        .navigationBarTitleDisplayMode(.inline)
    }
}
