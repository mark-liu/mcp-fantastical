import EventKit
import Foundation

let store = EKEventStore()

// Request calendar access synchronously
func requestAccess() -> Bool {
    let semaphore = DispatchSemaphore(value: 0)
    var granted = false
    store.requestFullAccessToEvents { g, error in
        granted = g
        if let error = error {
            fputs("Error requesting access: \(error.localizedDescription)\n", stderr)
        }
        semaphore.signal()
    }
    semaphore.wait()
    return granted
}

// Find calendars by name
func findCalendars(named name: String) -> [EKCalendar] {
    return store.calendars(for: .event).filter { $0.title == name }
}

// Find iCloud source
func findICloudSource() -> EKSource? {
    // Prefer iCloud
    if let icloud = store.sources.first(where: { $0.sourceType == .calDAV && $0.title.lowercased().contains("icloud") }) {
        return icloud
    }
    // Fallback to any CalDAV
    if let caldav = store.sources.first(where: { $0.sourceType == .calDAV }) {
        return caldav
    }
    // Fallback to local
    return store.sources.first(where: { $0.sourceType == .local })
}

// JSON output helpers
func jsonSuccess(_ dict: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: dict, options: .prettyPrinted),
       let str = String(data: data, encoding: .utf8) {
        print(str)
    }
}

func jsonError(_ msg: String) {
    jsonSuccess(["success": false, "error": msg])
    exit(1)
}

// MARK: - Commands

func cmdCreateCalendar(name: String) {
    let existing = findCalendars(named: name)
    if !existing.isEmpty {
        jsonSuccess(["success": true, "message": "Calendar '\(name)' already exists", "created": false, "count": existing.count])
        return
    }

    guard let source = findICloudSource() else {
        jsonError("No suitable calendar source found")
        return
    }

    let calendar = EKCalendar(for: .event, eventStore: store)
    calendar.title = name
    calendar.source = source
    calendar.cgColor = CGColor(red: 0.5, green: 0.2, blue: 0.9, alpha: 1.0)

    do {
        try store.saveCalendar(calendar, commit: true)
        jsonSuccess(["success": true, "message": "Calendar '\(name)' created on \(source.title)", "created": true, "calendarId": calendar.calendarIdentifier])
    } catch {
        jsonError("Failed to create calendar: \(error.localizedDescription)")
    }
}

func cmdDeleteCalendar(name: String, keepWithEvents: Bool) {
    let calendars = findCalendars(named: name)
    if calendars.isEmpty {
        jsonSuccess(["success": true, "message": "No calendar named '\(name)' found", "deleted": 0])
        return
    }

    var deleted = 0
    for cal in calendars {
        if keepWithEvents {
            // Count events in next year
            let start = Date()
            let end = Calendar.current.date(byAdding: .year, value: 1, to: start)!
            let predicate = store.predicateForEvents(withStart: start.addingTimeInterval(-365*24*3600), end: end, calendars: [cal])
            let events = store.events(matching: predicate)
            if !events.isEmpty {
                continue // skip calendars with events
            }
        }
        do {
            try store.removeCalendar(cal, commit: true)
            deleted += 1
        } catch {
            fputs("Warning: failed to delete calendar: \(error.localizedDescription)\n", stderr)
        }
    }
    jsonSuccess(["success": true, "deleted": deleted, "total_found": calendars.count])
}

func cmdDeleteEvent(calendarName: String?, titleContains: String, dateStr: String?) {
    var calendars: [EKCalendar]
    if let name = calendarName {
        calendars = findCalendars(named: name)
        if calendars.isEmpty {
            jsonError("No calendar named '\(name)' found")
            return
        }
    } else {
        calendars = store.calendars(for: .event)
    }

    // Date range: if date specified, use that day; otherwise search ±1 year
    let dateFormatter = DateFormatter()
    dateFormatter.dateFormat = "yyyy-MM-dd"

    var startDate: Date
    var endDate: Date

    if let ds = dateStr, let parsed = dateFormatter.date(from: ds) {
        startDate = Calendar.current.startOfDay(for: parsed)
        endDate = Calendar.current.date(byAdding: .day, value: 1, to: startDate)!
    } else {
        startDate = Date().addingTimeInterval(-365 * 24 * 3600)
        endDate = Date().addingTimeInterval(365 * 24 * 3600)
    }

    let predicate = store.predicateForEvents(withStart: startDate, end: endDate, calendars: calendars)
    let events = store.events(matching: predicate)

    var deleted = 0
    for event in events {
        if event.title.contains(titleContains) {
            do {
                try store.remove(event, span: .thisEvent, commit: false)
                deleted += 1
            } catch {
                fputs("Warning: failed to delete event '\(event.title ?? "")': \(error.localizedDescription)\n", stderr)
            }
        }
    }

    if deleted > 0 {
        do {
            try store.commit()
        } catch {
            jsonError("Failed to commit deletions: \(error.localizedDescription)")
            return
        }
    }

    jsonSuccess(["success": true, "deleted_count": deleted, "title_filter": titleContains, "calendar_filter": calendarName ?? "all", "date_filter": dateStr ?? "any"])
}

