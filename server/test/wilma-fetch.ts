/**
 * Covers the two things in the Wilma provider that decide how much traffic the
 * school's server sees, and the one thing that decides whether the unread badge
 * tells the truth. Neither is exercised by the generic provider tests.
 *
 * Run with:  npm run test:wilma --workspace=server
 */
import "./test-env.ts";
import assert from "node:assert/strict";
import type { Message, OverviewData, ScheduleLesson, StudentInfo } from "@wilm-ai/wilma-client";
import { fetchStudent, type WilmaClientLike, type WilmaData } from "../src/providers/wilma.ts";
import { localDateKey, shiftDateKey } from "../src/core/time.ts";

const student: StudentInfo = { studentNumber: "1234", name: "Testilapsi", href: "/!1234/" };

const today = localDateKey();
const nextWeekDay = shiftDateKey(today, 7);

function lesson(date: string, start: string, subject: string): ScheduleLesson {
  return {
    date,
    dayOfWeek: 1,
    start,
    end: "09:45",
    subject,
    subjectCode: subject.slice(0, 2).toUpperCase(),
    teacher: "Opettaja",
    teacherCode: "OP",
    groupId: 1,
  };
}

function overview(lessons: ScheduleLesson[]): OverviewData {
  return { schedule: lessons, upcomingExams: [], grades: [], homework: [], fetchedAt: new Date() };
}

/**
 * Mirrors what the real library actually returns from the inbox listing:
 * id, subject and timestamp only. Sender and status live on the detail alone,
 * which is the whole reason the provider fetches details at all.
 */
function listedMessage(id: number, subject: string): Message {
  return {
    wilmaId: id,
    subject,
    sentAt: new Date("2026-08-06T09:00:00Z"),
    folder: "inbox",
    fetchedAt: new Date(),
  };
}

function detailMessage(id: number, sender: string, status: number): Message {
  return {
    ...listedMessage(id, `Aihe ${id}`),
    senderName: sender,
    status,
    content: "<p>Terveisin<br>opettaja</p>",
  };
}

interface Counts {
  overview: number;
  scheduleByDate: number;
  messageList: number;
  messageDetail: number;
}

function fakeClient(options: {
  currentWeek: ScheduleLesson[];
  nextWeek: ScheduleLesson[];
  inbox: Message[];
  details: Map<number, Message>;
}): { client: WilmaClientLike; counts: Counts } {
  const counts: Counts = { overview: 0, scheduleByDate: 0, messageList: 0, messageDetail: 0 };

  const client: WilmaClientLike = {
    overview: {
      get: async () => {
        counts.overview += 1;
        return overview(options.currentWeek);
      },
    },
    schedule: {
      list: async () => {
        counts.scheduleByDate += 1;
        return options.nextWeek;
      },
    },
    messages: {
      list: async () => {
        counts.messageList += 1;
        return options.inbox;
      },
      get: async (id: number) => {
        counts.messageDetail += 1;
        const detail = options.details.get(id);
        assert.ok(detail, `test asked for an unknown message detail: ${id}`);
        return detail;
      },
    },
  };

  return { client, counts };
}

function asPrevious(result: Awaited<ReturnType<typeof fetchStudent>>): WilmaData {
  return {
    students: [{ studentNumber: student.studentNumber, name: student.name }],
    byStudent: { [student.studentNumber]: result.data },
    messages: result.messages,
    unreadCount: result.messages.filter((m) => m.unread === true).length,
  };
}

/**
 * On a Friday, a weekend or a holiday there is nothing after today in the
 * current week, so the provider has to look at the following one. That test is
 * true on every single cycle for as long as the break lasts, so the lookup must
 * be throttled by time — otherwise it repeats every 20 minutes all summer.
 */
