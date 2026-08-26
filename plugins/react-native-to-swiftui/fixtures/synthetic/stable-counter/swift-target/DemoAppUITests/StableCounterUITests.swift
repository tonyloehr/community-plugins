// react-native-to-swiftui: ui-test slice=StableCounter
import XCTest

final class StableCounterUITests: XCTestCase {
    func testIncrementUpdatesTheVisibleCount() {
        let app = XCUIApplication()
        app.launch()

        XCTAssertEqual(app.staticTexts["stable-counter.value"].label, "Count: 0")
        app.buttons["stable-counter.increment"].tap()
        XCTAssertEqual(app.staticTexts["stable-counter.value"].label, "Count: 1")
    }
}
