import type { SignedEnvelope } from "./types";

export type RoomListing = {
  roomId: string;
  secret: string;
  host: string;
  createdAt: number;
  problemCount: number;
  status: "lobby" | "arena" | "finished";
  startedAt?: number;
  endedAt?: number;
  winner?: "red" | "blue" | "draw";
  rated?: boolean;
  averageDifficulty?: number;
  minimumDifficulty?: number;
  maximumDifficulty?: number;
  closedReason?: string;
  redPlayers?: string[];
  bluePlayers?: string[];
  // 作弊封禁：比赛因作弊取消时由后端标记，前端据此保留房间证据并显示"已封禁"。
  cheatBanned?: boolean;
  cheaterName?: string;
};

export type UserRecord = {
  name: string;
  rating: number;
  wins: number;
  losses: number;
  games: number;
  ratingHistory?: Array<{ at: number; rating: number }>;
  avatar?: string;
  color?: string;
  profileHtml?: string;
  updatedAt: number;
};

export type ServerMessage =
  | { type: "hello"; envelopes: SignedEnvelope[] }
  | { type: "event"; envelope: SignedEnvelope }
  | { type: "sync"; envelopes: SignedEnvelope[] }
  | { type: "directory"; rooms: RoomListing[] }
  | { type: "users"; users: UserRecord[] }
  | { type: "pong"; at: number }
  | { type: "error"; message: string };

const requestTimeoutMs = 6500;
const requestLimitPerMinute = 60;
let requestTimes: number[] = [];
let requestWarningHandler: (() => void) | undefined;

export const setServerRequestWarningHandler = (handler: () => void) => {
  requestWarningHandler = handler;
};

export const allowServerRequest = (): boolean => {
  const now = Date.now();
  requestTimes = requestTimes.filter((at) => now - at < 60_000);
  if (requestTimes.length >= requestLimitPerMinute) {
    requestWarningHandler?.();
    return false;
  }
  requestTimes.push(now);
  return true;
};

const requireServerRequest = () => {
  if (!allowServerRequest()) throw new Error("操作已取消");
};

export const fetchRooms = async (): Promise<RoomListing[]> => {
  requireServerRequest();
  const response = await fetch("/api/rooms", {
    cache: "no-store",
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  if (!response.ok) throw new Error(`room directory failed: ${response.status}`);
  const data = (await response.json()) as { rooms?: RoomListing[] };
  return Array.isArray(data.rooms) ? data.rooms : [];
};

export const fetchUsers = async (): Promise<UserRecord[]> => {
  requireServerRequest();
  const response = await fetch("/api/users", {
    cache: "default",
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  if (!response.ok) throw new Error(`users request failed: ${response.status}`);
  const data = (await response.json()) as { users?: UserRecord[] };
  return Array.isArray(data.users) ? data.users : [];
};

// 考试通过状态：服务端（worker）为唯一权威来源，每次都直连 /api/exam/status 校验，
// 不再做任何本地缓存。旧的 localStorage 缓存（30 天 TTL）会让“已通过”的用户被旧缓存里的
// false 弹回 /exam，与服务端记录来回横跳形成 / 与 /exam 的死循环。
export const fetchExamStatus = async (name: string): Promise<boolean> => {
  requireServerRequest();
  const response = await fetch(`/api/exam/status?user=${encodeURIComponent(name)}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  if (!response.ok) throw new Error(`exam status failed: ${response.status}`);
  const data = (await response.json()) as { passed?: boolean };
  return data.passed === true;
};

export const passExamServer = async (name: string): Promise<void> => {
  requireServerRequest();
  const response = await fetch("/api/exam/pass", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user: name }),
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  if (!response.ok) throw new Error(`exam pass failed: ${response.status}`);
};

export const fetchLowRoomAvailability = async (name: string): Promise<boolean> => {
  requireServerRequest();
  const url = new URL("/api/room-limit/low", location.origin);
  url.searchParams.set("name", name);
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(requestTimeoutMs) });
  if (!response.ok) throw new Error(`room limit request failed: ${response.status}`);
  const data = await response.json() as { allowed?: boolean };
  return data.allowed === true;
};

export const clearRoomDraft = async (roomId: string, secret: string): Promise<void> => {
  const response = await fetch(roomApiUrl(roomId, secret, "clear"), {
    method: "POST",
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  if (!response.ok) throw new Error(`room cleanup failed: ${response.status}`);
};

export const fetchUserRecord = async (name: string): Promise<UserRecord | null> => {
  requireServerRequest();
  const response = await fetch(`/api/users/${encodeURIComponent(name)}`, {
    cache: "default",
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`user request failed: ${response.status}`);
  const data = (await response.json()) as { user?: UserRecord };
  return data.user ?? null;
};

export const saveUserRecord = async (user: Partial<UserRecord> & { name: string }): Promise<UserRecord> => {
  requireServerRequest();
  const response = await fetch(`/api/users/${encodeURIComponent(user.name)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(user),
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  if (!response.ok) throw new Error(`user save failed: ${response.status}`);
  const data = (await response.json()) as { user: UserRecord };
  return data.user;
};

export const updateUserRating = async (name: string, rating: number, adminName: string): Promise<UserRecord> => {
  requireServerRequest();
  const response = await fetch(`/api/users/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-name": adminName },
    body: JSON.stringify({ rating }),
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  if (!response.ok) throw new Error(`rating update failed: ${response.status}`);
  const data = (await response.json()) as { user: UserRecord };
  return data.user;
};

export const fetchSnapshot = async (roomId: string, secret: string, guard = true): Promise<SignedEnvelope[]> => {
  if (guard) requireServerRequest();
  const response = await fetch(roomApiUrl(roomId, secret, "snapshot"), {
    cache: "no-store",
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  if (!response.ok) throw new Error(`room snapshot failed: ${response.status}`);
  const data = (await response.json()) as { envelopes?: SignedEnvelope[] };
  return Array.isArray(data.envelopes) ? data.envelopes : [];
};

export const publishEnvelope = async (roomId: string, secret: string, envelope: SignedEnvelope): Promise<void> => {
  const response = await fetch(roomApiUrl(roomId, secret, "event"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ envelope }),
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(data?.error || `room event failed: ${response.status}`);
  }
};

export const roomWebSocketUrl = (roomId: string, secret: string): string => {
  const url = roomApiUrl(roomId, secret, "ws");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
};

export const directoryWebSocketUrl = (): string => {
  const url = new URL("/api/rooms/ws", location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
};

const roomApiUrl = (roomId: string, secret: string, action: string): URL => {
  const url = new URL(`/api/rooms/${encodeURIComponent(roomId)}/${action}`, location.origin);
  url.searchParams.set("secret", secret);
  return url;
};
