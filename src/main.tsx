import "./style.css";
import Swal from "sweetalert2";
import "sweetalert2/dist/sweetalert2.min.css";
import type VditorType from "vditor";
import "vditor/dist/index.css";
import Chart from "chart.js/auto";
import type { ComponentChildren, JSX } from "preact";
import { render } from "preact";
import { useEffect, useRef } from "preact/hooks";
import {
  Ban,
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Copy,
  Crown,
  DoorClosed,
  Eye,
  Flame,
  Flag,
  Handshake,
  House,
  KeyRound,
  LogOut,
  Medal,
  MessageSquare,
  Monitor,
  Moon,
  Palette,
  Pin,
  Play,
  Radio,
  RefreshCw,
  Send,
  Shield,
  Sprout,
  Star,
  Sun,
  Swords,
  Terminal,
  Trash2,
  Trophy,
  UserMinus,
  Users,
  Volume2,
  VolumeX,
  X,
  Zap
} from "lucide-preact";
import {
  applyEvent,
  applyEvents,
  buildVote,
  canCloseRoom,
  createInitialState,
  isAdminName,
  isTeam,
  normalizeName,
  privateChatViolation,
  requiredVoters,
  scoreOf,
  sortProblemsByDifficulty,
  teamName,
  visibleChats,
  winThreshold
} from "./domain";
import { createIdentity, loadIdentity, renameIdentity, signEvent, verifyEnvelope, type LocalIdentity } from "./identity";
import { cachedProblemCount, defaultRatios, difficultyMeta, parseCustomProblems, pickProblems, pickReplacementProblem, platformLabel, type DifficultyLevel, type PlatformRatios, type ProblemPlatform } from "./problemPicker";
import { loadVJudgeSession, logoutVJudgeSession, verifyVJudgeLogin, type VJudgeLoginMethod, type VJudgeSession } from "./oauth";
import { allowServerRequest, clearRoomDraft, directoryWebSocketUrl, fetchLowRoomAvailability, fetchRooms, fetchSnapshot, fetchUserRecord, fetchUsers, publishEnvelope, roomWebSocketUrl, saveUserRecord, setServerRequestWarningHandler, updateUserRating, type RoomListing, type ServerMessage, type UserRecord } from "./realtimeStore";
import { fetchVJudgeRecords } from "./vjudge";
import { AdminPlayersSkeleton, AdminRoomsSkeleton, BootScreen, ChatSkeleton, RankingSkeleton, RoomListSkeleton, SkeletonRows } from "./loadingViews";
import type { ChatMessage, DuelEvent, DuelState, Player, Problem, Seat, SignedEnvelope, VoteKind } from "./types";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing #app");

type BootPhase = "loading" | "auth-error" | "ready";
type ViewMode = "home" | "room" | "profile" | "admin";

function profileNameFromPath(): string {
  const match = decodeURIComponent(location.pathname).match(/^\/user\/([^/]+)\/?$/);
  return match?.[1]?.trim() ?? "";
}

const initialProfileUserName = profileNameFromPath();
let bootPhase: BootPhase = "loading";
let mode: ViewMode = initialProfileUserName ? "profile" : "home";
let identity: LocalIdentity;
let vjudgeSession: VJudgeSession | null = null;
let roomId = "global";
let roomSecret = "public-lobby";
let envelopes: SignedEnvelope[] = [];
let state: DuelState = createInitialState(roomId);
let globalModeration: DuelState = createInitialState("global");
// 本地乐观提交的封禁/禁言事件缓冲。后台快照刷新（refreshGlobalModeration /
// applyAuthoritativeSnapshot）会用服务端快照整体覆盖 globalModeration，若该快照在
// 刚发布的封禁事件被服务端接纳前抢先到达，乐观更新会被抹掉，表现为“禁不上”。
// 这里保留待确认事件，刷新时合并回去，直到服务端快照中已包含该事件再清理。
let pendingGlobalEvents: DuelEvent[] = [];
const mergePendingGlobalEvents = (events: DuelEvent[]): DuelEvent[] => {
  const byId = new Map<string, DuelEvent>();
  for (const event of events) byId.set(event.id, event);
  for (const event of pendingGlobalEvents) if (event.roomId === "global") byId.set(event.id, event);
  return [...byId.values()];
};
const prunePendingGlobalEvents = (confirmed: DuelEvent[]): void => {
  const ids = new Set(confirmed.map((event) => event.id));
  pendingGlobalEvents = pendingGlobalEvents.filter((event) => !ids.has(event.id));
};
let rooms: RoomListing[] = [];
let users: UserRecord[] = [];
let usersLoaded = false;
let profileLoading = false;
let profileUserName = initialProfileUserName;
let bootScreenVisible = true;
let bootScreenLeaving = false;
let socket: WebSocket | null = null;
let directorySocket: WebSocket | null = null;
let reconnectTimer: number | undefined;
let directoryReconnectTimer: number | undefined;
let reconnectNoticeTimer: number | undefined;
let directoryReconnectNoticeTimer: number | undefined;
let roomReconnectAttempts = 0;
let directoryReconnectAttempts = 0;
let roomSocketGeneration = 0;
let directorySocketGeneration = 0;
let directoryLiveSnapshotReceived = false;
let lastDirectoryLiveAt = 0;
let lastUsersLiveAt = 0;
let lastProfileFallbackSync = 0;
let finishReturnTimer: number | undefined;
let clockTimer: number | undefined;
let syncTimer: number | undefined;
let heartbeatTimer: number | undefined;
let initialFallbackTimer: number | undefined;
let syncInFlight = false;
let roomLastPongAt = 0;
let directoryLastPongAt = 0;
let lastRoomLiveStateAt = 0;
let statusText = "booting...";
let statusTone: "info" | "error" = "info";
let authErrorText = "";
let announcementTitle = "VJudge Duel 公告";
let announcementContent = "正在读取公告…";
let vjudgeUsername = "";
let vjudgeLoginMethod: VJudgeLoginMethod = "recent";
let schoolVerificationCode = "";
let creatingRoom = false;
let joiningRoom = false;
let recoveringRoomSetup = false;
let pendingRoomSetup: { roomId: string; secret: string; count: number; customProblems: Problem[]; rated: boolean; difficultyLow: DifficultyLevel; difficultyHigh: DifficultyLevel; ratios: PlatformRatios } | null = null;
let loginSubmitting = false;
const adminBusy = new Set<string>();
const judgingProblems = new Set<string>();
const replacingProblems = new Set<string>();
let downloadProgress: Record<ProblemPlatform, { percent: number; status: string }> = {
  luogu: { percent: 0, status: "等待下载" }, codeforces: { percent: 0, status: "等待下载" }, atcoder: { percent: 0, status: "等待下载" }
};
let toasts: ToastMessage[] = [];
const notifiedKeys = new Set<string>();
const joinDeniedRooms = new Set<string>();
const systemLogoUrl = "https://cdn.luogu.com.cn/upload/image_hosting/lb8qcsrx.png";
const darkBrandLogoUrl = "https://cdn.luogu.com.cn/upload/image_hosting/giufbahf.png";
const lightBrandLogoUrl = "https://cdn.luogu.com.cn/upload/image_hosting/tq5l4861.png";
const avatarCacheKey = "luogu-duel.avatar-cache";
const userCacheKey = "luogu-duel.user-cache";
const registrationCacheKey = "luogu-duel.registration-cache";
const userCacheTtl = 24 * 60 * 60 * 1000;
const themeModeKey = "luogu-duel.theme-mode";
const bgImageKey = "luogu-duel.bg-image";
const frostedKey = "luogu-duel.frosted";
const blurRadiusKey = "luogu-duel.blur-radius";
const panelAlphaKey = "luogu-duel.panel-alpha";
const themeColorRKey = "luogu-duel.theme-color-r";
const themeColorGKey = "luogu-duel.theme-color-g";
const themeColorBKey = "luogu-duel.theme-color-b";
const avatarCache: Record<string, string> = readAvatarCache();
const userCache: Record<string, { user: UserRecord; cachedAt: number }> = readUserCache();
const avatarLoading = new Set<string>();
const avatarMissing = new Set<string>();
let profileVditor: VditorType | null = null;
let chatVditor: VditorType | null = null;
let chatVditorTarget: HTMLDivElement | null = null;
let chatVditorGeneration = 0;
let vditorModulePromise: Promise<typeof import("vditor")> | null = null;
const vditorPreviewSources = new WeakMap<HTMLElement, string>();
let themeMode = readThemeMode();
let bgImageUrl = readStoredText(bgImageKey) || "";
let frostedGlass = readStoredText(frostedKey) === "1";
let blurRadius = readStoredNumber(blurRadiusKey, 5);
let panelAlpha = readStoredNumber(panelAlphaKey, 80);
let themeColorR = readStoredNumber(themeColorRKey, 63);
let themeColorG = readStoredNumber(themeColorGKey, 185);
let themeColorB = readStoredNumber(themeColorBKey, 140);
const themeQuery = window.matchMedia("(prefers-color-scheme: dark)");

const draft = {
  userMenuOpen: false,
  roomTab: "duel" as "duel" | "ranking",
  profileTab: "home" as "home" | "matches" | "achievements",
  profileEditing: false,
  profileDraft: "",
  chat: "",
  roomCount: 9,
  customProblems: "",
  difficultyLow: 1 as DifficultyLevel,
  difficultyHigh: 3 as DifficultyLevel,
  ratios: { ...defaultRatios } as PlatformRatios,
  unrated: false,
  pickerStatus: "",
  closeReason: "房主关闭房间",
  adminTarget: "",
  adminSearch: "",
  adminReason: "",
  adminRatings: {} as Record<string, string>,
  spectatorsOpen: false,
  matchIslandPinned: false,
  userMenuClosing: false
};

const closeUserMenu = () => {
  if (!draft.userMenuOpen || draft.userMenuClosing) return;
  draft.userMenuClosing = true;
  notify();
};

type ToastMessage = {
  id: string;
  title: string;
  text: string;
  tone: "info" | "success" | "warning";
};

const dataVersion = "v4";
const roomSeatKey = () => `luogu-duel.${dataVersion}.seat.${roomId}`;
const activeRoomKey = `luogu-duel.active-room.${dataVersion}`;
const historyKey = `luogu-duel.history.${dataVersion}`;
const directoryCacheKey = "vjudge-duel.directory-cache";
const eventCacheKey = (id: string) => `vjudge-duel.events.${dataVersion}.${id}`;
const announcementCacheKey = "vjudge-duel.announcement";
const firstVisitRulesKey = "vjudge-duel.rules-seen.v1";
const judgeCooldownKey = () => `vjudge-duel.judge-cooldown.${normalizeName(identity?.luoguName ?? "anonymous")}`;
const temporaryBanKey = "vjudge-duel.security.ban-until";
const temporaryBanReasonKey = "vjudge-duel.security.ban-reason";
const temporaryMuteKey = "vjudge-duel.security.mute-until";
let temporaryBanUntil = readStoredNumber(temporaryBanKey);
let temporaryBanReason = readStoredText(temporaryBanReasonKey) || "操作过于频繁";
let temporaryMuteUntil = readStoredNumber(temporaryMuteKey);

recordBurst("refresh", 4_000, 3, () => applyTemporaryBan(20_000, "4 秒内刷新次数过多"));

const notify = (forceStickChat = false) => {
  syncViewportScroll();
  const stickChat = forceStickChat || shouldStickChats();
  render(<App />, app);
  if (stickChat) queueMicrotask(scrollChatsToBottom);
};

function syncViewportScroll(): void {
  const fixedViewport = window.innerWidth > 1180 && (mode === "home" || mode === "room" || mode === "profile");
  document.documentElement.classList.toggle("fixed-viewport", fixedViewport);
  document.body.classList.toggle("fixed-viewport", fixedViewport);
}

window.addEventListener("resize", syncViewportScroll, { passive: true });

document.addEventListener("pointerdown", (event) => {
  if (!draft.userMenuOpen || draft.userMenuClosing) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest(".session-menu, .session-user")) return;
  closeUserMenu();
}, true);

let themeTick = 0;

const applyTheme = () => {
  const effective = themeMode === "system" ? (themeQuery.matches ? "dark" : "light") : themeMode;
  document.documentElement.dataset.theme = effective;
  if (bgImageUrl) {
    let bgLayer = document.getElementById("theme-bg-layer");
    if (!bgLayer) {
      bgLayer = document.createElement("div");
      bgLayer.id = "theme-bg-layer";
      document.body.insertBefore(bgLayer, document.body.firstChild);
    }
    bgLayer.style.backgroundImage = `url(${bgImageUrl})`;
    document.body.style.backgroundImage = "";
    document.body.style.backgroundSize = "";
    document.body.style.backgroundPosition = "";
    document.body.style.backgroundAttachment = "";
  } else {
    const bgLayer = document.getElementById("theme-bg-layer");
    if (bgLayer) bgLayer.style.backgroundImage = "";
    document.body.style.backgroundImage = "";
    document.body.style.backgroundSize = "";
    document.body.style.backgroundPosition = "";
    document.body.style.backgroundAttachment = "";
  }
  const isDefaultColor = themeColorR === 63 && themeColorG === 185 && themeColorB === 140;
  if (!isDefaultColor) {
    document.documentElement.style.setProperty("--green", `rgb(${themeColorR},${themeColorG},${themeColorB})`);
  } else {
    document.documentElement.style.removeProperty("--green");
  }
  const styleEl = document.getElementById("frosted-custom-style") || document.createElement("style");
  styleEl.id = "frosted-custom-style";
  if (frostedGlass && blurRadius > 0) {
    const a = panelAlpha / 100;
    const dk = `rgba(13,17,23,${a})`;
    const lt = `rgba(244,247,251,${a})`;
    // Top-level surfaces: get the frosted blur + translucent background.
    const surfaces = [
      ".panel", ".topbar", ".match-island", ".home-room-panel",
      ".command-panel", ".profile-card", ".session-menu", ".modal-overlay",
      ".duel-swal .swal2-popup", "body.swal2-shown .swal2-popup", ".admin-page-head"
    ];
    // Nested sub-cards: stay fully transparent so blur/colour never stacks.
    const subs = [
      ".home-announcement", ".problem-card", ".chat-line.bubble", ".vditor", ".vditor-toolbar",
      ".vditor-content", ".vditor-wysiwyg", ".vditor-reset", ".vditor-preview", ".duel-table",
      ".ranking-list", ".team-card", ".island-roster", ".chat-log", ".chat-form input",
      ".chat-form textarea", ".vote", "input", "select", "textarea"
    ];
    const surfaceRules = [
      ...surfaces.map(s => `${s} { backdrop-filter: blur(${blurRadius}px); -webkit-backdrop-filter: blur(${blurRadius}px); background: ${dk}; }`),
      ...surfaces.map(s => `[data-theme="light"] ${s} { background: ${lt}; }`)
    ];
    const subRules = [
      ...subs.map(s => `${s} { background: transparent !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }`),
      ...subs.map(s => `[data-theme="light"] ${s} { background: transparent !important; }`),
      `.problem-card:hover { background: color-mix(in srgb, var(--green) 10%, transparent) !important; border-color: var(--green); }`,
      `.duel-row { background: transparent; }`,
      `.duel-swal .swal2-html-container { background: transparent; }`
    ];
    styleEl.textContent = [...surfaceRules, ...subRules].join("\n");
  } else {
    styleEl.textContent = "";
  }
  if (!document.head.contains(styleEl)) document.head.appendChild(styleEl);
  themeTick++;
  try { document.dispatchEvent(new Event("luogu-duel:theme")); } catch { /* ignore */ }
};
const setStatus = (text: string, tone: "info" | "error" = "info") => {
  statusText = text;
  statusTone = tone;
  notify();
};

const finishBootScreen = () => {
  if (!bootScreenVisible || bootScreenLeaving) return;
  bootScreenLeaving = true;
  notify();
  window.setTimeout(() => {
    bootScreenVisible = false;
    notify();
  }, 260);
};

const boot = async () => {
  identity = await loadIdentity();
  applyTheme();
  void loadAnnouncement();
  themeQuery.addEventListener("change", () => {
    if (themeMode === "system") applyTheme();
    notify();
  });
  clockTimer ??= window.setInterval(() => {
    if ((mode === "room" && state.phase === "arena") || temporaryBanUntil > Date.now() || temporaryMuteUntil > Date.now()) notify();
  }, 1_000);
  syncTimer ??= window.setInterval(() => void periodicSync(), 60_000);
  heartbeatTimer ??= window.setInterval(() => {
    if (document.visibilityState !== "visible") return;
    const now = Date.now();
    if (socket?.readyState === WebSocket.OPEN) {
      if (roomLastPongAt && now - roomLastPongAt > 120_000) socket.close();
      else socket.send("ping");
    }
    if (directorySocket?.readyState === WebSocket.OPEN) {
      if (directoryLastPongAt && now - directoryLastPongAt > 120_000) directorySocket.close();
      else directorySocket.send("ping");
    }
  }, 45_000);
  window.addEventListener("hashchange", () => void enterFromHash());
  window.addEventListener("online", () => {
    connectRoom();
    connectDirectory();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    const now = Date.now();
    if (socket?.readyState === WebSocket.OPEN) {
      roomLastPongAt = now;
      socket.send("ping");
    }
    if (directorySocket?.readyState === WebSocket.OPEN) {
      directoryLastPongAt = now;
      directorySocket.send("ping");
    }
  });

  vjudgeSession = loadVJudgeSession();
  if (!vjudgeSession) {
    authErrorText = "请使用 VJudge 登录。";
    statusText = "等待 VJudge 身份验证";
    bootPhase = "auth-error";
    finishBootScreen();
    notify();
    return;
  }

  identity = await renameIdentity(identity, vjudgeSession.username);
  bootPhase = "ready";
  await registerCurrentUser();
  await enterFromHash();
  finishBootScreen();
  scheduleFirstVisitRules();
};

const enterFromHash = async () => {
  const params = new URLSearchParams(location.hash.slice(1));
  const profileName = profileNameFromPath();
  const adminRequested = params.get("admin") === "1";
  if (profileName && !(adminRequested && isAdmin())) {
    mode = "profile";
    roomId = "global";
    roomSecret = "public-lobby";
    profileUserName = profileName;
    closeSocket();
    connectDirectory();
    await Promise.all([loadDirectory(), loadUsers()]);
    profileLoading = true;
    notify();
    await ensureUserLoaded(profileName);
    profileLoading = false;
    notify();
    return;
  }
  if (profileName && adminRequested) draft.adminSearch = profileName;
  roomId = params.get("room") || "global";
  roomSecret = params.get("secret") || (roomId === "global" ? "public-lobby" : "public-room");
  mode = adminRequested && isAdmin() ? "admin" : roomId === "global" ? "home" : "room";
  closeSocket();
  if (initialFallbackTimer) window.clearTimeout(initialFallbackTimer);
  initialFallbackTimer = undefined;
  lastRoomLiveStateAt = 0;
  clearFinishTimer();
  draft.chat = "";
  chatVditor?.setValue("", true);
  draft.spectatorsOpen = false;
  draft.closeReason = isAdmin() ? "管理员强制关闭房间" : "房主关闭房间";

  if (mode === "home" || mode === "admin") {
    directoryLiveSnapshotReceived = false;
    envelopes = [];
    state = createInitialState("global");
    globalModeration = state;
    rooms = [];
    users = [];
    usersLoaded = false;
    connectDirectory();
    connectRoom();
    statusTone = "info";
    statusText = "正在连接大厅";
    notify();
    initialFallbackTimer = window.setTimeout(() => {
      if (mode !== "home" && mode !== "admin") return;
      void (async () => {
        if (!directoryLiveSnapshotReceived) await Promise.all([loadDirectory(), loadUsers()]);
        else if (!lastRoomLiveStateAt) await refreshGlobalModeration();
        notify();
      })();
    }, 2_000);
    return;
  }

  state = createInitialState(roomId);
  closeDirectory();
  const cachedEvents = readEventCache(roomId);
  envelopes = [];
  notify();
  connectRoom();
  const expectedRoomId = roomId;
  initialFallbackTimer = window.setTimeout(() => {
    if (mode !== "room" || roomId !== expectedRoomId || lastRoomLiveStateAt) return;
    void (async () => {
      const loaded = await loadSnapshot();
      if (!loaded && !envelopes.length) await mergeEnvelopes(cachedEvents);
      await ensureJoined();
      notify();
    })();
  }, 2_000);
  rememberActiveRoomIfNeeded();
  notify();
};

