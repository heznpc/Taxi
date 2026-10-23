// TaxiKit - AppEntity scaffold for typed App Intents parameters.
//
// These entities intentionally avoid schema-annotated AppEntity macros for now. Full
// Xcode toolchains can expand the non-deprecated App* schema macros, but Apple's
// public AppIntents SDK exposes them only for official AssistantSchemas constants.
// The Calendar / Reminders / Contacts workflow domains Taxi needs first do not
// have matching public schema constants in the local SDK, and the generated default
// artifact still needs to compile under Command Line Tools.

#if canImport(AppIntents)
import AppIntents
import Foundation

public protocol TaxiStringBackedEntity: AppEntity, Codable, Hashable, Sendable where ID == String {
    var id: String { get }
    var title: String { get }
    var subtitle: String? { get }
    var isSynthetic: Bool { get }

    init(id: String, title: String, subtitle: String?)
    init(id: String, title: String, subtitle: String?, isSynthetic: Bool)
}

public extension TaxiStringBackedEntity {
    var displayRepresentation: DisplayRepresentation {
        if let subtitle, !subtitle.isEmpty {
            return DisplayRepresentation(title: "\(title)", subtitle: "\(subtitle)")
        }
        return DisplayRepresentation(title: "\(title)")
    }
}

public struct TaxiStringEntityQuery<Entity: TaxiStringBackedEntity>: EntityStringQuery {
    public static var syntheticSubtitle: String { "Unresolved Taxi ID" }

    public init() {}

    public func entities(for identifiers: [Entity.ID]) async throws -> [Entity] {
        identifiers.map { Self.syntheticEntity(id: $0) }
    }

    public func entities(matching string: String) async throws -> [Entity] {
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }
        return [Self.syntheticEntity(id: trimmed)]
    }

    public func suggestedEntities() async throws -> [Entity] {
        []
    }

    public static func syntheticEntity(id: String) -> Entity {
        let trimmed = id.trimmingCharacters(in: .whitespacesAndNewlines)
        let stableId = trimmed.isEmpty ? "unknown" : trimmed
        return Entity(id: stableId, title: stableId, subtitle: syntheticSubtitle, isSynthetic: true)
    }
}

public enum TaxiAppEntityResolutionError: LocalizedError, Sendable {
    case unresolvedEntity(type: String, id: String, tool: String)

    public var errorDescription: String? {
        switch self {
        case .unresolvedEntity(let type, let id, let tool):
            return "\(tool) requires a resolved \(type), but \(id) was not found."
        }
    }
}

public func requireResolvedTaxiEntityId<Entity: TaxiStringBackedEntity>(
    _ entity: Entity,
    tool: String
) throws -> String {
    guard !entity.isSynthetic else {
        throw TaxiAppEntityResolutionError.unresolvedEntity(
            type: String(describing: Entity.self),
            id: entity.id,
            tool: tool
        )
    }
    return entity.id
}

public struct TaxiCalendarEventEntity: TaxiStringBackedEntity {
    public static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Calendar Event")
    public static let defaultQuery = TaxiCalendarEventQuery()

    public let id: String
    public let title: String
    public let subtitle: String?
    public let isSynthetic: Bool

    public init(id: String, title: String, subtitle: String? = nil) {
        self.init(id: id, title: title, subtitle: subtitle, isSynthetic: false)
    }

    public init(id: String, title: String, subtitle: String? = nil, isSynthetic: Bool) {
        self.id = id
        self.title = title
        self.subtitle = subtitle
        self.isSynthetic = isSynthetic
    }
}

public struct TaxiReminderEntity: TaxiStringBackedEntity {
    public static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Reminder")
    public static let defaultQuery = TaxiReminderQuery()

    public let id: String
    public let title: String
    public let subtitle: String?
    public let isSynthetic: Bool

    public init(id: String, title: String, subtitle: String? = nil) {
        self.init(id: id, title: title, subtitle: subtitle, isSynthetic: false)
    }

    public init(id: String, title: String, subtitle: String? = nil, isSynthetic: Bool) {
        self.id = id
        self.title = title
        self.subtitle = subtitle
        self.isSynthetic = isSynthetic
    }
}

public struct TaxiContactEntity: TaxiStringBackedEntity {
    public static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Contact")
    public static let defaultQuery = TaxiContactQuery()

    public let id: String
    public let title: String
    public let subtitle: String?
    public let isSynthetic: Bool

    public init(id: String, title: String, subtitle: String? = nil) {
        self.init(id: id, title: title, subtitle: subtitle, isSynthetic: false)
    }

    public init(id: String, title: String, subtitle: String? = nil, isSynthetic: Bool) {
        self.id = id
        self.title = title
        self.subtitle = subtitle
        self.isSynthetic = isSynthetic
    }
}

public struct TaxiCalendarEventQuery: EntityStringQuery {
    public init() {}

    public func entities(for identifiers: [TaxiCalendarEventEntity.ID]) async throws -> [TaxiCalendarEventEntity] {
        let service = EventKitService()
        var entities: [TaxiCalendarEventEntity] = []
        for id in identifiers {
            if let detail = try? await service.readEvent(ReadEventInput(id: id)) {
                entities.append(TaxiCalendarEventEntity(
                    id: detail.id,
                    title: titleOrId(detail.summary, id: id),
                    subtitle: joinedSubtitle([detail.startDate, detail.calendar])
                ))
            } else {
                entities.append(TaxiStringEntityQuery<TaxiCalendarEventEntity>.syntheticEntity(id: id))
            }
        }
        return entities
    }

