/**
 * The reviewer account's sample classes (2026-10-07), for reviewSandbox.ts.
 *
 * The same six classes the app's demo pages show (AP Chemistry, Algebra II,
 * English 10, U.S. History, Spanish III, PE), with invented teachers, so a
 * reviewer moving between demo mode and this account sees one consistent
 * student. Everything here is static description; reviewSandbox.ts turns it
 * into Schoology's JSON shapes at request time, with every date placed
 * relative to "now" so the account always looks current: some work overdue,
 * one thing due today, the rest this week and next, grades posted hours and
 * weeks ago.
 *
 * Due dates are wall-clock times in SANDBOX_ZONE, the way real Schoology
 * gives them in the student's own zone (its /users/me says which, tz_name).
 * The app sends its own zone with ?tz= and reads them in that; a reviewer in
 * another zone may see "due today" land on a neighbouring day, which is the
 * one thing a sandbox that can't see the zone can't get right everywhere.
 *
 * The attachment files (a one-page PDF per handout, one PNG diagram) are
 * built here in a few hundred bytes each, so nothing binary is checked in and
 * downloads, Edit in Canva and the Files page all have real bytes to work on.
 *
 * Every id is a digit string in its own range (sections 70000000xx,
 * assignments 71000xxxxx, documents 73..., files 74..., folders 75...,
 * updates 76..., events 77..., threads 78...), because the routes only pass
 * digits through to Schoology paths. Teachers' uids are digits too (81...),
 * as extras.ts and messages.ts drop any id that isn't.
 */

export const SANDBOX_ZONE = "America/Los_Angeles";

export const STUDENT = {
  name_first: "Alex",
  name_last: "Rivera",
  name_display: "Alex Rivera",
  primary_email: "reviewer@averages.io",
  grad_year: "2029",
};

/** [days from today, hour, minute] in SANDBOX_ZONE. */
export type DueSpec = [number, number, number];

export interface TeacherDef {
  uid: string;
  title: string;
  first: string;
  last: string;
}

export interface AssignmentDef {
  id: string;
  title: string;
  type: "assignment" | "discussion" | "assessment";
  /** Index into the section's categories (ignored when it has none). */
  category: number;
  maxPoints: number;
  description: string;
  /**
   * Graded work has no due date on purpose: Schoology doesn't say whether
   * something was turned in, so the app counts every past due date as
   * overdue, and five graded assignments per class with real due dates would
   * fill Home's Overdue list with finished work. Teachers do leave due dates
   * off, so this is still a shape Schoology sends.
   */
  graded?: { earned: number; daysAgo: number };
  due?: DueSpec;
  /** Takes a turned-in file or text (Schoology's dropbox). */
  dropbox?: boolean;
  files?: string[];
  links?: { title: string; url: string }[];
  folder?: string;
}

export interface DocumentDef {
  id: string;
  title: string;
  file: string;
  folder?: string;
}

export interface FolderDef {
  id: string;
  title: string;
  /** "0" for the class's top level. */
  parent: string;
  color: string;
}

export interface SectionDef {
  id: string;
  courseId: string;
  title: string;
  code: string;
  period: number;
  teacher: TeacherDef;
  /** Weighted categories; empty = total points (PE). */
  categories: { id: string; title: string; weight: number }[];
  assignments: AssignmentDef[];
  documents: DocumentDef[];
  folders: FolderDef[];
  updates: { id: string; body: string; hoursAgo: number }[];
  /** The teacher's own calendar events (assignments are added from `assignments`). */
  events: { id: string; title: string; description: string; start: DueSpec; allDay?: boolean }[];
}

export interface FileDef {
  title: string;
  filename: string;
  kind: "pdf" | "png";
  /** The PDF's heading and lines (ASCII; it's drawn in Helvetica). */
  heading?: string;
  lines?: string[];
  daysAgo: number;
}

/* ── Files ─────────────────────────────────────────────────────────────── */

