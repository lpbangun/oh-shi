import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getDomain } from "tldts";
import {
  evidenceUrlFor,
  type EdtechPack,
  type EdtechPackRow,
} from "../lib/edtech-pack";

const LASTRound_CSV = path.join(
  process.cwd(),
  "third_party",
  "lastround",
  "lastroundai-ats-company-directory-2026-08.csv"
);
const OUTPUT_PACK = path.join(process.cwd(), "packs", "edtech.json");
const OUTPUT_YIELD = path.join(process.cwd(), "artifacts", "edtech-pack-yield.md");
const WIKIDATA_ENDPOINT = "https://query.wikidata.org/sparql";
const WIKIDATA_TERMS = "https://www.wikidata.org/wiki/Wikidata:Copyright";
const USER_AGENT = "OH-SHI/1.0 edtech-pack-builder (https://ohshi.work/about)";
const LASTRound_ATTRIBUTION =
  "LastRound AI ATS company directory (CC BY 4.0), https://github.com/fyrosofttech/lastroundai-hiring-data";

type LastRoundRow = {
  provider: EdtechPackRow["provider"];
  name: string;
  board_id: string;
};

type YieldStats = {
  lastroundRows: number;
  keywordCandidates: number;
  wikidataEntities: number;
  wikidataMatched: number;
  curatedIncluded: number;
  rejectedFalsePositive: number;
  rejectedNoWebsite: number;
  packRows: number;
};

const REVIEW_RULE =
  "Include LastRound greenhouse/lever/ashby boards when (a) manually curated known education employer, " +
  "(b) company name matches education/learning keywords after false-positive exclusions, or " +
  "(c) Wikidata industry/education entity label matches with website join. " +
  "Reject generic learning false positives (machine learning, campus recruiting, non-education academies). " +
  "Dedup provider+board_id; website must be first-party HTTPS from Wikidata P856 or curated override.";

