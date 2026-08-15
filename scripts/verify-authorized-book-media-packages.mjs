import fs from "node:fs";
import path from "node:path";
import { collectBookMediaReferences } from "../lib/aylamed-book-media.js";
import { matchMediaReferences, safeMediaEntryName } from "../lib/content-media-r2.js";
import { openContentZip } from "../lib/content-zip-source.js";

const preparedRoot = path.resolve(process.argv[2] || "");
if (!preparedRoot || !fs.existsSync(preparedRoot)) {
  throw new Error("Usage: node scripts/verify-authorized-book-media-packages.mjs <prepared-directory>");
}

async function zipAssets(file) {
  const zip = await openContentZip(file);
  const assets = [];
  await new Promise((resolve, reject) => {
    zip.on("entry", (entry) => {
      const originalName = safeMediaEntryName(entry.fileName, { allowSvg: true });
      if (originalName) assets.push({ originalName, objectKey: originalName });
      zip.readEntry();
    });
    zip.on("end", resolve);
    zip.on("error", reject);
    zip.readEntry();
  });
  return assets;
}

const packages = fs.readdirSync(preparedRoot)
  .filter((name) => name.endsWith(".json") && name !== "book-import-summary.json")
  .map((name) => JSON.parse(fs.readFileSync(path.join(preparedRoot, name), "utf8")));
const grouped = new Map();
for (const entry of packages) {
  const key = String(entry?.book?.key || "");
  if (!key) continue;
  if (!grouped.has(key)) grouped.set(key, []);
  grouped.get(key).push(...(Array.isArray(entry.resources) ? entry.resources : []));
}

const books = [];
for (const [bookKey, resources] of grouped) {
  const zipFile = path.join(preparedRoot, `${bookKey}.media.zip`);
  const { references } = collectBookMediaReferences(resources, { bookKey });
  const assets = await zipAssets(zipFile);
  const report = matchMediaReferences(references, assets);
  books.push({
    book_key: bookKey,
    resources: resources.length,
    references: references.length,
    assets: assets.length,
    matched: report.matches.length,
    missing: report.missing.length,
    ambiguous: report.ambiguous.length,
    unreferenced: report.unreferenced.length,
    zip_bytes: fs.statSync(zipFile).size,
  });
}
const totals = books.reduce((total, book) => ({
  resources: total.resources + book.resources,
  references: total.references + book.references,
  assets: total.assets + book.assets,
  matched: total.matched + book.matched,
  missing: total.missing + book.missing,
  ambiguous: total.ambiguous + book.ambiguous,
  unreferenced: total.unreferenced + book.unreferenced,
  zip_bytes: total.zip_bytes + book.zip_bytes,
}), { resources: 0, references: 0, assets: 0, matched: 0, missing: 0, ambiguous: 0, unreferenced: 0, zip_bytes: 0 });
const result = { version: "aylamed-private-book-media-verification-v1", books, totals };
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (totals.missing || totals.ambiguous || totals.unreferenced || totals.matched !== totals.references) process.exitCode = 1;
