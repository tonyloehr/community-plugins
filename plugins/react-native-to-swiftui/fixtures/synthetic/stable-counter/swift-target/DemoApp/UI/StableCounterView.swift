// react-native-to-swiftui: ui slice=StableCounter
import SwiftUI

struct StableCounterView: View {
    @State private var state = CounterState()

    var body: some View {
        VStack {
            Text("Count: \(state.count)")
                .accessibilityIdentifier("stable-counter.value")
            Button("Increment") {
                state.increment()
            }
            .accessibilityIdentifier("stable-counter.increment")
        }
        .accessibilityIdentifier("stable-counter.root")
    }
}