const loadDirectory = async () => {
  try {
    await refreshGlobalModeration();
    if (mode === "home") state = globalModeration;
    const remoteRooms = await fetchRooms();
    if (!directoryLiveSnapshotReceived || Date.now() - lastDirectoryLiveAt >= 20_000) {
      rooms = remoteRooms;
      writeDirectoryCache(rooms);
      directoryLiveSnapshotReceived = true;
      lastDirectoryLiveAt = Date.now();
    }
    statusTone = "info";
    statusText = "大厅在线";
  } catch (error) {
    if (!rooms.length) rooms = readDirectoryCache();
    statusTone = "error";
    statusText = friendlyError(error, "房间目录暂时不可用");
  }
};

const dedupeUserRecords = (records: UserRecord[]): UserRecord[] => {
  const unique = new Map<string, UserRecord>();
  for (const user of records) {
    const key = normalizeName(user.name);
    if (key && !unique.has(key)) unique.set(key, user);
  }
  return [...unique.values()];
};

const loadUsers = async () => {
  try {
    const remoteUsers = await fetchUsers();
    users = dedupeUserRecords(remoteUsers);
    for (const user of users) userCache[normalizeName(user.name)] = { user, cachedAt: Date.now() };
    writeUserCache();
  } catch {
    users = Object.values(userCache)
      .filter((entry) => Date.now() - entry.cachedAt < userCacheTtl)
      .map((entry) => entry.user);
  } finally {
    usersLoaded = true;
  }
};

const setThemeMode = (next: "system" | "light" | "dark") => {
  themeMode = next;
  try {
    localStorage.setItem(themeModeKey, next);
  } catch {
    // ignore
  }
  applyTheme();
  setVditorTheme(profileVditor);
  setVditorTheme(chatVditor);
  notify();
};

function readThemeMode(): "system" | "light" | "dark" {
  try {
    const stored = localStorage.getItem(themeModeKey);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
    // ignore
  }
  return "system";
}

