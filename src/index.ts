#!/usr/bin/env node
/**
 * MCP Server for Fantastical Calendar
 *
 * Provides calendar management through Fantastical's AppleScript interface
 * and Apple Calendar.app for CRUD operations.
 *
 * Fork: mark-liu/mcp-fantastical
 * Upstream: aplaceforallmystuff/mcp-fantastical
 * Fork fixes: calendar CRUD, encoding fix (parse sentence), calendar filter, notes field
 *
 * Requirements:
 * - macOS only
 * - Fantastical installed (for event creation via natural language)
 * - Calendar.app (for reads, deletes, updates — ships with macOS)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { exec } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const NATIVE_HELPER_PATH = join(__dirname, "native", "fantastical-helper");

// Run the Swift EventKit native helper binary
async function runNativeHelper(args: string[]): Promise<string> {
  const escapedArgs = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  const cmd = `${NATIVE_HELPER_PATH} ${escapedArgs}`;
  const { stdout, stderr } = await execAsync(cmd, { timeout: 15000 });
  if (stderr) {
    console.error(`Native helper stderr: ${stderr.trim()}`);
  }
  return stdout.trim();
}

// Helper to run single-line AppleScript
async function runAppleScript(script: string): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`);
    if (stderr && !stdout) {
      throw new Error(stderr);
    }
    return stdout.trim();
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`AppleScript error: ${error.message}`);
    }
    throw error;
  }
}

// Helper to run multi-line AppleScript via temp file (avoids shell escaping issues)
async function runAppleScriptFile(script: string): Promise<string> {
  try {
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const tmpFile = path.join(os.tmpdir(), `mcp-fantastical-${Date.now()}.scpt`);
    fs.writeFileSync(tmpFile, script);
    try {
      const { stdout, stderr } = await execAsync(`osascript "${tmpFile}"`, { timeout: 15000 });
      if (stderr && !stdout) {
        throw new Error(stderr);
      }
      return stdout.trim();
    } finally {
      fs.unlinkSync(tmpFile);
    }
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`AppleScript error: ${error.message}`);
    }
    throw error;
  }
}

// Tool definitions
const TOOLS: Tool[] = [
  {
    name: "fantastical_create_event",
    description: "Create a calendar event using Fantastical's natural language parsing. Examples: 'Meeting with John tomorrow at 3pm', 'Dentist appointment Friday 10am', 'Call with team every Monday at 9am'. Use /CalendarName at the end of the sentence to target a specific calendar.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sentence: {
          type: "string",
          description: "Natural language description of the event (e.g., 'Lunch with Sarah tomorrow at noon')",
        },
        calendar: {
          type: "string",
          description: "Optional: Target calendar name (e.g., 'Work', 'Personal', 'Claude'). Appended as /CalendarName to the sentence.",
        },
        notes: {
          type: "string",
          description: "Optional: Additional notes for the event",
        },
        addImmediately: {
          type: "boolean",
          description: "Add immediately without showing Fantastical UI (default: true)",
        },
      },
      required: ["sentence"],
    },
  },
  {
    name: "fantastical_get_today",
    description: "Get today's calendar events. Optionally filter by calendar name. Returns event titles, times, locations, and notes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        calendar: {
          type: "string",
          description: "Optional: Filter events to a specific calendar (e.g., 'Claude', 'Work')",
        },
      },
      required: [],
    },
  },
  {
    name: "fantastical_get_upcoming",
    description: "Get upcoming calendar events. Optionally filter by calendar name. Returns event titles, times, locations, and notes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        days: {
          type: "number",
          description: "Number of days to look ahead (default: 7)",
        },
        calendar: {
          type: "string",
          description: "Optional: Filter events to a specific calendar (e.g., 'Claude', 'Work')",
        },
      },
      required: [],
    },
  },
  {
    name: "fantastical_show_date",
    description: "Open Fantastical and navigate to a specific date",
    inputSchema: {
      type: "object" as const,
      properties: {
        date: {
          type: "string",
          description: "Date to show (e.g., '2025-01-15', 'tomorrow', 'next monday')",
        },
      },
      required: ["date"],
    },
  },
  {
    name: "fantastical_get_calendars",
    description: "List all available calendars with their IDs and writable status",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "fantastical_search",
    description: "Search for events by text in Fantastical. Opens Fantastical's search UI.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (event title, location, or notes)",
        },
      },
      required: ["query"],
    },
  },
  // --- New tools (fork additions) ---
  {
    name: "fantastical_create_calendar",
    description: "Create a new calendar in Apple Calendar. Creates on iCloud if available, otherwise locally.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Name for the new calendar (e.g., 'Claude', 'Projects')",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "fantastical_delete_event",
    description: "Delete calendar events matching a title pattern. Optionally filter by calendar and date.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title_contains: {
          type: "string",
          description: "Text that the event title must contain (case-sensitive match)",
        },
        calendar: {
          type: "string",
          description: "Optional: Only delete from this calendar",
        },
        date: {
          type: "string",
          description: "Optional: Only delete events on this date (YYYY-MM-DD format)",
        },
      },
      required: ["title_contains"],
    },
  },
  {
    name: "fantastical_update_event",
    description: "Update properties of a calendar event matched by title. Optionally filter by calendar.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title_contains: {
          type: "string",
          description: "Text that the event title must contain (matches first found)",
        },
        calendar: {
          type: "string",
          description: "Optional: Only match events in this calendar",
        },
        new_title: {
          type: "string",
          description: "Optional: New title for the event",
        },
        new_notes: {
          type: "string",
          description: "Optional: New notes/description for the event",
        },
      },
      required: ["title_contains"],
    },
  },
];

// Create server instance
const server = new Server(
  {
    name: "mcp-fantastical",
    version: "1.2.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Build AppleScript for reading events with optional calendar filter and notes
function buildEventQueryScript(calFilter: string | undefined, dateRangeSetup: string): string {
  const calBlock = calFilter
    ? `tell calendar "${calFilter.replace(/"/g, '\\"')}"\n`
    : `repeat with cal in calendars\n    set calName to name of cal\n    tell cal\n`;
  const calBlockEnd = calFilter
    ? `end tell`
    : `end tell\n  end repeat`;
  const calNameExpr = calFilter
    ? `"${calFilter.replace(/"/g, '\\"')}"`
    : `calName`;

  return `set output to ""
${dateRangeSetup}
tell application "Calendar"
  ${calBlock}    try
      set calEvents to (every event whose start date >= rangeStart and start date < rangeEnd)
      repeat with evt in calEvents
        set evtTitle to summary of evt
        set evtStart to start date of evt
        set evtEnd to end date of evt
        set evtLoc to ""
        try
          set evtLoc to location of evt
        end try
        set evtNotes to ""
        try
          set evtNotes to description of evt
        on error
          set evtNotes to ""
        end try
        set output to output & ${calNameExpr} & "|" & evtTitle & "|" & (evtStart as string) & "|" & (evtEnd as string) & "|" & evtLoc & "|" & evtNotes & return
      end repeat
    end try
  ${calBlockEnd}
end tell
return output`;
}

// Parse pipe-delimited event output into structured objects
function parseEventOutput(result: string) {
  return result
    .split("\n")
    .filter(line => line.trim())
    .map(line => {
      const parts = line.split("|");
      return {
        calendar: parts[0] || "",
        title: parts[1] || "",
        start: parts[2] || "",
        end: parts[3] || "",
        location: parts[4] || "",
        notes: parts[5] || "",
      };
    })
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
}

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "fantastical_create_event": {
        const { sentence, calendar, notes, addImmediately = true } = args as {
          sentence: string;
          calendar?: string;
          notes?: string;
          addImmediately?: boolean;
        };

        // Use Fantastical AppleScript 'parse sentence' instead of URL scheme
        // to avoid URLSearchParams encoding spaces as '+' (Fantastical bug)
        const calHint = calendar ? ` /${calendar}` : "";
        const escapedSentence = (sentence + calHint).replace(/"/g, '\\"');
        const addFlag = addImmediately ? " with add immediately" : "";

        let script: string;
        if (notes) {
          const escapedNotes = notes.replace(/"/g, '\\"');
          script = `tell application "Fantastical"
  parse sentence "${escapedSentence}" notes "${escapedNotes}"${addFlag}
end tell`;
        } else {
          script = `tell application "Fantastical" to parse sentence "${escapedSentence}"${addFlag}`;
        }

        await runAppleScriptFile(script);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Event created: "${sentence}"`,
              calendar: calendar || "default",
              addedImmediately: addImmediately,
            }, null, 2),
          }],
        };
      }

      case "fantastical_get_today": {
        const { calendar: calFilter } = args as { calendar?: string };

        const dateSetup = `set rangeStart to current date
set hours of rangeStart to 0
set minutes of rangeStart to 0
set seconds of rangeStart to 0
set rangeEnd to rangeStart + (1 * days)`;

        const script = buildEventQueryScript(calFilter, dateSetup);
        const result = await runAppleScriptFile(script);
        const events = parseEventOutput(result);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              date: new Date().toISOString().split("T")[0],
              count: events.length,
              calendar_filter: calFilter || null,
              events,
            }, null, 2),
          }],
        };
      }

      case "fantastical_get_upcoming": {
        const { days = 7, calendar: calFilter } = args as { days?: number; calendar?: string };
        const today = new Date();
        const endDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() + days);

        const dateSetup = `set rangeStart to current date
set hours of rangeStart to 0
set minutes of rangeStart to 0
set seconds of rangeStart to 0
set rangeEnd to rangeStart + (${days} * days)`;

        const script = buildEventQueryScript(calFilter, dateSetup);
        const result = await runAppleScriptFile(script);
        const events = parseEventOutput(result);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              range: {
                start: today.toISOString().split("T")[0],
                end: endDate.toISOString().split("T")[0],
                days,
              },
              count: events.length,
              calendar_filter: calFilter || null,
              events,
            }, null, 2),
          }],
        };
      }

      case "fantastical_show_date": {
        const { date } = args as { date: string };
        const script = `do shell script "open 'x-fantastical3://show/calendar/${encodeURIComponent(date)}'"`;
        await runAppleScript(script);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Opened Fantastical to date: ${date}`,
            }, null, 2),
          }],
        };
      }

      case "fantastical_get_calendars": {
        const script = `set output to ""
tell application "Calendar"
  repeat with cal in calendars
    set calName to name of cal
    set calWritable to writable of cal
    set output to output & calName & "|" & calWritable & return
  end repeat
end tell
return output`;

        const result = await runAppleScriptFile(script);
        const calendars = result
          .split("\n")
          .filter(line => line.trim())
          .map(line => {
            const [calName, writable] = line.split("|");
            return { name: calName, writable: writable === "true" };
          });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              count: calendars.length,
              calendars,
            }, null, 2),
          }],
        };
      }

      case "fantastical_search": {
        const { query } = args as { query: string };
        const script = `do shell script "open 'x-fantastical3://search?query=${encodeURIComponent(query)}'"`;
        await runAppleScript(script);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Opened Fantastical search for: "${query}"`,
            }, null, 2),
          }],
        };
      }

      // --- New tools (fork additions) ---

      case "fantastical_create_calendar": {
        const { name: calName } = args as { name: string };
        const result = await runNativeHelper(["create-calendar", calName]);
        return {
          content: [{ type: "text", text: result }],
        };
      }

      case "fantastical_delete_event": {
        const { title_contains, calendar: calFilter, date } = args as {
          title_contains: string;
          calendar?: string;
          date?: string;
        };

        const helperArgs = ["delete-event", "--title-contains", title_contains];
        if (calFilter) { helperArgs.push("--calendar", calFilter); }
        if (date) { helperArgs.push("--date", date); }

        const result = await runNativeHelper(helperArgs);
        return {
          content: [{ type: "text", text: result }],
        };
      }

      case "fantastical_update_event": {
        const { title_contains, calendar: calFilter, new_title, new_notes } = args as {
          title_contains: string;
          calendar?: string;
          new_title?: string;
          new_notes?: string;
        };

        if (!new_title && new_notes === undefined) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: false,
                message: "No update properties provided (need new_title or new_notes)",
              }, null, 2),
            }],
          };
        }

        const helperArgs = ["update-event", "--title-contains", title_contains];
        if (calFilter) { helperArgs.push("--calendar", calFilter); }
        if (new_title) { helperArgs.push("--new-title", new_title); }
        if (new_notes !== undefined) { helperArgs.push("--new-notes", new_notes || ""); }

        const result = await runNativeHelper(helperArgs);
        return {
          content: [{ type: "text", text: result }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${errorMessage}` }],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  if (process.platform !== "darwin") {
    console.error("Error: This MCP server only works on macOS (Fantastical is macOS-only)");
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Fantastical MCP server running (mark-liu fork v1.2.0)");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
