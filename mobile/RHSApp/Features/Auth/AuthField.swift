import SwiftUI

/// One labelled input. The only field style in the app, so sign-in, signup and
/// password reset cannot drift apart.
struct AuthField<Content: View>: View {
    private let label: String
    @ViewBuilder private let content: () -> Content

    init(_ label: String, @ViewBuilder content: @escaping () -> Content) {
        self.label = label
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text(label)
                .font(Typography.label)
                .tracking(1.2)
                .textCase(.uppercase)
                .foregroundStyle(Palette.secondaryInk)
            content()
                .font(Typography.body)
                .padding(Spacing.md)
                .background(
                    Palette.brandWash,
                    in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                )
        }
    }
}
