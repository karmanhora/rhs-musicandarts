import SwiftUI

/// A small original mark, drawn rather than shipped as artwork. It is a leaf and
/// an initial, not the school's logo — that artwork is deliberately absent from
/// this repository (docs/BRAND_ASSETS.md).
struct BrandMark: View {
    var size: CGFloat = 56

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
                .fill(Palette.brand)
            Image(systemName: "leaf.fill")
                .font(.system(size: size * 0.42, weight: .semibold))
                .foregroundStyle(Palette.onBrand)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}