/** Curated education employers confirmed in LastRound or via public ATS JSON slugs. */
const CURATED: Array<{
  name: string;
  website: string;
  provider: EdtechPackRow["provider"];
  board_id: string;
  employer_kind?: string;
}> = [
  { name: "Coursera", website: "https://www.coursera.org/", provider: "greenhouse", board_id: "coursera", employer_kind: "higher_ed_platform" },
  { name: "Duolingo", website: "https://www.duolingo.com/", provider: "greenhouse", board_id: "duolingo", employer_kind: "language_learning" },
  { name: "Khan Academy", website: "https://www.khanacademy.org/", provider: "greenhouse", board_id: "khanacademy", employer_kind: "nonprofit_learning" },
  { name: "Instructure", website: "https://www.instructure.com/", provider: "ashby", board_id: "instructure", employer_kind: "lms" },
  { name: "Quizlet", website: "https://quizlet.com/", provider: "lever", board_id: "quizlet-2", employer_kind: "study_tools" },
  { name: "ClassDojo", website: "https://www.classdojo.com/", provider: "ashby", board_id: "classdojo", employer_kind: "k12_communication" },
  { name: "Udemy", website: "https://www.udemy.com/", provider: "greenhouse", board_id: "udemy", employer_kind: "online_courses" },
  { name: "MasterClass", website: "https://www.masterclass.com/", provider: "greenhouse", board_id: "masterclass", employer_kind: "online_courses" },
  { name: "Newsela", website: "https://newsela.com/", provider: "greenhouse", board_id: "newsela", employer_kind: "k12_content" },
  { name: "Outschool", website: "https://outschool.com/", provider: "greenhouse", board_id: "outschool", employer_kind: "live_classes" },
  { name: "Renaissance Learning", website: "https://www.renaissance.com/", provider: "greenhouse", board_id: "renaissancelearning-nam", employer_kind: "k12_assessment" },
  { name: "Amplify", website: "https://amplify.com/", provider: "ashby", board_id: "amplify", employer_kind: "curriculum" },
  { name: "Guild", website: "https://www.guildeducation.com/", provider: "greenhouse", board_id: "guild", employer_kind: "workforce_learning" },
  { name: "Degreed", website: "https://degreed.com/", provider: "greenhouse", board_id: "degreed", employer_kind: "workforce_learning" },
  { name: "Docebo", website: "https://www.docebo.com/", provider: "ashby", board_id: "docebo", employer_kind: "lms" },
  { name: "2U", website: "https://2u.com/", provider: "greenhouse", board_id: "2u", employer_kind: "higher_ed_platform" },
  { name: "DataCamp", website: "https://www.datacamp.com/", provider: "greenhouse", board_id: "datacamp", employer_kind: "skills_training" },
  { name: "Brilliant", website: "https://brilliant.org/", provider: "lever", board_id: "brilliant", employer_kind: "stem_learning" },
  { name: "Age of Learning", website: "https://www.ageoflearning.com/", provider: "lever", board_id: "aofl", employer_kind: "early_learning" },
  { name: "Handshake", website: "https://joinhandshake.com/", provider: "ashby", board_id: "handshake", employer_kind: "career_network" },
  { name: "Babbel", website: "https://www.babbel.com/", provider: "ashby", board_id: "babbel", employer_kind: "language_learning" },
  { name: "Clever", website: "https://www.clever.com/", provider: "ashby", board_id: "clever", employer_kind: "k12_platform" },
  { name: "Seesaw", website: "https://web.seesaw.me/", provider: "greenhouse", board_id: "seesaw", employer_kind: "k12_portfolio" },
  { name: "Edpuzzle", website: "https://edpuzzle.com/", provider: "lever", board_id: "edpuzzle", employer_kind: "k12_video" },
  { name: "Skillsoft", website: "https://www.skillsoft.com/", provider: "greenhouse", board_id: "skillsoft", employer_kind: "workforce_learning" },
  { name: "GoStudent", website: "https://gostudent.org/", provider: "greenhouse", board_id: "gostudent", employer_kind: "tutoring" },
  { name: "GiveCampus", website: "https://go.givecampus.com/", provider: "greenhouse", board_id: "givecampus", employer_kind: "higher_ed_fundraising" },
  { name: "Teachable", website: "https://teachable.com/", provider: "greenhouse", board_id: "teachablecareers", employer_kind: "creator_learning" },
  { name: "LearnUpon", website: "https://www.learnupon.com/", provider: "greenhouse", board_id: "learnupon", employer_kind: "lms" },
  { name: "Schoolhouse", website: "https://schoolhouse.world/", provider: "ashby", board_id: "schoolhouse-world", employer_kind: "tutoring" },
  { name: "MagicSchool AI", website: "https://www.magicschool.ai/", provider: "ashby", board_id: "magicschool", employer_kind: "teacher_tools" },
  { name: "Brisk Teaching", website: "https://www.briskteaching.com/", provider: "ashby", board_id: "brisk-teaching", employer_kind: "teacher_tools" },
  { name: "PrairieLearn", website: "https://prairielearn.com/", provider: "ashby", board_id: "prairielearn", employer_kind: "higher_ed_assessment" },
  { name: "Presence", website: "https://www.presence.com/", provider: "greenhouse", board_id: "presencelearning", employer_kind: "special_ed_services" },
  { name: "Follett Software", website: "https://www.follettsoftware.com/", provider: "greenhouse", board_id: "follettsoftware", employer_kind: "k12_ops" },
  { name: "SchoolStatus", website: "https://www.schoolstatus.com/", provider: "greenhouse", board_id: "schoolstatus", employer_kind: "k12_communication" },
  { name: "Teachstone", website: "https://teachstone.com/", provider: "greenhouse", board_id: "teachstone", employer_kind: "teacher_coaching" },
  { name: "ACI Learning", website: "https://www.acilearning.com/", provider: "greenhouse", board_id: "acilearning", employer_kind: "it_training" },
  { name: "Learneo", website: "https://www.learneo.com/", provider: "greenhouse", board_id: "learneo", employer_kind: "writing_tools" },
  { name: "Parallel", website: "https://www.parallellearning.com/", provider: "greenhouse", board_id: "parallellearning", employer_kind: "special_ed_services" },
  { name: "Relay Graduate School of Education", website: "https://relay.edu/", provider: "greenhouse", board_id: "relaygraduateschoolofeducation", employer_kind: "teacher_prep" },
  { name: "Success Academy", website: "https://www.successacademies.org/", provider: "greenhouse", board_id: "successacademycharterschool", employer_kind: "charter_school" },
  { name: "ACCEL Schools", website: "https://accelschools.com/", provider: "greenhouse", board_id: "accelschools", employer_kind: "charter_school" },
  { name: "Nightingale College", website: "https://nightingale.edu/", provider: "greenhouse", board_id: "nightingalecollege", employer_kind: "higher_ed" },
  { name: "Michigan Online School", website: "https://www.michiganonlineschool.org/", provider: "greenhouse", board_id: "mos", employer_kind: "online_school" },
  { name: "Product School", website: "https://productschool.com/", provider: "greenhouse", board_id: "productschool", employer_kind: "professional_training" },
  { name: "Aaron School", website: "https://www.aaronschool.org/", provider: "ashby", board_id: "aaron-school", employer_kind: "special_ed_school" },
  { name: "Green Tree School & Services", website: "https://www.greentreeschool.com/", provider: "ashby", board_id: "green-tree-school-and-services", employer_kind: "special_ed_school" },
  { name: "Prodigy Education", website: "https://www.prodigygame.com/", provider: "ashby", board_id: "prodigy-education", employer_kind: "k12_learning_games" },
  { name: "Rebecca School", website: "https://www.rebeccaschool.org/", provider: "ashby", board_id: "rebecca-school", employer_kind: "special_ed_school" },
  { name: "Rivermont Schools", website: "https://rivermontschools.com/", provider: "ashby", board_id: "rivermont-schools", employer_kind: "special_ed_school" },
  { name: "The Learning Spectrum", website: "https://thelearningspectrum.com/", provider: "ashby", board_id: "the-learning-spectrum", employer_kind: "special_ed_school" },
  { name: "The Pinnacle School", website: "https://www.thepinnacleschool.org/", provider: "ashby", board_id: "the-pinnacle-school", employer_kind: "special_ed_school" },
  { name: "The Spire School", website: "https://www.spireschool.org/", provider: "ashby", board_id: "the-spire-school", employer_kind: "special_ed_school" },
  { name: "New Story Schools (OH)", website: "https://newstoryschools.com/", provider: "ashby", board_id: "new-story-schools-oh", employer_kind: "special_ed_school" },
  { name: "New Story Schools (PA)", website: "https://newstoryschools.com/", provider: "ashby", board_id: "new-story-schools-pa", employer_kind: "special_ed_school" },
  { name: "Apollo Education Systems", website: "https://www.apolloed.com/", provider: "greenhouse", board_id: "apollo", employer_kind: "k12_ops" },
  { name: "Array Education", website: "https://www.arrayed.com/", provider: "greenhouse", board_id: "arrayeducation", employer_kind: "higher_ed" },
  { name: "Constellation Schools", website: "https://www.constellationschools.com/", provider: "greenhouse", board_id: "constellationschools", employer_kind: "charter_school" },
  { name: "Cotulla Education", website: "https://www.cotullaeducation.com/", provider: "greenhouse", board_id: "cotullaeducation", employer_kind: "higher_ed" },
  { name: "Dr. Richard Izquierdo Health & Science Charter School", website: "https://www.drizquierdocharterschools.org/", provider: "greenhouse", board_id: "drizquierdocharterschools", employer_kind: "charter_school" },
  { name: "Early Learning Academies", website: "https://www.earlylearningacademies.com/", provider: "greenhouse", board_id: "ela", employer_kind: "early_learning" },
  { name: "Excel Learning Center", website: "https://www.excellearningcenter.com/", provider: "greenhouse", board_id: "excel", employer_kind: "early_learning" },
  { name: "Guidepost Global Education Asia", website: "https://www.guideposteducation.com/", provider: "greenhouse", board_id: "gge-asia", employer_kind: "montessori" },
  { name: "Inspira Education", website: "https://www.inspiraeducationgroup.com/", provider: "greenhouse", board_id: "inspiraeducation", employer_kind: "tutoring" },
  { name: "Learning Safari", website: "https://www.learningsafari.com/", provider: "greenhouse", board_id: "learningsafari", employer_kind: "early_learning" },
  { name: "SEO (Sponsors for Educational Opportunity)", website: "https://www.seo-usa.org/", provider: "greenhouse", board_id: "sponsorsforeducationalopportunity", employer_kind: "nonprofit_education" },
  { name: "The AI Education Project", website: "https://www.aiedu.org/", provider: "greenhouse", board_id: "aiedu", employer_kind: "nonprofit_education" },
  { name: "The ANA Educational Foundation", website: "https://www.aefonline.org/", provider: "greenhouse", board_id: "aef", employer_kind: "nonprofit_education" },
  { name: "The Children's Corner Learning Center", website: "https://www.childrenscorner.com/", provider: "greenhouse", board_id: "childrenscorner", employer_kind: "early_learning" },
  { name: "TutorMe", website: "https://tutorme.com/", provider: "greenhouse", board_id: "tutorme", employer_kind: "tutoring" },
  { name: "UMA Education", website: "https://www.uma.edu/", provider: "greenhouse", board_id: "umaeducationinc", employer_kind: "higher_ed" },
  { name: "University of Cleveland Preparatory School", website: "https://www.clevelandpreparatoryschool.org/", provider: "greenhouse", board_id: "universityofclevelandpreparatoryschool", employer_kind: "charter_school" },
  { name: "Wonderschool", website: "https://www.wonderschool.com/", provider: "greenhouse", board_id: "wonderschool", employer_kind: "early_learning" },
  { name: "360Learning", website: "https://360learning.com/", provider: "lever", board_id: "360learning", employer_kind: "lms" },
  { name: "Challenge Preparatory Charter School", website: "https://www.challengecharterschools.org/", provider: "lever", board_id: "challengecharterschools", employer_kind: "charter_school" },
  { name: "Freedom Preparatory Academy Charter Schools", website: "https://www.freedomprep.net/", provider: "lever", board_id: "freedomprep", employer_kind: "charter_school" },
  { name: "Head-Royce School", website: "https://www.headroyce.org/", provider: "lever", board_id: "headroyce", employer_kind: "independent_school" },
  { name: "Heartworks Early Education", website: "https://www.heartworksvt.com/", provider: "lever", board_id: "heartworksvt", employer_kind: "early_learning" },
  { name: "Intrepid College Prep Schools", website: "https://www.intrepidcollegeprep.org/", provider: "lever", board_id: "intrepidcollegeprep", employer_kind: "charter_school" },
  { name: "KIPP SoCal Public Schools", website: "https://www.kippsocal.org/", provider: "lever", board_id: "kippsocal", employer_kind: "charter_school" },
  { name: "Mastery Charter Schools", website: "https://www.masterycharter.org/", provider: "lever", board_id: "masterycharter", employer_kind: "charter_school" },
  { name: "Nevada State High School", website: "https://www.earlycollegenv.com/", provider: "lever", board_id: "NSHS", employer_kind: "early_college" },
  { name: "NOLA Public Schools", website: "https://www.nolapublicschools.com/", provider: "lever", board_id: "nolapublicschools", employer_kind: "public_school_district" },
  { name: "Rocketship Public Schools", website: "https://www.rocketshipschools.org/", provider: "lever", board_id: "rocketship", employer_kind: "charter_school" },
  { name: "SAR Academy & SAR High School", website: "https://www.saracademy.org/", provider: "lever", board_id: "sar", employer_kind: "independent_school" },
  { name: "Sora Schools", website: "https://www.soraschools.com/", provider: "lever", board_id: "soraschools", employer_kind: "online_school" },
  { name: "Strada Education Foundation", website: "https://www.stradaeducation.org/", provider: "lever", board_id: "stradaeducation", employer_kind: "nonprofit_education" },
  { name: "The Menta Education Group", website: "https://www.menta.org/", provider: "lever", board_id: "menta", employer_kind: "special_ed_school" },
  { name: "Williamsburg Learning", website: "https://www.williamsburglearning.org/", provider: "lever", board_id: "williamsburglearning", employer_kind: "online_school" },
  { name: "Renaissance Learning EMEA APAC", website: "https://www.renaissance.com/", provider: "greenhouse", board_id: "renaissancelearning-emea", employer_kind: "k12_assessment" },
];

