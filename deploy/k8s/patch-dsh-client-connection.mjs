import { readFileSync, writeFileSync } from "node:fs";

const filePath = process.argv[2];
if (filePath === undefined) {
  throw new Error("patch-dsh-client-connection: target file is required");
}

let source = readFileSync(filePath, "utf8");

const importNeedle = 'import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";';
const importReplacement = `${importNeedle}\nimport { writeFileSync } from "node:fs";`;
if (!source.includes(importNeedle)) {
  throw new Error("patch-dsh-client-connection: crypto import was not found");
}
if (!source.includes('import { writeFileSync } from "node:fs";')) {
  source = source.replace(importNeedle, importReplacement);
}

const functionStart = source.indexOf("function processLaunchToken(owner)");
if (functionStart < 0) {
  throw new Error("patch-dsh-client-connection: processLaunchToken was not found");
}
if (source.indexOf("function processLaunchToken(owner)", functionStart + 1) !== -1) {
  throw new Error("patch-dsh-client-connection: processLaunchToken must appear exactly once");
}

const functionEnd = source.indexOf("function ", functionStart + 1);
if (functionEnd < 0) {
  throw new Error("patch-dsh-client-connection: processLaunchToken end was not found");
}
const functionBlock = source.slice(functionStart, functionEnd);
if (functionBlock.includes("DSH_LAUNCH_TOKEN_FILE")) {
  writeFileSync(filePath, source);
} else {
  const setStatement = "PROCESS_LAUNCH_TOKENS.set(owner, created);";
  const setIndex = functionBlock.indexOf(setStatement);
  if (setIndex < 0) {
    throw new Error("patch-dsh-client-connection: token map update was not found");
  }
  const insertion = `\n\tconst launchTokenFile = process.env.DSH_LAUNCH_TOKEN_FILE;\n\tif (launchTokenFile !== undefined) writeFileSync(launchTokenFile, \`\${created}\\n\`, { mode: 0o600 });`;
  const insertAt = functionStart + setIndex + setStatement.length;
  source = source.slice(0, insertAt) + insertion + source.slice(insertAt);
  writeFileSync(filePath, source);
}

writeFileSync(filePath, source);
