import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.join(__dirname, '.env');
const outputPath = path.join(__dirname, 'config.local.js');

function parseEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const contents = fs.readFileSync(filePath, 'utf8');
  const values = {};

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex === -1) continue;

    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim();
    values[key] = value.replace(/^['"]|['"]$/g, '');
  }

  return values;
}

const envValues = parseEnv(envPath);
const geminiKey = envValues.GEMINI_API_KEY || '';
const output = `// Auto-generated from .env by build-config.js. Do not edit manually.
export const GEMINI_API_KEY = ${JSON.stringify(geminiKey)};
`;

fs.writeFileSync(outputPath, output, 'utf8');
console.log(`Generated ${path.basename(outputPath)} with GEMINI_API_KEY=${geminiKey ? 'set' : 'empty'}.`);
