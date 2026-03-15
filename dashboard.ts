/**
 * Keybr Leerkrachtendashboard — Webserver
 *
 * Draait als aparte container naast keybr.
 * Leest de gedeelde SQLite-database en binaire stats-bestanden uit.
 *
 * Endpoints:
 *   GET /          → HTML dashboard met overzicht van alle leerlingen
 *   GET /api/data  → JSON met alle leerlingdata
 */

import Database from "better-sqlite3";
import { createServer } from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";

// --- Configuratie ---

const DATA_DIR = process.env.DATA_DIR || "./data";
const PORT = parseInt(process.env.PORT || "3001", 10);
const DB_PATH = path.join(DATA_DIR, "database.sqlite");
const STATS_DIR = path.join(DATA_DIR, "user_stats");

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

interface TypingResult {
  timestamp: Date;
  timeMs: number;
  length: number;
  errors: number;
}

function parseStatsFile(filePath: string): TypingResult[] {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length === 0) return [];

  const reader = new BinaryReader(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
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

      for (let i = 0; i < sampleCount; i++) {
        reader.readVLQ(); // code point
        reader.readVLQ(); // hits
        reader.readVLQ(); // misses
        reader.readVLQ(); // time to type
      }

      results.push({
        timestamp: new Date(timestampSec * 1000),
        timeMs,
        length,
        errors,
      });
    }
  } catch {
    // Einde van bestand of parse-fout — geef terug wat we hebben
  }

  return results;
}

// --- Gebruikerspad berekenen (keybr formaat: /000/012/000012345) ---

function userStatsPath(userId: number): string {
  const padded = userId.toString().padStart(9, "0");
  const dir1 = padded.slice(0, 3);
  const dir2 = padded.slice(3, 6);
  return path.join(STATS_DIR, dir1, dir2, padded);
}

// --- Data ophalen ---

interface UserRow {
  id: number;
  email: string | null;
  name: string | null;
  created_at: string;
}

interface UserSummary {
  id: number;
  naam: string;
  email: string;
  sessies: number;
  totaleMinuten: number;
  gemCPM: number;
  gemNauwkeurigheid: number;
  laatstActief: string;
}

function getSummaries(): UserSummary[] {
  if (!fs.existsSync(DB_PATH)) return [];

  const db = new Database(DB_PATH, { readonly: true });
  const users = db.prepare("SELECT id, email, name, created_at FROM User").all() as UserRow[];
  const summaries: UserSummary[] = [];

  for (const user of users) {
    const statsPath = userStatsPath(user.id);
    let results: TypingResult[] = [];

    if (fs.existsSync(statsPath)) {
      results = parseStatsFile(statsPath);
    }

    if (results.length === 0) {
      summaries.push({
        id: user.id,
        naam: user.name || "(anoniem)",
        email: user.email || "-",
        sessies: 0,
        totaleMinuten: 0,
        gemCPM: 0,
        gemNauwkeurigheid: 0,
        laatstActief: "-",
      });
      continue;
    }

    const totaleMs = results.reduce((sum, r) => sum + r.timeMs, 0);
    const totaleKarakters = results.reduce((sum, r) => sum + r.length, 0);
    const totaleErrors = results.reduce((sum, r) => sum + r.errors, 0);
    const laatsteResult = results.reduce((latest, r) =>
      r.timestamp > latest.timestamp ? r : latest,
    );

    summaries.push({
      id: user.id,
      naam: user.name || "(anoniem)",
      email: user.email || "-",
      sessies: results.length,
      totaleMinuten: Math.round((totaleMs / 60000) * 10) / 10,
      gemCPM: totaleMs > 0 ? Math.round((totaleKarakters / totaleMs) * 60000) : 0,
      gemNauwkeurigheid:
        totaleKarakters > 0
          ? Math.round(((totaleKarakters - totaleErrors) / totaleKarakters) * 100)
          : 0,
      laatstActief: laatsteResult.timestamp.toLocaleDateString("nl-BE"),
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
          <td>${s.sessies}</td>
          <td>${s.totaleMinuten}</td>
          <td>${s.gemCPM}</td>
          <td>${s.gemNauwkeurigheid}%</td>
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
      max-width: 960px;
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
    th, td { padding: 0.75rem 1rem; text-align: left; border-bottom: 1px solid #eee; }
    th { background: #f5f5f5; font-weight: 600; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.03em; color: #555; }
    td { font-size: 0.95rem; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #f9f9f9; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .geen { color: #999; }
    .footer { margin-top: 1rem; color: #999; font-size: 0.8rem; }
  </style>
</head>
<body>
  <h1>Keybr Leerkrachtendashboard</h1>
  <p class="meta">
    ${summaries.length} leerlingen &middot;
    ${new Date().toLocaleString("nl-BE")}
    <a class="refresh" href="/">Vernieuwen</a>
  </p>
  <table>
    <thead>
      <tr>
        <th>Naam</th>
        <th class="num">Sessies</th>
        <th class="num">Minuten</th>
        <th class="num">CPM</th>
        <th class="num">Nauwkeurigheid</th>
        <th>Laatst actief</th>
      </tr>
    </thead>
    <tbody>${rows || '<tr><td colspan="6" class="geen">Nog geen leerlingen gevonden. Wacht tot ze een account aanmaken en beginnen typen.</td></tr>'}
    </tbody>
  </table>
  <p class="footer">CPM = karakters per minuut. Data wordt live gelezen bij elke paginalading.</p>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// --- Webserver ---

const server = createServer((req, res) => {
  if (req.url === "/api/data") {
    const summaries = getSummaries();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(summaries, null, 2));
    return;
  }

  // Alles andere → HTML dashboard
  const summaries = getSummaries();
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(generateHtml(summaries));
});

server.listen(PORT, () => {
  console.log(`Dashboard draait op http://localhost:${PORT}`);
});