const FALSE_POSITIVE_PATTERNS = [
  /\bmachine learning\b/i,
  /\bdeep learning\b/i,
  /\bunlearn\b/i,
  /\bbrilliant earth\b/i,
  /\bcanvas medical\b/i,
  /\bcanvas forum\b/i,
  /\bcanvas worldwide\b/i,
  /\bbella\+canvas\b/i,
  /\bguild garage\b/i,
  /\bgelber group handshake\b/i,
  /\bgenedx\b/i,
  /\bcaredx\b/i,
  /\btelemed\b/i,
  /\bcampus recruiting\b/i,
  /\bcampus partner\b/i,
  /\buniversity jobs\b/i,
  /\buniversity job board\b/i,
  /\buniversity programs?\b/i,
  /\bearly career paths?\b/i,
  /\bstudents? graduates?\b/i,
  /\bresume drop\b/i,
  /\bnot advertised\b/i,
  /\btrading\b/i,
  /\bhedge fund\b/i,
  /\bfinancial\b/i,
  /\bbank\b/i,
  /\binsurance\b/i,
  /\blaw firm\b/i,
  /\brecruiting school\b/i,
  /\brobot learning company\b/i,
  /\blinkedin\b/i,
  /\bharvard university\b/i,
  /\bgeorge m[a]?son university\b/i,
  /\bklaviyo campus\b/i,
  /\bgeneral atlantic\b/i,
  /\bflow traders\b/i,
  /\bexoduspoint\b/i,
  /\bchicago trading\b/i,
  /\btenstorrent university\b/i,
  /\bradix trading\b/i,
  /\bsolomon partners\b/i,
  /\bmorgan & morgan\b/i,
  /\bbedi partnerships\b/i,
  /\budemybedi\b/i,
  /\bguild\.ai\b/i,
  /\brenaissance learning emea\b/i,
];

