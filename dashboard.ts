/**
 * Keybr Leerkrachtendashboard — Webserver
 *
 * Draait als aparte container naast keybr.
 * Leest de gedeelde SQLite-database en binaire stats-bestanden uit.
 *
 * Endpoints:
 *   GET  /                        → HTML dashboard met overzicht
 *   GET  /admin                   → Admin pagina (leerlingen beheren)
 *   GET  /api/data                → JSON met alle leerlingdata
 *   POST /api/users               → Leerling aanmaken
 *   DELETE /api/users/:id         → Leerling verwijderen
 *   PUT /api/users/:id/settings   → Instellingen aanpassen
 */

import * as fs from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import * as path from "node:path";
import Database from "better-sqlite3"; // eslint-disable-line n/no-extraneous-import

// --- Configuratie ---

const DATA_DIR = process.env.DATA_DIR || "./data";
const PORT = parseInt(process.env.PORT || "3001", 10);
const ADMIN_CODE = process.env.ADMIN_CODE || "";
const DB_PATH = path.join(DATA_DIR, "database.sqlite");
const STATS_DIR = path.join(DATA_DIR, "user_stats");
const SETTINGS_DIR = path.join(DATA_DIR, "user_settings");

// --- VLQ decoder (Variable-Length Quantity, keybr binair formaat) ---

class BinaryReader {
  private view: DataView;
  private offset: number;

  constructor(buffer: ArrayBuffer) {
    this.view = new DataView(buffer);
    this.offset = 0;
  }

  get remaining(): number {
    return this.view.byteLength - this.offset;
  }

  readUint8(): number {
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  readUint32(): number {
    const value = this.view.getUint32(this.offset, false); // big-endian
    this.offset += 4;
    return value;
  }

  readVLQ(): number {
    // Keybr uses big-endian VLQ: most-significant group first
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const byte = this.view.getUint8(this.offset);
      this.offset += 1;
      value = ((value << 7) | (byte & 0x7f)) >>> 0;
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error("VLQ too long");
  }

  skip(bytes: number): void {
    this.offset += bytes;
  }
}

// --- Keybr binair formaat parser ---

type SampleData = {
  codePoint: number;
  hits: number;
  misses: number;
};

type TypingResult = {
  timestamp: Date;
  timeMs: number;
  length: number;
  errors: number;
  samples: SampleData[];
};

function parseStatsFile(filePath: string): TypingResult[] {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length === 0) return [];

  const reader = new BinaryReader(
    buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ),
  );
  const results: TypingResult[] = [];

  // Skip 8-byte file header: signature (4 bytes) + version (4 bytes)
  if (reader.remaining < 8) return [];
  reader.skip(8);

  try {
    while (reader.remaining >= 6) {
      reader.readUint8(); // layoutId
      reader.readUint8(); // textTypeId
      const timestampSec = reader.readUint32();
      const timeMs = reader.readVLQ();
      const length = reader.readVLQ();
      const errors = reader.readVLQ();
      const sampleCount = reader.readVLQ();

      const samples: SampleData[] = [];
      for (let i = 0; i < sampleCount; i++) {
        const codePoint = reader.readVLQ();
        const hits = reader.readVLQ();
        const misses = reader.readVLQ();
        reader.readVLQ(); // time to type — niet gebruikt
        samples.push({ codePoint, hits, misses });
      }

      results.push({
        timestamp: new Date(timestampSec * 1000),
        timeMs,
        length,
        errors,
        samples,
      });
    }
  } catch {
    // Einde van bestand of parse-fout — geef terug wat we hebben
  }

  return results;
}

// --- Gebruikerspad berekenen (keybr formaat: /000/012/000012345) ---

function userPath(baseDir: string, userId: number): string {
  const padded = userId.toString().padStart(9, "0");
  const dir1 = padded.slice(0, 3);
  const dir2 = padded.slice(3, 6);
  return path.join(baseDir, dir1, dir2, padded);
}

// --- Layout-namen mapping ---

const LAYOUT_NAMES: Record<string, string> = {
  "en-us": "QWERTY (US)",
  "en-dvorak": "Dvorak",
  "en-colemak": "Colemak",
  "nl-nl": "QWERTY (NL)",
  "nl-be": "AZERTY (BE)",
  "fr-fr": "AZERTY (FR)",
  "fr-ca": "QWERTY (FR-CA)",
  "de-de": "QWERTZ (DE)",
};