const rgbToHex = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map((c) => Math.min(255, Math.max(0, c)).toString(16).padStart(2, "0")).join("")}`;

const hexToRgb = (hex: string): { r: number; g: number; b: number } => {
  const clean = hex.replace("#", "");
  return {
    r: parseInt(clean.slice(0, 2), 16) || 63,
    g: parseInt(clean.slice(2, 4), 16) || 185,
    b: parseInt(clean.slice(4, 6), 16) || 140
  };
};

const openThemeEditor = async () => {
  const modeLabels: Record<string, string> = { system: "跟随系统", light: "浅色", dark: "深色" };
  const modeIcons: Record<string, string> = { system: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>', light: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>', dark: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>' };
  const modeButtons = (["system", "light", "dark"] as const).map(m => 
    `<button type="button" class="theme-editor-mode-btn ${themeMode === m ? 'active' : ''}" data-mode="${m}">${modeIcons[m]} ${modeLabels[m]}</button>`
  ).join("");

  // Snapshot current values for cancel revert
  const snap = { mode: themeMode, bg: bgImageUrl, r: themeColorR, g: themeColorG, b: themeColorB, frosted: frostedGlass, blur: blurRadius, alpha: panelAlpha };

  const preview = () => { applyTheme(); };

  const result = await Swal.fire({
    title: "主题编辑器",
    html: `
      <div class="theme-editor-dialog">
        <label>主题模式</label>
        <div class="theme-editor-modes">${modeButtons}</div>
        <label>背景图片 URL</label>
        <input id="te-bg" type="text" value="${bgImageUrl.replace(/"/g, "&quot;")}" placeholder="留空=无背景">
        <label>主题颜色</label>
        <div class="te-color-row">
          <input id="te-color" type="color" value="${rgbToHex(themeColorR, themeColorG, themeColorB)}">
          <span id="te-color-hex">${rgbToHex(themeColorR, themeColorG, themeColorB)}</span>
        </div>
        <label>毛玻璃</label>
        <div class="te-frosted-row">
          <label class="te-check"><input id="te-frosted" type="checkbox" ${frostedGlass ? "checked" : ""}> 启用</label>
          <label class="te-range">模糊 <input id="te-blur" type="range" min="1" max="40" value="${blurRadius}" ${frostedGlass ? "" : "disabled"}> <span id="te-blur-val">${blurRadius}px</span></label>
          <label class="te-range">透明 <input id="te-alpha" type="range" min="10" max="100" value="${panelAlpha}" ${frostedGlass ? "" : "disabled"}> <span id="te-alpha-val">${panelAlpha}%</span></label>
        </div>
      </div>
    `,
    confirmButtonText: "保存",
    showCancelButton: true,
    cancelButtonText: "取消",
    showDenyButton: true,
    denyButtonText: "重置默认",
    customClass: { popup: "duel-swal theme-editor-swal", confirmButton: "duel-swal-confirm", cancelButton: "duel-swal-cancel", denyButton: "duel-swal-deny" },
    didOpen: () => {
      const get = (id: string) => document.getElementById(id) as HTMLInputElement;
      const applyNow = () => {
        const colorHex = get("te-color")?.value || "#3fb98c";
        const { r, g, b } = hexToRgb(colorHex);
        themeColorR = r; themeColorG = g; themeColorB = b;
        frostedGlass = get("te-frosted")?.checked ?? false;
        blurRadius = Number(get("te-blur")?.value) || 0;
        panelAlpha = Number(get("te-alpha")?.value) || 100;
        (get("te-blur-val")).textContent = `${blurRadius}px`;
        (get("te-alpha-val")).textContent = `${panelAlpha}%`;
        (get("te-color-hex")).textContent = colorHex;
        const blurInp = get("te-blur");
        const alphaInp = get("te-alpha");
        if (blurInp) blurInp.disabled = !frostedGlass;
        if (alphaInp) alphaInp.disabled = !frostedGlass;
        preview();
      };
      // Mode buttons
      document.querySelectorAll(".theme-editor-mode-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          const mode = btn.getAttribute("data-mode") || "system";
          setThemeMode(mode as "system" | "light" | "dark");
          document.querySelectorAll(".theme-editor-mode-btn").forEach(b => b.classList.remove("active"));
          btn.classList.add("active");
        });
      });
      // Real-time: color, blur, alpha, frosted
      ["te-color", "te-blur", "te-alpha", "te-frosted"].forEach(id => get(id)?.addEventListener("input", applyNow));
      get("te-frosted")?.addEventListener("change", () => {
        frostedGlass = get("te-frosted")?.checked ?? false;
        const blurInp = get("te-blur");
        const alphaInp = get("te-alpha");
        if (blurInp) blurInp.disabled = !frostedGlass;
        if (alphaInp) alphaInp.disabled = !frostedGlass;
        if (frostedGlass && blurRadius === 0 && panelAlpha === 100) {
          if (blurInp) blurInp.value = "5";
          if (alphaInp) alphaInp.value = "80";
        }
        applyNow();
      });
    },
    preConfirm: () => {
      const bgUrl = (document.getElementById("te-bg") as HTMLInputElement)?.value?.trim() || "";
      return { bgUrl, r: themeColorR, g: themeColorG, b: themeColorB, frosted: frostedGlass, blur: blurRadius, alpha: panelAlpha };
    }
  });

  if (result.isDenied) {
    // Reset to defaults
    themeMode = "system";
    bgImageUrl = "";
    themeColorR = 63; themeColorG = 185; themeColorB = 140;
    frostedGlass = false; blurRadius = 5; panelAlpha = 80;
    try { localStorage.removeItem(themeModeKey); localStorage.removeItem(bgImageKey); localStorage.removeItem(frostedKey); localStorage.removeItem(blurRadiusKey); localStorage.removeItem(panelAlphaKey); localStorage.removeItem(themeColorRKey); localStorage.removeItem(themeColorGKey); localStorage.removeItem(themeColorBKey); } catch {}
    applyTheme(); notify(); return;
  }

  if (result.isDismissed) {
    // Cancelled - revert to snapshot
    themeMode = snap.mode;
    bgImageUrl = snap.bg;
    themeColorR = snap.r; themeColorG = snap.g; themeColorB = snap.b;
    frostedGlass = snap.frosted; blurRadius = snap.blur; panelAlpha = snap.alpha;
    applyTheme(); notify(); return;
  }

  if (result.isConfirmed && result.value) {
    bgImageUrl = result.value.bgUrl;
    try {
      localStorage.setItem(themeModeKey, themeMode);
      localStorage.setItem(bgImageKey, bgImageUrl);
      localStorage.setItem(frostedKey, frostedGlass ? "1" : "0");
      localStorage.setItem(blurRadiusKey, String(blurRadius));
      localStorage.setItem(panelAlphaKey, String(panelAlpha));
      localStorage.setItem(themeColorRKey, String(themeColorR));
      localStorage.setItem(themeColorGKey, String(themeColorG));
      localStorage.setItem(themeColorBKey, String(themeColorB));
    } catch {}
    applyTheme(); notify();
  }
};

const loadSnapshot = async (): Promise<boolean> => {
  try {
    await refreshGlobalModeration();
    const requestedAt = Date.now();
    const remote = await fetchSnapshot(roomId, roomSecret);
    if (lastRoomLiveStateAt > requestedAt) return true;
    await applyAuthoritativeSnapshot(remote);
    statusTone = "info";
    statusText = "快照已同步";
    return true;
  } catch (error) {
    statusTone = "error";
    statusText = friendlyError(error, "房间快照同步失败");
    return false;
  }
};

const periodicSync = async () => {
  if (bootPhase !== "ready" || syncInFlight) return;
  syncInFlight = true;
  try {
    if (mode === "home" || mode === "admin") {
      const directoryOpen = directorySocket?.readyState === WebSocket.OPEN;
      const roomOpen = socket?.readyState === WebSocket.OPEN;
      connectDirectory();
      connectRoom();
      if (!directoryOpen) await Promise.all([loadDirectory(), loadUsers()]);
      else if (!roomOpen) await refreshGlobalModeration();
    } else if (mode === "room") {
      const roomOpen = socket?.readyState === WebSocket.OPEN;
      if (!roomOpen) {
        connectRoom();
        await loadSnapshot();
      }
    } else if (Date.now() - lastProfileFallbackSync >= 5 * 60_000) {
      lastProfileFallbackSync = Date.now();
      await Promise.all([loadDirectory(), loadUsers()]);
    }
  } finally {
    syncInFlight = false;
    notify();
  }
};

const shouldConnectRoomSocket = (): boolean => mode === "room" || ((mode === "home" || mode === "admin") && roomId === "global");

const connectRoom = () => {
  if (!shouldConnectRoomSocket()) return;
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  if (!allowServerRequest()) return;
  if (reconnectTimer) window.clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  closeSocket(false);
  const generation = ++roomSocketGeneration;
  const nextSocket = new WebSocket(roomWebSocketUrl(roomId, roomSecret));
  socket = nextSocket;
  nextSocket.addEventListener("open", () => {
    if (generation !== roomSocketGeneration) return;
    roomReconnectAttempts = 0;
    roomLastPongAt = Date.now();
    if (reconnectNoticeTimer) window.clearTimeout(reconnectNoticeTimer);
    reconnectNoticeTimer = undefined;
    statusTone = "info";
    statusText = roomId === "global" ? "大厅在线" : "房间实时在线";
    notify();
  });
  nextSocket.addEventListener("message", (event) => {
    if (generation !== roomSocketGeneration) return;
    roomLastPongAt = Date.now();
    if (event.data === "pong") return;
    void handleServerMessage(event.data);
  });
  nextSocket.addEventListener("close", () => {
    if (generation !== roomSocketGeneration) return;
    if (socket === nextSocket) socket = null;
    if (shouldConnectRoomSocket()) {
      const delay = Math.min(30_000, 500 * 2 ** Math.min(roomReconnectAttempts, 6));
      roomReconnectAttempts += 1;
      reconnectTimer = window.setTimeout(connectRoom, delay);
      if (!reconnectNoticeTimer) {
        reconnectNoticeTimer = window.setTimeout(() => {
          reconnectNoticeTimer = undefined;
          if (generation !== roomSocketGeneration || socket?.readyState === WebSocket.OPEN) return;
          statusTone = "info";
          statusText = "连接中断，正在恢复";
          notify();
        }, 4_000);
      }
    }
  });
  nextSocket.addEventListener("error", () => {
    if (generation !== roomSocketGeneration) return;
    // close 事件统一负责重连，避免 error + close 连续刷新状态。
  });
};
const notifyDraft = () => render(<App />, app);

const closeSocket = (clearTimer = true) => {
  roomSocketGeneration += 1;
  if (clearTimer && reconnectTimer) window.clearTimeout(reconnectTimer);
  if (reconnectNoticeTimer) window.clearTimeout(reconnectNoticeTimer);
  reconnectTimer = undefined;
  reconnectNoticeTimer = undefined;
  if (socket) socket.close();
  socket = null;
};

const connectDirectory = () => {
  if (mode !== "home" && mode !== "admin") return;
  if (directorySocket?.readyState === WebSocket.OPEN || directorySocket?.readyState === WebSocket.CONNECTING) return;
  if (!allowServerRequest()) return;
  if (directoryReconnectTimer) window.clearTimeout(directoryReconnectTimer);
  directoryReconnectTimer = undefined;
  closeDirectory(false);
  const generation = ++directorySocketGeneration;
  const nextSocket = new WebSocket(directoryWebSocketUrl());
  directorySocket = nextSocket;
  nextSocket.addEventListener("open", () => {
    if (generation !== directorySocketGeneration) return;
    directoryReconnectAttempts = 0;
    directoryLastPongAt = Date.now();
    if (directoryReconnectNoticeTimer) window.clearTimeout(directoryReconnectNoticeTimer);
    directoryReconnectNoticeTimer = undefined;
    statusTone = "info";
    statusText = "大厅实时连接已建立";
    notify();
  });
  nextSocket.addEventListener("message", (event) => {
    if (generation !== directorySocketGeneration) return;
    directoryLastPongAt = Date.now();
    if (event.data === "pong") return;
    void handleDirectoryMessage(event.data);
  });
  nextSocket.addEventListener("close", () => {
    if (generation !== directorySocketGeneration) return;
    if (directorySocket === nextSocket) directorySocket = null;
    if (mode === "home" || mode === "admin") {
      const delay = Math.min(60_000, 1_000 * 2 ** Math.min(directoryReconnectAttempts, 6));
      directoryReconnectAttempts += 1;
      directoryReconnectTimer = window.setTimeout(connectDirectory, delay);
      if (!directoryReconnectNoticeTimer) {
        directoryReconnectNoticeTimer = window.setTimeout(() => {
          directoryReconnectNoticeTimer = undefined;
          if (generation !== directorySocketGeneration || directorySocket?.readyState === WebSocket.OPEN) return;
          statusTone = "info";
          statusText = "大厅连接中断，正在恢复";
          notify();
        }, 5_000);
      }
    }
  });
  nextSocket.addEventListener("error", () => {
    if (generation !== directorySocketGeneration) return;
    // close 事件统一负责重连，避免重复提示。
  });
};

const closeDirectory = (clearTimer = true) => {
  directorySocketGeneration += 1;
  if (clearTimer && directoryReconnectTimer) window.clearTimeout(directoryReconnectTimer);
  if (directoryReconnectNoticeTimer) window.clearTimeout(directoryReconnectNoticeTimer);
  directoryReconnectTimer = undefined;
  directoryReconnectNoticeTimer = undefined;
  if (directorySocket) directorySocket.close();
  directorySocket = null;
};

const handleDirectoryMessage = async (raw: string) => {
  const message = JSON.parse(raw) as ServerMessage;
  if (message.type === "pong") {
    directoryLastPongAt = Date.now();
    return;
  }
  if (message.type === "directory") {
    rooms = message.rooms;
    writeDirectoryCache(rooms);
    directoryLiveSnapshotReceived = true;
    lastDirectoryLiveAt = Date.now();
    statusTone = "info";
    statusText = "大厅在线";
  }
  if (message.type === "users") {
    users = dedupeUserRecords(message.users);
    lastUsersLiveAt = Date.now();
    for (const user of users) userCache[normalizeName(user.name)] = { user, cachedAt: Date.now() };
    writeUserCache();
    usersLoaded = true;
  }
  if (message.type === "error") {
    statusTone = "error";
    statusText = message.message;
  }
  notify();
};

const handleServerMessage = async (raw: string) => {
  const message = JSON.parse(raw) as ServerMessage;
  if (message.type === "pong") {
    roomLastPongAt = Date.now();
    return;
  }
  if (message.type === "hello" || message.type === "sync") {
    await applyAuthoritativeSnapshot(message.envelopes);
    lastRoomLiveStateAt = Date.now();
    await ensureJoined();
  }
  if (message.type === "event") {
    await receiveEnvelope(message.envelope);
    lastRoomLiveStateAt = Date.now();
  }
  if (message.type === "error") {
    statusTone = "error";
    statusText = message.message;
    if (message.message.includes("另一场未结束比赛")) joinDeniedRooms.add(roomId);
    if (message.message.includes("每天最多创建 1 场")) {
      await clearRoomDraft(roomId, roomSecret).catch(() => undefined);
      localStorage.removeItem(eventCacheKey(roomId));
      localStorage.removeItem(activeRoomKey);
      pendingRoomSetup = null;
      location.href = "/";
      notify();
      return;
    }
    if (message.message.includes("房间尚未完成题目配置")) {
      statusTone = "info";
      statusText = "正在重新配置房间题目";
      void recoverPendingRoomSetup();
      notify();
      return;
    }
    await replaceRoomSnapshot().catch(() => undefined);
    await ensureJoined();
  }
  notify();
};

const mergeEnvelopes = async (incoming: SignedEnvelope[]) => {
  for (const envelope of incoming) await receiveEnvelope(envelope, false);
};

const applyAuthoritativeSnapshot = async (incoming: SignedEnvelope[]) => {
  const verified: SignedEnvelope[] = [];
  for (const envelope of incoming) {
    if (envelope.event.roomId === roomId && await verifyEnvelope(envelope)) verified.push(envelope);
  }
  const unique = new Map(verified.map((envelope) => [envelope.event.id, envelope]));
  envelopes = [...unique.values()].sort(compareEnvelopes);
  let events = envelopes.map((item) => item.event);
  if (roomId === "global") {
    events = mergePendingGlobalEvents(events);
    prunePendingGlobalEvents(events);
  }
  state = applyEvents(roomId, events);
  writeEventCache(roomId, envelopes);
  if (roomId === "global") globalModeration = state;
  saveHistory();
  scheduleFinishReturn();
  rememberActiveRoomIfNeeded();
};

const replaceRoomSnapshot = async () => {
  const remote = await fetchSnapshot(roomId, roomSecret, false);
  await applyAuthoritativeSnapshot(remote);
  if (state.closed) localStorage.removeItem(eventCacheKey(roomId));
  else writeEventCache(roomId, envelopes);
  saveHistory();
};

const ensureJoined = async () => {
  if (mode !== "room" || state.phase === "finished" || state.players[identity.id] || bannedRecord() || joinDeniedRooms.has(roomId)) return;
  if (state.phase === "arena") {
    await emit({ ...baseEvent("player.joined"), luoguName: identity.luoguName, team: "spectator" });
    rememberSeat("spectator");
    return;
  }
  const active = readActiveRoom();
  if (active?.roomId && active.roomId !== roomId) {
    setStatus("你正在另一场未结束比赛中，本房以观赛方式打开", "error");
    return;
  }
  const seat = preferredSeat();
  await emit({ ...baseEvent("player.joined"), luoguName: identity.luoguName, team: seat });
  rememberSeat(seat);
};

const ensureHomeJoined = async () => {
  if (mode !== "home" || state.players[identity.id] || bannedRecord()) return;
  await emit({ ...baseEvent("player.joined"), luoguName: identity.luoguName, team: "spectator" });
};

const receiveEnvelope = async (envelope: SignedEnvelope, renderNow = true) => {
  if (envelopes.some((item) => item.event.id === envelope.event.id)) return;
  if (!(await verifyEnvelope(envelope))) return;
  const previousPhase = state.phase;
  const previousSystemCount = state.system.length;
  envelopes.push(envelope);
  envelopes.sort(compareEnvelopes);
  state = applyEvents(roomId, envelopes.map((item) => item.event));
  writeEventCache(roomId, envelopes);
  if (roomId === "global") globalModeration = state;
  saveHistory();
  scheduleFinishReturn();
  rememberActiveRoomIfNeeded();
  if (renderNow) pushToastsForEvent(envelope.event, previousPhase, previousSystemCount);
  if (renderNow) notify();
};

const emit = async (event: DuelEvent) => {
  if (blockedByBan()) return;
  if (mode === "room" && state.phase === "finished") return;
  if (!allowServerRequest()) return;
  const envelope = await signEvent(identity, event);
  await receiveEnvelope(envelope);
  let sentBySocket = false;
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "event", envelope }));
    sentBySocket = true;
  }
  if (sentBySocket) return;
  try {
    await publishEnvelope(roomId, roomSecret, envelope);
  } catch (error) {
    const message = friendlyError(error, "发送失败，正在恢复服务器状态");
    if (!sentBySocket) setStatus(message, "error");
    if (message.includes("另一场未结束比赛")) joinDeniedRooms.add(roomId);
    await replaceRoomSnapshot().catch(() => undefined);
  }
};

const pushToastsForEvent = (event: DuelEvent, previousPhase: DuelState["phase"], previousSystemCount: number) => {
  if (mode !== "room" && event.roomId !== "global") return;
  if (event.type === "game.started") {
    const elapsed = Date.now() - (state.startedAt ?? event.issuedAt);
    if (elapsed >= 0 && elapsed < 5_000) {
      notifyImportant(`start:${roomId}:${state.startedAt ?? event.issuedAt}:${matchTitle()}`, "比赛开始", matchTitle(), "success");
    }
  }
  if (previousPhase !== "finished" && state.phase === "finished") {
    const text = state.closed?.reason ?? (state.winner === "draw" ? "双方平局" : `${teamName(state.winner)} 获胜`);
    notifyImportant(`end:${roomId}:${state.closed?.at ?? event.issuedAt}:${text}`, "比赛结束", text, "warning");
    void showMatchResult();
  }
  if (event.type === "chat.sent" && event.visibility === "team" && state.phase === "arena") {
    const chat = state.chats.find((item) => item.id === event.id);
    if (chat && visibleChats(state, identity.id).some((item) => item.id === chat.id) && !mentionsUser(chat.text, identity.luoguName)) {
      notifyImportant(`${event.id}:team`, `队内消息 / ${chat.luoguName}`, chat.text, "info");
    }
  }
  if (event.type === "chat.sent" && event.actorId !== identity.id) {
    const chat = state.chats.find((item) => item.id === event.id);
    if (chat && visibleChats(state, identity.id).some((item) => item.id === chat.id) && mentionsUser(chat.text, identity.luoguName)) {
      void notifyImportant(`${event.id}:mention`, `${chat.luoguName} @了你`, chat.text, "info");
    }
  }
  if (event.type !== "game.started" && (state.phase === "arena" || event.type.startsWith("vote.") || event.type === "judge.recordSeen" || event.type === "room.closed")) {
    for (const message of state.system.slice(previousSystemCount)) {
      notifyImportant(`system:${roomId}:${message.at}:${message.text}`, "系统", message.text, event.type === "judge.recordSeen" ? "success" : "info");
    }
  }
};

const notifyImportant = async (key: string, title: string, text: string, tone: ToastMessage["tone"] = "info") => {
  const normalizedKey = `${key}:${title}:${text}`.replace(/\s+/g, " ").trim();
  if (notifiedKeys.has(normalizedKey)) return;
  notifiedKeys.add(normalizedKey);
  const gmNotify = (globalThis as unknown as { GM_notification?: (options: { title: string; text: string; timeout?: number }) => void }).GM_notification;
  if (gmNotify) {
    gmNotify({ title: `VJudge Duel · ${title}`, text, timeout: 4200 });
    return;
  }
  if ("Notification" in window) {
    let permission = Notification.permission;
    if (permission === "default") {
      try {
        permission = await Notification.requestPermission();
      } catch {
        permission = "denied";
      }
    }
    if (permission === "granted") {
      new Notification(`VJudge Duel · ${title}`, {
        body: text,
        icon: systemLogoUrl
      });
      return;
    }
  }
  pushToast(title, text, tone);
};

setServerRequestWarningHandler(() => {
  void notifyImportant(
    `request-limit:${Math.floor(Date.now() / 60_000)}`,
    "请求过于频繁",
    "本分钟已发送 60 次请求，继续操作可能被视为攻击并导致管理员封号。",
    "warning"
  );
});

const pushToast = (title: string, text: string, tone: ToastMessage["tone"] = "info") => {
  if (toasts.some((item) => item.title === title && item.text === text)) return;
  const toast: ToastMessage = { id: crypto.randomUUID(), title, text, tone };
  toasts = [...toasts.slice(-3), toast];
  window.setTimeout(() => {
    toasts = toasts.filter((item) => item.id !== toast.id);
    notify();
  }, 4200);
};

const emitChat = async (text: string, visibility: "all" | "team") => {
  if (mode === "home") await ensureHomeJoined();
  if (mode === "room" && !state.players[identity.id]) await ensureJoined();
  const player = state.players[identity.id];
  if (mode === "room" && !player) {
    setStatus("尚未加入房间，请稍后重试", "error");
    return;
  }
  await emit({ ...baseEvent("chat.sent"), text, visibility: player?.team === "spectator" ? "all" : visibility });
};

const mentionsUser = (text: string, name: string): boolean => {
  const target = normalizeName(name);
  return [...text.matchAll(/@([A-Za-z0-9_.-]{1,40})/g)].some((match) => normalizeName(match[1]) === target);
};

const insertMention = (name: string) => {
  if (!name.trim() || isOwnName(name)) return;
  const current = (chatVditor?.getValue() ?? draft.chat).trimEnd();
  const next = `${current}${current ? " " : ""}@${name.trim()} `;
  draft.chat = next;
  chatVditor?.setValue(next, true);
  chatVditorTarget?.querySelector<HTMLElement>("[contenteditable='true']")?.focus();
};

const emitDirect = async (event: Extract<DuelEvent, { type: "room.closed" | "room.muted" | "room.unmuted" | "player.kicked" | "player.unkicked" | "player.muted" | "player.unmuted" }>) => {
  await emit(event);
};

const showMatchResult = async (): Promise<void> => {
  const player = state.players[identity.id];
  if (!player || !isTeam(player.team) || state.closed) return;
  if (!state.winner) return;
  if (state.winner === "draw") {
    await Swal.fire({
      title: "平局",
      text: "双方握手言和",
      imageUrl: "/match-draw.png",
      imageAlt: "平局动画",
      imageWidth: 160,
      imageHeight: 160,
      confirmButtonText: "知道了",
      customClass: { popup: "duel-swal match-result-swal draw", confirmButton: "duel-swal-confirm" }
    });
    return;
  }
  const won = player.team === state.winner;
  await Swal.fire({
    title: won ? "胜利" : "失败",
    text: won ? "恭喜本场对决获胜！" : "本场对决失利...",
    imageUrl: won ? "/match-win.png" : "/match-loss.png",
    imageAlt: won ? "胜利动画" : "失败动画",
    imageWidth: 160,
    imageHeight: 160,
    confirmButtonText: "知道了",
    customClass: { popup: `duel-swal match-result-swal ${won ? "won" : "lost"}`, confirmButton: "duel-swal-confirm" }
  });
};

const refreshGlobalModeration = async () => {
  try {
    const requestedAt = Date.now();
    const remote = await fetchSnapshot("global", "public-lobby");
    if (mode === "home" && roomId === "global") {
      if (lastRoomLiveStateAt > requestedAt) return;
      await mergeHomeGlobalSnapshot(remote);
      return;
    }
    const refreshed = mergePendingGlobalEvents(remote.map((item) => item.event));
    prunePendingGlobalEvents(refreshed);
    globalModeration = applyEvents("global", refreshed);
  } catch {
    if (mode === "home" && roomId === "global") globalModeration = state;
  }
};

const mergeHomeGlobalSnapshot = async (incoming: SignedEnvelope[]) => {
  await applyAuthoritativeSnapshot(incoming);
};

const ensureGlobalAdminJoined = async () => {
  if (globalModeration.players[identity.id]) return;
  const joinEvent: DuelEvent = {
    type: "player.joined",
    roomId: "global",
    actorId: identity.id,
    id: crypto.randomUUID(),
    lamport: globalModeration.lamport + 1,
    issuedAt: Date.now(),
    luoguName: identity.luoguName,
    team: "spectator"
  };
  const envelope = await signEvent(identity, joinEvent);
  await publishEnvelope("global", "public-lobby", envelope);
  globalModeration = applyEvent(globalModeration, envelope.event);
};

const moderateGlobal = async (action: "ban" | "unban" | "mute" | "unmute") => {
  const targetName = draft.adminTarget.trim();
  if (!isAdmin() || !targetName) return;
  if (isAdminName(targetName)) {
    setStatus("不能操作管理员账号", "error");
    return;
  }

  await ensureGlobalAdminJoined();
  const targetId = `name:${normalizeName(targetName)}`;
  const base = {
    roomId: "global",
    actorId: identity.id,
    id: crypto.randomUUID(),
    lamport: globalModeration.lamport + 1,
    issuedAt: Date.now()
  };
  const event: DuelEvent =
    action === "ban"
      ? { ...base, type: "player.kicked", targetId, targetName, reason: draft.adminReason.trim() || "管理员封禁" }
      : action === "unban"
        ? { ...base, type: "player.unkicked", targetName }
        : action === "mute"
          ? { ...base, type: "player.muted", targetId, targetName }
          : { ...base, type: "player.unmuted", targetId, targetName };
  const envelope = await signEvent(identity, event);
  pendingGlobalEvents.push(event);
  await publishEnvelope("global", "public-lobby", envelope);
  globalModeration = applyEvent(globalModeration, envelope.event);
  if (mode === "home" || mode === "admin") state = globalModeration;
  setStatus(`已${actionLabel(action)} ${targetName}`);
};

const actionLabel = (action: "ban" | "unban" | "mute" | "unmute"): string =>
  action === "ban" ? "封禁" : action === "unban" ? "解封" : action === "mute" ? "禁言" : "解禁言";

const baseEvent = <T extends DuelEvent["type"]>(type: T) => ({
  type,
  roomId,
  actorId: identity.id,
  id: crypto.randomUUID(),
  lamport: state.lamport + 1,
  issuedAt: Date.now()
});

type RoomDialogValues = {
  count: number;
  difficultyLow: DifficultyLevel;
  difficultyHigh: DifficultyLevel;
  ratios: PlatformRatios;
  customProblems: string;
  unrated: boolean;
};

const openCreateRoomDialog = async () => {
  if (creatingRoom) return;
  const difficultyOptions = difficultyMeta.map((item) => `<option value="${item.value}" data-difficulty="${item.value}" style="--difficulty-color:${item.color}">${item.label}</option>`).join("");
  const result = await Swal.fire<RoomDialogValues>({
    title: "生成房间",
    html: `
      <div class="room-builder-dialog">
        <label><span>题目数量</span><input id="room-builder-count" type="number" min="1" max="21"></label>
        <div class="room-builder-difficulties">
          <label><span>最低难度</span><select id="room-builder-low" class="difficulty-select">${difficultyOptions}</select></label>
          <label><span>最高难度</span><select id="room-builder-high" class="difficulty-select">${difficultyOptions}</select></label>
        </div>
        <div class="room-builder-oj">
          <strong>题目来源 <small>默认 2 : 1 : 1</small></strong>
          ${(["luogu", "codeforces", "atcoder"] as ProblemPlatform[]).map((platform) => `
            <div class="room-builder-oj-row">
              <input id="room-builder-${platform}-enabled" type="checkbox">
              <label for="room-builder-${platform}-enabled">${platformLabel(platform)}</label>
              <input id="room-builder-${platform}-weight" type="number" min="1" max="20" aria-label="${platformLabel(platform)} 权重">
            </div>
          `).join("")}
        </div>
        <label><span>自定义题目 <small>填写后强制 UNR</small></span><textarea id="room-builder-custom" rows="4" placeholder="每行一个题目；留空则随机抽题"></textarea></label>
        <label class="room-builder-unrated"><input id="room-builder-unrated" type="checkbox"><span>UNR 休闲模式</span></label>
        <small class="room-builder-cache">本地题库缓存 ${cachedProblemCount()} 条</small>
      </div>
    `,
    showCancelButton: true,
    confirmButtonText: "开始生成",
    cancelButtonText: "取消",
    focusConfirm: false,
    customClass: { popup: "duel-swal room-builder-swal", confirmButton: "duel-swal-confirm", cancelButton: "duel-swal-cancel" },
    didOpen: (popup) => {
      const count = popup.querySelector<HTMLInputElement>("#room-builder-count")!;
      const low = popup.querySelector("#room-builder-low");
      const high = popup.querySelector("#room-builder-high");
      const custom = popup.querySelector<HTMLTextAreaElement>("#room-builder-custom")!;
      const unrated = popup.querySelector<HTMLInputElement>("#room-builder-unrated")!;
      if (!(low instanceof HTMLSelectElement) || !(high instanceof HTMLSelectElement)) return;
      count.value = String(draft.roomCount);
      low.value = String(draft.difficultyLow);
      high.value = String(draft.difficultyHigh);
      custom.value = draft.customProblems;
      unrated.checked = draft.unrated;
      const ratioInputs = (["luogu", "codeforces", "atcoder"] as ProblemPlatform[]).map((platform) => {
        const enabled = popup.querySelector<HTMLInputElement>(`#room-builder-${platform}-enabled`)!;
        const weight = popup.querySelector<HTMLInputElement>(`#room-builder-${platform}-weight`)!;
        enabled.checked = draft.ratios[platform] > 0;
        weight.value = String(draft.ratios[platform] || defaultRatios[platform]);
        enabled.addEventListener("input", () => { weight.disabled = !enabled.checked || Boolean(custom.value.trim()); });
        return { enabled, weight };
      });
      const paintDifficulty = (select: HTMLSelectElement) => {
        const color = difficultyMeta.find((item) => item.value === Number(select.value))?.color ?? "var(--text)";
        select.dataset.difficulty = select.value;
        select.style.setProperty("--difficulty-color", color);
      };
      const syncCustom = () => {
        const usingCustom = Boolean(custom.value.trim());
        const customCount = parseCustomProblems(custom.value).length;
        if (customCount) count.value = String(customCount);
        count.disabled = usingCustom;
        low.disabled = usingCustom;
        high.disabled = usingCustom;
        ratioInputs.forEach(({ enabled, weight }) => {
          enabled.disabled = usingCustom;
          weight.disabled = usingCustom || !enabled.checked;
        });
        unrated.checked = usingCustom || draft.unrated;
        unrated.disabled = usingCustom;
      };
      low.addEventListener("input", () => paintDifficulty(low));
      high.addEventListener("input", () => paintDifficulty(high));
      custom.addEventListener("input", syncCustom);
      paintDifficulty(low);
      paintDifficulty(high);
      syncCustom();
    },
    preConfirm: () => {
      const popup = Swal.getPopup()!;
      const customProblems = popup.querySelector<HTMLTextAreaElement>("#room-builder-custom")!.value;
      const custom = parseCustomProblems(customProblems);
      if (customProblems.trim() && !custom.length) {
        Swal.showValidationMessage("没有识别到有效的自定义题目");
        return false;
      }
      const low = popup.querySelector("#room-builder-low");
      const high = popup.querySelector("#room-builder-high");
      if (!(low instanceof HTMLSelectElement) || !(high instanceof HTMLSelectElement)) return false;
      const difficultyLow = Number(low.value) as DifficultyLevel;
      const difficultyHigh = Number(high.value) as DifficultyLevel;
      if (!custom.length && difficultyLow > difficultyHigh) {
        Swal.showValidationMessage("最低难度不能高于最高难度");
        return false;
      }
      const ratios = Object.fromEntries((["luogu", "codeforces", "atcoder"] as ProblemPlatform[]).map((platform) => {
        const enabled = popup.querySelector<HTMLInputElement>(`#room-builder-${platform}-enabled`)!.checked;
        const weight = Number(popup.querySelector<HTMLInputElement>(`#room-builder-${platform}-weight`)!.value);
        return [platform, enabled ? clamp(weight, 1, 20) : 0];
      })) as PlatformRatios;
      if (!custom.length && Object.values(ratios).every((value) => value === 0)) {
        Swal.showValidationMessage("至少选择一个题目来源");
        return false;
      }
      return {
        count: custom.length || clamp(Number(popup.querySelector<HTMLInputElement>("#room-builder-count")!.value), 1, 21),
        difficultyLow,
        difficultyHigh,
        ratios,
        customProblems,
        unrated: custom.length > 0 || popup.querySelector<HTMLInputElement>("#room-builder-unrated")!.checked
      };
    }
  });
  if (!result.isConfirmed || !result.value) return;
  draft.roomCount = result.value.count;
  draft.difficultyLow = result.value.difficultyLow;
  draft.difficultyHigh = result.value.difficultyHigh;
  draft.ratios = result.value.ratios;
  draft.customProblems = result.value.customProblems;
  draft.unrated = result.value.unrated;
  await submitCreateRoom();
};

