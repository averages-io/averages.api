/**
 * Tests for the Files page's course-file list (GET /data/files).
 *
 * Run: node --experimental-strip-types test/files.test.ts
 *
 * The Schoology payloads below are shaped like real ones (both the
 * `files: {file: [...]}` and bare-object forms Schoology sends); ids and
 * names are made up.
 */

import { adaptCourseFiles, findAttachment, MAX_COURSE_FILES, pdfPreviewPath } from "../src/adapt.ts";

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

const doc = (id: string, title: string, files: unknown) => ({ id, title, attachments: { files } });

{
  const { files, partial } = adaptCourseFiles({
    "111": {
      documents: [
        doc("501", "Syllabus", { file: [{ id: "9001", title: "Syllabus", filename: "syllabus.pdf", filesize: "2048", timestamp: "1790000000", download_path: "https://api.schoology.com/v1/attachment/9001/source/x.pdf" }] }),
        // a link document has no files
        { id: "502", title: "PhET", attachments: { links: { link: [{ url: "https://phet.colorado.edu" }] } } },
      ],
      assignments: [
        doc("601", "Lab Report #4", { file: { id: "9002", title: "Lab Template.docx", filename: "Lab Template.docx", filesize: 10, timestamp: 1790500000 } }),
      ],
    },
    "222": { documents: [], assignments: [doc("602", "<b>Essay</b>", [{ id: "9003", title: "Rubric", extension: "PDF", timestamp: "1780000000" }])] },
  });
  check("three files, newest first", files.map((f) => f.id), ["9002", "9001", "9003"]);
  check("assignment file", files[0], { id: "9002", name: "Lab Template.docx", ext: "docx", size: 10, at: 1790500000000, course: "111", kind: "assignment", parent: "601", parentTitle: "Lab Report #4" });
  check("document file gets its extension from the filename", [files[1].name, files[1].ext, files[1].kind, files[1].parent], ["Syllabus.pdf", "pdf", "document", "501"]);
  check("Schoology's extension field wins and is lower-cased; HTML stripped from titles", [files[2].name, files[2].ext, files[2].parentTitle], ["Rubric.pdf", "pdf", "Essay"]);
  check("no download path ever leaves the Worker", JSON.stringify(files).includes("download_path") || JSON.stringify(files).includes("api.schoology.com"), false);
  check("not partial when every section answered", partial, false);
}
{
  const { files, partial } = adaptCourseFiles({ "111": { documents: null, assignments: [] } });
  check("a section that failed makes it partial", [files.length, partial], [0, true]);
}
{
  const { files } = adaptCourseFiles({
    "111": {
      documents: [doc("abc", "Bad parent", { file: [{ id: "1", title: "x.pdf" }] }), doc("7", "Bad file id", { file: [{ id: "../9", title: "y.pdf" }] })],
      assignments: [],
    },
  });
  check("ids that aren't numbers are skipped (they end up in download URLs)", files.length, 0);
}
{
  const many = Array.from({ length: MAX_COURSE_FILES + 5 }, (_, i) => doc(String(i + 1), "D", { file: [{ id: String(i + 1), title: `f${i}.pdf`, timestamp: String(1790000000 + i) }] }));
  const { files, partial } = adaptCourseFiles({ "111": { documents: many, assignments: [] } });
  check("capped, newest kept, and marked partial", [files.length, files[0].id, partial], [MAX_COURSE_FILES, String(MAX_COURSE_FILES + 5), true]);
}
{
  const { files } = adaptCourseFiles({ "111": { documents: [doc("5", "D", { file: [{ id: "8", title: "😀".repeat(300), filename: "a.png" }] })], assignments: [] } });
  check("long names cut by character, never mid-emoji, extension kept", [Array.from(files[0].name).length, files[0].name.endsWith("😀.png")], [244, true]);
}

{
  const raw = doc("5", "D", { file: [{ id: "8", title: "Q&amp;A <i>notes</i>", filename: "qa.pdf", extension: "constructor", download_path: "https://api.schoology.com/v1/attachment/8/source/qa.pdf" }] });
  const { files } = adaptCourseFiles({ "111": { documents: [raw], assignments: [] } });
  check("an extension that isn't one is ignored (the filename's is used); HTML entities and tags dropped", [files[0].name, files[0].ext], ["Q&A notes.pdf", "pdf"]);
  check("the download gets the same name as the list", findAttachment(raw, "8")?.name, files[0].name);
}
{
  const full = Array.from({ length: 200 }, (_, i) => ({ id: String(i + 1), title: "A" }));
  check("a full page of 200 from Schoology is marked partial", adaptCourseFiles({ "111": { documents: [], assignments: full } }).partial, true);
}

{
  // Schoology's PDF copy of an uploaded file (made for its viewer), used to preview Office files.
  const CONV = (id: string, extra: Record<string, unknown> = {}) => ({ converted_status: "1", converted_extension: "pdf", converted_download_path: `https://api.schoology.com/v1/attachment/${id}/conversion/file.pdf`, ...extra });
  const f = (id: string, filename: string, extra: Record<string, unknown> = {}) => ({ id, filename, title: filename, download_path: `https://api.schoology.com/v1/attachment/${id}/source/x`, ...extra });
  const raw = { attachments: { files: { file: [
    f("21", "Essay.docx", CONV("21")),
    f("22", "Slides.pptx", CONV("22", { converted_status: 1 })),
    f("23", "Scan.pdf", CONV("23")),
    f("24", "Data.xlsx", CONV("24", { converted_status: "0" })),
    f("25", "Notes.docx", CONV("25", { converted_extension: "png" })),
    f("26", "Old.doc", CONV("26", { converted_download_path: "https://evil.example/x.pdf" })),
    f("27", "Plain.docx"),
  ] } } };
  check("pdfPreviewPath: a converted Word file", pdfPreviewPath(raw.attachments.files.file[0]), "https://api.schoology.com/v1/attachment/21/conversion/file.pdf");
  check("pdfPreviewPath: status as a number works too", pdfPreviewPath(raw.attachments.files.file[1]) !== "", true);
  check("pdfPreviewPath: none for a PDF, an unfinished or non-PDF copy, another host, or no copy",
    ["23", "24", "25", "26", "27"].map((id) => pdfPreviewPath(raw.attachments.files.file.find((x) => x.id === id))), ["", "", "", "", ""]);
  check("findAttachment carries the preview path", [findAttachment(raw, "21")?.previewPath, findAttachment(raw, "27")?.previewPath], ["https://api.schoology.com/v1/attachment/21/conversion/file.pdf", ""]);
  const { files } = adaptCourseFiles({ "111": { documents: [{ id: "5", title: "Unit 1", ...raw }], assignments: [] } });
  check("the list marks only files with a PDF copy", files.filter((x) => x.preview).map((x) => x.id).sort(), ["21", "22"]);
  check("preview is left out (not false) when there's none", "preview" in files.find((x) => x.id === "27")!, false);
  check("no paths in the list", JSON.stringify(files).includes("conversion"), false);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
