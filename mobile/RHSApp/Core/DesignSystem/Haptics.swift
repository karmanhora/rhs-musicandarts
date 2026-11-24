import UIKit

/// Haptics explain an interaction; they do not celebrate it. Kept in one place
/// so the app cannot quietly develop a different vocabulary on every screen.
@MainActor
enum Haptics {
    /// A tab or segmented selection settled.
    static func selection() {
        UISelectionFeedbackGenerator().selectionChanged()
    }

    /// Something was accepted (a future check-in, a saved correction).
    static func success() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    /// Something was refused.
    static func warning() {
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
    }
}
