// Keys come from the environment (GitHub Actions secrets) or, locally, from ~/gta6archiveshq/.env.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const file = join(ROOT, '.env');
const fromFile = existsSync(file)
  ? Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
  : {};
export const env = { ...fromFile, ...Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v && /^(TELEGRAM_|BUFFER_|SUPABASE_)/.test(k))) };
