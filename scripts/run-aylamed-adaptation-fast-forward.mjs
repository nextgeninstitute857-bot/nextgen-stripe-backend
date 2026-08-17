import { runAylaAdaptationFastForwardSuite } from "../lib/aylamed-adaptation-fast-forward.js";

const examVariant = process.argv.includes("--pn") ? "nclex_pn" : "nclex_rn";
const report = runAylaAdaptationFastForwardSuite({ days: 150, examVariant });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