export const FILES: Record<string, FileDef> = {
  "7400000001": {
    title: "Lab Report #4 Instructions",
    filename: "Lab Report 4 Instructions.pdf",
    kind: "pdf",
    heading: "Lab Report #4: Acid-Base Titration",
    lines: [
      "AP Chemistry - Dr. Park - Period 1",
      "",
      "Purpose: find the molarity of an unknown HCl solution by titration",
      "with 0.100 M NaOH, using phenolphthalein as the indicator.",
      "",
      "Your report must include:",
      "  1. Title, purpose and a balanced equation for the reaction",
      "  2. Data table for both trials (initial and final burette readings)",
      "  3. Calculations: moles of NaOH, moles of HCl, molarity of HCl",
      "  4. Percent error for each trial (accepted value: 0.125 M)",
      "  5. Error analysis: at least two sources of error and their effect",
      "  6. Conclusion in 3-5 sentences",
      "",
      "Turn in one PDF or a typed answer on the assignment page.",
      "Worth 50 points (Labs category).",
    ],
    daysAgo: 9,
  },
  "7400000002": { title: "Titration Setup", filename: "Titration Setup.png", kind: "png", daysAgo: 9 },
  "7400000003": {
    title: "AP Chemistry Syllabus",
    filename: "AP Chemistry Syllabus.pdf",
    kind: "pdf",
    heading: "AP Chemistry Syllabus 2026-2027",
    lines: [
      "Instructor: Dr. Helen Park - Room 214",
      "",
      "Units: 1 Atomic Structure, 2 Bonding, 3 Thermochemistry,",
      "4 Kinetics, 5 Equilibrium, 6 Acids and Bases, 7 Electrochemistry",
      "",
      "Grading: Tests & Quizzes 40%, Labs 35%, Homework & Discussions 25%",
      "Late labs lose 10% per school day, up to 5 days.",
      "Safety goggles are required for every lab.",
    ],
    daysAgo: 45,
  },
  "7400000004": {
    title: "Enthalpy Notes",
    filename: "Unit 3 Enthalpy Notes.pdf",
    kind: "pdf",
    heading: "Unit 3 Notes: Enthalpy",
    lines: [
      "dH = H(products) - H(reactants)",
      "Exothermic: dH < 0, heat released. Endothermic: dH > 0, heat absorbed.",
      "q = m c dT (c of water = 4.18 J/g C)",
      "Hess's law: add the steps, add their dH values.",
    ],
    daysAgo: 6,
  },
  "7400000005": {
    title: "Unit 2 Study Guide",
    filename: "Unit 2 Study Guide.pdf",
    kind: "pdf",
    heading: "Algebra II - Unit 2 Study Guide: Quadratics",
    lines: [
      "1. Vertex form: y = a(x - h)^2 + k",
      "2. Factoring: GCF first, then trinomials and difference of squares",
      "3. Completing the square",
      "4. The quadratic formula and the discriminant",
      "5. Graphing: vertex, axis of symmetry, intercepts",
      "",
      "Quiz: 20 questions, 40 minutes, calculator allowed on Part B.",
    ],
    daysAgo: 4,
  },
  "7400000006": {
    title: "Problem Set 7",
    filename: "Problem Set 7.pdf",
    kind: "pdf",
    heading: "Problem Set 7: Solving Quadratics",
    lines: [
      "Solve each equation. Show your work.",
      "1. x^2 - 5x + 6 = 0        2. 2x^2 + 3x - 2 = 0",
      "3. x^2 + 4x = 12           4. 3x^2 - 27 = 0",
      "...",
      "12. Solve x^2 + 6x + 2 = 0 two ways and compare.",
    ],
    daysAgo: 3,
  },
  "7400000007": {
    title: "Persuasive Essay Rubric",
    filename: "Persuasive Essay Rubric.pdf",
    kind: "pdf",
    heading: "Persuasive Essay Rubric (100 points)",
    lines: [
      "Thesis and claim ........................ 20",
      "Evidence and reasoning .................. 30",
      "Counterargument and rebuttal ............ 15",
      "Organization ............................ 15",
      "Style, grammar and MLA format ........... 20",
    ],
    daysAgo: 8,
  },
  "7400000008": {
    title: "Reading Schedule",
    filename: "Of Mice and Men Reading Schedule.pdf",
    kind: "pdf",
    heading: "Of Mice and Men - Reading Schedule",
    lines: ["Week 1: Chapters 1-2", "Week 2: Chapters 3-4", "Week 3: Chapters 5-6", "Discussion posts are due each Thursday."],
    daysAgo: 20,
  },
  "7400000009": {
    title: "Constitution Study Guide",
    filename: "Constitution Study Guide.pdf",
    kind: "pdf",
    heading: "Unit 2: The Constitution",
    lines: ["Articles of Confederation and their weaknesses", "The Great Compromise", "Federalists and Anti-Federalists", "The Bill of Rights"],
    daysAgo: 5,
  },
};

