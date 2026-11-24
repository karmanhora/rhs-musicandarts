import SwiftUI

/// The shape every Phase 1 screen takes: a quiet header, one rule, and an
/// honest list of what this destination will do once its feature exists.
///
/// It is deliberately not a dashboard template. There is no grid of cards, no
/// gradient and no fake metric — a placeholder that invents data is worse than
/// one that says what is missing.
struct PlaceholderScreen: View {
    let kicker: String
    let title: String
    let summary: String
    let symbol: String
    let planned: [String]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                header
                Rectangle()
                    .fill(Palette.separator)
                    .frame(height: Layout.hairline)
                plannedList
                PhaseNote()
            }
            .padding(.horizontal, Layout.screenPadding)
            .padding(.top, Spacing.md)
            .padding(.bottom, Spacing.xl)
        }
        .background(Palette.canvas)
        .scrollContentBackground(.hidden)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack(spacing: Spacing.sm) {
                Image(systemName: symbol)
                    .font(Typography.meta)
                    .foregroundStyle(Palette.brand)
                Text(kicker)
                    .font(Typography.label)
                    .tracking(1.4)
                    .textCase(.uppercase)
                    .foregroundStyle(Palette.secondaryInk)
            }
            Text(title)
                .font(Typography.title)
                .foregroundStyle(Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
            Text(summary)
                .font(Typography.body)
                .foregroundStyle(Palette.secondaryInk)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    private var plannedList: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            Text("Next phase")
                .font(Typography.label)
                .tracking(1.4)
                .textCase(.uppercase)
                .foregroundStyle(Palette.secondaryInk)

            ForEach(planned, id: \.self) { item in
                HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
                    Circle()
                        .fill(Palette.brandWash)
                        .overlay(Circle().fill(Palette.brand).frame(width: 5, height: 5))
                        .frame(width: 14, height: 14)
                        .accessibilityHidden(true)
                    Text(item)
                        .font(Typography.body)
                        .foregroundStyle(Palette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .frame(minHeight: 28, alignment: .leading)
            }
        }
    }
}

/// A small, repeated statement of what this build is. It is the only chrome the
/// placeholders add.
struct PhaseNote: View {
    var body: some View {
        HStack(spacing: Spacing.xs) {
            Image(systemName: "hammer")
                .font(Typography.meta)
            Text("Phase 1 foundation — no attendance data yet")
                .font(Typography.meta)
        }
        .foregroundStyle(Palette.secondaryInk)
        .padding(.top, Spacing.sm)
        .accessibilityElement(children: .combine)
    }
}
