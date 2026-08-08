import type { DuelEvent, SignedEnvelope } from "./types";

const identityKey = "vjudge-duel.identity";

export type LocalIdentity = {
  id: string;
  luoguName: string;
  publicKey: JsonWebKey;
  privateKey: JsonWebKey;
};

export const loadIdentity = async (): Promise<LocalIdentity> => {
  const raw = localStorage.getItem(identityKey);
  if (raw) return JSON.parse(raw) as LocalIdentity;
  return createIdentity(`player_${Math.floor(Math.random() * 10000)}`);
};

export const createIdentity = async (luoguName: string): Promise<LocalIdentity> => {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateKey = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const id = await keyId(publicKey);
  const identity = { id, luoguName, publicKey, privateKey };
  localStorage.setItem(identityKey, JSON.stringify(identity));
  return identity;
};

export const renameIdentity = async (identity: LocalIdentity, luoguName: string): Promise<LocalIdentity> => {
  const next = { ...identity, luoguName: luoguName.trim() || identity.luoguName };
  localStorage.setItem(identityKey, JSON.stringify(next));
  return next;
};

export const signEvent = async (identity: LocalIdentity, event: DuelEvent): Promise<SignedEnvelope> => {
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    identity.privateKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    bytes(stableStringify(event))
  );
  return { publicKey: identity.publicKey, event, signature: base64(signature) };
};

export const verifyEnvelope = async (envelope: SignedEnvelope): Promise<boolean> => {
  if ((await keyId(envelope.publicKey)) !== envelope.event.actorId) return false;
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    envelope.publicKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    unbase64(envelope.signature),
    bytes(stableStringify(envelope.event))
  );
};

const keyId = async (publicKey: JsonWebKey): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes(stableStringify(publicKey)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
};

const stableStringify = (value: unknown): string => {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(",")}}`;
};

const bytes = (text: string): ArrayBuffer => {
  const encoded = new TextEncoder().encode(text);
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
};
const base64 = (buffer: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(buffer)));
const unbase64 = (text: string): ArrayBuffer => {
  const decoded = Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  return decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength);
};
