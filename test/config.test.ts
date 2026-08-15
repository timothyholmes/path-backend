import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ConfigLoader, getConfig } from '../src/config';

const CONFIG_DIR = path.resolve(process.cwd(), 'config');

let originalKey: string | undefined;
const createdFiles: string[] = [];

beforeEach(() => {
  originalKey = process.env.CONFIG_ENCRYPTION_KEY;
});

afterEach(() => {
  if (originalKey === undefined) delete process.env.CONFIG_ENCRYPTION_KEY;
  else process.env.CONFIG_ENCRYPTION_KEY = originalKey;
  while (createdFiles.length) fs.rmSync(createdFiles.pop() as string, { force: true });
});

function writeEnvConfig(env: string, contents: string): void {
  const file = path.join(CONFIG_DIR, `${env}.yml`);
  fs.writeFileSync(file, contents);
  createdFiles.push(file);
}

function encrypt(plaintext: string, keyHex: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `ENC(${[iv, authTag, ciphertext].map((b) => b.toString('base64')).join(':')})`;
}

describe('ConfigLoader secret decryption', () => {
  it('decrypts nested ENC() values using CONFIG_ENCRYPTION_KEY', () => {
    const key = crypto.randomBytes(32).toString('hex');
    process.env.CONFIG_ENCRYPTION_KEY = key;
    writeEnvConfig('coverage-enc', `auth:\n  jwtSecret: ${encrypt('decrypted-secret', key)}\n`);

    const config = new ConfigLoader('coverage-enc').get();
    expect(config.auth.jwtSecret).toBe('decrypted-secret');
  });

  it('throws when an ENC() value is present but no key is set', () => {
    const key = crypto.randomBytes(32).toString('hex');
    writeEnvConfig('coverage-nokey', `auth:\n  jwtSecret: ${encrypt('x', key)}\n`);
    delete process.env.CONFIG_ENCRYPTION_KEY;

    expect(() => new ConfigLoader('coverage-nokey')).toThrow(/CONFIG_ENCRYPTION_KEY is not set/);
  });

  it('throws when the key is not 32 bytes', () => {
    process.env.CONFIG_ENCRYPTION_KEY = 'abcd';
    writeEnvConfig('coverage-shortkey', 'auth:\n  jwtSecret: ENC(aa:bb:cc)\n');

    expect(() => new ConfigLoader('coverage-shortkey')).toThrow(/64-character hex/);
  });

  it('throws on a malformed ENC() payload', () => {
    process.env.CONFIG_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    writeEnvConfig('coverage-malformed', 'auth:\n  jwtSecret: ENC(only-one-part)\n');

    expect(() => new ConfigLoader('coverage-malformed')).toThrow(/Malformed ENC/);
  });
});

describe('ConfigLoader file loading', () => {
  it('returns the base config when the env override file is absent', () => {
    const config = new ConfigLoader('definitely-not-an-env').get();
    expect(config.server.port).toBe(3000);
    expect(config.auth.jwtSecret).toBeTruthy();
  });

  it('getConfig() loads and returns the merged config', () => {
    expect(getConfig().auth.audience).toBe('authenticated');
  });
});