    public func entities(matching string: String) async throws -> [TaxiCalendarEventEntity] {
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return try await suggestedEntities() }

        let now = Date()
        let start = Calendar.current.date(byAdding: .day, value: -30, to: now) ?? now
        let end = Calendar.current.date(byAdding: .month, value: 6, to: now) ?? now
        if let output = try? await EventKitService().searchEvents(SearchEventsInput(
            query: trimmed,
            startDate: formatISO8601(start),
            endDate: formatISO8601(end),
            limit: 10
        )), !output.events.isEmpty {
            return output.events.map(eventEntity)
        }
        return [TaxiStringEntityQuery<TaxiCalendarEventEntity>.syntheticEntity(id: trimmed)]
    }

    public func suggestedEntities() async throws -> [TaxiCalendarEventEntity] {
        guard let output = try? await EventKitService().getUpcomingEvents(UpcomingEventsInput(limit: 10)) else {
            return []
        }
        return output.events.map { event in
            TaxiCalendarEventEntity(
                id: event.id,
                title: titleOrId(event.summary, id: event.id),
                subtitle: joinedSubtitle([event.startDate, event.calendar])
            )
        }
    }
}

public struct TaxiReminderQuery: EntityStringQuery {
    public init() {}

    public func entities(for identifiers: [TaxiReminderEntity.ID]) async throws -> [TaxiReminderEntity] {
        let service = EventKitService()
        var entities: [TaxiReminderEntity] = []
        for id in identifiers {
            if let detail = try? await service.readReminder(ReadReminderInput(id: id)) {
                entities.append(TaxiReminderEntity(
                    id: detail.id,
                    title: titleOrId(detail.name, id: id),
                    subtitle: joinedSubtitle([detail.dueDate, detail.list])
                ))
            } else {
                entities.append(TaxiStringEntityQuery<TaxiReminderEntity>.syntheticEntity(id: id))
            }
        }
        return entities
    }

    public func entities(matching string: String) async throws -> [TaxiReminderEntity] {
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return try await suggestedEntities() }

        if let output = try? await EventKitService().searchReminders(SearchRemindersInput(
            query: trimmed,
            limit: 10
        )), !output.reminders.isEmpty {
            return output.reminders.map(reminderEntity)
        }
        return [TaxiStringEntityQuery<TaxiReminderEntity>.syntheticEntity(id: trimmed)]
    }

    public func suggestedEntities() async throws -> [TaxiReminderEntity] {
        guard let output = try? await EventKitService().listReminders(ListRemindersInput(
            list: nil,
            completed: false,
            limit: 10,
            offset: 0
        )) else {
            return []
        }
        return output.reminders.map(reminderEntity)
    }
}

public struct TaxiContactQuery: EntityStringQuery {
    public init() {}

    public func entities(for identifiers: [TaxiContactEntity.ID]) async throws -> [TaxiContactEntity] {
        let service = ContactsService()
        var entities: [TaxiContactEntity] = []
        for id in identifiers {
            if let detail = try? await service.readContact(ReadContactInput(id: id)) {
                entities.append(TaxiContactEntity(
                    id: detail.id,
                    title: titleOrId(detail.name, id: id),
                    subtitle: joinedSubtitle([detail.organization, detail.emails.first?.value])
                ))
            } else {
                entities.append(TaxiStringEntityQuery<TaxiContactEntity>.syntheticEntity(id: id))
            }
        }
        return entities
    }

    public func entities(matching string: String) async throws -> [TaxiContactEntity] {
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return try await suggestedEntities() }

        if let output = try? await ContactsService().searchContacts(SearchContactsInput(
            query: trimmed,
            limit: 10
        )), !output.contacts.isEmpty {
            return output.contacts.map(contactEntity)
        }
        return [TaxiStringEntityQuery<TaxiContactEntity>.syntheticEntity(id: trimmed)]
    }

    public func suggestedEntities() async throws -> [TaxiContactEntity] {
        guard let output = try? await ContactsService().listContacts(ListContactsInput(
            limit: 10,
            offset: 0
        )) else {
            return []
        }
        return output.contacts.map { contact in
            TaxiContactEntity(
                id: contact.id,
                title: titleOrId(contact.name, id: contact.id),
                subtitle: joinedSubtitle([contact.email, contact.phone])
            )
        }
    }
}

private func eventEntity(_ event: EventListItem) -> TaxiCalendarEventEntity {
    TaxiCalendarEventEntity(
        id: event.id,
        title: titleOrId(event.summary, id: event.id),
        subtitle: joinedSubtitle([event.startDate, event.calendar])
    )
}

private func reminderEntity(_ reminder: ReminderListItem) -> TaxiReminderEntity {
    TaxiReminderEntity(
        id: reminder.id,
        title: titleOrId(reminder.name, id: reminder.id),
        subtitle: joinedSubtitle([reminder.dueDate, reminder.list])
    )
}

private func contactEntity(_ contact: ContactSearchItem) -> TaxiContactEntity {
    TaxiContactEntity(
        id: contact.id,
        title: titleOrId(contact.name, id: contact.id),
        subtitle: joinedSubtitle([contact.organization, contact.email, contact.phone])
    )
}

private func titleOrId(_ title: String, id: String) -> String {
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? id : trimmed
}

private func joinedSubtitle(_ parts: [String?]) -> String? {
    let nonEmpty = parts.compactMap { value -> String? in
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
    return nonEmpty.isEmpty ? nil : nonEmpty.joined(separator: " - ")
}
#endif
