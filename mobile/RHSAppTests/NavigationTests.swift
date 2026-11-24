import XCTest
@testable import RHSApp

final class NavigationTests: XCTestCase {
    func testStudentDestinations() {
        XCTAssertEqual(
            AppRole.student.tabs,
            [.home, .events, .checkIn, .attendance, .profile]
        )
    }

    func testStaffDestinations() {
        XCTAssertEqual(
            AppRole.teacher.tabs,
            [.dashboard, .events, .scanner, .roster, .profile]
        )
    }

    func testEachRoleHasFiveDistinctDestinations() {
        for role in AppRole.allCases {
            XCTAssertEqual(role.tabs.count, 5, "\(role) must have five tabs")
            XCTAssertEqual(Set(role.tabs).count, role.tabs.count, "\(role) repeats a tab")
        }
    }

    func testProfileIsSharedButTheOtherTabsAreNot() {
        for role in AppRole.allCases {
            XCTAssertTrue(role.tabs.contains(.profile))
        }

        let studentOnly = Set(AppRole.student.tabs).subtracting(AppRole.teacher.tabs)
        XCTAssertEqual(studentOnly, [.home, .checkIn, .attendance])

        let staffOnly = Set(AppRole.teacher.tabs).subtracting(AppRole.student.tabs)
        XCTAssertEqual(staffOnly, [.dashboard, .scanner, .roster])
    }

    func testEveryTabHasALabelAndASymbol() {
        for tab in RoleTab.allCases {
            XCTAssertFalse(tab.title.isEmpty)
            XCTAssertFalse(tab.systemImage.isEmpty)
            XCTAssertEqual(tab.id, tab.rawValue)
        }
    }

    func testRoleTitlesAreHumanReadable() {
        XCTAssertEqual(AppRole.student.title, "Student")
        XCTAssertEqual(AppRole.teacher.title, "Staff")
    }
}
