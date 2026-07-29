/**
 * Encrypts a plaintext value for safe storage in a YAML config file.
 *
 * Usage:
 *   CONFIG_ENCRYPTION_KEY=<64-char-hex> npx ts-node scripts/encrypt-secret.ts "my secret"
 *
 * Generate a key:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * Paste the printed ENC(...) value directly into your config YAML.
 */
import * as crypto from 'crypto';

const plaintext = process.argv[2];
if (!plaintext) {
  console.error('Usage: CONFIG_ENCRYPTION_KEY=<key> npx ts-node scripts/encrypt-secret.ts "value"');
  process.exit(1);
}

const keyHex = process.env.CONFIG_ENCRYPTION_KEY;
if (!keyHex) {
  console.error('Error: CONFIG_ENCRYPTION_KEY environment variable is not set');
  process.exit(1);
}

const keyBuf = Buffer.from(keyHex, 'hex');
if (keyBuf.length !== 32) {
  console.error('Error: CONFIG_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
  process.exit(1);
}

const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv);
const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
const authTag = cipher.getAuthTag();

const payload = [iv, authTag, ciphertext].map((b) => b.toString('base64')).join(':');
console.log(`ENC(${payload})`);