const submitCreateRoom = async (event?: Event) => {
  event?.preventDefault();
  if (creatingRoom) return;
  creatingRoom = true;
  notify();
  try {
  const nextRoom = compactId();
  const nextSecret = compactId() + compactId();
  const customProblems = parseCustomProblems(draft.customProblems);
  if (draft.customProblems.trim() && !customProblems.length) {
    setStatus("没有识别到有效的自定义题目", "error");
    return;
  }
  const count = customProblems.length || clamp(draft.roomCount, 1, 21);
  if (customProblems.length) {
    draft.roomCount = customProblems.length;
    draft.unrated = true;
  }
  if (!customProblems.length && draft.difficultyLow <= 2) {
    try {
      if (!(await fetchLowRoomAvailability(identity.luoguName))) {
        setStatus("今天已经创建过包含橙题或更低难度题目的房间", "error");
        await Swal.fire({ icon: "warning", title: "今日低难度房间已达上限", text: "每位用户每天只能创建 1 场包含橙题或更低难度题目的房间。", confirmButtonText: "知道了", customClass: { popup: "duel-swal" } });
        return;
      }
    } catch {
      // 预检查不可用时继续，由服务器创建事务执行最终校验。
    }
  }
  if (!(await leaveOrCloseCurrentMatchForNewRoom())) return;
  let problems: Problem[];
  try {
    if (customProblems.length) {
      problems = customProblems;
      draft.pickerStatus = `已使用 ${customProblems.length} 道自定义题目`;
    } else {
      draft.pickerStatus = "正在读取题库";
      downloadProgress = { luogu: { percent: 0, status: "等待下载" }, codeforces: { percent: 0, status: "等待下载" }, atcoder: { percent: 0, status: "等待下载" } };
      void Swal.fire({
        title: "正在准备题库",
        html: problemBankProgressHtml(),
        allowEscapeKey: false,
        allowOutsideClick: false,
        showConfirmButton: false,
        customClass: { popup: "duel-swal bank-loading-swal" }
      });
      problems = await pickProblems(count, nextRoom, draft.difficultyLow, draft.difficultyHigh, draft.ratios, (platform, percent, status) => {
        downloadProgress[platform] = { percent, status };
        Swal.update({ html: problemBankProgressHtml() });
      });
    }
    problems = sortProblemsByDifficulty(problems);
    if (!problems.length) throw new Error("当前难度和题库没有可用题目，请调整难度或比例后重试");
    draft.pickerStatus = `已抽取 ${problems.length} 题`;
    Swal.close();
  } catch (error) {
    Swal.close();
    draft.pickerStatus = "";
    setStatus(error instanceof Error ? error.message : "题库抽取失败", "error");
    return;
  }

  pendingRoomSetup = {
    roomId: nextRoom,
    secret: nextSecret,
    count,
    customProblems,
    rated: customProblems.length ? false : !draft.unrated,
    difficultyLow: draft.difficultyLow,
    difficultyHigh: draft.difficultyHigh,
    ratios: { ...draft.ratios }
  };
  const configuredEvent: DuelEvent = {
    type: "room.configured",
    roomId: nextRoom,
    actorId: identity.id,
    id: crypto.randomUUID(),
    lamport: 1,
    issuedAt: Date.now(),
    problems,
    rated: customProblems.length ? false : !draft.unrated,
    hostName: identity.luoguName,
    minimumDifficulty: customProblems.length ? undefined : draft.difficultyLow
  };
  try {
    await publishEnvelope(nextRoom, nextSecret, await signEvent(identity, configuredEvent));
  } catch (error) {
    await clearRoomDraft(nextRoom, nextSecret).catch(() => undefined);
    pendingRoomSetup = null;
    const message = friendlyError(error, "房间配置失败");
    if (message.includes("每天最多创建") || message.includes("daily low difficulty")) {
      setStatus("今天已经创建过包含橙题或更低难度题目的房间，房间已删除", "error");
      await Swal.fire({ icon: "warning", title: "房间未创建", text: "今日低难度房间次数已用完，临时房间已清理。", confirmButtonText: "知道了", customClass: { popup: "duel-swal" } });
    } else {
      setStatus(message, "error");
    }
    return;
  }
  history.pushState(null, "", `#room=${nextRoom}&secret=${nextSecret}`);
  await enterFromHash();
  await ensureJoined();
  } finally {
    creatingRoom = false;
    notify();
  }
};

const problemBankProgressHtml = (): string => (["luogu", "codeforces", "atcoder"] as ProblemPlatform[])
  .map((platform) => {
    const progress = downloadProgress[platform];
    return `<div class="swal-bank-progress"><div><strong>${platformLabel(platform)}</strong><span>${progress.status}</span><b>${progress.percent}%</b></div><progress max="100" value="${progress.percent}"></progress></div>`;
  })
  .join("");

const recoverPendingRoomSetup = async () => {
  const setup = pendingRoomSetup;
  if (!setup || setup.roomId !== roomId || recoveringRoomSetup) return;
  recoveringRoomSetup = true;
  try {
    const problems = setup.customProblems.length
      ? sortProblemsByDifficulty(setup.customProblems)
      : sortProblemsByDifficulty(await pickProblems(setup.count, `${setup.roomId}:${crypto.randomUUID()}`, setup.difficultyLow, setup.difficultyHigh, setup.ratios, () => undefined));
    if (!problems.length) throw new Error("重新抽题失败");
    const event: DuelEvent = {
      type: "room.configured",
      roomId: setup.roomId,
      actorId: identity.id,
      id: crypto.randomUUID(),
      lamport: Math.max(1, state.lamport + 1),
      issuedAt: Date.now(),
      problems,
      rated: setup.rated,
      hostName: identity.luoguName,
      minimumDifficulty: setup.customProblems.length ? undefined : setup.difficultyLow
    };
    await publishEnvelope(setup.roomId, setup.secret, await signEvent(identity, event));
    await replaceRoomSnapshot();
    await ensureJoined();
    setStatus("房间题目已重新配置");
  } catch (error) {
    const message = friendlyError(error, "房间重新配置失败");
    if (message.includes("每天最多创建") || message.includes("daily low difficulty")) {
      await clearRoomDraft(setup.roomId, setup.secret).catch(() => undefined);
      localStorage.removeItem(eventCacheKey(setup.roomId));
      localStorage.removeItem(activeRoomKey);
      pendingRoomSetup = null;
      location.href = "/";
      return;
    }
    setStatus(message, "error");
  } finally {
    recoveringRoomSetup = false;
    notify();
  }
};

const submitChat = async (event?: Event) => {
  event?.preventDefault();
  const raw = draft.chat.trim();
  if (!raw || blockedByBan()) return;
  if (isMutedCurrent()) {
    setStatus("你已被禁言", "error");
    return;
  }
  const teamMessage = raw.startsWith("/") && mode === "room";
  const text = teamMessage ? raw.slice(1).trim() : raw;
  if (!text) return;
  const privateViolation = teamMessage ? null : privateChatViolation(text);
  console.log(privateViolation);
  if (privateViolation) {
    setStatus(privateViolation, "error");
    applyTemporaryMute(20_000);
    notify();
    return;
  }
  if (recordBurst("chat", 5_000, 3, () => applyTemporaryMute(20_000))) {
    setStatus("发送过于频繁，已临时禁言 20 秒", "error");
    notify();
    return;
  }
  await emitChat(text, teamMessage ? "team" : "all");
  draft.chat = "";
  chatVditor?.setValue("", true);
  notify(true);
};

const closeRoom = async () => {
  if (!canCloseRoom(state, identity.id, identity.luoguName)) return;
  await emitDirect({ ...baseEvent("room.closed"), reason: draft.closeReason, actorName: identity.luoguName });
};

const leaveRoom = async () => {
  const seat = state.players[identity.id]?.team ?? preferredSeat();
  if (mode !== "room") return;
  if (state.phase === "finished") {
    localStorage.removeItem(roomSeatKey());
    localStorage.removeItem(activeRoomKey);
    location.hash = "";
    return;
  }
  if (state.hostId === identity.id) {
    setStatus("房主不能退出，只能关闭房间", "error");
    return;
  }
  await emit({ ...baseEvent("player.left") });
  localStorage.removeItem(roomSeatKey());
  localStorage.removeItem(activeRoomKey);
  location.hash = "";
};

const kickLobbyPlayer = async (player: Player) => {
  if (state.phase !== "lobby" || state.hostId === player.id) return;
  const allowed = state.hostId === identity.id || isAdmin();
  if (!allowed) return;
  await emitDirect({
    ...baseEvent("player.kicked"),
    targetId: player.id,
    targetName: player.luoguName,
    reason: "移出准备房"
  });
};

const leaveOrCloseCurrentMatchForNewRoom = async (action = "创建新房间"): Promise<boolean> => {
  let activeState = state;
  let activeId = roomId;
  let activeSecret = roomSecret;
  if (mode !== "room" || state.phase === "finished" || !isTeam(state.players[identity.id]?.team)) {
    const active = readActiveRoom();
    if (!active?.roomId || !active.secret) return true;
    const remote = await fetchSnapshot(active.roomId, active.secret);
    activeState = applyEvents(active.roomId, remote.map((item) => item.event));
    activeId = active.roomId;
    activeSecret = active.secret;
  }
  const player = activeState.players[identity.id];
  if (activeState.phase === "finished" || !isTeam(player?.team)) {
    localStorage.removeItem(activeRoomKey);
    return true;
  }
  const host = activeState.hostId === identity.id;
  const message = host
    ? `你正在主持一场未结束的比赛。${action}会关闭当前房间，是否继续？`
    : `你正在参加一场未结束的比赛。${action}会退出当前房间，是否继续？`;
  const confirmation = await Swal.fire({
    title: host ? `关闭当前房间并${action}？` : `退出当前比赛并${action}？`,
    text: message,
    icon: "warning",
    showCancelButton: true,
    confirmButtonText: "继续创建",
    cancelButtonText: "取消",
    background: "var(--panel)",
    color: "var(--text)",
    customClass: {
      popup: "duel-swal",
      confirmButton: "duel-swal-confirm",
      cancelButton: "duel-swal-cancel"
    }
  });
  if (!confirmation.isConfirmed) return false;
  if (!allowServerRequest()) return false;
  const base = {
    roomId: activeId,
    actorId: identity.id,
    id: crypto.randomUUID(),
    lamport: activeState.lamport + 1,
    issuedAt: Date.now()
  };
  const event: DuelEvent = host
    ? { ...base, type: "room.closed", reason: "房主创建新房间", actorName: identity.luoguName }
    : { ...base, type: "player.left" };
  const envelope = await signEvent(identity, event);
  try {
    await publishEnvelope(activeId, activeSecret, envelope);
  } catch (error) {
    setStatus(friendlyError(error, "退出当前比赛失败，请重试"), "error");
    return false;
  }
  localStorage.removeItem(`luogu-duel.${dataVersion}.seat.${activeId}`);
  localStorage.removeItem(activeRoomKey);
  return true;
};

const setSeat = async (seat: Seat) => {
  if (blockedByBan() || state.phase !== "lobby") return;
  if (currentSeat() === seat) return;
  if (state.hostId === identity.id && seat === "spectator") {
    setStatus("房主不能进入观战席", "error");
    return;
  }
  if (recordBurst("team", 3_000, 3, () => applyTemporaryBan(10_000, "3 秒内切换队伍次数过多"))) return;
  rememberSeat(seat);
  await emit({ ...baseEvent("player.teamChanged"), team: seat });
};

const toggleReady = async () => {
  const player = state.players[identity.id];
  if (!player || !isTeam(player.team) || blockedByBan()) return;
  await emit({ ...baseEvent("player.readyChanged"), ready: !player.ready });
};

const openVote = async (kind: VoteKind, targetPid?: string, replacement?: Problem) => {
  const player = state.players[identity.id];
  if (state.phase !== "arena" || !player || !isTeam(player.team) || blockedByBan()) return;
  if (kind === "surrender") {
    const existing = Object.values(state.votes).find((vote) => vote.kind === "surrender" && vote.team === player.team && vote.status === "open");
    if (existing) {
      if (!existing.approvals[identity.id]) await emit({ ...baseEvent("vote.cast"), voteId: existing.id, approve: true });
      return;
    }
  }
  if (kind === "replace-problem" && targetPid && Object.values(state.votes).some((vote) => vote.kind === kind && vote.targetPid === targetPid && vote.status === "open")) {
    setStatus(`${targetPid} 已有换题投票`);
    return;
  }
  if (kind === "draw" && Object.values(state.votes).some((vote) => vote.kind === "draw" && vote.status === "open")) {
    setStatus("已有求和投票");
    return;
  }
  await emit({ ...baseEvent("vote.opened"), vote: buildVote(kind, player, targetPid, replacement) });
};

const replaceProblem = async (targetPid: string) => {
  const current = state.problems.find((problem) => problem.pid === targetPid);
  if (!current || replacingProblems.has(targetPid) || Object.values(state.votes).some((vote) => vote.kind === "replace-problem" && vote.targetPid === targetPid && vote.status === "open") || state.phase !== "arena") return;
  replacingProblems.add(targetPid);
  notify();
  try {
    setStatus(`正在为 ${targetPid} 查找低一级题目`);
    const replacement = await pickReplacementProblem(
      current,
      state.problems,
      `${roomId}:${state.lamport}:${identity.id}`,
      state.minimumDifficulty as DifficultyLevel | undefined
    );
    await openVote("replace-problem", targetPid, replacement);
    setStatus(`${targetPid} → ${replacement.pid}，等待投票`);
  } catch (error) {
    setStatus(friendlyError(error, "换题失败"), "error");
  } finally {
    replacingProblems.delete(targetPid);
    notify();
  }
};

const judgeProblem = async (problem: Problem) => {
  const key = `${problem.platform ?? "luogu"}:${problem.pid}`;
  if (judgingProblems.has(key) || judgeCooldownRemaining() > 0 || state.phase !== "arena" || !state.startedAt) return;
  judgingProblems.add(key);
  notify();
  try {
    let records: DuelState["feed"] = [];
    let hasPending = false;
    do {
      if (mode !== "room" || state.phase !== "arena" || !state.startedAt) break;
      const players = Object.values(state.players).filter((player) => isTeam(player.team) && !moderationRecordForPlayer(player));
      records = await fetchVJudgeRecords(problem, players.map((player) => player.luoguName), state.startedAt, identity.luoguName);
      for (const record of records) {
        const existing = state.feed.find((item) => item.recordId === record.recordId && item.pid === record.pid);
        if (!existing || existing.status !== record.status || existing.at !== record.at) {
          await emit({ ...baseEvent("judge.recordSeen"), record });
        }
      }
      hasPending = records.some((record) => record.status === "PD");
      if (hasPending) {
        setStatus(`${problem.pid} 仍在判题，5 秒后自动同步`);
        await new Promise((resolve) => window.setTimeout(resolve, 5_000));
      }
    } while (hasPending);
    if (records.some((record) => record.status !== "UKE")) startJudgeCooldown();
    if (!hasPending) setStatus(records.length ? `${problem.pid} 已同步 ${records.length} 条提交` : `${problem.pid} 暂无开赛后的提交`);
  } catch (error) {
    if(error instanceof Error && error.message === "403") {
      setStatus("请刷新通过人机验证再尝试点击判题", "error");
    }
    setStatus(friendlyError(error, "VJudge 判题同步失败"), "error");
  } finally {
    judgingProblems.delete(key);
    notify();
  }
};

const App = () => {
  if (temporaryBanUntil > Date.now()) return <TemporaryBlockOverlay />;
  if (bootPhase === "loading") {
    return <BootScreen leaving={false} />;
  }
  const bootOverlay = bootScreenVisible ? <BootScreen leaving={bootScreenLeaving} /> : null;
  if (bootPhase === "auth-error") {
    return (
      <>
        <AuthError />
        {bootOverlay}
      </>
    );
  }
  return (
    <>
      <Shell title="VJudge Duel" subtitle={mode === "profile" ? "user" : mode === "admin" ? "admin" : mode === "home" ? "control room" : `${roomId} / ${state.phase}`}>
        {mode === "profile" ? <ProfilePage /> : mode === "admin" ? <AdminPage /> : mode === "home" ? <Home /> : <Room />}
      </Shell>
      <ToastStack />
      <BanOverlay />
      {bootOverlay}
    </>
  );
};

const Shell = ({ title, subtitle, children }: { title: string; subtitle: string; children: ComponentChildren }) => (
  <div class="app-shell">
    <header class="topbar">
      <button class="brand" onClick={() => {
        if (mode === "profile") location.href = "/";
        else if (mode === "room" && currentSeat() === "spectator") void leaveRoom();
        else location.hash = "";
      }}>
        {lightBrandLogoUrl || darkBrandLogoUrl ? <img src={document.documentElement.dataset.theme === "light" ? lightBrandLogoUrl : darkBrandLogoUrl} alt="" /> : null}
        <span>{title}</span>
        <em>{subtitle}</em>
      </button>
      <div class={`status-pill ${statusTone}`}>
        <Radio size={15} />
        <span>{statusText}</span>
      </div>
      <div class="session">
        <button class="ghost icon-only" onClick={() => void openThemeEditor()}>
          <Palette size={16} />
        </button>
        {bootPhase === "ready" ? (
          <>
            {isAdmin() ? <button class="ghost" onClick={() => { draft.adminSearch = mode === "profile" ? (profileUserName || "") : ""; location.hash = mode === "admin" ? "" : "admin=1"; }}><Shield size={15} />{mode === "admin" ? "主页" : "管理"}</button> : null}
            <button class="session-user" onClick={() => {
              if (draft.userMenuClosing) { draft.userMenuClosing = false; draft.userMenuOpen = true; notify(); return; }
              if (draft.userMenuOpen) closeUserMenu();
              else { draft.userMenuOpen = true; draft.userMenuClosing = false; notify(); }
            }}>
              <UserAvatar name={identity?.luoguName ?? "?"} className="chat-avatar" />
              {identity?.luoguName ?? "..."}
            </button>
            {draft.userMenuOpen ? <div class={`session-menu${draft.userMenuClosing ? " closing" : ""}`} onAnimationEnd={(event) => {
              if (draft.userMenuClosing && event.animationName === "menu-pop-out") {
                draft.userMenuOpen = false;
                draft.userMenuClosing = false;
                notify();
              }
            }}>
              <button onClick={() => { closeUserMenu(); openProfile(identity?.luoguName ?? ""); }}><House size={14} />主页</button>
              <button onClick={() => { closeUserMenu(); logout(); }}><LogOut size={14} />登出</button>
            </div> : null}
          </>
        ) : null}
      </div>
    </header>
    {children}
  </div>
);

const Home = () => (
  <main class="home-grid">
    <section class="command-panel">
      <div class="section-head">
        <Terminal size={18} />
        <div>
          <h1>创建 VJudge Duel</h1>
          <p>与朋友创建一场友好的对决。</p>
        </div>
      </div>
      <div class="home-announcement">
        <h3>{announcementTitle}</h3>
        <RichText text={announcementContent} className="announcement-content" />
        <div class="announcement-actions">
          <button type="button" class="sponsor-trigger" onClick={() => void showSponsorCode()}>赞助</button>
          <button type="button" class="rules-ticket" onClick={() => window.open('https://www.luogu.me/article/fgiidurs', '_blank')}>
            规则与工单
          </button>
        </div>
        <BanAnnouncement />
      </div>
    </section>

    <section class="panel home-room-panel">
      <div class="section-head">
        <Users size={18} />
        <div>
          <h2>公开房间</h2>
        </div>
        <div class="home-room-actions">
          <button class="ghost icon-only" title="刷新房间" onClick={() => void loadDirectory()}>
            <RefreshCw size={16} />
          </button>
          <button class={`primary open-room-builder ${creatingRoom ? "is-loading" : ""}`} disabled={creatingRoom} onClick={() => void openCreateRoomDialog()}>
            {creatingRoom ? <RefreshCw class="spin" size={16} /> : <Play size={16} />}
            {creatingRoom ? "生成中…" : "生成房间"}
          </button>
        </div>
      </div>
      <div class="home-tabs">
        <button class={draft.roomTab === "duel" ? "active" : ""} onClick={() => {
          draft.roomTab = "duel";
          notify();
        }}>Duel</button>
        <button class={draft.roomTab === "ranking" ? "active" : ""} onClick={() => {
          draft.roomTab = "ranking";
          notify();
        }}>Ranking</button>
      </div>
      {draft.roomTab === "duel" ? <RoomList /> : <Ranking />}
    </section>

    <section class="panel home-chat-panel">
      <Chat />
    </section>
  </main>
);

