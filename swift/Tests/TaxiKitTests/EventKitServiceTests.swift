// TaxiKit — EventKitService unit tests (non-authorization paths).

import XCTest
import EventKit
@testable import TaxiKit

final class EventKitServiceTests: XCTestCase {

    let service = EventKitService()

    func testInvalidCreateDateIsRejectedBeforeAuthorization() async throws {
        let input = try JSONDecoder().decode(CreateReminderInput.self, from: Data(#"{"title":"fixture","dueDate":"invalid"}"#.utf8))
        do {
            _ = try await service.createReminder(input)
            XCTFail("Invalid date must not create a reminder")
        } catch {
            guard case TaxiKitError.invalidInput = error else { return XCTFail("Expected input rejection before authorization: \(error)") }
        }
    }

    func testInvalidUpdateDateIsRejectedBeforeTargetLookup() async throws {
        let input = try JSONDecoder().decode(UpdateReminderInput.self, from: Data(#"{"id":"fixture-not-a-real-id","dueDate":"invalid"}"#.utf8))
        do {
            _ = try await service.updateReminder(input)
            XCTFail("Invalid date must not update a reminder")
        } catch {
            guard case TaxiKitError.invalidInput = error else { return XCTFail("Expected input rejection before target lookup: \(error)") }
        }
    }

    func testReminderDateAcceptanceContract() throws {
        for value in ["invalid", "2026-02-30T10:00:00Z", "2026-09-09T10:00:00", "2026-09-09T24:00:00Z", "2026-09-09T10:00:00-00:00", "2026-09-09T10:00:00.123Z"] {
            XCTAssertThrowsError(try parseReminderDate(value), value)
        }
        XCTAssertEqual(try parseReminderDate("2026-09-09T10:00:00+09:00"), try parseReminderDate("2026-09-09T01:00:00.000Z"))
        XCTAssertNoThrow(try parseReminderDate("2028-02-29T10:00:00Z"))
    }

    // MARK: - Recurrence Rule Building

    func testDailyRecurrenceRule() throws {
        let input = RecurrenceInput(
            frequency: "daily", interval: 1,
            endDate: nil, count: nil, daysOfWeek: nil
        )
        let rule = try service.buildRecurrenceRule(input)
        XCTAssertEqual(rule.frequency, .daily)
        XCTAssertEqual(rule.interval, 1)
        XCTAssertNil(rule.recurrenceEnd)
    }

    func testWeeklyRecurrenceWithDays() throws {
        let input = RecurrenceInput(
            frequency: "weekly", interval: 2,
            endDate: nil, count: 10, daysOfWeek: [2, 4, 6] // Mon, Wed, Fri
        )
        let rule = try service.buildRecurrenceRule(input)
        XCTAssertEqual(rule.frequency, .weekly)
        XCTAssertEqual(rule.interval, 2)
        XCTAssertEqual(rule.daysOfTheWeek?.count, 3)
        XCTAssertEqual(rule.recurrenceEnd?.occurrenceCount, 10)
    }

    func testMonthlyRecurrence() throws {
        let input = RecurrenceInput(
            frequency: "monthly", interval: 1,
            endDate: "2025-12-31T00:00:00Z", count: nil, daysOfWeek: nil
        )
        let rule = try service.buildRecurrenceRule(input)
        XCTAssertEqual(rule.frequency, .monthly)
        XCTAssertNotNil(rule.recurrenceEnd)
    }

    func testYearlyRecurrence() throws {
        let input = RecurrenceInput(
            frequency: "yearly", interval: 1,
            endDate: nil, count: 5, daysOfWeek: nil
        )
        let rule = try service.buildRecurrenceRule(input)
        XCTAssertEqual(rule.frequency, .yearly)
        XCTAssertEqual(rule.recurrenceEnd?.occurrenceCount, 5)
    }

    func testInvalidFrequencyThrows() {
        let input = RecurrenceInput(
            frequency: "biweekly", interval: 1,
            endDate: nil, count: nil, daysOfWeek: nil
        )
        XCTAssertThrowsError(try service.buildRecurrenceRule(input)) { error in
            XCTAssertTrue(error is TaxiKitError)
        }
    }

    func testInvalidDaysOfWeekFiltered() throws {
        let input = RecurrenceInput(
            frequency: "weekly", interval: 1,
            endDate: nil, count: nil, daysOfWeek: [0, 1, 8, 3] // 0 and 8 are invalid
        )
        let rule = try service.buildRecurrenceRule(input)
        XCTAssertEqual(rule.daysOfTheWeek?.count, 2)
    }
}
