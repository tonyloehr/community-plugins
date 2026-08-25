// react-native-to-swiftui: domain slice=StableCounter
import Foundation

struct CounterState: Equatable {
    private(set) var count: Int

    init(initialCount: Int = 0) {
        count = initialCount
    }

    mutating func increment() {
        count += 1
    }
}