const Room = () => {
  if (!lastRoomLiveStateAt && !state.problems.length) return (
    <main class="room-grid room-loading">
      <div class="skeleton-match-island"><i /><span /><b /></div>
      <div class="panel skeleton-panel"><div class="sk-panel-head"><i /><b /></div><SkeletonRows count={4} compact /></div>
      <div class="panel skeleton-panel"><div class="sk-panel-head"><i /><b /></div><SkeletonRows count={5} compact /></div>
      <div class="panel skeleton-panel"><div class="sk-panel-head"><i /><b /></div><SkeletonRows count={6} compact /></div>
    </main>
  );
  return <main class="room-grid">
    <MatchIsland />

    <section class="panel comms-panel">
      <Chat />
      <Votes />
      <RoomControls />
    </section>

    <section class="panel submissions-panel">
      <PanelTitle icon={<Flame size={16} />} title="SUBMISSIONS" detail="history" />
      <FeedTable />
    </section>

    <section class="panel problems-panel">
      <PanelTitle icon={<Terminal size={16} />} title="PROBLEMS" detail="easy -> hard" />
      <Problems />
    </section>
  </main>;
};

const ArchiveStatus = () => {
  if (state.phase !== "finished") return null;
  if (state.closed) {
    return <p class="archive-status closed"><strong>已关闭</strong><span>关闭原因：{state.closed.reason}</span></p>;
  }
  if (state.winner === "draw") return <p class="archive-status draw"><strong>比赛结束：平局</strong></p>;
  const winner = state.winner === "red" ? "红方" : "蓝方";
  return <p class={`archive-status ${state.winner ?? "draw"}`}><strong>{winner} 胜利</strong><span>比赛已封档，只读观赛</span></p>;
};

const MatchTitle = () => {
  const red = Object.values(state.players).filter((p) => p.team === "red");
  const blue = Object.values(state.players).filter((p) => p.team === "blue");
  const names = (players: Player[], fallback: string) =>
    players.length ? players.map((player, index) => (
      <span key={player.id}>
        {index > 0 ? " / " : ""}
        <button class="title-name" style={{ color: nameColor(player.luoguName) }} onClick={() => openProfile(player.luoguName)}>{player.luoguName}</button>
      </span>
    )) : fallback;
  return (
    <>
      <span class="red-title">{names(red, "红方")}</span>
      <span> vs </span>
      <span class="blue-title">{names(blue, "蓝方")}</span>
    </>
  );
};

const RoomControls = () => {
  const player = state.players[identity.id];
  const canClose = canCloseRoom(state, identity.id, identity.luoguName);
  const canPlayAction = state.phase === "arena" && isTeam(player?.team) && !blockedByBan();
  const canLeaveSpectator = mode === "room" && (player?.team === "spectator" || (!player && preferredSeat() === "spectator"));
  const showLobbyControls = state.phase === "lobby";
  if (state.phase === "finished") {
    return (
      <div class="room-controls">
        <button class="leave-seat" onClick={() => void leaveRoom()}>
          <DoorClosed size={15} />
          返回大厅
        </button>
      </div>
    );
  }
  return (
    <div class="room-controls">
      {showLobbyControls ? (
        <>
          <div class="segmented">
            <button class="leave-seat" disabled={state.hostId === identity.id || blockedByBan()} onClick={() => void leaveRoom()}>
              <DoorClosed size={15} />
              退出
            </button>
            {(["red", "blue", "spectator"] as Seat[]).map((seat) => (
              <button key={seat} class={currentSeat() === seat ? "active" : ""} disabled={blockedByBan() || (seat === "spectator" && state.hostId === identity.id)} onClick={() => void setSeat(seat)}>
                {seat === "spectator" ? <Eye size={15} /> : <CircleDot size={15} />}
                {teamName(seat)}
              </button>
            ))}
          </div>
          <button class={player?.ready ? "success" : "primary"} disabled={!isTeam(player?.team) || blockedByBan()} onClick={() => void toggleReady()}>
            <Check size={16} />
            {player?.ready ? "已准备" : "准备"}
          </button>
        </>
      ) : null}
      {!showLobbyControls && canLeaveSpectator ? (
        <div class="segmented">
          <button class="leave-seat" disabled={blockedByBan()} onClick={() => void leaveRoom()}>
            <DoorClosed size={15} />
            退出观赛
          </button>
        </div>
      ) : null}
      {canPlayAction ? (
        <div class="match-actions">
          <button class="ghost" onClick={() => void openVote("draw")}>
            <Handshake size={16} />
            求和
          </button>
          <button class="danger" onClick={() => void openVote("surrender")}>
            <Flag size={16} />
            投降
          </button>
        </div>
      ) : null}
      {canClose ? (
        <div class="close-box">
          <input value={draft.closeReason} onInput={(event) => (draft.closeReason = event.currentTarget.value)} />
          <button class="danger" onClick={() => void closeRoom()}>
            <DoorClosed size={16} />
            {isAdmin() ? "强制关房" : "关闭房间"}
          </button>
        </div>
      ) : null}
    </div>
  );
};

const PanelTitle = ({ icon, title, detail }: { icon: ComponentChildren; title: string; detail: string }) => (
  <div class="panel-title">
    <span>{icon}</span>
    <strong>{title}</strong>
    <em>{detail}</em>
  </div>
);

const ScoreBar = () => {
  const red = scoreOf(state, "red");
  const blue = scoreOf(state, "blue");
  const total = Math.max(1, state.problems.reduce((sum, problem) => sum + problem.score, 0));
  const redPct = Math.min(100, (red / total) * 100);
  const bluePct = Math.min(100, (blue / total) * 100);
  const thresholdPct = Math.min(100, (winThreshold(state) / total) * 100);
  return (
    <div class="duel-progress" aria-label="score progress">
      <div class="red-fill" style={{ width: `${redPct}%` }}>
        <span>{red}</span>
      </div>
      <div class="blue-fill" style={{ width: `${bluePct}%` }}>
        <span>{blue}</span>
      </div>
      <i class="win-marker red-marker" style={{ left: `${thresholdPct}%` }} aria-label={`红方胜利线 ${winThreshold(state)}`} />
      <i class="win-marker blue-marker" style={{ left: `${100 - thresholdPct}%` }} aria-label={`蓝方胜利线 ${winThreshold(state)}`} />
    </div>
  );
};

const RoomList = () => {
  const fresh = sortedRooms().filter((room) => !(room.status === "finished" && !room.winner && playerCount(room) <= 1)).slice(0, 20);
  if (!directoryLiveSnapshotReceived && !fresh.length) return <RoomListSkeleton />;
  if (!fresh.length) return <p class="muted">暂无公开房间。</p>;
  return (
    <div class="duel-table">
      {fresh.map((room) => (
        <button class="duel-row" key={room.roomId} disabled={joiningRoom || creatingRoom} onClick={() => void joinRoom(room)} title={roomDifficultyLabel(room) || undefined}>
          <code>{shortRoomId(room.roomId)}</code>
          <RoomLineView room={room} />
          <RoomDifficulty room={room} />
          <em class={roomStatusClass(room)}>{roomStatusLabel(room)}</em>
        </button>
      ))}
    </div>
  );
};

const sortedRooms = (): RoomListing[] => {
  const rank = { lobby: 0, arena: 1, finished: 2 };
  return [...rooms].sort(
    (a, b) =>
      rank[a.status] - rank[b.status] ||
      (b.endedAt ?? b.startedAt ?? b.createdAt) - (a.endedAt ?? a.startedAt ?? a.createdAt)
  );
};

const RoomLineView = ({ room }: { room: RoomListing }) => {
  const red = room.redPlayers?.length ? room.redPlayers : [room.host];
  const blue = room.bluePlayers ?? [];
  if (isClosedListing(room)) {
    return <span class="room-line"><PlayerNameList names={[room.host]} /> <em class="result-closed">已关闭：{room.closedReason || "房间已关闭"}</em></span>;
  }
  if (room.status === "lobby") {
    return <span class="room-line"><PlayerNameList names={[room.host]} /> <em>的未开始房间{room.rated === false ? " / UNR" : ""}</em></span>;
  }
  if (room.status === "finished" && room.winner && room.winner !== "draw") {
    const winner = room.winner === "red" ? red : blue.length ? blue : ["蓝方"];
    const loser = room.winner === "red" ? (blue.length ? blue : ["蓝方"]) : red;
    return <span class="room-line"><PlayerNameList names={winner} /> <em class="result-win">胜</em> <PlayerNameList names={loser} /></span>;
  }
  if (room.status === "finished" && room.winner === "draw") {
    return <span class="room-line"><PlayerNameList names={red} /> <em class="result-draw">平</em> <PlayerNameList names={blue.length ? blue : ["蓝方"]} /></span>;
  }
  return <span class="room-line"><PlayerNameList names={red} /> <em>vs</em> <PlayerNameList names={blue.length ? blue : ["等待蓝方"]} />{room.rated === false ? <em>UNR</em> : null}</span>;
};

const PlayerNameList = ({ names }: { names: string[] }) => (
  <>
    {names.map((name, index) => (
      <span class="room-player" style={{ color: nameColor(name) }} key={`${name}:${index}`}>
        {index > 0 ? " & " : ""}
        {name}
      </span>
    ))}
  </>
);

const roomLine = (room: RoomListing): string => {
  const red = (room.redPlayers?.length ? room.redPlayers : [room.host]).join(" & ");
  const blue = (room.bluePlayers ?? []).join(" & ");
  if (isClosedListing(room)) return `${room.host} 的房间已关闭${room.closedReason ? `：${room.closedReason}` : ""}`;
  if (room.status === "finished" && room.winner && room.winner !== "draw") {
    const winner = room.winner === "red" ? red : blue || "蓝方";
    const loser = room.winner === "red" ? blue || "蓝方" : red;
    return `${winner} 胜 ${loser}`;
  }
  if (room.status === "finished" && room.winner === "draw") return `${red} 平 ${blue || "蓝方"}`;
  if (room.status === "lobby") return `${room.host} 的未开始房间${room.rated === false ? " / UNR" : ""}`;
  return `${red} vs ${blue || "等待蓝方"}`;
};

const roomStatusLabel = (room: RoomListing): string =>
  isClosedListing(room) ? "已关闭" : room.status === "lobby" ? "准备" : room.status === "arena" ? "进行中" : room.winner ? "已结束" : "已关闭";

const roomDifficultyLabel = (room: RoomListing): string => {
  if (!room.averageDifficulty && !room.minimumDifficulty && !room.maximumDifficulty) return "";
  // 主页 Duel 菜单使用彩虹色名（红橙黄绿青蓝紫）而非文字难度名
  const labelOf = (value?: number): string => value ? difficultyMeta.find((d) => d.value === value)?.colorName ?? `L${value}` : "";
  const min = room.minimumDifficulty ? labelOf(room.minimumDifficulty) : "";
  const max = room.maximumDifficulty ? labelOf(room.maximumDifficulty) : (room.averageDifficulty ? labelOf(Math.round(room.averageDifficulty)) : "");
  if (min && max) return min === max ? min : `${min}~${max}`;
  return min || max;
};

const RoomDifficulty = ({ room }: { room: RoomListing }) => {
  const min = room.minimumDifficulty ?? 1;
  const max = room.maximumDifficulty ? room.maximumDifficulty : (room.averageDifficulty ? Math.round(room.averageDifficulty) : min);
  const minColor = difficultyMeta.find((d) => d.value === min)?.color ?? "#888";
  const maxColor = difficultyMeta.find((d) => d.value === max)?.color ?? "#888";
  const label = roomDifficultyLabel(room);
  if (!label) return <span class="room-difficulty">—</span>;
  const [low, high] = label.split("~");
  return (
    <span class="room-difficulty">
      <b data-difficulty={min} style={{ "--difficulty-color": minColor } as JSX.CSSProperties}>{low}</b>
      {high ? <><i>~</i><b data-difficulty={max} style={{ "--difficulty-color": maxColor } as JSX.CSSProperties}>{high}</b></> : null}
    </span>
  );
};

const roomStatusClass = (room: RoomListing): string =>
  isClosedListing(room) || (room.status === "finished" && !room.winner) ? "closed" : room.status;

const isClosedListing = (room: RoomListing): boolean =>
  Boolean(room.closedReason) || (room.status === "lobby" && Boolean(room.endedAt));

const shortRoomId = (id: string): string => id.replace(/\D/g, "").slice(-5) || id.slice(0, 5);

type RatingRow = {
  name: string;
  rating: number;
  wins: number;
  losses: number;
  games: number;
};

const Ranking = () => {
  const rows = ratingRows();
  if (!usersLoaded) return <RankingSkeleton />;
  if (!rows.length) return <p class="muted">暂无注册用户。</p>;
  return (
    <div class="ranking-list">
      {rows.map((row, index) => (
        <button class="ranking-row" key={row.name} onClick={() => openProfile(row.name)}>
          <span>#{index + 1}</span>
          <UserAvatar name={row.name} className="chat-avatar" />
          <strong style={{ color: nameColor(row.name, row.rating) }}>{row.name}</strong>
          <code>{Math.round(row.rating)}</code>
          <em>{row.wins}-{row.losses}</em>
        </button>
      ))}
    </div>
  );
};

const ratingRows = (): RatingRow[] => {
  const map = new Map<string, RatingRow>();
  const ensure = (name: string): RatingRow => {
    const key = normalizeName(name);
    const existing = map.get(key);
    if (existing) return existing;
    const stored = userRecordFor(name);
    const row = {
      name: stored?.name ?? name,
      rating: stored?.rating ?? 1300,
      wins: stored?.wins ?? 0,
      losses: stored?.losses ?? 0,
      games: stored?.games ?? 0
    };
    map.set(key, row);
    return row;
  };
  for (const user of users) ensure(user.name);
  if (identity?.luoguName) ensure(identity.luoguName);
  return [...map.values()].sort((a, b) => b.rating - a.rating || b.wins - a.wins || a.name.localeCompare(b.name));
};

const AdminPage = () => {
  if (!isAdmin()) return <main class="center-screen"><Shield size={42} /><h1>无管理员权限</h1></main>;
  const rows = ratingRows();
  const search = normalizeName(draft.adminSearch);
  const visibleRows = search ? rows.filter((row) => normalizeName(row.name).includes(search)) : rows;
  const managedRooms = rooms.filter((room) => (room.status === "lobby" || room.status === "arena") && !isClosedListing(room));
  return (
    <main class="admin-page">
      <header class="admin-page-head">
        <div><Shield size={22} /><span><h1>管理中心</h1><p>当前管理员：{identity.luoguName}</p></span></div>
        <div class="admin-stats"><strong>{rows.length}</strong><span>玩家</span><strong>{managedRooms.length}</strong><span>活跃房间</span></div>
        <button class="ghost" onClick={() => void Promise.all([loadDirectory(), loadUsers()])}><RefreshCw size={15} />刷新</button>
      </header>

      <section class="panel admin-section">
        <div class="admin-section-head">
          <div><h2>玩家管理</h2><p>{visibleRows.length} / {rows.length} 名玩家</p></div>
          <div class="admin-player-filters">
            <input type="search" value={draft.adminSearch} placeholder="搜索用户名" onInput={(event) => { draft.adminSearch = event.currentTarget.value; notifyDraft(); }} />
            <input value={draft.adminReason} placeholder="封禁原因（可选）" onInput={(event) => (draft.adminReason = event.currentTarget.value)} />
          </div>
        </div>
        <div class="admin-player-list">
          {!usersLoaded ? <AdminPlayersSkeleton /> : visibleRows.map((row) => {
            const key = normalizeName(row.name);
            const banned = Boolean(globalModeration.banned[key]);
            const muted = Boolean(globalModeration.muted[`name:${key}`]);
            const protectedAccount = isAdminName(row.name);
            const busy = adminBusy.has(`user:${key}`);
            return (
              <article class="admin-player" key={key}>
                <UserAvatar name={row.name} className="avatar" />
                <div class="admin-player-name"><button onClick={() => openProfile(row.name)} style={{ color: nameColor(row.name, row.rating) }}>{row.name}</button><span>{protectedAccount ? "ADMIN" : banned ? "BANNED" : muted ? "MUTED" : "ACTIVE"}</span></div>
                <label class="admin-rating"><span>Rating</span><input disabled={busy} type="number" min={0} max={10000} value={draft.adminRatings[key] ?? String(Math.round(row.rating))} onInput={(event) => { draft.adminRatings[key] = event.currentTarget.value; }} /></label>
                <button disabled={busy} onClick={() => void saveAdminRating(row.name)}>{busy ? <RefreshCw class="spin" size={14} /> : <Check size={14} />}保存</button>
                <div class="admin-player-actions">
                  <button class={banned ? "ghost" : "danger"} disabled={busy || protectedAccount} onClick={() => void runAdminUserAction(row.name, banned ? "unban" : "ban")}>{banned ? <X size={14} /> : <Ban size={14} />}{banned ? "解封" : "封禁"}</button>
                  <button class="ghost" disabled={busy || protectedAccount} onClick={() => void runAdminUserAction(row.name, muted ? "unmute" : "mute")}>{muted ? <Volume2 size={14} /> : <VolumeX size={14} />}{muted ? "解禁" : "禁言"}</button>
                </div>
              </article>
            );
          })}
          {usersLoaded && !visibleRows.length ? <p class="muted admin-empty">没有匹配的玩家。</p> : null}
        </div>
      </section>

      <section class="panel admin-section">
        <div class="admin-section-head"><div><h2>房间管理</h2></div></div>
        <div class="admin-room-list">
          {!directoryLiveSnapshotReceived ? <AdminRoomsSkeleton /> : managedRooms.length ? managedRooms.map((room) => {
            const busy = adminBusy.has(`room:${room.roomId}`);
            return (
              <article class="admin-room" key={room.roomId}>
                <code>{room.roomId}</code>
                <span><strong>{room.host}</strong><small>{roomStatusLabel(room)} · {playerCount(room)} 人 · {room.problemCount} 题</small></span>
                <button class="danger" disabled={busy} onClick={() => void runForceCloseRoom(room)}>{busy ? <RefreshCw class="spin" size={14} /> : <Trash2 size={14} />}强制关闭</button>
              </article>
            );
          }) : <p class="muted">暂无准备中或进行中的房间。</p>}
        </div>
      </section>
    </main>
  );
};

const runAdminUserAction = async (name: string, action: "ban" | "unban" | "mute" | "unmute") => {
  const key = `user:${normalizeName(name)}`;
  if (adminBusy.has(key)) return;
  adminBusy.add(key);
  draft.adminTarget = name;
  notify();
  try {
    await moderateGlobal(action);
    setStatus(`已${actionLabel(action)} ${name}`);
  } catch (error) {
    setStatus(friendlyError(error, `操作 ${actionLabel(action)} 失败`), "error");
  } finally {
    adminBusy.delete(key);
    notify();
  }
};

const saveAdminRating = async (name: string) => {
  const nameKey = normalizeName(name);
  const key = `user:${nameKey}`;
  if (adminBusy.has(key)) return;
  const rating = Number(draft.adminRatings[nameKey] ?? ratingRowFor(name).rating);
  if (!Number.isFinite(rating) || rating < 0 || rating > 10_000) {
    setStatus("Rating 必须在 0 到 10000 之间", "error");
    return;
  }
  adminBusy.add(key);
  notify();
  try {
    const user = await updateUserRating(name, Math.round(rating), identity.luoguName);
    updateLocalUser(user.name, user, false);
    draft.adminRatings[nameKey] = String(user.rating);
    setStatus(`已将 ${user.name} 的 Rating 修改为 ${user.rating}`);
  } catch (error) {
    setStatus(friendlyError(error, "Rating 修改失败"), "error");
  } finally {
    adminBusy.delete(key);
    notify();
  }
};

