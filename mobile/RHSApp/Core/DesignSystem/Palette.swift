import SwiftUI
import UIKit

/// The app's colour. Every value exists here and nowhere else, and each pair was
/// chosen for readability rather than decoration:
///
/// - `ink` on `canvas` and on `surface` clears AA in both appearances.
/// - `secondaryInk` is a measured value, not a lighter tint of `ink`.
/// - `brand` is ink and the primary action; on dark it lightens so it still reads
///   as green instead of turning into a dark hole.
/// - `gold` is the single attention colour (today, something expiring). It is
///   never used decoratively.
///
/// Four type roles and one accent keep the app from looking like a dashboard.
enum Palette {
    /// The page itself: warm off-white in light, near-black green in dark.
    static let canvas = Color(light: 0xF7F5EE, dark: 0x0E1411)
    /// Primary copy.
    static let ink = Color(light: 0x11251C, dark: 0xF3F1E7)
    /// Secondary copy, timestamps, explanations.
    static let secondaryInk = Color(light: 0x53645A, dark: 0xAFBAB2)
    /// RHS deep green: primary actions, selection, presence.
    static let brand = Color(light: 0x0E3B2C, dark: 0x7AC7A0)
    /// Copy that sits on `brand`.
    static let onBrand = Color(light: 0xF7F5EE, dark: 0x08130E)
    /// A quiet green wash for a selected row or a status.
    static let brandWash = Color(light: 0xE7EFE7, dark: 0x16281F)
    /// The one attention colour.
    static let attention = Color(light: 0x8A5F10, dark: 0xE4B963)
    /// Hairlines between rows.
    static let separator = Color(light: 0xE2DED1, dark: 0x2A352F)
}

extension Color {
    /// A colour that answers the system appearance. Written once so no view has
    /// to branch on `colorScheme` for a token.
    init(light: UInt32, dark: UInt32) {
        self.init(uiColor: UIColor { traits in
            UIColor(hex: traits.userInterfaceStyle == .dark ? dark : light)
        })
    }
}

private extension UIColor {
    convenience init(hex: UInt32) {
        let red = CGFloat((hex >> 16) & 0xFF) / 255
        let green = CGFloat((hex >> 8) & 0xFF) / 255
        let blue = CGFloat(hex & 0xFF) / 255
        self.init(red: red, green: green, blue: blue, alpha: 1)
    }
}
