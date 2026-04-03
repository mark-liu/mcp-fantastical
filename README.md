# MCP Fantastical Server (Enhanced Fork)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![MCP](https://img.shields.io/badge/MCP-Compatible-blue)](https://modelcontextprotocol.io)

MCP server for [Fantastical](https://flexibits.com/fantastical) and Apple Calendar on macOS. Full CRUD for events and calendars.

**Fork of [aplaceforallmystuff/mcp-fantastical](https://github.com/aplaceforallmystuff/mcp-fantastical)** with additional features:

- **Calendar CRUD** — create calendars, delete events, update events
- **Encoding fix** — event creation uses Fantastical AppleScript `parse sentence` instead of URL scheme (fixes `+` encoding bug where spaces appeared as `+` in event titles)
- **Calendar filter** — filter `get_today` and `get_upcoming` by calendar name
- **Notes/description** — read event notes in all query results
- **Enhanced calendar list** — returns calendar IDs and writable status

## Features

| Tool | Description | Type |
|------|-------------|------|
| `fantastical_create_event` | Create event via Fantastical natural language | write |
| `fantastical_get_today` | Today's events (optional calendar filter) | read |
| `fantastical_get_upcoming` | Upcoming events for N days (optional calendar filter) | read |
| `fantastical_show_date` | Navigate Fantastical to a date | navigation |
| `fantastical_get_calendars` | List calendars with IDs and writable status | read |
| `fantastical_search` | Search events in Fantastical | navigation |
| `fantastical_create_calendar` | Create a new calendar in Apple Calendar | **write (new)** |
| `fantastical_delete_event` | Delete events by title match | **destructive (new)** |
| `fantastical_update_event` | Update event title or notes | **write (new)** |

## Prerequisites

- macOS
- Node.js 18+
- [Fantastical](https://flexibits.com/fantastical) installed (for event creation)
- Calendar.app (for reads, deletes, updates — ships with macOS)

## Installation

### From Source (Recommended for Fork)

```bash
git clone https://github.com/mark-liu/mcp-fantastical.git
cd mcp-fantastical
npm install
npm run build
```

### Configuration

Add to `~/.claude.json` (Claude Code) or Claude Desktop config:

```json
{
  "mcpServers": {
    "fantastical": {
      "command": "node",
      "args": ["/path/to/mcp-fantastical/dist/index.js"]
    }
  }
}
```

## Usage Examples

### Creating Events

```
fantastical_create_event(sentence="Meeting with team tomorrow at 2pm", calendar="Work")
```

The `calendar` parameter appends `/CalendarName` to the Fantastical parse sentence, routing the event to the correct calendar.

### Creating Calendars

```
fantastical_create_calendar(name="Projects")
```

Creates a new calendar in Apple Calendar. If the calendar already exists, returns its ID without creating a duplicate.

### Deleting Events

```
fantastical_delete_event(title_contains="[CHECK] Review", calendar="Claude", date="2026-04-10")
```

Deletes events matching the title pattern. Optional calendar and date filters narrow the scope.

### Updating Events

```
fantastical_update_event(title_contains="Weekly standup", calendar="Work", new_notes="Updated agenda")
```

### Filtering by Calendar

```
fantastical_get_today(calendar="Claude")
fantastical_get_upcoming(days=7, calendar="Work")
```

## Differences from Upstream

| Feature | Upstream (1.1.0) | This Fork (1.2.0) |
|---------|-----------------|-------------------|
| Event creation | URL scheme (`x-fantastical3://parse`) | AppleScript `parse sentence` (no encoding bugs) |
| Calendar filter | No | Yes (`calendar` param on reads) |
| Event notes | Not returned | Returned in all queries |
| Calendar list | Name only | Name + ID + writable status |
| Create calendar | No | Yes |
| Delete events | No | Yes (by title match) |
| Update events | No | Yes (title, notes) |
| Multi-line AppleScript | Inline shell escaping | Temp file execution (safer) |

## Development

```bash
npm run build    # Compile TypeScript
npm run watch    # Watch mode
node dist/index.js  # Run locally
```

## Troubleshooting

### "AppleScript error: Not authorized to send Apple events"
Grant accessibility permissions: System Preferences > Privacy & Security > Accessibility > add Terminal.

### Events created with `+` in title
You're running the upstream version. This fork fixes the encoding by using Fantastical's `parse sentence` AppleScript instead of the URL scheme.

### Calendar filter returns empty
Ensure the calendar name matches exactly (case-sensitive). Use `fantastical_get_calendars` to list available names.

## License

MIT — see [LICENSE](LICENSE) for details.

## Upstream

- [aplaceforallmystuff/mcp-fantastical](https://github.com/aplaceforallmystuff/mcp-fantastical) — original project
- [Fantastical](https://flexibits.com/fantastical) — calendar app
- [Model Context Protocol](https://modelcontextprotocol.io) — MCP specification
