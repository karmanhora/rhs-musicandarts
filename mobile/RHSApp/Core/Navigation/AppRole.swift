import Foundation

/// The interface's two navigation shells.
///
/// This is a *presentation* concept, not an authorization one. The database
/// remains the boundary: every query and RPC is scoped by RLS and capabilities,
/// so a shell can only show controls the server would accept.
enum AppRole: String, CaseIterable, Identifiable, Sendable {
    case student
    case teacher

    var id: String { rawValue }

    var title: String {
        switch self {
        case .student: return "Student"
        case .teacher: return "Staff"
        }
    }

    /// The native bottom tab bar for this role, in order.
    var tabs: [RoleTab] {
        switch self {
        case .student:
            return [.home, .events, .checkIn, .attendance, .profile]
        case .teacher:
            return [.dashboard, .events, .scanner, .roster, .profile]
        }
    }
}

/// One tab destination. The screen behind each is a Phase 1 placeholder.
enum RoleTab: String, CaseIterable, Identifiable, Hashable, Sendable {
    case home
    case events
    case checkIn
    case attendance
    case profile
    case dashboard
    case scanner
    case roster

    var id: String { rawValue }

    var title: String {
        switch self {
        case .home: return "Home"
        case .events: return "Events"
        case .checkIn: return "Check-in"
        case .attendance: return "Attendance"
        case .profile: return "Profile"
        case .dashboard: return "Dashboard"
        case .scanner: return "Scanner"
        case .roster: return "Roster"
        }
    }

    var systemImage: String {
        switch self {
        case .home: return "house"
        case .events: return "calendar"
        case .checkIn: return "qrcode.viewfinder"
        case .attendance: return "checkmark.circle"
        case .profile: return "person.crop.circle"
        case .dashboard: return "square.grid.2x2"
        case .scanner: return "barcode.viewfinder"
        case .roster: return "person.2"
        }
    }
}
