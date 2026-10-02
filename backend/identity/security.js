import {
  createHash,
  createHmac,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from 'node:crypto';

export const opaque = () => randomBytes(32).toString('base64url');
export const digest = (value) =>
  createHash('sha256').update(value).digest('hex');
export const challenge = (value) =>
  createHash('sha256').update(value).digest('base64url');
export function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length > 1024)
    return false;
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
/** Bind encrypted provider tokens to the session digest; never persist plaintext. */
export function seal(value, key, binding) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(binding));
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), data]
    .map((part) => part.toString('base64url'))
    .join('.');
}
export function unseal(value, key, binding) {
  const parts = value.split('.').map((part) => Buffer.from(part, 'base64url'));
  if (parts.length !== 3 || parts[0].length !== 12 || parts[1].length !== 16)
    throw new Error('Invalid encrypted token');
  const cipher = createDecipheriv('aes-256-gcm', key, parts[0]);
  cipher.setAAD(Buffer.from(binding));
  cipher.setAuthTag(parts[1]);
  return JSON.parse(
    Buffer.concat([cipher.update(parts[2]), cipher.final()]).toString(),
  );
}
export const csrf = (key, tokenHash) =>
  createHmac('sha256', key).update(`csrf:${tokenHash}`).digest('base64url');
export function authError(code, status = 401) {
  return Object.assign(new Error(code), { publicCode: code, status });
}
