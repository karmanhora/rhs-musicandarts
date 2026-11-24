import XCTest
@testable import RHSApp

final class RoleResolutionTests: XCTestCase {
    func testStudentRoleGetsTheStudentShell() {
        XCTAssertEqual(
            SupabaseRoleResolver.resolution(roles: ["student"], isProgramAdmin: false),
            .shell(.student)
        )
    }

    func testStaffSystemRolesGetTheStaffShell() {
        for role in ["director", "secretary", "section_leader"] {
            XCTAssertEqual(
                SupabaseRoleResolver.resolution(roles: ["student", role], isProgramAdmin: false),
                .shell(.teacher),
                "\(role) should open the staff shell"
            )
        }
    }

    func testProgramAdministratorAlwaysGetsTheStaffShell() {
        XCTAssertEqual(
            SupabaseRoleResolver.resolution(roles: [], isProgramAdmin: true),
            .shell(.teacher)
        )
    }

    func testARoleTheAppDoesNotKnowIsNotTreatedAsStaff() {
        XCTAssertEqual(
            SupabaseRoleResolver.resolution(roles: ["student", "alumni"], isProgramAdmin: false),
            .shell(.student)
        )
    }
}