const runForceCloseRoom = async (room: RoomListing) => {
  const key = `room:${room.roomId}`;
  if (adminBusy.has(key)) return;
  adminBusy.add(key);
  notify();
  try {
    await forceCloseRoom(room);
  } finally {
    adminBusy.delete(key);
    notify();
  }
};

const forceCloseRoom = async (room: RoomListing) => {
  const snapshot = await fetchSnapshot(room.roomId, room.secret);
  const roomState = applyEvents(room.roomId, snapshot.map((item) => item.event));
  const event: DuelEvent = {
    type: "room.closed",
    roomId: room.roomId,
    actorId: identity.id,
    id: crypto.randomUUID(),
    lamport: roomState.lamport + 1,
    issuedAt: Date.now(),
    reason: "管理员删除房间",
    actorName: identity.luoguName
  };
  const envelope = await signEvent(identity, event);
  await publishEnvelope(room.roomId, room.secret, envelope);
  rooms = rooms.filter((item) => item.roomId !== room.roomId);
  writeDirectoryCache(rooms);
  localStorage.removeItem(eventCacheKey(room.roomId));
  setStatus(`已删除房间 ${room.roomId}`);
};

const playerCount = (room: RoomListing): number => {
  const names = [room.host, ...(room.redPlayers ?? []), ...(room.bluePlayers ?? [])];
  return new Set(names.filter(Boolean).map((name) => normalizeName(name))).size;
};

const Roster = () => {
  const spectators = Object.values(state.players).filter((player) => player.team === "spectator");
  return (
    <div class="teams">
      {(["red", "blue"] as const).map((seat) => (
        <div class={`team-card ${seat}`} key={seat}>
          <h3>{teamName(seat)}</h3>
          {Object.values(state.players).filter((player) => player.team === seat).length ? (
            Object.values(state.players)
              .filter((player) => player.team === seat)
              .map((player) => <PlayerRow player={player} key={player.id} />)
          ) : (
            <p class="muted">等待玩家</p>
          )}
        </div>
      ))}
      <div class="team-card spectator-card">
        <button class="spectator-toggle" onClick={() => { draft.spectatorsOpen = !draft.spectatorsOpen; notify(); }}>
          <Eye size={14} />
          <strong>观赛席</strong>
          <span>{spectators.length}</span>
          {draft.spectatorsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        {draft.spectatorsOpen ? (
          <div class="spectator-list">
            {spectators.length ? spectators.map((player) => <PlayerRow player={player} key={player.id} />) : <p class="muted">暂无观赛人员</p>}
          </div>
        ) : null}
      </div>
    </div>
  );
};

const PlayerRow = ({ player }: { player: Player }) => {
  const banned = moderationRecordForPlayer(player);
  const muted = isMutedPlayer(player);
  const row = ratingRowFor(player.luoguName);
  const canKick = state.phase === "lobby" && state.hostId !== player.id && (state.hostId === identity.id || isAdmin());
  return (
    <div class={`player-row ${banned ? "banned" : ""}`}>
      <UserAvatar name={player.luoguName} className="avatar" />
      <div class="player-main">
        <button class="name-button" style={{ color: nameColor(player.luoguName) }} onClick={() => openProfile(player.luoguName)}>{player.luoguName}</button>
        <small>{Math.round(row.rating)}</small>
      </div>
      <div class="player-tags">
        {state.hostId === player.id ? <em><Crown size={12} />HOST</em> : null}
        {isAdminName(player.luoguName) ? <em><Shield size={12} />ADMIN</em> : null}
        {muted ? <em><Ban size={12} />MUTED</em> : null}
        {banned ? <em><Ban size={12} />BANNED</em> : <em>{player.ready ? "READY" : teamName(player.team).toUpperCase()}</em>}
        {!isOwnName(player.luoguName) ? <button type="button" class="mention-player" title={`@${player.luoguName}`} onClick={() => insertMention(player.luoguName)}>@</button> : null}
        {canKick ? <button class="kick-player" title="移出准备房" onClick={() => void kickLobbyPlayer(player)}><UserMinus size={13} /></button> : null}
      </div>
    </div>
  );
};

const Problems = () => (
  <div class="problem-grid">
    {state.problems.map((problem, index) => (
      <article class={`problem-card ${problem.solvedBy?.team ?? ""}`} key={`${problem.platform ?? "luogu"}:${problem.pid}`}>
        <div>
          {state.phase === "lobby" ? (
            <span class="problem-mask">P{String(index + 1).padStart(4, "0")}</span>
          ) : (
            <div class="problem-heading">
              <a href={vjudgeProblemUrl(problem)} target="_blank" rel="noreferrer" title={problem.title}>
                <small>{platformLabel(problem.platform ?? "luogu")}</small>{problem.pid}
              </a>
              <span class="problem-source-links">
                {problemLinks(problem).map((link) => <a href={link.href} target="_blank" rel="noreferrer" key={link.label}>{link.label}</a>)}
              </span>
            </div>
          )}
          <span>{problem.score} pts</span>
        </div>
        {problem.difficulty ? <DifficultyBadge level={problem.difficulty} /> : <em>自定义</em>}
        <strong>{problem.solvedBy?.luoguName ?? (state.phase === "lobby" ? "hidden" : "unclaimed")}</strong>
        {state.phase === "arena" && isTeam(currentSeat()) && !blockedByBan() ? (
          <div class="problem-actions">
            <button disabled={judgingProblems.has(`${problem.platform ?? "luogu"}:${problem.pid}`) || judgeCooldownRemaining() > 0} onClick={() => void judgeProblem(problem)}>
              {judgingProblems.has(`${problem.platform ?? "luogu"}:${problem.pid}`) ? <RefreshCw class="spin" size={13} /> : null}
              {judgingProblems.has(`${problem.platform ?? "luogu"}:${problem.pid}`) ? "同步中" : judgeCooldownRemaining() > 0 ? `${judgeCooldownRemaining()}s` : "判题"}
            </button>
            <button disabled={replacingProblems.has(problem.pid) || Object.values(state.votes).some((vote) => vote.kind === "replace-problem" && vote.targetPid === problem.pid && vote.status === "open")} onClick={() => void replaceProblem(problem.pid)}>{replacingProblems.has(problem.pid) ? <RefreshCw class="spin" size={13} /> : null}{replacingProblems.has(problem.pid) ? "查找中" : "换题"}</button>
            <button onClick={() => void openVote("delete-problem", problem.pid)}>删题</button>
          </div>
        ) : null}
      </article>
    ))}
  </div>
);

const Chat = () => {
  const items = chatStreamItems();
  const muted = isMutedCurrent() || (state.muted["__room__"] === true && state.hostId !== identity.id && !isAdminName(identity.luoguName));
  const readOnly = mode === "room" && state.phase === "finished";
  const canRoomMute = mode === "room" && state.phase === "arena" && (state.hostId === identity.id || isAdmin());
  queueMicrotask(syncChatVditorState);
  return (
    <div class="chat">
      <PanelTitle icon={<MessageSquare size={16} />} title="CHAT" detail={mode === "room" ? "/ prefix = team" : "global"} />
      <div class="chat-log">
        {!lastRoomLiveStateAt && !items.length ? <ChatSkeleton /> : items.map((item) => <ChatLine item={item} key={item.id} />)}
      </div>
      <form class="chat-form" onSubmit={(event) => void submitChat(event)}>
        <div class="chat-vditor" ref={chatVditorRef} />
        <div class="chat-form-actions">
          <button disabled={blockedByBan() || muted || readOnly}>
            <Send size={15} />
            {readOnly ? "只读" : muted ? "禁言" : "发送"}
          </button>
          {canRoomMute ? (
            <button class={state.muted["__room__"] ? "ghost" : "danger"} onClick={(event) => { event.preventDefault(); void emitDirect({ ...baseEvent(state.muted["__room__"] ? "room.unmuted" : "room.muted") }); }}>
              {state.muted["__room__"] ? <Volume2 size={15} /> : <VolumeX size={15} />}
              {state.muted["__room__"] ? "解禁" : "禁言"}
            </button>
          ) : null}
        </div>
      </form>
    </div>
  );
};

type ChatStreamItem =
  | { type: "chat"; id: string; at: number; chat: ChatMessage }
  | { type: "system"; id: string; at: number; text: string }
  | { type: "judge"; id: string; at: number; record: DuelState["feed"][number] };

const chatStreamItems = (): ChatStreamItem[] => {
  const chats = visibleChats(state, identity.id).slice(-20).map((chat) => ({ type: "chat" as const, id: chat.id, at: chat.at, chat }));
  const judges = mode === "room" ? state.feed.slice(0, 20).map((record) => ({
    type: "judge" as const,
    id: `judge:${record.recordId}:${record.pid}`,
    at: record.at,
    record
  })) : [];
  const systems = mode === "room" ? state.system.slice(-20).map((message) => ({
    type: "system" as const,
    id: `system:${message.id}`,
    at: message.at,
    text: message.text
  })) : [];
  return [...chats, ...judges, ...systems].sort((a, b) => a.at - b.at).slice(-20);
};

const ChatLine = ({ item }: { item: ChatStreamItem }) => {
  if (item.type === "system") {
    return (
      <p class="chat-line system">
        <span class="chat-avatar">#</span>
        <span>SYS</span>
        <RichText text={item.text} className="chat-text" />
      </p>
    );
  }
  if (item.type === "judge") {
    const record = item.record;
    return (
      <p class={record.status === "OK" ? "chat-line judge ok" : "chat-line judge fail"}>
        <span class="chat-avatar">{record.status === "OK" ? "✓" : "!"}</span>
        <span>{formatClock(record.at)} / {record.pid}</span>
        <RichText text={`${record.luoguName} ${displayJudgeStatus(record.status)}`} className="chat-text" />
      </p>
    );
  }
  const chat = item.chat;
  const mine = chat.actorId === identity.id || isOwnName(chat.luoguName);
  return (
    <p class={`chat-line bubble ${mine ? "mine" : "theirs"} ${chat.visibility === "team" ? "private" : ""}`}>
      <UserAvatar name={chat.luoguName} className="chat-avatar" />
      <button type="button" class="chat-name" title={`点击 @${chat.luoguName}`} style={{ color: nameColor(chat.luoguName) }} onClick={() => insertMention(chat.luoguName)}>{chat.visibility === "team" ? "TEAM / " : ""}{chat.luoguName}</button>
      <RichText text={chat.text} className="chat-text" />
    </p>
  );
};

const UserAvatar = ({ name, className }: { name: string; className: string }) => {
  const url = avatarUrlFor(name);
  return url ? <img class={className} src={url} alt="" loading="lazy" /> : <span class={className}>{avatarText(name)}</span>;
};

const ToastStack = () => {
  if (!toasts.length) return null;
  return (
    <div class="toast-stack">
      {toasts.map((toast) => (
        <div class={`toast ${toast.tone}`} key={toast.id}>
          {systemLogoUrl ? <img src={systemLogoUrl} alt="" /> : null}
          <strong>{toast.title}</strong>
          <span>{toast.text}</span>
        </div>
      ))}
    </div>
  );
};

const ProfilePage = () => {
  if (profileLoading) return (
    <main class="profile-page">
      <div class="profile-card profile-skeleton">
        <div class="profile-skeleton-hero"><i /><div><b /><span /></div><strong /></div>
        <div class="profile-skeleton-tabs"><i /><i /><i /></div>
        <div class="profile-skeleton-body">
          <div class="profile-skeleton-main"><SkeletonRows count={5} /></div>
          <div class="profile-skeleton-side">
            <div class="profile-skeleton-curve"><span /><strong /></div>
            <SkeletonRows count={2} compact />
          </div>
        </div>
      </div>
    </main>
  );
  const name = profileUserName || identity.luoguName;
  const user = userRecordFor(name);
  const row = ratingRowFor(name);
  const mine = normalizeName(name) === normalizeName(identity.luoguName);
  const source = user?.profileHtml || "";
  const openEditor = () => {
    draft.profileDraft = source;
    draft.profileEditing = true;
    notify();
    queueMicrotask(() => void mountProfileVditor());
  };
  return (
    <main class="profile-page">
      <div class="profile-card">
        <header class="profile-hero">
          <UserAvatar name={name} className="profile-avatar" />
          <div class="profile-identity">
            <p class="eyebrow">PLAYER PROFILE</p>
            <h1 style={{ color: nameColor(name) }}>{name}</h1>
            <p>{row.games} 场对决 · {row.wins} 胜 · {row.losses} 负</p>
          </div>
          <div class="profile-rating-summary">
            <span>RATING</span>
            <strong>{Math.round(row.rating)}</strong>
          </div>
        </header>

        <nav class="profile-tabs" aria-label="个人主页栏目">
          {(["home", "matches", "achievements"] as const).map((tab) => (
            <button class={draft.profileTab === tab ? "active" : ""} key={tab} onClick={() => { destroyProfileVditor(); draft.profileTab = tab; draft.profileEditing = false; notify(); }}>
              {tab === "home" ? "主页" : tab === "matches" ? "对局" : "成就"}
            </button>
          ))}
        </nav>

        {draft.profileTab === "home" ? (
          <div class="profile-home-layout">
            <section class="profile-home-main">
              <div class="profile-content-head">
                <div><h2>个人主页</h2></div>
                {mine ? (
                  <div class="profile-actions">
                    {draft.profileEditing ? (
                      <>
                        <button class="primary" onClick={() => void persistUserProfile(name, profileVditor?.getValue() ?? draft.profileDraft)}>保存</button>
                        <button class="ghost" onClick={() => { destroyProfileVditor(); draft.profileEditing = false; draft.profileDraft = ""; notify(); }}>取消</button>
                      </>
                    ) : <button class="primary" onClick={openEditor}>编辑主页</button>}
                  </div>
                ) : null}
              </div>
              <div class="profile-home-scroll">
                {draft.profileEditing && mine ? (
                  <div id="profile-vditor" class="profile-vditor" />
                ) : (
                  <div class="profile-html">
                    <RichText text={source || "这个用户还没有填写个人主页。"} className="profile-rich-text" />
                  </div>
                )}
              </div>
            </section>
            <aside class="profile-sidebar">
              <RatingCurve name={name} />
              <div class="profile-stats">
                <span>比赛数据</span>
                <strong>{row.wins}/{row.games}</strong>
                <small>{row.games ? Math.round(row.wins / row.games * 100) : 0}% 胜率</small>
              </div>
            </aside>
          </div>
        ) : null}

        {draft.profileTab === "matches" ? (
          <section class="profile-section profile-tab-panel">
            <h2>最近 20 场</h2>
            {completedPlayerRooms(name).length
              ? completedPlayerRooms(name).slice(0, 20).map((room) => <p key={room.roomId}><code>{shortRoomId(room.roomId)}</code><span>{roomLine(room)}</span><em>{roomStatusLabel(room)}</em></p>)
              : <p class="muted">暂无已结束的对局。</p>}
          </section>
        ) : null}

        {draft.profileTab === "achievements" ? (
          <div class="achievement-grid profile-tab-panel">
            {achievementsFor(name, row).map((achievement) => (
              <article class={`achievement ${achievement.progress >= 100 ? "complete" : ""}`} key={achievement.title}>
                <achievement.Icon size={26} />
                <div><h3>{achievement.title}</h3><p>{achievement.text}</p><span>进度 {achievement.progress}%</span></div>
              </article>
            ))}
          </div>
        ) : null}
      </div>
    </main>
  );
};

const FeedTable = () => (
  <table class="feed-table">
    <thead>
      <tr>
        <th>TIME</th>
        <th>PROB</th>
        <th>USER</th>
        <th>VERDICT</th>
      </tr>
    </thead>
    <tbody>
      {state.feed.slice(0, 16).map((item) => (
        <tr class={item.status === "OK" ? "ok" : "fail"} key={`${item.recordId}:${item.pid}`}>
          <td>{formatClock(item.at)}</td>
          <td><code>{problemCode(item.pid)}</code></td>
          <td>{item.luoguName}</td>
          <td>{displayJudgeStatus(item.status)}</td>
        </tr>
      ))}
      {state.feed.length === 0 ? (
        <tr>
          <td colSpan={4}>No submissions.</td>
        </tr>
      ) : null}
    </tbody>
  </table>
);

const Votes = () => {
  const openVotes = Object.values(state.votes).filter((vote) => vote.status === "open");
  if (!openVotes.length) return null;
  const canVote = isTeam(currentSeat()) && !blockedByBan();
  return (
    <div class="votes">
      {openVotes.map((vote) => (
        <div class="vote" key={vote.id}>
          <span>{vote.kind === "surrender" ? `${teamName(vote.team)}投降` : `${voteLabel(vote.kind)} ${vote.targetPid ?? ""}`}</span>
          <strong>{vote.kind === "surrender"
            ? `${requiredVoters(state, vote).filter((id) => vote.approvals[id]).length}/${requiredVoters(state, vote).length}`
            : `${Object.keys(vote.approvals).length}/${participantCount()}`}</strong>
          {vote.kind === "surrender" ? (
            currentSeat() === vote.team && !vote.approvals[identity.id] && !vote.rejections[identity.id] ? <><button class="danger" onClick={() => void emit({ ...baseEvent("vote.cast"), voteId: vote.id, approve: true })}>确认投降</button><button onClick={() => void emit({ ...baseEvent("vote.cast"), voteId: vote.id, approve: false })}>拒绝</button></> : null
          ) : canVote ? (
            <>
              <button onClick={() => void emit({ ...baseEvent("vote.cast"), voteId: vote.id, approve: true })}>同意</button>
              <button onClick={() => void emit({ ...baseEvent("vote.cast"), voteId: vote.id, approve: false })}>拒绝</button>
            </>
          ) : null}
        </div>
      ))}
    </div>
  );
};

const BanOverlay = () => {
  const record = bannedRecord();
  if (!record) return null;
  return (
    <div class="ban-overlay">
      <div>
        <Ban size={46} />
        <h1>你已被封禁</h1>
        <p>{record.reason}</p>
        <a class="ban-contact" href="https://www.luogu.com.cn/chat?uid=752953" target="_blank" rel="noreferrer">联系 sLMxf 申请解封</a>
        <small>操作人：{record.by}</small>
      </div>
    </div>
  );
};

const RatingCurve = ({ name }: { name: string }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const user = userRecordFor(name);
  const raw = user?.ratingHistory?.length ? user.ratingHistory.slice(-24) : [{ at: Date.now(), rating: user?.rating ?? 1300 }];
  const values = raw.map((point) => point.rating).sort((a, b) => a - b);
  const medianOf = (items: number[]): number => items.length % 2
    ? items[(items.length - 1) / 2]
    : (items[items.length / 2 - 1] + items[items.length / 2]) / 2;
  const median = medianOf(values);
  const deviation = medianOf(values.map((rating) => Math.abs(rating - median)).sort((a, b) => a - b));
  const outlierDistance = Math.max(400, deviation * 6);
  const filtered = raw.filter((point) => Math.abs(point.rating - median) <= outlierDistance);
  const visible = filtered.length ? filtered : raw;
  const history = visible.length === 1 ? [visible[0], { ...visible[0], at: visible[0].at + 1 }] : visible;
  const ratings = history.map((point) => point.rating);
  const minimum = Math.min(...ratings);
  const maximum = Math.max(...ratings);
  // 完全基于数据自适应：先按数据上下各留白，保证所有点都在区间内；
  // 若可视区高度不足 MIN_CHART_RANGE，再向两侧对称扩展（仍以数据为中心，不溢出）。
  const RATING_PAD = 40;
  const MIN_CHART_RANGE = 300;

  const dataRange = maximum - minimum;
  const padding = Math.max(RATING_PAD, dataRange * 0.15);
  let floor = minimum - padding;
  let ceiling = maximum + padding;

  const span = ceiling - floor;
  if (span < MIN_CHART_RANGE) {
    const extra = (MIN_CHART_RANGE - span) / 2;
    floor -= extra;
    ceiling += extra;
  }

  floor = Math.floor(floor);
  ceiling = Math.ceil(ceiling);
  const first = history[0].rating;
  const current = history.at(-1)?.rating ?? first;

  const cssVar = (n: string, fallback: string): string =>
    getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fallback;

  const buildChart = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    chartRef.current?.destroy();

    const green = cssVar("--green", "#3fb98c");

    const chart = new Chart(canvas, {
      type: "line",
      data: {
        labels: history.map((_, i) => i),
        datasets: [{
          data: history.map((p) => p.rating),
          borderColor: green,
          backgroundColor: (ctx) => {
            const { chart } = ctx;
            const { ctx: c, chartArea } = chart;
            if (!chartArea) return "transparent";
            const g = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
            g.addColorStop(0, green);
            // 向主题背景色过渡：浅色模式→浅色，深色模式→深色（不再向黑色过渡）
            g.addColorStop(1, cssVar("--panel", "#0d1117"));
            return g;
          },
          fill: true,
          tension: 0,
          pointBackgroundColor: green,
          pointBorderColor: "transparent",
          pointRadius: 2.5,
          pointHoverRadius: 6,
          pointHoverBackgroundColor: green,
          pointHoverBorderColor: cssVar("--panel", "#0d1117"),
          pointHoverBorderWidth: 2,
          borderWidth: 2.5,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 900, easing: "easeOutQuart" },
        interaction: { intersect: false, mode: "index" as const },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: cssVar("--panel", "#0d1117"),
            titleColor: cssVar("--muted", "#667085"),
            bodyColor: cssVar("--text", "#f0f6fc"),
            borderColor: cssVar("--line-soft", "#21262d"),
            borderWidth: 1,
            cornerRadius: 8,
            padding: 10,
            displayColors: false,
            titleFont: { family: "ui-monospace, monospace", size: 11, weight: "bold" },
            bodyFont: { family: "ui-monospace, monospace", size: 14, weight: "bold" },
            callbacks: {
              title: (items) => {
                const i = items[0]?.dataIndex;
                if (i == null) return "";
                return new Date(history[i].at).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
              },
              label: (item) => `Rating ${Math.round(item.parsed.y ?? 0)}`,
            },
          },
        },
        scales: {
          x: { display: false },
          y: { display: false, min: floor, max: ceiling },
        },
      },
    });
    chartRef.current = chart;
  };

  useEffect(() => {
    buildChart();
    const handler = () => buildChart();
    document.addEventListener("luogu-duel:theme", handler);
    return () => {
      document.removeEventListener("luogu-duel:theme", handler);
      chartRef.current?.destroy();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  return (
    <section class="rating-curve-card" aria-label="Rating 曲线">
      <div><span>RATING</span><strong>{Math.round(current)}</strong><em class={current >= first ? "up" : "down"}>{current >= first ? "+" : ""}{Math.round(current - first)}</em></div>
      <canvas ref={canvasRef} />
    </section>
  );
};

const loadAnnouncement = async () => {
  const raw = "https://github.com/ggenerals/VJudge-Duel-Homepage/raw/refs/heads/main/README.md";
  const urls = [
    `https://gh.xmly.dev/${raw}`,
    `https://gh-proxy.com/${raw}`,
    `https://github.ikgy.top/${raw}`,
    `https://gh-proxy.org/${raw}`,
    `https://cdn.gh-proxy.org/${raw}`,
    `https://g.z321.cc.cd/${raw}`,
    `https://j.1lin.dpdns.org/${raw}`,
    raw
  ];

  try {
    const c = JSON.parse(localStorage.getItem(announcementCacheKey) || "null");
    if (c?.content && Date.now() - (c.cachedAt || 0) < 3600000) {
      announcementTitle = "VJudge Duel 公告";
      announcementContent = c.content;
      notify();
      return;
    }
  } catch {}

  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const text = await res.text();
      announcementTitle = "VJudge Duel 公告";
      announcementContent = text;
      try { localStorage.setItem(announcementCacheKey, JSON.stringify({ content: text, cachedAt: Date.now() })); } catch {}
      notify();
      return;
    } catch {}
  }

  if (announcementContent === "正在读取公告…") announcementContent = "公告暂时不可用。";
};

