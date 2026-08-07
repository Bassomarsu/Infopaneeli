/**
 * Wilma never tells us whether a message was read (see providers/wilma.ts),
 * so read state is tracked locally in the `message_reads` table instead. This
 * covers the store functions that back that: marking a message read must be
 * idempotent, and unrelated ids must stay unread.
 *
 * Run with:  npm run test:message-reads --workspace=server
 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { config } from "../src/core/config.ts";
import { isMessageRead, listReadMessageIds, markMessageRead } from "../src/core/store.ts";

// The test database file persists between runs, so start from a clean table
// rather than dodging leftovers with time-derived ids. Fixed ids keep the test
// deterministic, and clearing up front means a failed run cannot poison the
// next one — the same reason the suite writes to its own database at all.
new DatabaseSync(config.dbPath).exec("DELETE FROM message_reads");

const [readId, untouchedId] = [86921, 86922];

function testUnknownMessageIsNotRead(): void {
  assert.equal(isMessageRead(untouchedId), false, "a message never opened must not read as read");
  console.log("ok  an id that was never marked read stays unread");
}

function testMarkingReadPersists(): void {
  assert.equal(isMessageRead(readId), false, "must start unread");
  const readAt = markMessageRead(readId);
  assert.ok(readAt, "markMessageRead must return the timestamp it stored");
  assert.equal(isMessageRead(readId), true, "must read as read once marked");
  assert.equal(isMessageRead(untouchedId), false, "marking one message must not affect another");
  console.log("ok  marking a message read persists and is scoped to that id");
}

function testMarkingReadTwiceStaysConsistent(): void {
  const first = markMessageRead(readId);
  const second = markMessageRead(readId);
  assert.equal(isMessageRead(readId), true, "must still read as read");
  assert.ok(second >= first, "the second read_at must not move backwards");
  console.log("ok  opening an already-read message again does not error or unread it");
}

function testListReadMessageIdsIncludesMarkedOnes(): void {
  const ids = listReadMessageIds();
  assert.ok(ids.has(readId), "the bulk listing must include a message marked read above");
  assert.ok(!ids.has(untouchedId), "the bulk listing must not include an id that was never marked");
  console.log("ok  listReadMessageIds reflects what markMessageRead recorded");
}

testUnknownMessageIsNotRead();
testMarkingReadPersists();
testMarkingReadTwiceStaysConsistent();
testListReadMessageIdsIncludesMarkedOnes();

console.log("\nall message-read tests passed");
process.exit(0);
