const encoder = new TextEncoder();
async function keyFromSecret(secret: string) {
  if (!/^[a-fA-F0-9]{64}$/.test(secret)) throw new Error('Invalid vault key');
  const bytes = Uint8Array.from(secret.match(/../g)!, value => parseInt(value, 16));
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encryptPassword(secret: string, username: string, password: string): Promise<string> {
  const key = await keyFromSecret(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(username) }, key, encoder.encode(password));
  return `v1.${btoa(String.fromCharCode(...iv))}.${btoa(String.fromCharCode(...new Uint8Array(encrypted)))}`;
}
export async function decryptPassword(secret: string, username: string, envelope: string): Promise<string> {
  const [version, nonce, ciphertext, extra] = envelope.split('.');
  if (version !== 'v1' || !nonce || !ciphertext || extra !== undefined) throw new Error('Invalid vault record');
  const iv = Uint8Array.from(atob(nonce), c => c.charCodeAt(0));
  if (iv.length !== 12) throw new Error('Invalid nonce');
  const data = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(username) }, await keyFromSecret(secret), data);
  return new TextDecoder().decode(decrypted);
}