function readUserSettings(userId: number): {
  layout: string;
  language: string;
} {
  const settingsPath = userPath(SETTINGS_DIR, userId);
  try {
    if (fs.existsSync(settingsPath)) {
      const json = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      return {
        layout: json["keyboard.layout"] || "-",
        language: json["keyboard.language"] || "-",
      };
    }
  } catch {
    // Onleesbaar bestand — standaardwaarden teruggeven
  }
  return { layout: "-", language: "-" };
}

function formatLayout(layoutId: string): string {
  if (layoutId === "-") return '<span class="geen">standaard</span>';
  return LAYOUT_NAMES[layoutId] || layoutId;
}

function formatChar(cp: number): string {
  if (cp === 32) return "spatie";
  if (cp === 9) return "tab";
  return String.fromCodePoint(cp);
}

function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

// --- Data ophalen ---

type UserRow = {
  id: number;
  email: string | null;
  name: string | null;
  created_at: string;
};

type UserSummary = {
  id: number;
  naam: string;
  email: string;
  layout: string;
  taal: string;
  sessies: number;
  totaleMinuten: number;
  gemCPM: number;
  gemNauwkeurigheid: number;
  laatstActief: string;
  aantalKarakters: number;
  nieuwsteKarakter: string;
  probleemLetter: string;
  streak: number;
  actieveDagen: number;
};

function getSummaries(): UserSummary[] {
  if (!fs.existsSync(DB_PATH)) return [];

  const db = new Database(DB_PATH, { readonly: true });
  const users = db
    .prepare("SELECT id, email, name, created_at FROM User")
    .all() as UserRow[];
  const summaries: UserSummary[] = [];

  for (const user of users) {
    const statsPath = userPath(STATS_DIR, user.id);
    const settings = readUserSettings(user.id);
    let results: TypingResult[] = [];

    if (fs.existsSync(statsPath)) {
      results = parseStatsFile(statsPath);
    }

    if (results.length === 0) {
      summaries.push({
        id: user.id,
        naam: user.name || "(anoniem)",
        email: user.email || "-",
        layout: settings.layout,
        taal: settings.language,
        sessies: 0,
        totaleMinuten: 0,
        gemCPM: 0,
        gemNauwkeurigheid: 0,
        laatstActief: "-",
        aantalKarakters: 0,
        nieuwsteKarakter: "-",
        probleemLetter: "-",
        streak: 0,
        actieveDagen: 0,
      });
      continue;
    }

    const totaleMs = results.reduce((sum, r) => sum + r.timeMs, 0);
    const totaleKarakters = results.reduce((sum, r) => sum + r.length, 0);
    const totaleErrors = results.reduce((sum, r) => sum + r.errors, 0);
    const laatsteResult = results.reduce((latest, r) =>
      r.timestamp > latest.timestamp ? r : latest,
    );

    // Per-codepoint aggregatie: hits, misses, eerste verschijning
    const cpStats = new Map<
      number,
      { hits: number; misses: number; firstSeen: Date }
    >();
    const dagen = new Set<string>();
    for (const r of results) {
      dagen.add(localDateKey(r.timestamp));
      for (const s of r.samples) {
        const existing = cpStats.get(s.codePoint);
        if (existing) {
          existing.hits += s.hits;
          existing.misses += s.misses;
          if (r.timestamp < existing.firstSeen)
            existing.firstSeen = r.timestamp;
        } else {
          cpStats.set(s.codePoint, {
            hits: s.hits,
            misses: s.misses,
            firstSeen: r.timestamp,
          });
        }
      }
    }

    // Nieuwste karakter = codepoint met de meest recente eerste verschijning
    let nieuwsteCp = -1;
    let nieuwsteDate = new Date(0);
    for (const [cp, stat] of cpStats) {
      if (stat.firstSeen > nieuwsteDate) {
        nieuwsteDate = stat.firstSeen;
        nieuwsteCp = cp;
      }
    }

    // Probleemletter = hoogste miss-ratio met minimaal 10 aanslagen
    const MIN_AANSLAGEN = 10;
    let probleemCp = -1;
    let probleemRatio = 0;
    let probleemPct = 0;
    for (const [cp, stat] of cpStats) {
      const totaal = stat.hits + stat.misses;
      if (totaal < MIN_AANSLAGEN) continue;
      const ratio = stat.misses / totaal;
      if (ratio > probleemRatio) {
        probleemRatio = ratio;
        probleemPct = Math.round(ratio * 100);
        probleemCp = cp;
      }
    }

    // Streak: tel opeenvolgende dagen terug vanaf laatste actieve dag,
    // mits die vandaag of gisteren is (anders is de reeks gebroken)
    const vandaagKey = localDateKey(new Date());
    const gisterenKey = localDateKey(new Date(Date.now() - 86400000));
    const sortedDagen = Array.from(dagen).sort();
    const laatsteDag = sortedDagen[sortedDagen.length - 1];
    let streak = 0;
    if (laatsteDag === vandaagKey || laatsteDag === gisterenKey) {
      const cursor = new Date(laatsteDag + "T12:00:00");
      while (dagen.has(localDateKey(cursor))) {
        streak++;
        cursor.setDate(cursor.getDate() - 1);
      }
    }

    summaries.push({
      id: user.id,
      naam: user.name || "(anoniem)",
      email: user.email || "-",
      layout: settings.layout,
      taal: settings.language,
      sessies: results.length,
      totaleMinuten: Math.round((totaleMs / 60000) * 10) / 10,
      gemCPM:
        totaleMs > 0 ? Math.round((totaleKarakters / totaleMs) * 60000) : 0,
      gemNauwkeurigheid:
        totaleKarakters > 0
          ? Math.round(
              ((totaleKarakters - totaleErrors) / totaleKarakters) * 100,
            )
          : 0,
      laatstActief: laatsteResult.timestamp.toLocaleDateString("nl-BE"),
      aantalKarakters: cpStats.size,
      nieuwsteKarakter: nieuwsteCp >= 0 ? formatChar(nieuwsteCp) : "-",
      probleemLetter:
        probleemCp >= 0 ? `${formatChar(probleemCp)} (${probleemPct}%)` : "-",
      streak,
      actieveDagen: dagen.size,
    });
  }

  db.close();
  return summaries;
}

