import CoreGraphics

/// Spacing comes from one scale; views pick a step instead of inventing a number.
enum Spacing {
    static let xs: CGFloat = 6
    static let sm: CGFloat = 10
    static let md: CGFloat = 16
    static let lg: CGFloat = 24
    static let xl: CGFloat = 36
}

enum Layout {
    /// Apple's minimum comfortable target. Every tappable row meets it.
    static let tapTarget: CGFloat = 44
    /// Screens sit on a 20pt gutter.
    static let screenPadding: CGFloat = 20
    static let hairline: CGFloat = 1
}
