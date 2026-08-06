import ical from "node-ical";
import type { CalendarResponse, FetchOptions, VEvent } from "node-ical";
import { FatalProviderError, Provider } from "../core/provider.ts";
import { config } from "../core/config.ts";
import { localDateKey } from "../core/time.ts";

const WINDOW_DAYS = 14;

// `fromURL`'s overloads resolve to the callback form (returning void) as soon
// as a second argument is passed, even though it also accepts just options.
// A narrow cast to the promise-returning shape keeps the call site honest.
const fromURL = ical.async.fromURL as (url: string, options: FetchOptions) => Promise<CalendarResponse>;

export interface CalendarEvent {
  id: string;
  title: string;
  /** ISO instant. */
  start: string;
  /** ISO instant. */
  end: string;
  allDay: boolean;
  location: string | null;
  /** Local day the event starts on, so the UI can group without re-deriving it. */
  dateKey: string;
}

export interface CalendarData {
  /** Chronological, spanning the next 14 days, recurrences already expanded. */
  events: CalendarEvent[];
}

/** iCal text fields are either a plain string or `{ val, params }` when they carry parameters. */
function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "val" in value) {
    const val = (value as { val: unknown }).val;
    return typeof val === "string" ? val : "";
  }
  return "";
}

// Full-day instances come back as a `Date` built from local getters
// (see node-ical's expandRecurringEvent), i.e. it already *is* the intended
// calendar day — reading it back through the Helsinki Intl formatter would
// misfire if this process ever ran in a different system timezone. Timed
// instances are real instants, so those go through the normal formatter.
function dateKeyFor(date: Date, allDay: boolean): string {
  if (allDay) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return localDateKey(date);
}

async function fetchCalendar(): Promise<CalendarData> {
  if (!config.calendarIcsUrl) {
    // Not a network hiccup — retrying on a schedule would just hammer nothing.
    // FatalProviderError trips the circuit breaker instead.
    throw new FatalProviderError("NotConfigured", "Kalenterin ICS-osoitetta ei ole asetettu");
  }

  const parsed = await fromURL(config.calendarIcsUrl, {
    signal: AbortSignal.timeout(15_000),
  });

  const from = new Date();
  const to = new Date(from.getTime() + WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const events: CalendarEvent[] = [];

  for (const item of Object.values(parsed)) {
    if (!item || typeof item !== "object" || item.type !== "VEVENT") continue;
    const event = item as VEvent;

    // Handles both plain events and RRULE recurrence in one call, already
    // honouring EXDATE exclusions and RECURRENCE-ID overrides.
    const instances = ical.expandRecurringEvent(event, { from, to });

    for (const instance of instances) {
      const title = textValue(instance.summary) || textValue(event.summary) || "(nimetön)";
      const location = textValue(instance.event.location ?? event.location) || null;

      events.push({
        id: `${event.uid}:${instance.start.toISOString()}`,
        title,
        start: instance.start.toISOString(),
        end: instance.end.toISOString(),
        allDay: instance.isFullDay,
        location,
        dateKey: dateKeyFor(instance.start, instance.isFullDay),
      });
    }
  }

  events.sort((a, b) => a.start.localeCompare(b.start));

  return { events };
}

export function createCalendarProvider(): Provider<CalendarData> {
  return new Provider<CalendarData>({
    id: "calendar",
    intervalMs: 15 * 60 * 1000,
    initialDelayMs: 10_000,
    fetch: fetchCalendar,
  });
}
