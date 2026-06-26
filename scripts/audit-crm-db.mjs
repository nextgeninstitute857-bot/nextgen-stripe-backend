import fs from "fs";

const CRM_PATH = process.env.CRM_DB_PATH || "/var/data/crm-db.json";

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(2) + " MB";
}

console.log("CRM audit started");
console.log("CRM_PATH:", CRM_PATH);

if (!fs.existsSync(CRM_PATH)) {
  console.error("CRM DB not found:", CRM_PATH);
  process.exit(1);
}

const stat = fs.statSync(CRM_PATH);
console.log("CRM DB file size:", mb(stat.size));

const raw = fs.readFileSync(CRM_PATH, "utf8");
const db = JSON.parse(raw);

const rows = [];

for (const [key, value] of Object.entries(db || {})) {
  const json = JSON.stringify(value ?? {});
  let count = 0;

  if (Array.isArray(value)) count = value.length;
  else if (value && typeof value === "object") count = Object.keys(value).length;

  rows.push({
    section: key,
    type: Array.isArray(value) ? "array" : typeof value,
    count,
    size_mb: Number((Buffer.byteLength(json) / 1024 / 1024).toFixed(2)),
  });
}

rows.sort((a, b) => b.size_mb - a.size_mb);

console.table(rows.slice(0, 40));

console.log("CRM audit complete");