/* ── Classes ───────────────────────────────────────────────────────────── */

export const SECTIONS: SectionDef[] = [
  {
    id: "7000000001",
    courseId: "6900000001",
    title: "AP Chemistry",
    code: "CHEM-AP",
    period: 1,
    teacher: { uid: "8100000001", title: "Dr.", first: "Helen", last: "Park" },
    categories: [
      { id: "7200000011", title: "Tests & Quizzes", weight: 40 },
      { id: "7200000012", title: "Labs", weight: 35 },
      { id: "7200000013", title: "Homework & Discussions", weight: 25 },
    ],
    assignments: [
      { id: "7100000101", title: "Intro Lab Safety Quiz", type: "assessment", category: 0, maxPoints: 25, description: "Lab safety rules and equipment.", graded: { earned: 18, daysAgo: 38 } },
      { id: "7100000102", title: "Stoichiometry Problem Set", type: "assignment", category: 2, maxPoints: 100, description: "Mole ratios and limiting reactants.", graded: { earned: 79, daysAgo: 30 }, dropbox: true },
      { id: "7100000103", title: "Molarity Discussion", type: "discussion", category: 2, maxPoints: 25, description: "Explain molarity to someone who missed class.", graded: { earned: 21, daysAgo: 21 } },
      { id: "7100000104", title: "Gas Laws Test", type: "assessment", category: 0, maxPoints: 100, description: "Boyle, Charles, Gay-Lussac and the ideal gas law.", graded: { earned: 88, daysAgo: 12 } },
      { id: "7100000105", title: "Lab Report #3", type: "assignment", category: 1, maxPoints: 50, description: "Specific heat of a metal.", graded: { earned: 45, daysAgo: 0.25 }, dropbox: true },
      {
        id: "7100000106",
        title: "Lab Report #4",
        type: "assignment",
        category: 1,
        maxPoints: 50,
        description: "<p>Write up the acid-base titration lab. The instructions and the setup diagram are attached.</p><p>Turn in <b>one PDF</b> or type your report here.</p>",
        due: [-2, 23, 59],
        dropbox: true,
        files: ["7400000001", "7400000002"],
        links: [{ title: "Acid-Base Solutions simulation (PhET)", url: "https://phet.colorado.edu/en/simulations/acid-base-solutions" }],
        folder: "7500000013",
      },
      { id: "7100000107", title: "Titration Lab Prep", type: "assignment", category: 2, maxPoints: 10, description: "Read the procedure and answer the pre-lab questions.", due: [1, 8, 0], dropbox: true, folder: "7500000012" },
      { id: "7100000108", title: "Unit 3 Test: Thermochemistry", type: "assessment", category: 0, maxPoints: 100, description: "Enthalpy, calorimetry and Hess's law.", due: [8, 10, 0], folder: "7500000012" },
    ],
    documents: [
      { id: "7300000101", title: "Course Syllabus", file: "7400000003", folder: "7500000011" },
      { id: "7300000102", title: "Unit 3 Notes: Enthalpy", file: "7400000004", folder: "7500000012" },
    ],
    folders: [
      { id: "7500000011", title: "Course Info", parent: "0", color: "blue" },
      { id: "7500000012", title: "Unit 3: Thermochemistry", parent: "0", color: "orange" },
      { id: "7500000013", title: "Lab Handouts", parent: "7500000012", color: "green" },
    ],
    updates: [
      { id: "7600000011", body: "Lab Report #3 grades are posted. Nice work overall; check my comments on your data tables.", hoursAgo: 6 },
      { id: "7600000012", body: "Reminder: bring your safety goggles tomorrow for the titration lab.", hoursAgo: 27 },
    ],
    events: [{ id: "7700000011", title: "Lab make-up session (Room 214)", description: "For anyone who missed the titration lab.", start: [2, 15, 30] }],
  },
  {
    id: "7000000002",
    courseId: "6900000002",
    title: "Algebra II",
    code: "MATH-ALG2",
    period: 2,
    teacher: { uid: "8100000002", title: "Mr.", first: "David", last: "Okafor" },
    categories: [
      { id: "7200000021", title: "Tests", weight: 50 },
      { id: "7200000022", title: "Quizzes", weight: 20 },
      { id: "7200000023", title: "Homework", weight: 30 },
    ],
    assignments: [
      { id: "7100000201", title: "Warm-Up Quiz 1", type: "assessment", category: 1, maxPoints: 50, description: "Linear functions review.", graded: { earned: 47, daysAgo: 36 } },
      { id: "7100000202", title: "Systems of Equations HW", type: "assignment", category: 2, maxPoints: 25, description: "Section 3.1-3.3, odd problems.", graded: { earned: 24, daysAgo: 29 }, dropbox: true },
      { id: "7100000203", title: "Factoring Discussion", type: "discussion", category: 2, maxPoints: 15, description: "Post a trinomial for a classmate to factor.", graded: { earned: 14, daysAgo: 22 } },
      { id: "7100000204", title: "Unit 1 Test", type: "assessment", category: 0, maxPoints: 100, description: "Functions and systems.", graded: { earned: 97, daysAgo: 14 } },
      { id: "7100000205", title: "Practice Set 6", type: "assignment", category: 2, maxPoints: 20, description: "Graphing parabolas.", graded: { earned: 19, daysAgo: 1 }, dropbox: true },
      { id: "7100000206", title: "Unit 2 Quiz", type: "assessment", category: 1, maxPoints: 50, description: "Quadratics. 40 minutes once you start.", due: [0, 23, 59], folder: "7500000021" },
      { id: "7100000207", title: "Problem Set 7", type: "assignment", category: 2, maxPoints: 20, description: "Solving quadratics. The problems are attached.", due: [2, 23, 59], dropbox: true, files: ["7400000006"], folder: "7500000021" },
      { id: "7100000208", title: "Practice Set 8", type: "assignment", category: 2, maxPoints: 20, description: "Complex numbers.", due: [9, 23, 59], dropbox: true },
    ],
    documents: [{ id: "7300000201", title: "Unit 2 Study Guide", file: "7400000005", folder: "7500000021" }],
    folders: [{ id: "7500000021", title: "Unit 2: Quadratics", parent: "0", color: "purple" }],
    updates: [{ id: "7600000021", body: "Unit 2 Quiz is open tonight. You'll have 40 minutes once you start, so find a quiet spot.", hoursAgo: 3 }],
    events: [{ id: "7700000021", title: "Math tutoring (Room 118)", description: "Drop in with questions on Problem Set 7.", start: [1, 15, 15] }],
  },
  {
    id: "7000000003",
    courseId: "6900000003",
    title: "English 10",
    code: "ENG10",
    period: 3,
    teacher: { uid: "8100000003", title: "Ms.", first: "Laura", last: "Bennett" },
    categories: [
      { id: "7200000031", title: "Essays", weight: 45 },
      { id: "7200000032", title: "Discussions", weight: 30 },
      { id: "7200000033", title: "Quizzes & Reading", weight: 25 },
    ],
    assignments: [
      { id: "7100000301", title: "Reading Journal 1", type: "assignment", category: 2, maxPoints: 50, description: "Chapters 1-2 reflections.", graded: { earned: 44, daysAgo: 37 }, dropbox: true },
      { id: "7100000302", title: "Vocabulary Quiz", type: "assessment", category: 2, maxPoints: 50, description: "Words from chapters 1-3.", graded: { earned: 41, daysAgo: 28 } },
      { id: "7100000303", title: "Chapter 3 Discussion", type: "discussion", category: 1, maxPoints: 100, description: "Why does Candy agree to let Carlson shoot his dog?", graded: { earned: 79, daysAgo: 20 } },
      { id: "7100000304", title: "Essay Draft", type: "assignment", category: 0, maxPoints: 100, description: "First draft of your persuasive essay.", graded: { earned: 76, daysAgo: 11 }, dropbox: true },
      { id: "7100000305", title: "Grammar Check", type: "assessment", category: 2, maxPoints: 100, description: "Commas, semicolons and run-ons.", graded: { earned: 73, daysAgo: 2 } },
      { id: "7100000306", title: "Chapter 6 Discussion", type: "discussion", category: 1, maxPoints: 20, description: "Is the ending of the novel inevitable? Reply to two classmates.", due: [-3, 23, 59] },
      { id: "7100000307", title: "Persuasive Essay: Final Draft", type: "assignment", category: 0, maxPoints: 100, description: "<p>Revise your draft using my comments and the rubric (attached). 800-1200 words, MLA format.</p>", due: [5, 23, 59], dropbox: true, files: ["7400000007"] },
    ],
    documents: [{ id: "7300000301", title: "Of Mice and Men Reading Schedule", file: "7400000008" }],
    folders: [],
    updates: [{ id: "7600000031", body: "The Chapter 6 discussion is still open for late posts through Friday.", hoursAgo: 22 }],
    events: [],
  },
  {
    id: "7000000004",
    courseId: "6900000004",
    title: "U.S. History",
    code: "HIST-US",
    period: 4,
    teacher: { uid: "8100000004", title: "Mr.", first: "James", last: "Whitfield" },
    categories: [
      { id: "7200000041", title: "Exams", weight: 40 },
      { id: "7200000042", title: "Projects", weight: 30 },
      { id: "7200000043", title: "Classwork", weight: 30 },
    ],
    assignments: [
      { id: "7100000401", title: "Colonial Era Notes", type: "assignment", category: 2, maxPoints: 100, description: "Guided notes, chapter 2.", graded: { earned: 89, daysAgo: 39 }, dropbox: true },
      { id: "7100000402", title: "Primary Source Quiz", type: "assessment", category: 0, maxPoints: 100, description: "Reading primary sources.", graded: { earned: 93, daysAgo: 31 } },
      { id: "7100000403", title: "Revolution Discussion", type: "discussion", category: 2, maxPoints: 25, description: "Was the Revolution radical?", graded: { earned: 22, daysAgo: 24 } },
      { id: "7100000404", title: "Timeline Project", type: "assignment", category: 1, maxPoints: 100, description: "1763-1783 illustrated timeline.", graded: { earned: 92, daysAgo: 15 }, dropbox: true },
      { id: "7100000405", title: "Unit 1 Exam", type: "assessment", category: 0, maxPoints: 100, description: "Colonies through the Revolution.", graded: { earned: 90, daysAgo: 5 } },
      { id: "7100000406", title: "Reading Response", type: "discussion", category: 2, maxPoints: 20, description: "Respond to the reading on the Articles of Confederation.", due: [-4, 15, 0] },
      { id: "7100000407", title: "Primary Source Analysis: Federalist No. 10", type: "assignment", category: 1, maxPoints: 50, description: "Use the analysis worksheet from class.", due: [3, 23, 59], dropbox: true },
      { id: "7100000408", title: "Unit 2 Exam", type: "assessment", category: 0, maxPoints: 100, description: "The Constitution. Study guide in Materials.", due: [7, 9, 0] },
    ],
    documents: [{ id: "7300000401", title: "Constitution Study Guide", file: "7400000009" }],
    folders: [],
    updates: [{ id: "7600000041", body: "Museum field trip permission slips are due next Friday.", hoursAgo: 50 }],
    events: [{ id: "7700000041", title: "Museum field trip", description: "Bus leaves at 8:15. Bring a lunch.", start: [12, 0, 0], allDay: true }],
  },
  {
    id: "7000000005",
    courseId: "6900000005",
    title: "Spanish III",
    code: "SPAN3",
    period: 5,
    teacher: { uid: "8100000005", title: "Sra.", first: "Elena", last: "Morales" },
    categories: [
      { id: "7200000051", title: "Evaluaciones", weight: 40 },
      { id: "7200000052", title: "Tareas", weight: 35 },
      { id: "7200000053", title: "Participación", weight: 25 },
    ],
    assignments: [
      { id: "7100000501", title: "Vocabulario Quiz", type: "assessment", category: 0, maxPoints: 25, description: "Unidad 1.", graded: { earned: 19, daysAgo: 36 } },
      { id: "7100000502", title: "Conjugación Practice", type: "assignment", category: 1, maxPoints: 50, description: "Preterite and imperfect.", graded: { earned: 40, daysAgo: 28 }, dropbox: true },
      { id: "7100000503", title: "Conversación Discussion", type: "discussion", category: 2, maxPoints: 100, description: "Record and post a 1-minute introduction.", graded: { earned: 83, daysAgo: 19 } },
      { id: "7100000504", title: "Listening Check", type: "assessment", category: 0, maxPoints: 20, description: "Audio comprehension.", graded: { earned: 17, daysAgo: 10 } },
      { id: "7100000505", title: "Composición 1", type: "assignment", category: 1, maxPoints: 100, description: "Mi familia (150 palabras).", graded: { earned: 87, daysAgo: 2 }, dropbox: true },
      { id: "7100000506", title: "Vocab Worksheet", type: "assignment", category: 1, maxPoints: 20, description: "Unidad 3 vocabulary.", due: [1, 23, 59], dropbox: true },
      { id: "7100000507", title: "Composición 2", type: "assignment", category: 1, maxPoints: 100, description: "Pick one of the topics in my message (200 palabras).", due: [6, 23, 59], dropbox: true },
    ],
    documents: [],
    folders: [],
    updates: [{ id: "7600000051", body: "¡Hola! Spanish Club meets Thursday at lunch in Room 302.", hoursAgo: 30 }],
    events: [{ id: "7700000051", title: "Spanish Club (Room 302)", description: "Lunch meeting.", start: [3, 12, 10] }],
  },
  {
    id: "7000000006",
    courseId: "6900000006",
    title: "PE",
    code: "PE-10",
    period: 6,
    teacher: { uid: "8100000006", title: "Coach", first: "Ryan", last: "Mitchell" },
    categories: [],
    assignments: [
      { id: "7100000601", title: "Fitness Log 1", type: "assignment", category: 0, maxPoints: 100, description: "Two weeks of workouts.", graded: { earned: 96, daysAgo: 40 }, dropbox: true },
      { id: "7100000602", title: "Rules Quiz", type: "assessment", category: 0, maxPoints: 50, description: "Volleyball rules.", graded: { earned: 49, daysAgo: 33 } },
      { id: "7100000603", title: "Team Strategy Discussion", type: "discussion", category: 0, maxPoints: 20, description: "How would you beat a team with a strong server?", graded: { earned: 19, daysAgo: 25 } },
      { id: "7100000604", title: "Skills Check", type: "assessment", category: 0, maxPoints: 100, description: "Serve, set, bump.", graded: { earned: 97, daysAgo: 16 } },
      { id: "7100000605", title: "Fitness Log 2", type: "assignment", category: 0, maxPoints: 50, description: "Two weeks of workouts.", graded: { earned: 48, daysAgo: 3 }, dropbox: true },
      { id: "7100000606", title: "Fitness Log 3", type: "assignment", category: 0, maxPoints: 50, description: "Two weeks of workouts, with your heart-rate zones.", due: [4, 23, 59], dropbox: true },
    ],
    documents: [],
    folders: [],
    updates: [{ id: "7600000061", body: "Great work on the fitness test this week, everyone!", hoursAgo: 46 }],
    events: [],
  },
];

