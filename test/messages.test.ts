// Tests for Schoology messages: the recipients list, the thread list, one thread, message text both ways.
// Run: node --experimental-strip-types test/messages.test.ts

import {
  adaptConversations,
  adaptRecipients,
  adaptThread,
  formatMessageTime,
  MAX_MESSAGE,
  messageHtml,
  messageText,
  findMessageFile,
  messageFiles,
  messageLinks,
  webAddress,
  namesFrom,
  parseNewMessage,
  parseReply,
  recipientRows,
  threadParticipants,
  threadSubject,
} from "../src/messages.ts";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}\n        expected: ${e}\n        actual:   ${a}`);
  }
}

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 6, 21, 5); // Tue Oct 6 2026, 2:05 PM in Los Angeles
const unix = (ms: number) => String(Math.floor(ms / 1000));
const ME = "1001";

console.log("\nrecipients");
{
  const rows = [
    { id: "5002", name: "Ms. Whitfield", school: "Lincoln HS", picture_url: "https://x" },
    { id: 5001, name: "Mr. Cho" },
    { id: "5001", name: "Mr. Cho (again)" },
    { id: "abc", name: "Bad id" },
    { uid: "5003", name_first: "Dana", name_last: "Lee" },
    { id: "5004", name: "" },
  ];
  check("wrapper keys Schoology might use", [recipientRows({ recipients: rows }).length, recipientRows({ recipient: rows }).length, recipientRows({ users: { user: rows } }).length, recipientRows(rows).length, recipientRows({ recipients: { id: 1, name: "One" } }).length, recipientRows(null).length], [6, 6, 6, 6, 1, 0]);
  check("ids digits only, each once, named, by name", adaptRecipients(rows), [
    { id: "5003", name: "Dana Lee" },
    { id: "5001", name: "Mr. Cho" },
    { id: "5002", name: "Ms. Whitfield" },
  ]);
  check("names map; no list means no names", [[...namesFrom(rows).entries()].length, namesFrom(null).size], [3, 0]);
}

console.log("\nthread list");
{
  const inbox = [
    { id: 88, subject: "Lab report", recipient_ids: "1001", last_updated: unix(NOW - 2 * HOUR), author_id: "5001", message_status: "unread", message: "<p>Nice work on the <b>lab</b>.</p>" },
    { id: 90, subject: "Class trip", recipient_ids: "1001,7001,7002", last_updated: unix(NOW - 30 * HOUR), author_id: "5002", message_status: "read", message: "Forms due Friday" },
    { id: 91, subject: "", recipient_ids: "1001", last_updated: unix(NOW - 50 * HOUR), author_id: "5009", message_status: "read", message: "?" },
  ];
  const sent = [
    // The student's reply in thread 88 is newer than the inbox copy.
    { id: 88, subject: "Lab report", recipient_ids: "5001", last_updated: unix(NOW - HOUR), author_id: ME, message_status: "read", message: "Thank you!" },
    // A thread the student started, no reply yet.
    { id: 95, subject: "Question", recipient_ids: "5002", last_updated: unix(NOW - 3 * HOUR), author_id: ME, message: "Can I come in at lunch?" },
    { id: "x", subject: "bad id", author_id: ME },
  ];
  const { CONVERSATIONS, PEOPLE } = adaptConversations({ inbox, sent, names: new Map([["5001", "Mr. Cho"], ["5002", "Ms. Whitfield"]]), me: ME, now: NOW });
  check("merged by thread, newest first", CONVERSATIONS.map((c) => [c.id, c.personId, c.subject, c.unread, c.time]), [
    ["88", "5001", "Lab report", true, "1h ago"],
    ["95", "5002", "Question", false, "3h ago"],
    ["90", "5002", "Class trip", false, "1d ago"],
    ["91", "5009", "No subject", false, "2d ago"],
  ]);
  check("preview is the newest message, plain text", [CONVERSATIONS[0].preview, CONVERSATIONS[0].at], ["Thank you!", Math.floor((NOW - HOUR) / 1000) * 1000]);
  check("participants: everyone but the student; messages load later", [CONVERSATIONS[2].participants, CONVERSATIONS[0].messages], [["5002", "7001", "7002"], []]);
  check("PEOPLE: names from the list, else Teacher (an author) or Classmate", PEOPLE, {
    "5001": { name: "Mr. Cho" },
    "5002": { name: "Ms. Whitfield" },
    "7001": { name: "Classmate" },
    "7002": { name: "Classmate" },
    "5009": { name: "Teacher" },
  });
  const many = adaptConversations({ inbox: Array.from({ length: 70 }, (_, i) => ({ id: i + 1, author_id: "5001", last_updated: unix(NOW - i * HOUR) })), sent: null, names: new Map(), me: ME, now: NOW });
  check("at most 50", [many.CONVERSATIONS.length, many.CONVERSATIONS[0].id], [50, "1"]);
}

console.log("\none thread");
{
  const rows = [
    { id: 88, subject: "Lab &amp; report", recipient_ids: "1001", last_updated: unix(NOW - 2 * HOUR), author_id: "5001", message: "<p>Nice work.</p><p>Line two<br>and three</p>" },
    { id: 88, subject: "Lab &amp; report", recipient_ids: "5001", last_updated: unix(NOW), author_id: ME, message: "Thank you!" },
    { id: 88, recipient_ids: "1001,7001", last_updated: unix(NOW - 3 * HOUR), author_id: "5001", message: "First" },
  ];
  const t = adaptThread("88", rows, ME, "America/Los_Angeles");
  check("oldest first, me/them, text keeps its lines", t.messages.map((m) => [m.from, m.authorId, m.text]), [
    ["them", "5001", "First"],
    ["them", "5001", "Nice work.\nLine two\nand three"],
    ["me", ME, "Thank you!"],
  ]);
  check("subject and participants", [t.id, t.subject, t.participants], ["88", "Lab & report", ["5001", "7001"]]);
  check("time in the student's zone", t.messages[2].time, "Tue, Oct 6 · 2:05 PM");
  check("formatMessageTime in UTC", formatMessageTime(Date.UTC(2026, 0, 2, 9, 7), "UTC"), "Fri, Jan 2 · 9:07 AM");
  check("threadParticipants / threadSubject", [threadParticipants([{ author_id: ME, recipient_ids: "5001, 5002,abc" }], ME), threadSubject([{ subject: "" }, { subject: "<b>Hi</b>" }])], [["5001", "5002"], "Hi"]);
}

console.log("\nmessage text both ways");
check("tags out, entities one level, lines kept", messageText("<div>Hi &amp; bye</div><div>&amp;lt;b&amp;gt;</div><script>x</script>"), "Hi & bye\n&lt;b&gt;\nx");
check("blank lines collapse to one", messageText("a<br><br><br><br>b"), "a\n\nb");
check("capped", messageText("x".repeat(MAX_MESSAGE + 50)).length, MAX_MESSAGE);
check("what the student types is escaped, line breaks kept", messageHtml('Hi <b>Mr.</b> "Cho" & co\nThanks'), "Hi &lt;b&gt;Mr.&lt;/b&gt; &quot;Cho&quot; &amp; co<br />Thanks");
check("a link stays plain text", messageHtml("https://example.com/a?b=1&c=2"), "https://example.com/a?b=1&amp;c=2");

console.log("\nchecking a new message");
{
  const ok = parseNewMessage({ recipientIds: ["5001", 5002, "5001", ME], subject: "  Lab\nreport  ", message: "Hello\r\nthere\u0007 " }, ME);
  check("recipients deduped (and not the student), subject one line, text cleaned", ok, { ok: true, recipientIds: ["5001", "5002"], subject: "Lab report", message: "Hello\nthere", fileIds: [] });
  const bad = (body: unknown) => {
    const r = parseNewMessage(body, ME);
    return r.ok ? "ok" : r.error;
  };
  check("refusals", [
    bad(null),
    bad([]),
    bad({ recipientIds: [], subject: "s", message: "m" }),
    bad({ recipientIds: "5001", subject: "s", message: "m" }),
    bad({ recipientIds: ["5001; DROP"], subject: "s", message: "m" }),
    bad({ recipientIds: ["../users/1"], subject: "s", message: "m" }),
    bad({ recipientIds: [ME], subject: "s", message: "m" }),
    bad({ recipientIds: Array.from({ length: 21 }, (_, i) => String(5000 + i)), subject: "s", message: "m" }),
    bad({ recipientIds: ["5001"], subject: "   ", message: "m" }),
    bad({ recipientIds: ["5001"], subject: "s".repeat(201), message: "m" }),
    bad({ recipientIds: ["5001"], subject: "s", message: "  \n " }),
    bad({ recipientIds: ["5001"], subject: "s", message: "m".repeat(10001) }),
    bad({ recipientIds: ["5001"], subject: 5, message: "m" }),
  ], ["invalid_body", "invalid_body", "bad_recipients", "bad_recipients", "bad_recipients", "bad_recipients", "bad_recipients", "bad_recipients", "empty_subject", "subject_too_long", "empty_message", "message_too_long", "empty_subject"]);
  check("limits are inclusive: 20 recipients, 200 and 10000 characters", parseNewMessage({ recipientIds: Array.from({ length: 20 }, (_, i) => String(5000 + i)), subject: "s".repeat(200), message: "m".repeat(10000) }, ME).ok, true);
}

console.log("\nchecking a reply");
check("ok", parseReply({ id: "88", message: " Thanks " }), { ok: true, id: "88", message: "Thanks", fileIds: [] });
check("refusals", [parseReply({ id: "8x", message: "m" }), parseReply({ id: "88" }), parseReply("88")].map((r) => (r.ok ? "ok" : r.error)), ["bad_request", "empty_message", "invalid_body"]);

console.log("\nfiles sent with a message (2026-11-03)");
{
  const ME = "1";
  const n = parseNewMessage({ recipientIds: ["5"], subject: "Lab", message: "", fileIds: ["11", 12, "11"] }, ME);
  check("a new message can be just files (ids deduped, numbers taken)", n.ok && [n.message, n.fileIds], ["", ["11", "12"]]);
  check("no words and no files is still empty", (parseNewMessage({ recipientIds: ["5"], subject: "Lab", message: " " }, ME) as any).error, "empty_message");
  check("file ids must be digits, at most 10", [(parseNewMessage({ recipientIds: ["5"], subject: "s", message: "m", fileIds: ["x1"] }, ME) as any).error, (parseNewMessage({ recipientIds: ["5"], subject: "s", message: "m", fileIds: Array.from({ length: 11 }, (_, i) => String(i + 1)) }, ME) as any).error], ["bad_files", "bad_files"]);
  const r = parseReply({ id: "9", fileIds: ["44"] });
  check("a reply can be just a file", r.ok && [r.message, r.fileIds], ["", ["44"]]);
  check("no fileIds is no files", (parseReply({ id: "9", message: "hi" }) as any).fileIds, []);
}

console.log("\nfiles and links on a message (2026-11-03)");
{
  const row = {
    message: 'See <a href="https://example.com/rubric">the rubric</a> and <a href="https://khanacademy.org">https://khanacademy.org</a>.',
    attachments: {
      files: { file: [{ id: 302540774, filename: "cell diagram.png", filesize: 21299, download_path: "https://api.schoology.com/v1/system/files/attachments/files/m/1/x.png" }, { id: "bad id", filename: "x" }] },
      links: { link: [{ url: "google.com", title: "google" }, { url: "javascript:alert(1)", title: "x" }, { url: "ftp://files.example.com", title: "ftp" }] },
    },
  };
  check("files: ids, names and sizes only (never the download path)", messageFiles(row), [{ id: "302540774", name: "cell diagram.png", size: 21299 }]);
  check("links: made full web addresses; anything else left out", messageLinks(row), [{ url: "https://google.com/", title: "google" }]);
  check("web addresses", [webAddress("google.com"), webAddress("http://a.b/c"), webAddress("javascript:x"), webAddress("localhost"), webAddress("https://u:p@a.com"), webAddress("two words.com")], ["https://google.com/", "http://a.b/c", "", "", "", ""]);
  check("a link written in the message keeps its address", messageText(row.message), "See the rubric (https://example.com/rubric) and https://khanacademy.org.");
  check("a file found again in the conversation", findMessageFile([row], "302540774"), { name: "cell diagram.png", downloadPath: "https://api.schoology.com/v1/system/files/attachments/files/m/1/x.png" });
  check("...and one that isn't in it", findMessageFile([row], "999"), null);
  const t = adaptThread("5", [{ author_id: "7", message: "hi", last_updated: 1700000000, ...row }], "1", "UTC");
  check("a thread's message carries its files and links", [t.messages[0].files.length, t.messages[0].links.length], [1, 1]);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