async function testNextWeekIsFetchedOnceNotEveryCycle(): Promise<void> {
  const { client, counts } = fakeClient({
    currentWeek: [lesson(today, "08:15", "Matematiikka")],
    nextWeek: [lesson(nextWeekDay, "08:15", "Historia")],
    inbox: [],
    details: new Map(),
  });

  const first = await fetchStudent(client, student, null);
  assert.equal(counts.scheduleByDate, 1, "the following week must be fetched when nothing follows today");
  assert.ok(
    first.data.lessons.some((l) => l.date === nextWeekDay),
    "next week's lessons must end up in the payload",
  );
  assert.ok(first.data.nextWeekCheckedAt, "the lookup time must be recorded");

  // Four more cycles, as would happen over the next hour or so.
  for (let i = 0; i < 4; i += 1) {
    const again = await fetchStudent(client, student, asPrevious(first));
    assert.ok(
      again.data.lessons.some((l) => l.date === nextWeekDay),
      "the known future lessons must survive without re-fetching",
    );
  }

  assert.equal(
    counts.scheduleByDate,
    1,
    `five cycles must cause one next-week request, got ${counts.scheduleByDate}`,
  );
  assert.equal(counts.overview, 5, "the current week is still refreshed every cycle");

  console.log("ok  next week is fetched once per TTL, not once per cycle");
}

/** A normal school day needs no extra request at all. */
async function testNoExtraRequestWhenWeekHasFutureDays(): Promise<void> {
  const { client, counts } = fakeClient({
    currentWeek: [lesson(today, "08:15", "Äidinkieli"), lesson(shiftDateKey(today, 1), "09:00", "Liikunta")],
    nextWeek: [],
    inbox: [],
    details: new Map(),
  });

  await fetchStudent(client, student, null);

  assert.equal(counts.scheduleByDate, 0, "tomorrow is already known, so nothing extra may be requested");
  console.log("ok  no extra request when the current week already covers tomorrow");
}

/**
 * The inbox listing carries neither sender nor read state. Reading them off the
 * listing silently marked every message unread and every sender unknown, which
 * broke the privacy view without any error appearing anywhere.
 */
async function testSenderAndUnreadComeFromTheDetail(): Promise<void> {
  const details = new Map<number, Message>([
    [10, detailMessage(10, "Opettaja Virtanen", 0)],
    [11, detailMessage(11, "Rehtori Nieminen", 1)],
  ]);

  const { client, counts } = fakeClient({
    currentWeek: [lesson(today, "08:15", "Matematiikka"), lesson(shiftDateKey(today, 1), "08:15", "Kemia")],
    nextWeek: [],
    inbox: [listedMessage(10, "Retkestä"), listedMessage(11, "Tiedote")],
    details,
  });

  const first = await fetchStudent(client, student, null);

  const unreadOne = first.messages.find((m) => m.id === 10);
  const readOne = first.messages.find((m) => m.id === 11);

  assert.equal(unreadOne?.senderName, "Opettaja Virtanen", "sender must come from the detail response");
  assert.equal(unreadOne?.unread, true, "status 0 means the message has not been opened");
  assert.equal(readOne?.unread, false, "a non-zero status means it has been read");
  assert.equal(readOne?.senderName, "Rehtori Nieminen");
  assert.equal(unreadOne?.content, "Terveisin\nopettaja", "HTML must be reduced to plain text");
  assert.equal(counts.messageDetail, 2, "each message detail is fetched once");

  // A second cycle must reuse what it already knows rather than re-downloading.
  const second = await fetchStudent(client, student, asPrevious(first));
  assert.equal(
    counts.messageDetail,
    2,
    `details must be carried forward, got ${counts.messageDetail} fetches`,
  );
  assert.equal(second.messages.find((m) => m.id === 11)?.senderName, "Rehtori Nieminen");

  console.log("ok  sender and read state are taken from the message detail and cached");
}

await testNextWeekIsFetchedOnceNotEveryCycle();
await testNoExtraRequestWhenWeekHasFutureDays();
await testSenderAndUnreadComeFromTheDetail();

console.log("\nall wilma tests passed");
process.exit(0);