const TemporaryBlockOverlay = () => (
  <div class="temporary-block-overlay">
    <div>
      <Shield size={48} />
      <h1>临时封禁</h1>
      <p>{temporaryBanReason}</p>
      <strong>{Math.max(1, Math.ceil((temporaryBanUntil - Date.now()) / 1000))}s</strong>
    </div>
  </div>
);

const vditorCdn = "https://cdn.jsdelivr.net/npm/vditor@3.11.2";

const loadVditor = () => {
  vditorModulePromise ??= import("vditor");
  return vditorModulePromise;
};

const currentVditorTheme = (): "dark" | "light" => document.documentElement.dataset.theme === "dark" ? "dark" : "light";

const vditorPreviewOptions = () => {
  const theme = currentVditorTheme();
  return {
    theme: { current: theme, path: `${vditorCdn}/dist/css/content-theme` },
    hljs: { style: theme === "dark" ? "github-dark" : "github" },
    markdown: { sanitize: true, codeBlockPreview: true, mathBlockPreview: true },
    math: { engine: "KaTeX" as const }
  };
};

const setVditorTheme = (editor: VditorType | null) => {
  if (!editor) return;
  const theme = currentVditorTheme();
  editor.setTheme(theme === "dark" ? "dark" : "classic", theme, theme === "dark" ? "github-dark" : "github", `${vditorCdn}/dist/css/content-theme`);
};

const chatEditorBlocked = () => blockedByBan() || isMutedCurrent() || (mode === "room" && state.phase === "finished");

const syncChatVditorState = () => {
  if (!chatVditor) return;
  if (chatEditorBlocked()) chatVditor.disabled();
  else chatVditor.enable();
};

const destroyChatVditor = () => {
  chatVditorGeneration += 1;
  chatVditor?.destroy();
  chatVditor = null;
  chatVditorTarget = null;
};

const mountChatVditor = async (target: HTMLDivElement) => {
  if (chatVditor && chatVditorTarget === target) {
    syncChatVditorState();
    return;
  }
  destroyChatVditor();
  chatVditorTarget = target;
  const generation = chatVditorGeneration;
  const { default: Vditor } = await loadVditor();
  if (generation !== chatVditorGeneration || !target.isConnected) return;
  const editor = new Vditor(target, {
    mode: "wysiwyg",
    value: draft.chat,
    lang: "zh_CN",
    cdn: vditorCdn,
    theme: currentVditorTheme() === "dark" ? "dark" : "classic",
    minHeight: 82,
    cache: { enable: false },
    counter: { enable: true, max: 500, type: "markdown" },
    toolbar: ["bold", "italic", "strike", "inline-code", "link", "emoji"],
    toolbarConfig: { pin: false },
    preview: vditorPreviewOptions(),
    input: (value) => { draft.chat = value; },
    ctrlEnter: (value) => {
      draft.chat = value;
      void submitChat();
    },
    after: () => syncChatVditorState()
  });
  chatVditor = editor;
};

const chatVditorRef = (element: HTMLDivElement | null) => {
  if (element) {
    void mountChatVditor(element);
    return;
  }
  queueMicrotask(() => {
    if (chatVditorTarget && !chatVditorTarget.isConnected) destroyChatVditor();
  });
};

const destroyProfileVditor = () => {
  profileVditor?.destroy();
  profileVditor = null;
};

const mountProfileVditor = async () => {
  const target = document.querySelector<HTMLDivElement>("#profile-vditor");
  if (!target || !draft.profileEditing) return;
  destroyProfileVditor();
  const { default: Vditor } = await loadVditor();
  if (!target.isConnected || !draft.profileEditing) return;
  const editor = new Vditor(target, {
    mode: "wysiwyg",
    value: draft.profileDraft,
    lang: "zh_CN",
    cdn: vditorCdn,
    theme: currentVditorTheme() === "dark" ? "dark" : "classic",
    minHeight: 380,
    cache: { enable: false },
    counter: { enable: true, max: 20_000, type: "markdown" },
    toolbar: ["headings", "bold", "italic", "strike", "|", "quote", "list", "ordered-list", "check", "|", "link", "table", "code", "inline-code", "|", "undo", "redo", "fullscreen"],
    preview: vditorPreviewOptions(),
    input: (value) => { draft.profileDraft = value; },
    ctrlEnter: (value) => void persistUserProfile(profileUserName || identity.luoguName, value)
  });
  profileVditor = editor;
};

const mountVditorPreview = (element: HTMLDivElement | null, source: string) => {
  const renderKey = `${currentVditorTheme()}\u0000${source}`;
  if (!element || vditorPreviewSources.get(element) === renderKey) return;
  vditorPreviewSources.set(element, renderKey);
  element.textContent = source;
  void loadVditor().then(({ default: Vditor }) => Vditor.preview(element, source, {
    mode: currentVditorTheme(),
    lang: "zh_CN",
    cdn: vditorCdn,
    anchor: 0,
    ...vditorPreviewOptions(),
    after: () => {
      element.querySelectorAll<HTMLAnchorElement>("a").forEach((anchor) => {
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
      });
    }
  })).catch(() => {
    element.textContent = source;
  });
};

const RichText = ({ text, className = "" }: { text: string; className?: string }) => (
  <div class={`rich-text vditor-reset ${currentVditorTheme() === "dark" ? "vditor-reset--dark" : ""} ${className}`} ref={(element) => mountVditorPreview(element, text)} />
);

const AuthError = () => (
  <Shell title="VJudge Duel" subtitle="login">
    <main class="center-screen auth-page">
      <section class="auth-card">
        <div class="auth-intro">
          <KeyRound class="login-mark" size={38} strokeWidth={1.8} />
          <p class="eyebrow">VJUDGE IDENTITY</p>
          <h1>使用 VJudge 登录</h1>
          <p>{authErrorText}</p>
        </div>
        <form class="paste-login" onSubmit={(event) => void submitVJudgeLogin(event)}>
          <strong class="login-title">验证账号</strong>
          <div class="auth-methods" role="tablist" aria-label="登录验证方式">
            <button type="button" role="tab" aria-selected={vjudgeLoginMethod === "recent"} class={vjudgeLoginMethod === "recent" ? "active" : ""} disabled={loginSubmitting} onClick={() => setVJudgeLoginMethod("recent")}><KeyRound size={15} />快速验证</button>
            <button type="button" role="tab" aria-selected={vjudgeLoginMethod === "school"} class={vjudgeLoginMethod === "school" ? "active" : ""} disabled={loginSubmitting} onClick={() => setVJudgeLoginMethod("school")}><Building2 size={15} />学校验证码</button>
          </div>
          <input disabled={loginSubmitting} value={vjudgeUsername} placeholder="VJudge 用户名" autoComplete="username" onInput={(event) => { vjudgeUsername = event.currentTarget.value; notify(); }} />
          {vjudgeLoginMethod === "recent" ? (
            <>
              <ol class="login-guide">
                <li>确保当前浏览器已经登录 VJudge</li>
                <li>点击按钮，由系统自动完成在线确认</li>
              </ol>
              <div class="login-actions">
                <a href="https://vjudge.net/" target="_blank" rel="noreferrer">前往 VJudge 登录</a>
                <button class={`primary ${loginSubmitting ? "is-loading" : ""}`} disabled={loginSubmitting} type="submit">
                  {loginSubmitting ? <RefreshCw class="spin" size={16} /> : <KeyRound size={16} />}{loginSubmitting ? "正在快速验证…" : "快速验证"}
                </button>
              </div>
            </>
          ) : (
            <>
              <ol class="login-guide">
                <li>点击用户名并选择“更新资料”</li>
                <li>在“学校”字段末尾加入下面的 6 位数字</li>
                <li>保存资料后回到这里验证</li>
              </ol>
              <div class="school-code-box">
                <span>学校验证码</span>
                <output>{schoolVerificationCode || "------"}</output>
                <button type="button" disabled={loginSubmitting} title="复制验证码" onClick={() => void copySchoolVerificationCode()}><Copy size={15} /></button>
                <button type="button" disabled={loginSubmitting} onClick={generateSchoolVerificationCode}>{schoolVerificationCode ? "换一个" : "生成"}</button>
              </div>
              <div class="login-actions">
                <a href={`https://vjudge.net/user/${encodeURIComponent(vjudgeUsername.trim())}`} target="_blank" rel="noreferrer">打开个人资料</a>
                <button class={`primary ${loginSubmitting ? "is-loading" : ""}`} disabled={loginSubmitting || !schoolVerificationCode} type="submit">
                  {loginSubmitting ? <RefreshCw class="spin" size={16} /> : <Check size={16} />}{loginSubmitting ? "正在读取资料…" : "验证学校字段"}
                </button>
              </div>
            </>
          )}
        </form>
      </section>
    </main>
  </Shell>
);

const BanAnnouncement = () => {
  const entries = Object.entries(globalModeration.banned);
  if (!entries.length) return null;
  return (
    <div class="ban-announcement">
      <strong>封禁公告</strong>
      {entries.map(([name, record]) => <p key={name}><b>{name}</b><span>{record.reason}</span></p>)}
    </div>
  );
};