const EDTECH_KEYWORD_PATTERNS = [
  /\bedtech\b/i,
  /\beducation(?:al)?\b/i,
  /\blearning\b/i,
  /\bschool(?:s|house)?\b/i,
  /\bstudent\b/i,
  /\btutor(?:ing|s)?\b/i,
  /\bcurriculum\b/i,
  /\bclassroom\b/i,
  /\bteach(?:er|able|ing|stone)?\b/i,
  /\bacademic\b/i,
  /\bliteracy\b/i,
  /\bassessment\b/i,
  /\blms\b/i,
  /\bonline school\b/i,
  /\bcharter school\b/i,
  /\bgraduate school of education\b/i,
  /\bearly learning\b/i,
  /\blanguage learning\b/i,
  /\bcourseware\b/i,
  /\bcollege prep\b/i,
  /\bk-?12\b/i,
  /\bhigher ed\b/i,
  /\buniversity\b/i,
  /\bcampus for\b/i,
  /\btraining academy\b/i,
  /\blearning center\b/i,
  /\blearning academy\b/i,
  /\blearning network\b/i,
  /\blearning commons\b/i,
  /\blearning safari\b/i,
  /\bproduct school\b/i,
  /\bskillsoft\b/i,
  /\bpluralsight\b/i,
  /\bgivecampus\b/i,
  /\bgostudent\b/i,
  /\bnewsela\b/i,
  /\bkahoot\b/i,
  /\bcodecademy\b/i,
  /\bchegg\b/i,
  /\binstructure\b/i,
  /\bquizlet\b/i,
  /\bclassdojo\b/i,
  /\boutschool\b/i,
  /\bmasterclass\b/i,
  /\bdegreed\b/i,
  /\bdocebo\b/i,
  /\bdatacamp\b/i,
  /\bcoursera\b/i,
  /\bduolingo\b/i,
  /\bkhan academy\b/i,
  /\bamplify\b/i,
  /\bhandshake\b/i,
  /\bbabbel\b/i,
  /\bclever\b/i,
  /\bseesaw\b/i,
  /\bedpuzzle\b/i,
  /\bmagicschool\b/i,
  /\bprairielearn\b/i,
  /\bpresence learning\b/i,
  /\bfollett\b/i,
  /\bschoolstatus\b/i,
  /\bteachstone\b/i,
  /\baci learning\b/i,
  /\blearneo\b/i,
  /\bparallel learning\b/i,
  /\brelay\b/i,
  /\bsuccess academy\b/i,
  /\baccels? schools\b/i,
  /\bnightingale college\b/i,
  /\bbrisk teaching\b/i,
  /\bschoolhouse\b/i,
];