func cmdUpdateEvent(calendarName: String?, titleContains: String, newTitle: String?, newNotes: String?) {
    var calendars: [EKCalendar]
    if let name = calendarName {
        calendars = findCalendars(named: name)
        if calendars.isEmpty {
            jsonError("No calendar named '\(name)' found")
            return
        }
    } else {
        calendars = store.calendars(for: .event)
    }

    // Search ±1 year
    let startDate = Date().addingTimeInterval(-365 * 24 * 3600)
    let endDate = Date().addingTimeInterval(365 * 24 * 3600)
    let predicate = store.predicateForEvents(withStart: startDate, end: endDate, calendars: calendars)
    let events = store.events(matching: predicate)

    for event in events {
        if event.title.contains(titleContains) {
            if let t = newTitle { event.title = t }
            if let n = newNotes { event.notes = n }

            do {
                try store.save(event, span: .thisEvent, commit: true)
                jsonSuccess(["success": true, "updated_title": event.title ?? "", "calendar": event.calendar.title])
                return
            } catch {
                jsonError("Failed to save event: \(error.localizedDescription)")
                return
            }
        }
    }

    jsonSuccess(["success": false, "message": "No event found matching '\(titleContains)'"])
}

func cmdListEvents(calendarName: String, days: Int) {
    let calendars = findCalendars(named: calendarName)
    if calendars.isEmpty {
        jsonError("No calendar named '\(calendarName)' found")
        return
    }

    let startDate = Calendar.current.startOfDay(for: Date())
    let endDate = Calendar.current.date(byAdding: .day, value: days, to: startDate)!
    let predicate = store.predicateForEvents(withStart: startDate, end: endDate, calendars: calendars)
    let events = store.events(matching: predicate).sorted { $0.startDate < $1.startDate }

    let dateFormatter = DateFormatter()
    dateFormatter.dateFormat = "yyyy-MM-dd HH:mm"

    var eventList: [[String: Any]] = []
    for event in events {
        eventList.append([
            "title": event.title ?? "",
            "start": dateFormatter.string(from: event.startDate),
            "end": dateFormatter.string(from: event.endDate),
            "notes": event.notes ?? "",
            "calendar": event.calendar.title,
        ])
    }

    jsonSuccess(["success": true, "count": eventList.count, "events": eventList])
}

// MARK: - Main

guard requestAccess() else {
    jsonError("Calendar access denied")
    exit(1)
}

let args = CommandLine.arguments
guard args.count >= 2 else {
    fputs("Usage: fantastical-helper <command> [args...]\n", stderr)
    fputs("Commands:\n", stderr)
    fputs("  create-calendar <name>\n", stderr)
    fputs("  delete-calendar <name> [--keep-with-events]\n", stderr)
    fputs("  delete-event --title-contains <text> [--calendar <name>] [--date YYYY-MM-DD]\n", stderr)
    fputs("  update-event --title-contains <text> [--calendar <name>] [--new-title <text>] [--new-notes <text>]\n", stderr)
    fputs("  list-events --calendar <name> [--days N]\n", stderr)
    exit(1)
}

let command = args[1]

switch command {
case "create-calendar":
    guard args.count >= 3 else { jsonError("Missing calendar name"); exit(1) }
    cmdCreateCalendar(name: args[2])

case "delete-calendar":
    guard args.count >= 3 else { jsonError("Missing calendar name"); exit(1) }
    let keepWithEvents = args.contains("--keep-with-events")
    cmdDeleteCalendar(name: args[2], keepWithEvents: keepWithEvents)

case "delete-event":
    var titleContains: String?
    var calendarName: String?
    var dateStr: String?
    var i = 2
    while i < args.count {
        switch args[i] {
        case "--title-contains": i += 1; if i < args.count { titleContains = args[i] }
        case "--calendar": i += 1; if i < args.count { calendarName = args[i] }
        case "--date": i += 1; if i < args.count { dateStr = args[i] }
        default: break
        }
        i += 1
    }
    guard let title = titleContains else { jsonError("Missing --title-contains"); exit(1) }
    cmdDeleteEvent(calendarName: calendarName, titleContains: title, dateStr: dateStr)

case "update-event":
    var titleContains: String?
    var calendarName: String?
    var newTitle: String?
    var newNotes: String?
    var i = 2
    while i < args.count {
        switch args[i] {
        case "--title-contains": i += 1; if i < args.count { titleContains = args[i] }
        case "--calendar": i += 1; if i < args.count { calendarName = args[i] }
        case "--new-title": i += 1; if i < args.count { newTitle = args[i] }
        case "--new-notes": i += 1; if i < args.count { newNotes = args[i] }
        default: break
        }
        i += 1
    }
    guard let title = titleContains else { jsonError("Missing --title-contains"); exit(1) }
    cmdUpdateEvent(calendarName: calendarName, titleContains: title, newTitle: newTitle, newNotes: newNotes)

case "list-events":
    var calendarName: String?
    var days = 1
    var i = 2
    while i < args.count {
        switch args[i] {
        case "--calendar": i += 1; if i < args.count { calendarName = args[i] }
        case "--days": i += 1; if i < args.count { days = Int(args[i]) ?? 1 }
        default: break
        }
        i += 1
    }
    guard let name = calendarName else { jsonError("Missing --calendar"); exit(1) }
    cmdListEvents(calendarName: name, days: days)

default:
    jsonError("Unknown command: \(command)")
}
