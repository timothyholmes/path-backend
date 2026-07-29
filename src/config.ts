import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as yaml from 'js-yaml';
import ReservationService from './api/ReservationService';
import ReservationStorage from './api/ReservationStorage';
import AvailabilityService from './api/AvailabilityService';

export interface Config {
  server: {
    port: number;
  };
  [key: string]: unknown;
}

export interface Dependencies {
  reservationService: ReservationService;
  reservationStorage: ReservationStorage;
  availabilityService: AvailabilityService;
  logger: Console;
}

function deepMerge<T extends Record<string, unknown>>(base: T, override: Partial<T>): T {
  const result = { ...base };
  for (const key of Object.keys(override) as (keyof T)[]) {
    const overrideVal = override[key];
    const baseVal = base[key];
    if (
      overrideVal !== null &&
      typeof overrideVal === 'object' &&
      !Array.isArray(overrideVal) &&
      baseVal !== null &&
      typeof baseVal === 'object' &&
      !Array.isArray(baseVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>,
      ) as T[keyof T];
    } else {
      result[key] = overrideVal as T[keyof T];
    }
  }
  return result;
}

const ENC_PREFIX = 'ENC(';
const ENC_SUFFIX = ')';

function decryptValue(encrypted: string): string {
  const key = process.env.CONFIG_ENCRYPTION_KEY;
  if (!key) {
    throw new Error(`Config contains encrypted value but CONFIG_ENCRYPTION_KEY is not set`);
  }

  const keyBuf = Buffer.from(key, 'hex');
  if (keyBuf.length !== 32) {
    throw new Error(`CONFIG_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)`);
  }

  const payload = encrypted.slice(ENC_PREFIX.length, -ENC_SUFFIX.length);
  const parts = payload.split(':');
  if (parts.length !== 3) {
    throw new Error(`Malformed ENC() value — expected iv:authTag:ciphertext`);
  }

  const [ivB64, authTagB64, ciphertextB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function decryptSecrets(obj: unknown): void {
  if (obj === null || typeof obj !== 'object') return;

  for (const key of Object.keys(obj as Record<string, unknown>)) {
    const record = obj as Record<string, unknown>;
    const val = record[key];
    if (typeof val === 'string' && val.startsWith(ENC_PREFIX) && val.endsWith(ENC_SUFFIX)) {
      record[key] = decryptValue(val);
    } else if (val !== null && typeof val === 'object') {
      decryptSecrets(val);
    }
  }
}

export class ConfigLoader {
  private config: Config;

  constructor(env = process.env.NODE_ENV ?? 'development') {
    const base = this.loadFile('config/default.yml');
    const override = this.loadFile(`config/${env}.yml`, true);
    const merged = deepMerge(
      base as Record<string, unknown>,
      override as Record<string, unknown>,
    ) as Config;
    decryptSecrets(merged);
    this.config = merged;
  }

  get(): Config {
    return this.config;
  }

  private loadFile(filePath: string, optional = false): Partial<Config> {
    const resolved = path.resolve(process.cwd(), filePath);
    if (!fs.existsSync(resolved)) {
      if (optional) return {};
      throw new Error(`Required config file not found: ${resolved}`);
    }
    const contents = fs.readFileSync(resolved, 'utf8');
    return (yaml.load(contents) as Partial<Config>) ?? {};
  }
}

export function getConfig(): Config {
  return new ConfigLoader().get();
}