const WIKIDATA_QUERIES = [
  {
    id: "edtech-industry",
    query: `SELECT ?company ?companyLabel ?website WHERE {
      ?company wdt:P452 wd:Q11862829;
        wdt:P856 ?website.
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    } ORDER BY ?company ?website LIMIT 800`,
  },
  {
    id: "education-company",
    query: `SELECT ?company ?companyLabel ?website WHERE {
      ?company wdt:P31/wdt:P279* wd:Q38723;
        wdt:P856 ?website.
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    } ORDER BY ?company ?website LIMIT 800`,
  },
] as const;

function normalizeName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalWebsite(url: string) {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "https:") return "";
    const domain = getDomain(parsed.hostname);
    if (!domain) return "";
    return `https://${domain}/`;
  } catch {
    return "";
  }
}

function parseCsvLine(line: string) {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      values.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  values.push(current);
  return values;
}

async function readLastRoundRows() {
  const raw = await readFile(LASTRound_CSV, "utf8");
  const lines = raw.trim().split("\n");
  const rows: LastRoundRow[] = [];
  for (const line of lines.slice(1)) {
    const [vendor, name, boardSlug] = parseCsvLine(line);
    const provider = vendor.trim().toLowerCase();
    if (!["ashby", "greenhouse", "lever"].includes(provider)) continue;
    const board_id = boardSlug.trim();
    if (!board_id) continue;
    rows.push({
      provider: provider as EdtechPackRow["provider"],
      name: name.trim(),
      board_id,
    });
  }
  return rows;
}