const openVJudgeForLogin = async (username: string): Promise<VJudgeSession> => {
  const popup = window.open("about:blank", "_blank", "popup,width=1080,height=760");
  const url = "https://vjudge.net/";
  if (!popup) throw new Error("浏览器阻止了 VJudge 窗口，请允许本站弹出窗口后重试");
  popup.location.replace(url);
  await fetch(url, { method: "HEAD", cache: "no-store", mode: "no-cors", credentials: "include" }).catch(() => undefined);
  const startedAt = performance.now();
  await fetch(url, { method: "HEAD", cache: "default", mode: "no-cors", credentials: "include" }).catch(() => undefined);
  const timeout = (performance.now() - startedAt) * 2 + 10000;

  const deadline = performance.now() + timeout;
  const POLL_INTERVAL = 2000;

  try {
    while (performance.now() < deadline) {
      if (popup.closed) throw new Error("VJudge 窗口已被关闭");
      try {
        return await verifyVJudgeLogin(username, "recent");
      } catch (err: unknown) {
        if (err instanceof Error && /404/.test(err.message)) {
          throw err;
        }
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      await new Promise((r) => setTimeout(r, Math.min(POLL_INTERVAL, remaining)));
    }

    throw new Error("VJudge 登录验证超时，请重试");
  } finally {
    if (!popup.closed) popup.close();
  }
};

const setVJudgeLoginMethod = (method: VJudgeLoginMethod) => {
  vjudgeLoginMethod = method;
  authErrorText = method === "recent" ? "快速验证会确认最近的 VJudge 在线状态。" : "将验证码加入 VJudge 学校字段后即可验证。";
  if (method === "school" && !schoolVerificationCode) generateSchoolVerificationCode();
  notify();
};

const generateSchoolVerificationCode = () => {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  schoolVerificationCode = String(random[0] % 1_000_000).padStart(6, "0");
  notify();
};

const copySchoolVerificationCode = async () => {
  if (!schoolVerificationCode) generateSchoolVerificationCode();
  try {
    await navigator.clipboard.writeText(schoolVerificationCode);
    authErrorText = `验证码 ${schoolVerificationCode} 已复制`;
  } catch {
    authErrorText = `请手动复制验证码 ${schoolVerificationCode}`;
  }
  notify();
};

const submitVJudgeLogin = async (event: Event) => {
  event.preventDefault();
  if (loginSubmitting) return;
  const username = vjudgeUsername.trim();
  if (!username) {
    authErrorText = "请输入 VJudge 用户名";
    notify();
    return;
  }
  loginSubmitting = true;
  notify();
  try {
    vjudgeSession = vjudgeLoginMethod === "recent"
      ? await openVJudgeForLogin(username)
      : await verifyVJudgeLogin(username, "school", schoolVerificationCode);
    identity = await renameIdentity(identity, vjudgeSession.username);
    authErrorText = "";
    bootPhase = "ready";
    await registerCurrentUser();
    await refreshGlobalModeration();
    await enterFromHash();
  } catch (error) {
    authErrorText =
      error instanceof Error
        ? error.message
        : "VJudge 登录失败";
  } finally {
    loginSubmitting = false;
  }
  notify();
};

const DifficultyBadge = ({ level }: { level: number }) => {
  const meta = difficultyMeta.find((item) => item.value === level);
  return <span class="difficulty-badge" data-difficulty={level} style={{ "--difficulty-color": meta?.color ?? "#6b7280" } as JSX.CSSProperties}>{meta?.short ?? level}</span>;
};

const History = () => {
  const history = readHistory();
  if (!history.length) return <p class="muted">暂无历史对局。</p>;
  return (
    <div class="history-list">
      {history.slice(-8).reverse().map((item) => (
        <p key={`${item.roomId}:${item.at}`}><span>{item.roomId}</span><strong>{item.result}</strong></p>
      ))}
    </div>
  );
};

const joinRoom = async (room: RoomListing) => {
  if (joiningRoom || creatingRoom) return;
  joiningRoom = true;
  notify();
  try {
    if (!(await leaveOrCloseCurrentMatchForNewRoom("进入新房间"))) return;
    location.hash = `room=${room.roomId}&secret=${room.secret}`;
  } finally {
    joiningRoom = false;
    notify();
  }
};

const MatchIsland = () => {
  const red = scoreOf(state, "red");
  const blue = scoreOf(state, "blue");
  const total = Math.max(1, state.problems.reduce((sum, problem) => sum + problem.score, 0));
  const threshold = winThreshold(state);
  return (
    <aside class={`match-island${draft.matchIslandPinned ? " pinned" : ""}`} onClick={() => { draft.matchIslandPinned = !draft.matchIslandPinned; notify(); }}>
      <div class="match-island-summary">
        <time>{state.phase === "lobby" ? "准备中" : formatMatchClock()}</time>
        <span class="island-duel" aria-label={`红方 ${red} 分，蓝方 ${blue} 分，胜利线 ${threshold}`}>
          <b class="island-red-score">{red}</b>
          <span class="island-duel-track">
            <i class="island-red-fill" style={{ width: `${Math.min(100, red / total * 100)}%` }} />
            <i class="island-blue-fill" style={{ width: `${Math.min(100, blue / total * 100)}%` }} />
          </span>
          <b class="island-blue-score">{blue}</b>
          <em>胜 {threshold}</em>
        </span>
        {draft.matchIslandPinned ? <span class="island-pin-icon" title="已固定，点击取消"><Pin size={12} /></span> : null}
      </div>
      <div class="island-hover-detail">
        <ArchiveStatus />
        <strong><MatchTitle /></strong>
        {state.phase === "lobby" ? <span>{state.problems.length} 题 / {state.rated ? "Rated" : "UNR"}</span> : null}
      </div>
      <div class="island-roster"><Roster /></div>
    </aside>
  );
};

const showSponsorCode = async () => {
  await Swal.fire({
    title: "赞助",
    imageUrl: "https://cdn.luogu.com.cn/upload/image_hosting/7uzglkak.png",
    imageAlt: "赞助码",
    imageWidth: 280,
    confirmButtonText: "关闭",
    customClass: { popup: "duel-swal", confirmButton: "duel-swal-confirm" }
  });
};

let firstVisitRulesScheduled = false;
const scheduleFirstVisitRules = () => {
  if (firstVisitRulesScheduled || localStorage.getItem(firstVisitRulesKey) === "1") return;
  firstVisitRulesScheduled = true;
  window.setTimeout(() => {
    const rulesWindow = window.open("https://www.luogu.me/article/fgiidurs", "_blank", "noopener,noreferrer");
    if (!rulesWindow) {
      void showFirstVisitRules();
      return;
    }
    const showOnReturn = () => {
      if (document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", showOnReturn);
      window.removeEventListener("focus", showOnReturn);
      void showFirstVisitRules();
    };
    document.addEventListener("visibilitychange", showOnReturn);
    window.addEventListener("focus", showOnReturn);
  }, 320);
};

const showFirstVisitRules = async () => {
  try {
    if (localStorage.getItem(firstVisitRulesKey) === "1") return;
    localStorage.setItem(firstVisitRulesKey, "1");
  } catch {
    // Keep the in-memory guard when persistent storage is unavailable.
  }
  await Swal.fire({
    title: "规则与工单",
    html: '<p class="first-visit-rules-text">开始对决前，请先阅读使用规则。遇到问题也可以在这里提交工单。</p><a class="first-visit-rules-link" href="https://www.luogu.me/article/fgiidurs" target="_blank" rel="noopener noreferrer">打开规则与工单</a>',
    confirmButtonText: "关闭",
    customClass: { popup: "duel-swal", confirmButton: "duel-swal-confirm" }
  });
};

const judgeCooldownRemaining = (): number => {
  try {
    const until = Number(localStorage.getItem(judgeCooldownKey()) || 0);
    return Math.max(0, Math.ceil((until - Date.now()) / 1000));
  } catch {
    return 0;
  }
};

const startJudgeCooldown = () => {
  try {
    localStorage.setItem(judgeCooldownKey(), String(Date.now() + 60_000));
  } catch {
    // Server-side rate limiting remains authoritative.
  }
};

const vjudgeProblemUrl = (problem: Problem): string => {
  const source = problem.platform === "codeforces" ? "Codeforces" : problem.platform === "atcoder" ? "AtCoder" : "洛谷";
  return `https://vjudge.net/problem/${encodeURIComponent(source)}-${encodeURIComponent(problem.pid)}`;
};

const problemLinks = (problem: Problem): Array<{ label: string; href: string }> => {
  const pid = problem.pid.trim();
  const platform = problem.platform ?? (pid.startsWith("CF") ? "codeforces" : pid.startsWith("AT_") ? "atcoder" : "luogu");
  const links: Array<{ label: string; href: string }> = [{ label: "VJudge", href: vjudgeProblemUrl(problem) }];
  if (platform === "codeforces") {
    const match = pid.match(/^(\d+)([A-Z]\d*)$/i);
    links.push({ label: "洛谷", href: `https://www.luogu.com.cn/problem/CF${encodeURIComponent(pid)}` });
    links.push({ label: "原站", href: match ? `https://codeforces.com/problemset/problem/${match[1]}/${match[2]}` : "https://codeforces.com/problemset" });
  } else if (platform === "atcoder") {
    const task = pid;
    const contest = task.split('_')[0].toLowerCase();
    links.push({ label: "洛谷", href: `https://www.luogu.com.cn/problem/AT_${encodeURIComponent(pid)}` });
    links.push({ label: "原站", href: contest ? `https://atcoder.jp/contests/${contest}/tasks/${task}` : "https://atcoder.jp/" });
  } else {
    links.push({ label: "洛谷", href: `https://www.luogu.com.cn/problem/${encodeURIComponent(pid)}` });
    links.push({ label: "原站", href: `https://www.luogu.com.cn/problem/${encodeURIComponent(pid)}` });
  }
  return links;
};

const displayJudgeStatus = (status: DuelState["feed"][number]["status"]): string => status;

const logout = () => {
  logoutVJudgeSession();
  location.hash = "";
  location.reload();
};

const blockedByBan = (): boolean => temporaryBanUntil > Date.now() || Boolean(bannedRecord());
const bannedRecord = () =>
  moderationRecordForPlayer(state.players[identity?.id]) ||
  moderationRecordForName(identity?.luoguName ?? "");
const moderationRecordForName = (name: string) =>
  state.banned[normalizeName(name)] || globalModeration.banned[normalizeName(name)];
const moderationRecordForPlayer = (player: Player | undefined) => (player ? state.kicked[player.id] || moderationRecordForName(player.luoguName) : undefined);
const isMutedCurrent = (): boolean => temporaryMuteUntil > Date.now() || isMutedByIdentity(identity?.id ?? "", identity?.luoguName ?? "");
const isMutedPlayer = (player: Player): boolean => isMutedByIdentity(player.id, player.luoguName);
const isMutedByIdentity = (id: string, name: string): boolean => {
  const nameKey = `name:${normalizeName(name)}`;
  return Boolean(state.muted[id] || state.muted[nameKey] || globalModeration.muted[id] || globalModeration.muted[nameKey]);
};
const isOwnName = (name: string): boolean => normalizeName(name) === normalizeName(identity?.luoguName ?? "");
const avatarUrlFor = (name: string): string => {
  const key = normalizeName(name);
  if (!key) return "";
  return avatarCache[key] || userRecordFor(name)?.avatar || "";
};
function readAvatarCache(): Record<string, string> {
  try {
    const raw = localStorage.getItem(avatarCacheKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, string | { url?: string }>;
    return Object.fromEntries(Object.entries(parsed).flatMap(([key, value]) => {
      if (typeof value === "string" && value) return [[key, value]];
      if (typeof value === "object" && typeof value?.url === "string" && value.url) return [[key, value.url]];
      return [];
    }));
  } catch {
    return {};
  }
}
const writeAvatarCache = () => {
  try {
    const entries = Object.entries(avatarCache)
      .filter(([, url]) => Boolean(url))
      .slice(-1000);
    localStorage.setItem(avatarCacheKey, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Avatar search is cosmetic; ignore quota/private-mode failures.
  }
};
function readUserCache(): Record<string, { user: UserRecord; cachedAt: number }> {
  try {
    const raw = localStorage.getItem(userCacheKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, { user?: UserRecord; cachedAt?: number }>;
    return Object.fromEntries(Object.entries(parsed).flatMap(([key, value]) =>
      value.user && typeof value.cachedAt === "number"
        ? [[key, value as { user: UserRecord; cachedAt: number }]]
        : []
    ));
  } catch {
    return {};
  }
}
const writeUserCache = () => {
  try {
    localStorage.setItem(userCacheKey, JSON.stringify(userCache));
  } catch {
    // User cache is an optimization only.
  }
};
const writeCachedUser = (user: UserRecord) => {
  userCache[normalizeName(user.name)] = { user, cachedAt: Date.now() };
  writeUserCache();
};
const registrationFresh = (nameKey: string): boolean => {
  try {
    const raw = localStorage.getItem(registrationCacheKey);
    const entries = raw ? JSON.parse(raw) as Record<string, number> : {};
    return Date.now() - (entries[nameKey] ?? 0) < userCacheTtl;
  } catch {
    return false;
  }
};
const rememberRegistered = (nameKey: string) => {
  try {
    const raw = localStorage.getItem(registrationCacheKey);
    const entries = raw ? JSON.parse(raw) as Record<string, number> : {};
    entries[nameKey] = Date.now();
    localStorage.setItem(registrationCacheKey, JSON.stringify(entries));
  } catch {
    // Registration cache only reduces duplicate writes.
  }
};
const userRecordFor = (name: string): UserRecord | null => {
  const key = normalizeName(name);
  const cached = userCache[key];
  return users.find((user) => normalizeName(user.name) === key) ?? (cached && Date.now() - cached.cachedAt < userCacheTtl ? cached.user : null);
};
const ensureUserLoaded = async (name: string): Promise<UserRecord | null> => {
  const key = normalizeName(name);
  const cached = userCache[key];
  if (cached && Date.now() - cached.cachedAt < userCacheTtl) return cached.user;
  try {
    const user = await fetchUserRecord(name);
    if (user) {
      updateLocalUser(user.name, user, false);
      writeCachedUser(user);
    }
    return user;
  } catch {
    return cached?.user ?? null;
  }
};
const updateLocalUser = (name: string, patch: Partial<UserRecord>, renderNow = true) => {
  const key = normalizeName(name);
  const existing = userRecordFor(name);
  const next: UserRecord = {
    name: existing?.name ?? name,
    rating: existing?.rating ?? 1300,
    wins: existing?.wins ?? 0,
    losses: existing?.losses ?? 0,
    games: existing?.games ?? 0,
    ratingHistory: existing?.ratingHistory,
    updatedAt: Date.now(),
    ...patch
  };
  users = users.filter((user) => normalizeName(user.name) !== key).concat(next);
  writeCachedUser(next);
  if (renderNow) notify();
};
const registerCurrentUser = async () => {
  if (!identity?.luoguName) return;
  const key = normalizeName(identity.luoguName);
  const cached = userCache[key];
  if (cached && Date.now() - cached.cachedAt < userCacheTtl && registrationFresh(key)) {
    updateLocalUser(cached.user.name, cached.user, false);
    return;
  }
  try {
    const user = await saveUserRecord({ name: identity.luoguName });
    updateLocalUser(user.name, user, false);
    rememberRegistered(key);
  } catch {
    updateLocalUser(identity.luoguName, {}, false);
  }
};
const persistUserProfile = async (name: string, profileHtml: string) => {
  updateLocalUser(name, { profileHtml });
  try {
    const user = await saveUserRecord({ name, profileHtml });
    destroyProfileVditor();
    draft.profileEditing = false;
    draft.profileDraft = "";
    updateLocalUser(user.name, user);
  } catch (error) {
    setStatus(friendlyError(error, "主页保存失败"), "error");
  }
};
const openProfile = (name: string) => {
  if (!name.trim()) return;
  window.open(`/user/${encodeURIComponent(name.trim())}`, "_blank", "noopener,noreferrer");
};
const ratingRowFor = (name: string): RatingRow => {
  const key = normalizeName(name);
  const user = userRecordFor(name);
  return ratingRows().find((item) => normalizeName(item.name) === key) ?? {
    name: user?.name ?? name,
    rating: user?.rating ?? 1300,
    wins: user?.wins ?? 0,
    losses: user?.losses ?? 0,
    games: user?.games ?? 0
  };
};
const nameColor = (name: string, rating = ratingRowFor(name).rating): string => {
  if (isAdminName(name)) return "rgb(157, 61, 207)";
  if (rating == 0) return "rgb(173,139,0)";
  if(rating < 1270) return "rgb(191,191,191)"
  if (rating < 1350) return "rgb(52, 152, 219)";
  if (rating < 1550) return "rgb(82, 196, 26)";
  if (rating < 1650) return "rgb(243, 156, 17)";
  return "rgb(254, 76, 97)";
};
const playerRooms = (name: string): RoomListing[] =>
  sortedRooms().filter((room) => [...(room.redPlayers ?? []), ...(room.bluePlayers ?? [])].some((player) => normalizeName(player) === normalizeName(name)));
const completedPlayerRooms = (name: string): RoomListing[] =>
  playerRooms(name).filter((room) => room.status === "finished" && Boolean(room.winner) && !room.closedReason);
const achievementsFor = (name: string, row: RatingRow) => {
  const rows = ratingRows();
  const rank = rows.findIndex((item) => normalizeName(item.name) === normalizeName(name)) + 1;
  const roomsForPlayer = playerRooms(name);
  const firstDone = row.games > 0;
  const fastWin = roomsForPlayer.some((room) => room.startedAt && room.endedAt && room.endedAt - room.startedAt <= 180000);
  const championDone = usersLoaded && row.games > 0 && rank === 1;
  return [
    { Icon: Star, title: "一等星", text: "进入排行榜前 20。", progress: rank > 0 && rank <= 20 ? 100 : 0 },
    { Icon: Swords, title: "决斗家", text: "获得 10 场胜利。", progress: Math.min(100, row.wins * 10) },
    { Icon: Sprout, title: "初出茅庐", text: "完成第一场决斗。", progress: firstDone ? 100 : 0 },
    { Icon: Zap, title: "闪电战", text: "在 3 分钟内结束一场对局。", progress: fastWin ? 100 : 0 },
    { Icon: Trophy, title: "冠军", text: "登上排行榜第一名。", progress: championDone ? 100 : 0 },
    { Icon: Medal, title: "常胜", text: "胜率达到 70%，且至少完成 5 场。", progress: row.games >= 5 ? Math.min(100, Math.round((row.wins / row.games / 0.7) * 100)) : Math.min(80, row.games * 16) }
  ];
};
const scrollChatsToBottom = () => {
  document.querySelectorAll<HTMLElement>(".chat-log").forEach((element) => {
    element.scrollTop = element.scrollHeight;
  });
};
const shouldStickChats = (): boolean =>
  [...document.querySelectorAll<HTMLElement>(".chat-log")].some((element) => element.scrollHeight - element.scrollTop - element.clientHeight < 80);
const currentSeat = (): Seat => state.players[identity.id]?.team ?? preferredSeat();
const preferredSeat = (): Seat => {
  if (state.phase !== "lobby") return "spectator";
  const remembered = localStorage.getItem(roomSeatKey()) as Seat | null;
  if (remembered === "red" || remembered === "blue" || remembered === "spectator") return remembered;
  const red = Object.values(state.players).filter((p) => p.team === "red").length;
  const blue = Object.values(state.players).filter((p) => p.team === "blue").length;
  return red <= blue ? "red" : "blue";
};
const rememberSeat = (seat: Seat) => localStorage.setItem(roomSeatKey(), seat);
const isAdmin = () => isAdminName(identity?.luoguName ?? "");
const participantCount = (): number => Object.values(state.players).filter((player) => isTeam(player.team) && !moderationRecordForPlayer(player)).length;
const matchTitle = (): string => {
  const red = Object.values(state.players).filter((p) => p.team === "red").map((p) => p.luoguName).join(" / ");
  const blue = Object.values(state.players).filter((p) => p.team === "blue").map((p) => p.luoguName).join(" / ");
  return `${red || "红方"} vs ${blue || "蓝方"}`;
};
const rememberActiveRoomIfNeeded = () => {
  const seat = state.players[identity.id]?.team;
  if (mode === "room" && isTeam(seat) && !blockedByBan() && state.phase !== "finished") {
    localStorage.setItem(activeRoomKey, JSON.stringify({ roomId, secret: roomSecret }));
    return;
  }
  if (mode === "room" || state.phase === "finished" || blockedByBan()) localStorage.removeItem(activeRoomKey);
};

const readActiveRoom = (): { roomId: string; secret?: string } | null => {
  const raw = localStorage.getItem(activeRoomKey);
  if (!raw) return null;
  try {
    const active = JSON.parse(raw) as { roomId?: string; secret?: string };
    const listed = rooms.find((room) => room.roomId === active.roomId);
    if (listed?.status === "finished") {
      localStorage.removeItem(activeRoomKey);
      return null;
    }
    return active.roomId ? { roomId: active.roomId, secret: active.secret } : null;
  } catch {
    localStorage.removeItem(activeRoomKey);
    return null;
  }
};

const scheduleFinishReturn = () => {
  if (state.phase !== "finished") return;
  clearFinishTimer();
  localStorage.removeItem(activeRoomKey);
};

const clearFinishTimer = () => {
  if (finishReturnTimer) window.clearTimeout(finishReturnTimer);
  finishReturnTimer = undefined;
};

const readHistory = (): Array<{ roomId: string; result: string; at: number }> => {
  try {
    return JSON.parse(localStorage.getItem(historyKey) || "[]") as Array<{ roomId: string; result: string; at: number }>;
  } catch {
    return [];
  }
};

const readDirectoryCache = (): RoomListing[] => {
  try {
    const cached = JSON.parse(localStorage.getItem(directoryCacheKey) || "[]") as RoomListing[];
    return Array.isArray(cached) ? cached : [];
  } catch {
    return [];
  }
};

const writeDirectoryCache = (snapshot: RoomListing[]) => {
  try {
    localStorage.setItem(directoryCacheKey, JSON.stringify(snapshot.slice(0, 500)));
  } catch {
    // Directory broadcasts remain authoritative when storage is unavailable.
  }
};

const readEventCache = (id: string): SignedEnvelope[] => {
  try {
    const cached = JSON.parse(localStorage.getItem(eventCacheKey(id)) || "[]") as SignedEnvelope[];
    return Array.isArray(cached) ? cached.filter((item) => item?.event?.roomId === id).slice(-1000) : [];
  } catch {
    return [];
  }
};

const writeEventCache = (id: string, snapshot: SignedEnvelope[]) => {
  try {
    localStorage.setItem(eventCacheKey(id), JSON.stringify(snapshot.slice(-1000)));
  } catch {
    // HTTP/WebSocket state still works if the browser quota is full.
  }
};

const saveHistory = () => {
  if (mode !== "room" || state.phase !== "finished" || (!state.winner && !state.closed)) return;
  const result = state.closed ? "关闭" : state.winner === "draw" ? "平局" : `${teamName(state.winner)}胜`;
  const next = readHistory().filter((item) => item.roomId !== roomId).concat({ roomId, result, at: Date.now() });
  localStorage.setItem(historyKey, JSON.stringify(next.slice(-30)));
};

const compareEnvelopes = (a: SignedEnvelope, b: SignedEnvelope): number =>
  a.event.lamport - b.event.lamport || a.event.issuedAt - b.event.issuedAt || a.event.id.localeCompare(b.event.id);

const voteLabel = (kind: VoteKind): string => {
  if (kind === "replace-problem") return "换题";
  if (kind === "delete-problem") return "删题";
  if (kind === "draw") return "平局";
  return "投降";
};

const formatMatchClock = (): string => {
  const base = state.startedAt ?? Date.now();
  const end = state.phase === "finished" ? state.endedAt ?? state.closed?.at ?? base : Date.now();
  const seconds = (state.phase === "arena" || state.phase === "finished") && state.startedAt ? Math.max(0, Math.floor((end - base) / 1000)) : 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
};

const formatClock = (time: number): string =>
  new Date(time).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });

const avatarText = (name: string): string => (name.trim()[0] || "?").toUpperCase();
const ratingFor = (name: string): number => 1200 + [...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 1900;
const problemCode = (pid: string): string => pid.replace(/^P/i, "") || pid;

const friendlyError = (error: unknown, prefix: string): string => `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
const compactId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 10);
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, Number.isFinite(n) ? n : min));
const timeAgo = (time: number): string => {
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  return `${Math.floor(minutes / 60)} 小时前`;
};

function readStoredNumber(key: string, fallback = 0): number {
  try {
    const value = Number(localStorage.getItem(key) || fallback);
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function readStoredText(key: string): string {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function recordBurst(kind: string, windowMs: number, threshold: number, punish: () => void): boolean {
  const key = `vjudge-duel.security.actions.${kind}`;
  const now = Date.now();
  try {
    const stored = JSON.parse(localStorage.getItem(key) || "[]") as number[];
    const recent = stored.filter((time) => Number.isFinite(time) && now - time < windowMs).concat(now);
    if (recent.length >= threshold) {
      localStorage.removeItem(key);
      punish();
      return true;
    }
    localStorage.setItem(key, JSON.stringify(recent));
  } catch {
    // The in-memory operation is still allowed when browser storage is unavailable.
  }
  return false;
}

function applyTemporaryBan(durationMs: number, reason: string): void {
  temporaryBanUntil = Date.now() + durationMs;
  temporaryBanReason = reason;
  try {
    localStorage.setItem(temporaryBanKey, String(temporaryBanUntil));
    localStorage.setItem(temporaryBanReasonKey, reason);
  } catch {
    // In-memory enforcement remains active.
  }
}

function applyTemporaryMute(durationMs: number): void {
  temporaryMuteUntil = Date.now() + durationMs;
  try {
    localStorage.setItem(temporaryMuteKey, String(temporaryMuteUntil));
  } catch {
    // In-memory enforcement remains active.
  }
}

notify();
void boot();
