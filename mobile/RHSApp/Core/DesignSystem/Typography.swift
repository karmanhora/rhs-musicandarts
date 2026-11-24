import SwiftUI

/// SF Pro, in four roles. Like the website's type scale, the rule is that a new
/// heading size is not a design decision — use one of these.
///
/// They are semantic text styles, so Dynamic Type works without extra code.
enum Typography {
    /// A screen's name.
    static let title = Font.system(.largeTitle, design: .default, weight: .bold)
    /// A section's subject.
    static let heading = Font.system(.title3, design: .default, weight: .semibold)
    /// Body copy and row labels.
    static let body = Font.system(.body, design: .default, weight: .regular)
    /// Emphasised body copy.
    static let bodyEmphasis = Font.system(.body, design: .default, weight: .semibold)
    /// Timestamps and secondary lines.
    static let meta = Font.system(.footnote, design: .default, weight: .regular)
    /// A small caps label above a group or figure.
    static let label = Font.system(.caption2, design: .default, weight: .semibold)
}