function isFalsePositive(name: string) {
  return FALSE_POSITIVE_PATTERNS.some((pattern) => pattern.test(name));
}

function matchesEdtechKeyword(name: string) {
  if (isFalsePositive(name)) return false;
  if (/\blearning\b/i.test(name) && /\b(machine|deep|robot|un)\b/i.test(name)) return false;
  return EDTECH_KEYWORD_PATTERNS.some((pattern) => pattern.test(name));
}

type WikidataEntity = {
  label: string;
  normalizedLabel: string;
  website: string;
};

async function queryWikidata(query: string) {
  const url = new URL(WIKIDATA_ENDPOINT);
  url.searchParams.set("query", query);
  url.searchParams.set("format", "json");
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(url, {
      headers: {
        Accept: "application/sparql-results+json",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 429 && attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
      continue;
    }
    if (!response.ok) {
      throw new Error(`Wikidata query failed with HTTP ${response.status}`);
    }
    const payload = await response.json() as {
      results?: {
        bindings?: Array<{
          companyLabel?: { value?: string };
          website?: { value?: string };
        }>;
      };
    };
    return payload.results?.bindings || [];
  }
  return [];
}

async function loadWikidataWebsites() {
  const byLabel = new Map<string, WikidataEntity>();
  let entityCount = 0;
  for (const source of WIKIDATA_QUERIES) {
    let bindings: Awaited<ReturnType<typeof queryWikidata>> = [];
    try {
      bindings = await queryWikidata(source.query);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    } catch (error) {
      console.warn(`Wikidata query ${source.id} skipped: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const row of bindings) {
      const label = row.companyLabel?.value || "";
      const website = canonicalWebsite(row.website?.value || "");
      if (!label || !website) continue;
      const normalizedLabel = normalizeName(label);
      const current = byLabel.get(normalizedLabel);
      if (!current || website.length < current.website.length) {
        byLabel.set(normalizedLabel, { label, normalizedLabel, website });
        entityCount += 1;
      }
    }
  }
  return { byLabel, entityCount };
}

function websiteForName(name: string, wikidata: Map<string, WikidataEntity>) {
  const normalized = normalizeName(name);
  const direct = wikidata.get(normalized);
  return direct?.website || "";
}

function toPackRow(
  input: {
    name: string;
    website: string;
    provider: EdtechPackRow["provider"];
    board_id: string;
    employer_kind?: string;
  }
): EdtechPackRow {
  return {
    name: input.name,
    website: input.website,
    provider: input.provider,
    board_id: input.board_id,
    evidence_url: evidenceUrlFor(input.provider, input.board_id),
    vertical: "edtech",
    employer_kind: input.employer_kind,
  };
}

async function main() {
  const generatedAt = new Date().toISOString();
  const lastroundRows = await readLastRoundRows();
  const { byLabel: wikidata, entityCount } = await loadWikidataWebsites();

  const stats: YieldStats = {
    lastroundRows: lastroundRows.length,
    keywordCandidates: 0,
    wikidataEntities: entityCount,
    wikidataMatched: 0,
    curatedIncluded: 0,
    rejectedFalsePositive: 0,
    rejectedNoWebsite: 0,
    packRows: 0,
  };

  const curatedByBoard = new Map(
    CURATED.map((row) => [`${row.provider}:${row.board_id.toLowerCase()}`, row])
  );
  const rows = new Map<string, EdtechPackRow>();

  for (const curated of CURATED) {
    const key = `${curated.provider}:${curated.board_id.toLowerCase()}`;
    rows.set(key, toPackRow(curated));
    stats.curatedIncluded += 1;
  }

  for (const candidate of lastroundRows) {
    const key = `${candidate.provider}:${candidate.board_id.toLowerCase()}`;
    if (rows.has(key)) continue;

    if (isFalsePositive(candidate.name)) {
      stats.rejectedFalsePositive += 1;
      continue;
    }

    const keywordMatch = matchesEdtechKeyword(candidate.name);
    if (!keywordMatch) continue;
    stats.keywordCandidates += 1;

    const curated = curatedByBoard.get(key);
    const wikidataWebsite = websiteForName(candidate.name, wikidata);
    const website = curated?.website || wikidataWebsite;
    if (!website) {
      stats.rejectedNoWebsite += 1;
      continue;
    }
    if (wikidataWebsite && !curated) stats.wikidataMatched += 1;

    rows.set(key, toPackRow({
      name: curated?.name || candidate.name,
      website,
      provider: candidate.provider,
      board_id: candidate.board_id,
      employer_kind: curated?.employer_kind || (wikidataWebsite ? "wikidata_reviewed" : "keyword_reviewed"),
    }));
  }

  const packRows = [...rows.values()].sort((left, right) =>
    left.name.localeCompare(right.name) ||
    left.provider.localeCompare(right.provider) ||
    left.board_id.localeCompare(right.board_id)
  );
  stats.packRows = packRows.length;

  const pack: EdtechPack = {
    schemaVersion: "1.0",
    vertical: "edtech",
    generatedAt,
    reviewRule: REVIEW_RULE,
    attribution: {
      lastround: LASTRound_ATTRIBUTION,
      lastroundLicense: "CC BY 4.0",
      lastroundUrl: "https://github.com/fyrosofttech/lastroundai-hiring-data",
      wikidata: `Wikidata structured data (CC0), ${WIKIDATA_TERMS}`,
    },
    rows: packRows,
  };

  await mkdir(path.dirname(OUTPUT_PACK), { recursive: true });
  await writeFile(OUTPUT_PACK, `${JSON.stringify(pack, null, 2)}\n`, "utf8");

  const yieldDoc = `# Edtech pack yield (Gate 1)

Generated: ${generatedAt}

## Coverage comparison

Edtech.com benchmark (checked 2026-09-19): ~756 companies / ~2,003 open jobs. This pack is **not** a scrape of Edtech.com; it is a precision-reviewed subset built from legal ATS directory + Wikidata identity joins.

## Builder counts

| Stage | Count |
| --- | ---: |
| LastRound greenhouse/lever/ashby rows scanned | ${stats.lastroundRows} |
| Keyword-matched candidates (pre-website) | ${stats.keywordCandidates} |
| Wikidata education/edtech entities loaded | ${stats.wikidataEntities} |
| Rows with Wikidata website join | ${stats.wikidataMatched} |
| Curated must-include employers | ${stats.curatedIncluded} |
| Rejected false positives | ${stats.rejectedFalsePositive} |
| Rejected (no first-party website) | ${stats.rejectedNoWebsite} |
| **Reviewed rows in pack** | **${stats.packRows}** |

## Review rule

${REVIEW_RULE}

## Attribution

- ${LASTRound_ATTRIBUTION}
- Wikidata CC0 website evidence (${WIKIDATA_TERMS})
`;

  await mkdir(path.dirname(OUTPUT_YIELD), { recursive: true });
  await writeFile(OUTPUT_YIELD, yieldDoc, "utf8");

  console.log(JSON.stringify({
    destination: OUTPUT_PACK,
    yield: OUTPUT_YIELD,
    stats,
    mustInclude: {
      coursera: packRows.some((row) => row.board_id === "coursera"),
      duolingo: packRows.some((row) => row.board_id === "duolingo"),
    },
  }, null, 2));
}

await main();