/** School-wide events on the student's own calendar (/users/{uid}/events). */
export const SCHOOL_EVENTS: { id: string; title: string; description: string; start: DueSpec; allDay?: boolean }[] = [
  { id: "7700000001", title: "Minimum Day: early dismissal", description: "Classes end at 12:30.", start: [5, 0, 0], allDay: true },
  { id: "7700000002", title: "Picture retakes", description: "In the library during your PE period.", start: [9, 0, 0], allDay: true },
];

/** Submissions already on file, so a history isn't empty before the reviewer tries it. */
export const SEEDED_REVISIONS: { section: string; assignment: string; revisionId: string; daysAgo: number; body?: string; file?: { id: string; filename: string; filesize: number } }[] = [
  { section: "7000000001", assignment: "7100000105", revisionId: "7950000001", daysAgo: 9, file: { id: "7900000001", filename: "Lab Report 3 - Alex Rivera.pdf", filesize: 184_320 } },
  { section: "7000000003", assignment: "7100000304", revisionId: "7950000002", daysAgo: 13, body: "<p>Schools should start later in the morning. Teenagers need more sleep than they get now, and studies of districts that moved their start times show better attendance and grades.</p>" },
];

/* ── Messages ──────────────────────────────────────────────────────────── */

export interface SeedRow {
  /** A teacher's uid, or "me" for the student. */
  author: string;
  hoursAgo: number;
  text: string;
  /** For a teacher's row: still unread until the thread is opened. */
  unread?: boolean;
}