// --- HTML genereren ---

function generateHtml(summaries: UserSummary[]): string {
  const rows = summaries
    .map(
      (s) => `
        <tr>
          <td>${esc(s.naam)}</td>
          <td>${formatLayout(s.layout)}</td>
          <td class="num">${s.sessies}</td>
          <td class="num">${s.totaleMinuten}</td>
          <td class="num">${s.gemCPM}</td>
          <td class="num">${s.gemNauwkeurigheid}%</td>
          <td class="num">${s.aantalKarakters}</td>
          <td class="char">${esc(s.nieuwsteKarakter)}</td>
          <td>${esc(s.probleemLetter)}</td>
          <td class="num">${s.streak}</td>
          <td class="num">${s.actieveDagen}</td>
          <td>${s.laatstActief}</td>
        </tr>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Keybr Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      max-width: 1280px;
      margin: 2rem auto;
      padding: 0 1rem;
      color: #1a1a1a;
      background: #fafafa;
    }
    h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
    .meta { color: #666; margin-bottom: 1.5rem; font-size: 0.9rem; }
    .refresh { color: #0066cc; text-decoration: none; margin-left: 1rem; }
    .refresh:hover { text-decoration: underline; }
    table { border-collapse: collapse; width: 100%; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    th, td { padding: 0.65rem 0.75rem; text-align: left; border-bottom: 1px solid #eee; }
    th { background: #f5f5f5; font-weight: 600; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.03em; color: #555; }
    td { font-size: 0.92rem; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #f9f9f9; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .char { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-weight: 600; text-align: center; }
    .geen { color: #999; }
    .footer { margin-top: 1rem; color: #999; font-size: 0.8rem; }
  </style>
</head>
<body>
  <h1>Keybr Leerkrachtendashboard</h1>
  <p class="meta">
    ${summaries.length} leerlingen &middot;
    ${new Date().toLocaleString("nl-BE")}
    <a class="refresh" href="/">Vernieuwen</a> &middot;
    <a class="refresh" href="/admin">Admin</a>
  </p>
  <table>
    <thead>
      <tr>
        <th>Naam</th>
        <th>Layout</th>
        <th class="num">Sessies</th>
        <th class="num">Minuten</th>
        <th class="num">CPM</th>
        <th class="num">Nauwkeurigheid</th>
        <th class="num" title="Aantal unieke karakters dat de leerling al heeft geoefend">Karakters</th>
        <th title="Karakter dat het meest recent voor het eerst werd geoefend">Nieuwste</th>
        <th title="Karakter met de hoogste foutmarge (min. 10 aanslagen)">Probleem</th>
        <th class="num" title="Aantal opeenvolgende dagen geoefend t.e.m. vandaag of gisteren">Streak</th>
        <th class="num" title="Totaal aantal verschillende dagen waarop de leerling oefende">Dagen</th>
        <th>Laatst actief</th>
      </tr>
    </thead>
    <tbody>${rows || '<tr><td colspan="12" class="geen">Nog geen leerlingen gevonden. Wacht tot ze een account aanmaken en beginnen typen.</td></tr>'}
    </tbody>
  </table>
  <p class="footer">CPM = karakters per minuut. Data wordt live gelezen bij elke paginalading.</p>
</body>
</html>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- Admin: gebruikersbeheer ---

function getDb(): InstanceType<typeof Database> {
  return new Database(DB_PATH);
}

function createUser(name: string): { id: number; name: string; email: string } {
  const db = getDb();
  try {
    const email = `${name.toLowerCase().replace(/[^a-z0-9.]/g, "")}@local`;
    // Controleer of naam al bestaat
    const existing = db.prepare("SELECT id FROM user WHERE name = ?").get(name);
    if (existing) throw new Error(`Leerling "${name}" bestaat al`);
    // Controleer of email al bestaat, voeg nummer toe indien nodig
    let finalEmail = email;
    for (
      let i = 1;
      db.prepare("SELECT id FROM user WHERE email = ?").get(finalEmail);
      i++
    ) {
      finalEmail = email.replace("@local", `${i}@local`);
    }
    const result = db
      .prepare(
        "INSERT INTO user (email, name, created_at) VALUES (?, ?, datetime('now'))",
      )
      .run(finalEmail, name);
    return { id: result.lastInsertRowid as number, name, email: finalEmail };
  } finally {
    db.close();
  }
}

function deleteUser(userId: number): void {
  const db = getDb();
  try {
    const user = db.prepare("SELECT id FROM user WHERE id = ?").get(userId);
    if (!user) throw new Error("Leerling niet gevonden");
    // Verwijder uit database (CASCADE verwijdert ook external_ids en orders)
    db.prepare("DELETE FROM user WHERE id = ?").run(userId);
  } finally {
    db.close();
  }
  // Verwijder settings-bestand
  const settingsPath = userPath(SETTINGS_DIR, userId);
  try {
    fs.unlinkSync(settingsPath);
  } catch {
    /* negeer als bestand niet bestaat */
  }
  // Verwijder stats-bestand
  const statsPath = userPath(STATS_DIR, userId);
  try {
    fs.unlinkSync(statsPath);
  } catch {
    /* negeer als bestand niet bestaat */
  }
}

function writeUserSettings(
  userId: number,
  layout: string,
  language: string,
): void {
  const settingsPath = userPath(SETTINGS_DIR, userId);
  // Lees bestaande settings of begin met leeg object
  let settings: Record<string, unknown> = {};
  try {
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    }
  } catch {
    /* negeer corrupte settings, herschrijf vanaf leeg */
  }
  settings["keyboard.layout"] = layout;
  settings["keyboard.language"] = language;
  // Maak directories aan indien nodig
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

// --- Beschikbare opties ---

const AVAILABLE_LAYOUTS: { id: string; label: string; language: string }[] = [
  { id: "nl-be", label: "AZERTY (BE)", language: "nl" },
  { id: "nl-nl", label: "QWERTY (NL)", language: "nl" },
  { id: "fr-fr", label: "AZERTY (FR)", language: "fr" },
  { id: "fr-ca", label: "QWERTY (FR-CA)", language: "fr" },
  { id: "en-us", label: "QWERTY (US)", language: "en" },
  { id: "en-dvorak", label: "Dvorak", language: "en" },
  { id: "en-colemak", label: "Colemak", language: "en" },
  { id: "de-de", label: "QWERTZ (DE)", language: "de" },
];

const AVAILABLE_LANGUAGES: { id: string; label: string }[] = [
  { id: "nl", label: "Nederlands" },
  { id: "fr", label: "Frans" },
  { id: "en", label: "Engels" },
  { id: "de", label: "Duits" },
];

// --- Admin HTML ---

function generateAdminHtml(summaries: UserSummary[]): string {
  const userRows = summaries
    .map(
      (s) => `
        <tr>
          <td>${esc(s.naam)}</td>
          <td>
            <select data-user-id="${s.id}" data-field="layout" class="setting-select">
              ${AVAILABLE_LAYOUTS.map((l) => `<option value="${l.id}" ${s.layout === l.id ? "selected" : ""}>${esc(l.label)}</option>`).join("")}
            </select>
          </td>
          <td>
            <select data-user-id="${s.id}" data-field="language" class="setting-select">
              ${AVAILABLE_LANGUAGES.map((l) => `<option value="${l.id}" ${s.taal === l.id ? "selected" : ""}>${esc(l.label)}</option>`).join("")}
            </select>
          </td>
          <td class="num">${s.sessies}</td>
          <td>
            <button class="btn btn-save" onclick="saveSettings(${s.id})">Opslaan</button>
            <button class="btn btn-danger" onclick="deleteUser(${s.id}, '${esc(s.naam)}')">Verwijderen</button>
          </td>
        </tr>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Keybr Admin</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      max-width: 1060px;
      margin: 2rem auto;
      padding: 0 1rem;
      color: #1a1a1a;
      background: #fafafa;
    }
    h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
    h2 { font-size: 1.15rem; margin: 1.5rem 0 0.75rem; color: #333; }
    .meta { color: #666; margin-bottom: 1.5rem; font-size: 0.9rem; }
    a { color: #0066cc; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .card {
      background: white; border-radius: 8px; padding: 1.25rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 1.5rem;
    }
    table { border-collapse: collapse; width: 100%; }
    th, td { padding: 0.6rem 0.75rem; text-align: left; border-bottom: 1px solid #eee; }
    th { font-weight: 600; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.03em; color: #555; }
    td { font-size: 0.95rem; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #f9f9f9; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .geen { color: #999; }
    .form-row { display: flex; gap: 0.75rem; align-items: end; flex-wrap: wrap; }
    .form-group { display: flex; flex-direction: column; gap: 0.25rem; }
    .form-group label { font-size: 0.8rem; font-weight: 600; color: #555; text-transform: uppercase; letter-spacing: 0.03em; }
    input, select {
      padding: 0.5rem 0.75rem; border: 1px solid #ddd; border-radius: 6px;
      font-size: 0.9rem; font-family: inherit; background: white;
    }
    input:focus, select:focus { outline: none; border-color: #0066cc; box-shadow: 0 0 0 2px rgba(0,102,204,0.15); }
    .setting-select { padding: 0.35rem 0.5rem; font-size: 0.85rem; }
    .btn {
      padding: 0.5rem 1rem; border: none; border-radius: 6px;
      font-size: 0.85rem; font-weight: 600; cursor: pointer; font-family: inherit;
    }
    .btn-primary { background: #0066cc; color: white; }
    .btn-primary:hover { background: #0052a3; }
    .btn-save { background: #16a34a; color: white; padding: 0.35rem 0.75rem; }
    .btn-save:hover { background: #15803d; }
    .btn-danger { background: white; color: #dc2626; border: 1px solid #dc2626; padding: 0.35rem 0.75rem; }
    .btn-danger:hover { background: #dc2626; color: white; }
    .toast {
      position: fixed; bottom: 1.5rem; right: 1.5rem; padding: 0.75rem 1.25rem;
      border-radius: 8px; color: white; font-size: 0.9rem; font-weight: 500;
      opacity: 0; transition: opacity 0.3s; pointer-events: none; z-index: 100;
    }
    .toast.show { opacity: 1; }
    .toast.success { background: #16a34a; }
    .toast.error { background: #dc2626; }
    .footer { margin-top: 1rem; color: #999; font-size: 0.8rem; }
  </style>
</head>
<body>
  <h1>Keybr Admin</h1>
  <p class="meta">
    ${summaries.length} leerlingen &middot;
    <a href="/">Dashboard</a>
  </p>

  <div class="card">
    <h2>Leerling toevoegen</h2>
    <form id="addForm" class="form-row">
      <div class="form-group">
        <label for="naam">Naam (voornaam.naam)</label>
        <input type="text" id="naam" name="naam" placeholder="emma.peeters" required pattern="[a-zA-Z0-9._-]+" title="Gebruik letters, cijfers, punten en streepjes">
      </div>
      <div class="form-group">
        <label for="newLayout">Layout</label>
        <select id="newLayout" name="layout">
          ${AVAILABLE_LAYOUTS.map((l) => `<option value="${l.id}" ${l.id === "nl-be" ? "selected" : ""}>${esc(l.label)}</option>`).join("")}
        </select>
      </div>
      <div class="form-group">
        <label for="newLanguage">Taal</label>
        <select id="newLanguage" name="language">
          ${AVAILABLE_LANGUAGES.map((l) => `<option value="${l.id}" ${l.id === "nl" ? "selected" : ""}>${esc(l.label)}</option>`).join("")}
        </select>
      </div>
      <button type="submit" class="btn btn-primary">Toevoegen</button>
    </form>
  </div>

  <div class="card">
    <h2>Leerlingen</h2>
    <table>
      <thead>
        <tr>
          <th>Naam</th>
          <th>Layout</th>
          <th>Taal</th>
          <th class="num">Sessies</th>
          <th>Acties</th>
        </tr>
      </thead>
      <tbody>${userRows || '<tr><td colspan="5" class="geen">Nog geen leerlingen.</td></tr>'}
      </tbody>
    </table>
  </div>

  <div id="toast" class="toast"></div>

  <script>
    const headers = { "Content-Type": "application/json" };

    function toast(msg, type = "success") {
      const el = document.getElementById("toast");
      el.textContent = msg;
      el.className = "toast show " + type;
      setTimeout(() => el.className = "toast", 2500);
    }

    document.getElementById("addForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const naam = document.getElementById("naam").value.trim();
      const layout = document.getElementById("newLayout").value;
      const language = document.getElementById("newLanguage").value;
      if (!naam) return;
      try {
        const res = await fetch("/api/users", {
          method: "POST", headers,
          body: JSON.stringify({ name: naam, layout, language }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Onbekende fout");
        toast(data.message || "Leerling aangemaakt");
        setTimeout(() => location.reload(), 800);
      } catch (err) {
        toast(err.message, "error");
      }
    });

    async function saveSettings(userId) {
      const row = document.querySelector(\`select[data-user-id="\${userId}"][data-field="layout"]\`).closest("tr");
      const layout = row.querySelector('select[data-field="layout"]').value;
      const language = row.querySelector('select[data-field="language"]').value;
      try {
        const res = await fetch(\`/api/users/\${userId}/settings\`, {
          method: "PUT", headers,
          body: JSON.stringify({ layout, language }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Onbekende fout");
        toast("Instellingen opgeslagen");
      } catch (err) {
        toast(err.message, "error");
      }
    }

    async function deleteUser(userId, naam) {
      if (!confirm(\`Weet je zeker dat je "\${naam}" wilt verwijderen? Alle data wordt gewist.\`)) return;
      try {
        const res = await fetch(\`/api/users/\${userId}\`, {
          method: "DELETE", headers,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Onbekende fout");
        toast("Leerling verwijderd");
        setTimeout(() => location.reload(), 800);
      } catch (err) {
        toast(err.message, "error");
      }
    }
  </script>
</body>
</html>`;
}

// --- Beveiliging (cookie-gebaseerd) ---

function parseCookies(req: IncomingMessage): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k) cookies[k] = decodeURIComponent(v.join("="));
  }
  return cookies;
}

function checkAdminCode(req: IncomingMessage): boolean {
  if (!ADMIN_CODE) return true;
  // Check header (API calls)
  if (req.headers["x-admin-code"] === ADMIN_CODE) return true;
  // Check cookie
  if (parseCookies(req)["dashboard_code"] === ADMIN_CODE) return true;
  // Check query parameter (login redirect)
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  return url.searchParams.get("code") === ADMIN_CODE;
}

function setAuthCookie(res: ServerResponse): void {
  // Cookie geldig voor 24 uur, alleen via HTTP
  res.setHeader(
    "Set-Cookie",
    `dashboard_code=${encodeURIComponent(ADMIN_CODE)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
  );
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

// --- Webserver ---

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const method = req.method || "GET";
  const pathname = url.pathname;

  // --- Alle routes beveiligd met ADMIN_CODE ---

  if (!checkAdminCode(req)) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(generateLoginHtml());
    return;
  }

  // Login via ?code= → cookie zetten en redirecten zonder code in URL
  if (url.searchParams.has("code")) {
    setAuthCookie(res);
    res.writeHead(302, { Location: pathname });
    res.end();
    return;
  }

  if (method === "GET" && pathname === "/api/data") {
    const summaries = getSummaries();
    sendJson(res, 200, summaries);
    return;
  }

  if (method === "GET" && pathname === "/") {
    const summaries = getSummaries();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(generateHtml(summaries));
    return;
  }

  if (method === "GET" && pathname === "/admin") {
    const summaries = getSummaries();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(generateAdminHtml(summaries));
    return;
  }

  if (method === "POST" && pathname === "/api/users") {
    try {
      const body = JSON.parse(await readBody(req));
      const name = (body.name || "").trim();
      if (!name) {
        sendJson(res, 400, { error: "Naam is verplicht" });
        return;
      }
      const user = createUser(name);
      // Stel meteen keyboard-instellingen in
      if (body.layout && body.language) {
        writeUserSettings(user.id, body.layout, body.language);
      }
      sendJson(res, 201, { message: `${name} aangemaakt`, id: user.id });
    } catch (err: any) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  // DELETE /api/users/:id
  const deleteMatch = pathname.match(/^\/api\/users\/(\d+)$/);
  if (method === "DELETE" && deleteMatch) {
    try {
      const userId = parseInt(deleteMatch[1], 10);
      deleteUser(userId);
      sendJson(res, 200, { message: "Leerling verwijderd" });
    } catch (err: any) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  // PUT /api/users/:id/settings
  const settingsMatch = pathname.match(/^\/api\/users\/(\d+)\/settings$/);
  if (method === "PUT" && settingsMatch) {
    try {
      const userId = parseInt(settingsMatch[1], 10);
      const body = JSON.parse(await readBody(req));
      if (!body.layout || !body.language) {
        sendJson(res, 400, { error: "Layout en taal zijn verplicht" });
        return;
      }
      writeUserSettings(userId, body.layout, body.language);
      sendJson(res, 200, { message: "Instellingen opgeslagen" });
    } catch (err: any) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  // 404
  sendJson(res, 404, { error: "Niet gevonden" });
});

// --- Login pagina ---

function generateLoginHtml(): string {
  return `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Keybr Admin — Aanmelden</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; background: #fafafa; color: #1a1a1a;
    }
    .login {
      background: white; padding: 2rem; border-radius: 12px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1); width: 100%; max-width: 360px;
    }
    h1 { font-size: 1.25rem; margin-bottom: 1.25rem; text-align: center; }
    label { display: block; font-size: 0.85rem; font-weight: 600; color: #555; margin-bottom: 0.25rem; }
    input {
      width: 100%; padding: 0.6rem 0.75rem; border: 1px solid #ddd;
      border-radius: 6px; font-size: 1rem; margin-bottom: 1rem; font-family: inherit;
    }
    input:focus { outline: none; border-color: #0066cc; box-shadow: 0 0 0 2px rgba(0,102,204,0.15); }
    button {
      width: 100%; padding: 0.65rem; background: #0066cc; color: white;
      border: none; border-radius: 6px; font-size: 0.95rem; font-weight: 600;
      cursor: pointer; font-family: inherit;
    }
    button:hover { background: #0052a3; }
  </style>
</head>
<body>
  <div class="login">
    <h1>Admin Toegang</h1>
    <form onsubmit="event.preventDefault(); window.location.href='/?code=' + encodeURIComponent(document.getElementById('code').value);">
      <label for="code">Toegangscode</label>
      <input type="password" id="code" placeholder="Voer de code in..." autofocus>
      <button type="submit">Aanmelden</button>
    </form>
  </div>
</body>
</html>`;
}

server.listen(PORT, () => {
  console.log(`Dashboard draait op http://localhost:${PORT}`);
  console.log(`Admin: http://localhost:${PORT}/admin`);
  if (!ADMIN_CODE)
    console.warn(
      "WAARSCHUWING: Geen ADMIN_CODE ingesteld — admin is onbeveiligd!",
    );
});