export const SEED_THREADS: { id: string; subject: string; teacher: string; rows: SeedRow[] }[] = [
  {
    id: "7800000001",
    subject: "Lab Report #4 rubric",
    teacher: "8100000001",
    rows: [
      { author: "8100000001", hoursAgo: 75, text: "Hi Alex, the rubric for Lab Report #4 is attached to the assignment. Make sure your error analysis covers both titration trials." },
      { author: "me", hoursAgo: 50, text: "Thanks Dr. Park! Should the error analysis include percent error for each trial or just the average?" },
      { author: "8100000001", hoursAgo: 5, text: "Both, please: percent error for each trial, then which sources of error mattered most. You can still turn it in this week.", unread: true },
    ],
  },
  {
    id: "7800000002",
    subject: "Composición 2 topics",
    teacher: "8100000005",
    rows: [{ author: "8100000005", hoursAgo: 4, text: "Hola Alex, I posted the topics for Composición 2. Pick one and send me your thesis by Wednesday.", unread: true }],
  },
  {
    id: "7800000003",
    subject: "Chapter 6 discussion",
    teacher: "8100000003",
    rows: [{ author: "8100000003", hoursAgo: 26, text: "Reminder: your Chapter 6 discussion post is past due, but I'll accept it through Friday for full credit." }],
  },
  {
    id: "7800000004",
    subject: "Fitness test",
    teacher: "8100000006",
    rows: [{ author: "8100000006", hoursAgo: 52, text: "Great job on the fitness test this week. Your mile time improved by 40 seconds!" }],
  },
  {
    id: "7800000005",
    subject: "Question about Problem Set 7",
    teacher: "8100000002",
    rows: [{ author: "me", hoursAgo: 20, text: "Hi Mr. Okafor, on problem 12, should we use the quadratic formula or complete the square?" }],
  },
];

/* ── Tiny real files ───────────────────────────────────────────────────── */

const encoder = new TextEncoder();

/**
 * A one-page PDF: a heading and lines of text in Helvetica. Written out by
 * hand (five objects and an exact cross-reference table) so it opens in any
 * viewer, including Canva's importer, at well under 2 KB.
 */
export function makePdf(heading: string, lines: string[]): Uint8Array {
  const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, "?").replace(/[\\()]/g, "\\$&");
  const text = [`BT /F1 18 Tf 72 720 Td (${ascii(heading)}) Tj`, "/F1 11 Tf 15 TL T*"];
  for (const line of lines) text.push(`T* (${ascii(line)}) Tj`);
  text.push("ET");
  const stream = text.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length); // ASCII only, so characters are bytes
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) out += `${String(at).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encoder.encode(out);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A small RGB PNG drawn by `pixel`. The image data goes in stored (not
 * compressed) deflate blocks, which every decoder accepts, so no zlib is
 * needed; at 96x72 that's about 21 KB.
 */
export function makePng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Uint8Array {
  const raw = new Uint8Array(height * (width * 3 + 1));
  let at = 0;
  for (let y = 0; y < height; y++) {
    raw[at++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[at++] = r;
      raw[at++] = g;
      raw[at++] = b;
    }
  }
  // zlib: header, stored blocks of at most 65535 bytes, Adler-32.
  const blocks: number[] = [0x78, 0x01];
  let from = 0;
  do {
    const end = Math.min(raw.length, from + 65535);
    const len = end - from;
    const nlen = ~len & 0xffff;
    blocks.push(end >= raw.length ? 1 : 0, len & 0xff, (len >> 8) & 0xff, nlen & 0xff, (nlen >> 8) & 0xff);
    for (let i = from; i < end; i++) blocks.push(raw[i]);
    from = end;
  } while (from < raw.length);
  let a = 1;
  let b = 0;
  for (const v of raw) {
    a = (a + v) % 65521;
    b = (b + a) % 65521;
  }
  blocks.push((b >> 8) & 0xff, b & 0xff, (a >> 8) & 0xff, a & 0xff);
  const idat = Uint8Array.from(blocks);

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB, no interlace

  const chunks: Uint8Array[] = [Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  for (const [type, data] of [["IHDR", ihdr], ["IDAT", idat], ["IEND", new Uint8Array(0)]] as const) {
    const head = new Uint8Array(8);
    new DataView(head.buffer).setUint32(0, data.length);
    head.set(encoder.encode(type), 4);
    const typed = new Uint8Array(4 + data.length);
    typed.set(head.subarray(4));
    typed.set(data, 4);
    const crc = new Uint8Array(4);
    new DataView(crc.buffer).setUint32(0, crc32(typed));
    chunks.push(head, data, crc);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const png = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    png.set(c, pos);
    pos += c.length;
  }
  return png;
}

/** The titration setup diagram: a stand, a burette and a flask of pink solution. */
export function titrationPng(): Uint8Array {
  return makePng(96, 72, (x, y) => {
    if (y >= 66) return [120, 110, 100]; // bench
    if (x >= 20 && x <= 22 && y >= 6) return [90, 90, 95]; // stand
    if (y >= 62 && x >= 12 && x <= 40) return [90, 90, 95]; // stand base
    if (y === 20 && x >= 22 && x <= 46) return [90, 90, 95]; // clamp
    if (x >= 46 && x <= 50 && y >= 6 && y <= 40) return y >= 14 ? [205, 225, 245] : [235, 240, 248]; // burette
    // Flask: a triangle from (48, 46) widening to the base at y = 64.
    if (y >= 46 && y <= 64) {
      const half = 2 + Math.floor((y - 46) * 0.9);
      if (Math.abs(x - 48) <= half) return y >= 54 ? [236, 140, 180] : [228, 236, 244];
    }
    return [250, 248, 242]; // paper
  });
}
