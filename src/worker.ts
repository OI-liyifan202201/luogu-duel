/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";
import { applyEvent, applyEvents, canStart, createInitialState, isAdminName, isTeam, privateChatViolation } from "./domain";
import type { DuelEvent, FeedRecord, Problem, SignedEnvelope } from "./types";

type Env = {
  DUEL_ROOM: DurableObjectNamespace<DuelRoom>;
  TICKET_STORE: DurableObjectNamespace<TicketStore>;
  ASSETS: Fetcher;
  API_RATE_LIMITER: RateLimit;
  JUDGE_RATE_LIMITER: RateLimit;
  MAINTENANCE?: string;
};

type RoomListing = {
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
  // 作弊封禁标记：比赛因检测到作弊而取消时，directory 据此执行 Rating 惩罚，
  // 客户端据此在房间列表保留证据并标记为"已封禁"。
  cheatBanned?: boolean;
  cheaterName?: string;
};

type UserRecord = {
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

type ClientMessage = { type: "event"; envelope: SignedEnvelope } | { type: "ping"; at?: number };
type SocketKind = "room" | "directory";

const adminNames = new Set(["general0826", "slmxf", "liyifan202201", "gcend", "gcsg01","imzfx_square"]);
const DATA_RETENTION_MS = 3 * 24 * 60 * 60_000;
const DIRECTORY_PRUNE_INTERVAL_MS = 24 * 60 * 60_000;
// 内部系统调用（房间 DO 调用工单 DO 自动建单）的鉴权头，避免外部伪造自动举报工单。
const INTERNAL_CLAIM = "vdsystem-internal-claim-7c2e9a";
// 作弊终止时写入 close reason 的分隔符，用于从事件流解析作弊者姓名。
const CHEAT_CLOSE_SEPARATOR = "｜";
// 自动举报工单的固定作者 / 责任人 / 状态。
const CHEAT_TICKET_AUTHOR = "VDsystem";
const CHEAT_TICKET_ASSIGNEE = "Gcend";
// 作弊场作废后，给非作弊参赛者的 Rating 补偿。
const CHEAT_COMPENSATION_RATING = 10;

export class DuelRoom extends DurableObject<Env> {
  private eventsCache: SignedEnvelope[] | null = null;
  private eventIds = new Set<string>();
  private cachedState = createInitialState("");
  private firstEvent: DuelEvent | null = null;
  private roomSecret: string | null = null;
  // 比赛开始的服务器时间戳。detectCheatAndReport 用它而非客户端 startedAt 计算 elapsed，
  // 避免"VJudge 提交时间(record.at) vs 客户端比赛开始时间"跨时钟比较在客户端时钟偏慢时
  // 把 30s AC 算成 >=180s 从而漏判。服务端(Cloudflare)与 VJudge 均为 NTP 同步，偏差很小。
  private matchStartServerMs: number | null = null;
  private listingsCache: Map<string, RoomListing> | null = null;
  private usersCache: Map<string, UserRecord> | null = null;
  private bannedUsersCache: Set<string> | null = null;
  private examPassedCache: Set<string> | null = null;
  private processedResultsCache: Set<string> | null = null;
  private actorWriteWindow = new Map<string, number[]>();
  private directoryObject: boolean | null = null;
  private wsActors = new Map<WebSocket, string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id TEXT PRIMARY KEY,
          room_id TEXT NOT NULL,
          issued_at INTEGER NOT NULL,
          lamport INTEGER NOT NULL,
          envelope TEXT NOT NULL
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS listings (
          room_id TEXT PRIMARY KEY,
          listing TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS users (
          name_key TEXT PRIMARY KEY,
          user_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS processed_results (
          room_id TEXT PRIMARY KEY,
          processed_at INTEGER NOT NULL
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS banned_users (
          name_key TEXT PRIMARY KEY,
          detected_at INTEGER NOT NULL
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS exam_passed (
          name_key TEXT PRIMARY KEY,
          passed_at INTEGER NOT NULL
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS active_players (
          name_key TEXT PRIMARY KEY,
          room_id TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS low_room_days (
          day_key TEXT PRIMARY KEY,
          room_id TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS snapshots (
          snapshot_key TEXT PRIMARY KEY,
          snapshot_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const secret = url.searchParams.get("secret");
    if (secret) await this.rememberSecret(secret);
    if (url.pathname.endsWith("/directory/ws")) return this.handleDirectoryWebSocket(request);
    if (url.pathname.endsWith("/directory")) return this.handleDirectory(request);
    if (url.pathname.endsWith("/active-player")) return this.handleActivePlayer(request);
    if (url.pathname.endsWith("/low-room-limit")) return this.handleLowRoomLimit(request);
    if (url.pathname.endsWith("/users")) return this.handleUsers(request);
    if (url.pathname.endsWith("/exam/status")) return this.handleExamStatus(request);
    if (url.pathname.endsWith("/exam/pass") && request.method === "POST") return this.handleExamPass(request);
    if (url.pathname.endsWith("/clear-all")) return this.handleClearAll(request);
    if (url.pathname.endsWith("/clear-runtime-data")) return this.handleClearRuntimeData(request);
    if (url.pathname.endsWith("/clear-global-chat")) return this.handleClearGlobalChat(request);
    if (url.pathname.endsWith("/compact")) return this.handleCompact(request);
    if (url.pathname.endsWith("/clear-room")) return this.handleClearRoom(request);
    const userMatch = url.pathname.match(/\/users\/([^/]+)$/);
    if (userMatch) return this.handleUser(request, decodeURIComponent(userMatch[1]));
    if (url.pathname.endsWith("/ws")) return this.handleWebSocket(request);
    if (url.pathname.endsWith("/snapshot")) {
      await this.expireStaleLobby();
      return Response.json({ envelopes: this.listEvents() });
    }
    // 内部使用：返回该房间的当前 lamport，供其他 DO 生成系统信封时取 lamport+1。
    if (url.pathname.endsWith("/lamport")) {
      this.hydrateEvents();
      return Response.json({ lamport: this.cachedState.lamport }, { headers: noStoreHeaders() });
    }
    if (url.pathname.endsWith("/manual-claim") && request.method === "POST") {
      return this.handleManualClaim(request);
    }
    if (url.pathname.endsWith("/event") && request.method === "POST") {
      const body = (await request.json()) as { envelope?: SignedEnvelope };
      if (!body.envelope) return jsonError("missing envelope", 400);
      try {
        const saved = await this.acceptEnvelope(body.envelope);
        if (saved) this.broadcast({ type: "event", envelope: body.envelope });
        return Response.json({ ok: true });
      } catch (error) {
        return jsonError(error instanceof Error ? error.message : "event rejected", 409);
      }
    }
    return jsonError("not found", 404);
  }

  private async handleManualClaim(request: Request): Promise<Response> {
    this.hydrateEvents();
    if (this.cachedState.phase !== "arena" || !this.cachedState.startedAt) return jsonError("房间不在比赛中", 409);
    const body = await request.json().catch(() => null) as { userName?: string; pid?: string } | null;
    const userName = body?.userName?.trim() ?? "";
    const pid = body?.pid?.trim() ?? "";
    if (!userName || !pid) return jsonError("missing userName or pid", 400);
    const player = Object.values(this.cachedState.players).find((item) => normalizeName(item.luoguName) === normalizeName(userName) && isPlayingSeat(item.team));
    if (!player) return jsonError("指定用户不是本场参赛者", 404);
    const problem = this.cachedState.problems.find((item) => item.pid.toLowerCase() === pid.toLowerCase());
    if (!problem) return jsonError("题目不在本场比赛中", 404);
    if (problem.solvedBy) {
      if (normalizeName(problem.solvedBy.luoguName) === normalizeName(player.luoguName)) {
        return Response.json({ ok: true, alreadyClaimed: true, roomId: this.cachedState.roomId, pid: problem.pid, userName: player.luoguName, recordId: problem.solvedBy.recordId });
      }
      return jsonError("题目已被其他人抢占", 409);
    }
    const now = Date.now();
    const recordId = `manual:${crypto.randomUUID()}`;
    const envelope = await systemJudgeEnvelope(this.cachedState.roomId, this.cachedState.lamport + 1, now, {
      id: recordId,
      recordId,
      luoguName: player.luoguName,
      pid: problem.pid,
      at: now,
      status: "OK"
    });
    const latestProblem = this.cachedState.problems.find((item) => item.pid.toLowerCase() === problem.pid.toLowerCase());
    if (!latestProblem || this.cachedState.phase !== "arena") return jsonError("比赛已经结束", 409);
    if (latestProblem.solvedBy) {
      if (normalizeName(latestProblem.solvedBy.luoguName) === normalizeName(player.luoguName)) {
        return Response.json({ ok: true, alreadyClaimed: true, roomId: this.cachedState.roomId, pid: latestProblem.pid, userName: player.luoguName, recordId: latestProblem.solvedBy.recordId });
      }
      return jsonError("题目已被其他人抢占", 409);
    }
    const saved = await this.acceptEnvelope(envelope);
    if (!saved) return jsonError("manual claim rejected", 409);
    this.broadcast({ type: "event", envelope });
    return Response.json({ ok: true, roomId: this.cachedState.roomId, pid: problem.pid, userName: player.luoguName, recordId });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    try {
      if (message === "ping") {
        ws.send("pong");
        return;
      }
      const data = JSON.parse(message) as { type?: ClientMessage["type"]; at?: number; envelope?: SignedEnvelope };
      const attachment = ws.deserializeAttachment() as { kind?: SocketKind } | undefined;
      if (data.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", at: Date.now() }));
        return;
      }
      if (attachment?.kind === "directory") return;
      if (data.type !== "event" || !data.envelope) return;
      const saved = await this.acceptEnvelope(data.envelope);
      if (saved) {
        // Track WebSocket → actor mapping for auto-leave on disconnect
        if (data.envelope.event.type === "player.joined") {
          this.wsActors.set(ws, data.envelope.event.actorId);
        }
        this.broadcast({ type: "event", envelope: data.envelope });
      }
    } catch (error) {
      ws.send(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : "bad message" }));
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    if (!this.wsActors.has(ws)) return;
    this.wsActors.delete(ws);
    // Refreshes and transient network changes close sockets too. Preserve the seat;
    // only an explicit player.left event is allowed to remove a room member.
  }

  private async handleWebSocket(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return jsonError("expected websocket", 426);
    await this.expireStaleLobby();
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ kind: "room" satisfies SocketKind, connectedAt: Date.now() });
    server.send(JSON.stringify({ type: "hello", envelopes: this.listEvents() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  private handleDirectoryWebSocket(request: Request): Response {
    if (request.headers.get("Upgrade") !== "websocket") return jsonError("expected websocket", 426);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ kind: "directory" satisfies SocketKind, connectedAt: Date.now() });
    server.send(JSON.stringify({ type: "directory", rooms: this.listRooms() }));
    server.send(JSON.stringify({ type: "users", users: this.listUsers() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  private async acceptEnvelope(envelope: SignedEnvelope): Promise<boolean> {
    const event = envelope.event;
    this.hydrateEvents();
    if (this.eventIds.has(event.id)) return false;
    if (!this.allowActorWrite(event.actorId)) throw new Error("操作过于频繁，已阻止本次服务器写入");
    const currentRoomId = this.cachedState.roomId || this.firstEvent?.roomId;
    if (currentRoomId && currentRoomId !== event.roomId) return false;
    // Finished matches are immutable archives. Reject before SQLite persistence
    // so delayed retries cannot produce writes or directory broadcasts.
    // 例外：system 作弊封禁的 player.kicked / room.closed 允许穿透——
    // 作弊 AC 同时是制胜 AC 时，updateWinner 已将 phase 翻为 finished，但封禁事件仍需执行。
    if (event.roomId !== "global" && this.cachedState.phase === "finished"
      && !(event.type === "player.kicked" && event.system)
      && !(event.type === "room.closed" && event.system)) return false;
    if (event.type === "room.configured" && this.cachedState.problems.length > 0) {
      throw new Error("房间已经完成题目配置");
    }
    if (event.roomId !== "global" && this.cachedState.problems.length === 0 && event.type !== "room.configured") {
      throw new Error("房间尚未完成题目配置");
    }
    if (event.type === "chat.sent" && event.visibility === "team") {
      const violation = privateChatViolation(event.text);
      if (violation) throw new Error(violation);
    }

    const currentPlayer = this.cachedState.players[event.actorId];
    const sameNamePlayer = event.type === "player.joined"
      ? Object.values(this.cachedState.players).find((player) => normalizeName(player.luoguName) === normalizeName(event.luoguName))
      : undefined;
    if (event.type === "player.joined" && this.cachedState.phase !== "lobby" && isPlayingSeat(event.team) && !isPlayingSeat(sameNamePlayer?.team)) {
      throw new Error("比赛已经开始，新加入的用户只能观赛");
    }
    if (event.type === "player.teamChanged" && this.cachedState.phase !== "lobby") {
      throw new Error("比赛开始后不能切换队伍");
    }
    if (event.type === "room.closed" && this.cachedState.phase === "arena" && !adminNames.has(normalizeName(event.actorName))) {
      throw new Error("比赛开始后只有管理员可以关闭房间");
    }
    if ((event.type === "room.muted" || event.type === "room.unmuted") && event.roomId !== "global") {
      const actor = this.cachedState.players[event.actorId];
      if (!actor || (this.cachedState.hostId !== event.actorId && !adminNames.has(normalizeName(actor.luoguName)))) throw new Error("只有房主或管理员可以全员禁言");
    }
    if (event.type === "player.joined" && event.team === "spectator" && !this.cachedState.hostId && event.roomId !== "global") {
      throw new Error("房主不能进入观战席");
    }
    if (event.type === "player.teamChanged" && event.team === "spectator" && this.cachedState.hostId === event.actorId && event.roomId !== "global") {
      throw new Error("房主不能进入观战席");
    }
    const kickedPlayer = event.type === "player.kicked"
      ? this.cachedState.players[event.targetId] ?? Object.values(this.cachedState.players).find((player) => normalizeName(player.luoguName) === normalizeName(event.targetName || ""))
      : undefined;
    const claimName =
      event.type === "player.joined" && isPlayingSeat(event.team)
        ? event.luoguName
        : event.type === "player.teamChanged" && isPlayingSeat(event.team) && currentPlayer
          ? currentPlayer.luoguName
          : "";
    if (claimName && !(await this.claimActivePlayer(claimName, event.roomId))) {
      throw new Error("你已在另一场未结束比赛中，本房只能观赛");
    }

    const releaseName =
      event.type === "player.left" && currentPlayer
        ? currentPlayer.luoguName
        : event.type === "player.teamChanged" && event.team === "spectator" && currentPlayer
          ? currentPlayer.luoguName
          : kickedPlayer
            ? kickedPlayer.luoguName
          : "";
    const previousPhase = this.cachedState.phase;
    const previousDirectoryFingerprint = directoryFingerprint(this.cachedState);
    const previousLastEnvelope = this.eventsCache![this.eventsCache!.length - 1];

    if (event.type === "room.configured" && (isLowDifficultyRoom(event.problems) || Number(event.minimumDifficulty) <= 2)) {
      const hostName = event.hostName?.trim() || "";
      if (!hostName) throw new Error("无法确认房主身份");
      const limiter = this.env.DUEL_ROOM.getByName(`__low-room-limit:${normalizeName(hostName)}`);
      const response = await limiter.fetch("https://duel.internal/low-room-limit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId: event.roomId })
      });
      if (!response.ok) throw new Error("每天最多创建 1 场包含橙色或更低难度题目的房间");
      if (this.eventIds.has(event.id)) return false;
    }

    this.ctx.storage.sql.exec(
      "INSERT INTO events (id, room_id, issued_at, lamport, envelope) VALUES (?, ?, ?, ?, ?)",
      event.id,
      event.roomId,
      event.issuedAt,
      event.lamport,
      JSON.stringify(envelope)
    );
    this.eventsCache!.push(envelope);
    this.eventsCache!.sort(compareEnvelopes);
    this.eventIds.add(event.id);
    this.firstEvent ??= event;
    this.cachedState = !previousLastEnvelope || compareEnvelopes(previousLastEnvelope, envelope) <= 0
      ? applyEvent(this.cachedState.roomId === event.roomId ? this.cachedState : createInitialState(event.roomId), event)
      : applyEvents(event.roomId, this.eventsCache!.map((item) => item.event));
    this.writeSnapshot("events", this.eventsCache!);
    // 通知中心：聊天 @ 提及、封禁/禁言/解除等系统事件异步写入全局通知（失败静默，不阻塞主流程）。
    void this.pushEventNotifications(event);
    // 作弊检测：比赛进行中，过快 AC（按题目难度）或同一人两次 AC 间隔过短，
    // 由 System 终止比赛并自动提交举报工单（不再自动封禁）。
    // 用 previousPhase 而非当前 phase：若作弊 AC 同时是制胜 AC，applyEvent 内的 updateWinner
    // 会先把 phase 翻成 finished，此时仍需检测并在下方 detectCheatAndReport 里覆盖胜利。
    if (event.type === "judge.recordSeen") {
      console.log(`[acceptEnvelope] judge.recordSeen: previousPhase=${previousPhase}, currentPhase=${this.cachedState.phase}, ` +
        `recordStatus=${event.record.status}, recordAt=${event.record.at}, ` +
        `stateStartedAt=${this.cachedState.startedAt}, willCallDetect=${event.roomId !== "global" && previousPhase === "arena"}`);
    }
    if (event.roomId !== "global" && event.type === "judge.recordSeen" && previousPhase === "arena") {
      await this.detectCheatAndReport(event);
    }
    // 记录比赛开始的服务器时间，供 detectCheatAndReport 跨时钟稳健地计算 elapsed。
    if (event.roomId !== "global" && event.type === "game.started" && this.cachedState.phase === "arena") {
      this.matchStartServerMs = Date.now();
    }
    // 比赛进行中（arena）管理员手动封禁 => 直接取消对决（close reason 附带被封禁者姓名，
    // 客户端与 directory 据此按"作弊取消"处理）。
    if (event.roomId !== "global" && event.type === "player.kicked" && this.cachedState.phase === "arena") {
      const kickedName = kickedPlayer?.luoguName || event.targetName || "";
      const closeEnvelope = await systemCloseEnvelope(
        this.cachedState.roomId,
        this.cachedState.lamport + 1,
        Date.now(),
        `检测到作弊，对决取消${CHEAT_CLOSE_SEPARATOR}${kickedName}`
      );
      const savedClose = await this.acceptEnvelope(closeEnvelope);
      if (savedClose) this.broadcast({ type: "event", envelope: closeEnvelope });
    }
    // 全局封禁/禁言同步：房间内管理员/房主的封禁与禁言，跨房间转发到 global 房间，
    // 使"封禁和禁言都是全局的"在实时状态上真正生效（仅转发实际封禁与管理员禁言）。
    if (event.roomId !== "global" && (event.type === "player.kicked" || event.type === "player.muted" || event.type === "player.unmuted" || event.type === "player.unkicked")) {
      await this.propagateGlobalModeration(event);
    }
    // 全局解封需回灌各进行中房间：房间级封禁（state.banned / kicked）与全局相互独立，
    // 仅解除全局封禁不会清除比赛房间内残留的封禁，该房间重放记录时仍会再次自动封禁。
    if (event.roomId === "global" && event.type === "player.unkicked") {
      await this.propagateGlobalUnban(event);
    }
    if (claimName && !isPlayingSeat(this.cachedState.players[event.actorId]?.team)) {
      await this.releaseActivePlayer(claimName, event.roomId);
    }
    if (releaseName) await this.releaseActivePlayer(releaseName, event.roomId);
    if (previousPhase !== "finished" && this.cachedState.phase === "finished") await this.releaseActiveRoom(event.roomId);
    if (previousDirectoryFingerprint !== directoryFingerprint(this.cachedState)) {
      await this.updateDirectory(event.roomId, event);
    }
    if (event.roomId !== "global") {
      if (this.cachedState.phase === "lobby" && event.type === "room.configured") {
        await this.ctx.storage.setAlarm((this.firstEvent?.issuedAt ?? event.issuedAt) + 10 * 60_000);
      } else if (this.cachedState.phase !== "lobby") {
        await this.ctx.storage.deleteAlarm();
      }
    } else {
      // 全局房间此前没有定时清理闹钟（expireStaleLobby 对 global 直接 return），导致事件无限累积。
      // 这里为全局房间引导一个每日压缩闹钟；若已存在（含历史遗留的过期闹钟）则交给 alarm() 自愈续期。
      const existingAlarm = await this.ctx.storage.getAlarm();
      if (existingAlarm === null) {
        await this.ctx.storage.setAlarm(Date.now() + DIRECTORY_PRUNE_INTERVAL_MS);
      }
    }
    if (event.roomId !== "global" && event.type === "player.readyChanged" && canStart(this.cachedState)) {
      // The last ready event must reach clients before the generated start event.
      // The outer request path may broadcast it again; clients deduplicate by event ID.
      this.broadcast({ type: "event", envelope });
      const startEnvelope = await systemStartEnvelope(event.roomId, this.cachedState.lamport + 1, Date.now());
      const started = await this.acceptEnvelope(startEnvelope);
      if (started) this.broadcast({ type: "event", envelope: startEnvelope });
    }
    return true;
  }

  private async detectCheatAndReport(event: Extract<DuelEvent, { type: "judge.recordSeen" }>): Promise<void> {
    const record = event.record;
    if (record.status !== "OK" || event.cheatExempt) {
      if (record.status !== "OK") console.log(`[detectCheatAndReport] skip: status=${record.status}, cheater=${record.luoguName}, pid=${record.pid}`);
      return;
    }
    const state = this.cachedState;
    // 优先用服务器端记录的开赛时间，规避客户端时钟与 VJudge 时钟偏移导致的 elapsed 误算。
    const startedAt = this.matchStartServerMs ?? state.startedAt ?? 0;
    const player = Object.values(state.players).find((item) => normalizeName(item.luoguName) === normalizeName(record.luoguName));
    if (!player || !isTeam(player.team)) {
      console.log(`[detectCheatAndReport] skip: player=${!!player}, team=${player?.team}, cheater=${record.luoguName}`);
      return;
    }
    // 已封禁者不再重复检测：手动解封后，若该玩家的 judge.recordSeen 被重放（重连 / 快照重建 /
    // judgeProblem 重发），此处若继续检测会再次触发自动封禁，造成"解封后马上又被自动封禁"的死循环。
    // 真正的新作弊（解封后另起一场并再次过快 AC）仍会被正常检测，因为那是一场全新的房间状态。
    if (state.banned[normalizeName(record.luoguName)]) {
      console.log(`[detectCheatAndReport] skip: already banned, cheater=${record.luoguName}`);
      return;
    }
    // 同一道题已记录过 OK（重复提交 / 双路径重复 claim），跳过重复检测，避免误封。
    if (state.feed.some((feed) => feed.pid === record.pid && normalizeName(feed.luoguName) === normalizeName(record.luoguName) && feed.status === "OK" && feed.at !== record.at)) {
      console.log(`[detectCheatAndReport] skip duplicate claim: pid=${record.pid}, cheater=${record.luoguName}`);
      return;
    }
    const problem = state.problems.find((item) => item.pid.toLowerCase() === record.pid.toLowerCase());
    const minMs = minSolveMsForDifficulty(problem?.difficulty);
    const elapsed = record.at - startedAt;
    const tooFastFromStart = minMs > 0 && elapsed >= 0 && elapsed < minMs;
    console.log(`[detectCheatAndReport] cheater=${record.luoguName}, pid=${record.pid}, difficulty=${problem?.difficulty}, ` +
      `recordAt=${record.at}, startedAt=${startedAt}, matchStartServerMs=${this.matchStartServerMs}, ` +
      `elapsed=${elapsed}ms, minMs=${minMs}ms, tooFastFromStart=${tooFastFromStart}`);
    let lastOkAt: number | null = null;
    for (const feed of state.feed) {
      // 同一玩家（不限队伍）、不同题目 的历史 AC 记录。
      // 同一道题重复提交 / 双路径重复 claim 不计入"连续 AC"，否则会被误判为作弊。
      if (feed.pid !== record.pid && normalizeName(feed.luoguName) === normalizeName(record.luoguName) && feed.status === "OK" && feed.at < record.at) {
        if (lastOkAt === null || feed.at > lastOkAt) lastOkAt = feed.at;
      }
    }
    // 同一玩家两次 AC 间隔过短（按题目难度最短时间映射，不再固定 60s）即判定作弊。
    const tooFastConsecutive = minMs > 0 && lastOkAt !== null && record.at - lastOkAt < minMs;
    if (!tooFastFromStart && !tooFastConsecutive) {
      console.log(`[detectCheatAndReport] NOT triggered: tooFastFromStart=${tooFastFromStart}, tooFastConsecutive=${tooFastConsecutive}, ` +
        `lastOkAt=${lastOkAt}, consecutiveGap=${lastOkAt !== null ? record.at - lastOkAt : "N/A"}`);
      return;
    }
    console.log(`[detectCheatAndReport] CHEAT DETECTED: cheater=${record.luoguName}, will terminate match + auto-report (no auto-ban)`);
    const cheaterName = record.luoguName;
    // 终止比赛：close reason 含"作弊"且附带作弊者姓名（供 directory 标记与客户端解析）。
    const closeEnvelope = await systemCloseEnvelope(
      this.cachedState.roomId,
      this.cachedState.lamport + 1,
      Date.now(),
      `检测到作弊，对决取消${CHEAT_CLOSE_SEPARATOR}${cheaterName}`
    );
    const savedClose = await this.acceptEnvelope(closeEnvelope);
    if (savedClose) this.broadcast({ type: "event", envelope: closeEnvelope });
    // 取消自动封禁逻辑：不再踢人 / 清零 Rating / 全局封禁 / +10 补偿。
    // 改为自动发起工单，由管理员在工单中审查并决定是否封禁或清零。
    void this.createCheatReportTicket(cheaterName, this.cachedState.roomId, this.roomSecret ?? "");
  }

  // 作弊自动检测后自动发起工单：举报用户 xxx 比赛疑似作弊（type=report），
  // 作者 VDsystem，责任人 Gcend，状态 处理中，并自动 @ 用户。降级为尽力而为，不影响比赛终止。
  private async createCheatReportTicket(cheaterName: string, roomId: string, secret: string): Promise<void> {
    try {
      const url = new URL("https://duel.internal/api/tickets/auto-report");
      const response = await this.env.TICKET_STORE.getByName("__tickets").fetch(new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-vd-claim": INTERNAL_CLAIM },
        body: JSON.stringify({ cheaterName, roomId, secret })
      }));
      if (!response.ok) console.log(`[createCheatReportTicket] ticket create returned ${response.status}`);
    } catch (error) {
      console.log(`[createCheatReportTicket] failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async alarm(): Promise<void> {
    if (await this.isDirectoryObject()) {
      await this.pruneDirectory();
      await this.ctx.storage.setAlarm(Date.now() + DIRECTORY_PRUNE_INTERVAL_MS);
      this.broadcastDirectory();
      return;
    }
    // 全局 moderation 房间（global:public-lobby）需要周期性压缩，清理累积的旁观者进入/聊天等临时事件。
    this.hydrateEvents();
    if (this.cachedState.roomId === "global") {
      await this.compactGlobalModeration();
      await this.ctx.storage.setAlarm(Date.now() + DIRECTORY_PRUNE_INTERVAL_MS);
      return;
    }
    await this.expireStaleLobby();
  }

  // 全局 moderation 房间会持续累积 player.joined（旁观者进入大厅）、chat.sent（大厅聊天）等临时事件。
  // 这些"古早内容"此前没有任何自动清理（expireStaleLobby 对 global 直接 return），导致事件无限增长。
  // 这里按 DATA_RETENTION_MS 保留期清理临时事件，同时永久保留定义 globalModeration 权威状态的
  // 封禁/禁言事件（player.kicked/muted/unmuted/unkicked），保证全局封禁与禁言不丢失。
  private async compactGlobalModeration(): Promise<void> {
    this.hydrateEvents();
    if (this.eventsCache!.length === 0) return;
    const cutoff = Date.now() - DATA_RETENTION_MS;
    const moderationTypes = new Set(["player.kicked", "player.muted", "player.unmuted", "player.unkicked"]);
    const retained = this.eventsCache!.filter((item) => moderationTypes.has(item.event.type) || item.event.issuedAt >= cutoff);
    if (retained.length === this.eventsCache!.length) return;
    this.ctx.storage.sql.exec("DELETE FROM events");
    this.ctx.storage.sql.exec("DELETE FROM snapshots WHERE snapshot_key = 'events'");
    for (const envelope of retained) {
      const event = envelope.event;
      this.ctx.storage.sql.exec(
        "INSERT INTO events (id, room_id, issued_at, lamport, envelope) VALUES (?, ?, ?, ?, ?)",
        event.id,
        event.roomId,
        event.issuedAt,
        event.lamport,
        JSON.stringify(envelope)
      );
    }
    this.eventsCache = retained;
    this.eventIds = new Set(retained.map((item) => item.event.id));
    this.firstEvent = retained[0]?.event ?? null;
    this.cachedState = retained.length ? applyEvents("global", retained.map((item) => item.event)) : createInitialState("global");
    this.writeSnapshot("events", retained);
    this.broadcast({ type: "sync", envelopes: retained });
  }

  private async expireStaleLobby(): Promise<void> {
    this.hydrateEvents();
    const createdAt = this.firstEvent?.issuedAt;
    if (!createdAt || this.cachedState.roomId === "global" || this.cachedState.phase !== "lobby") return;
    const deadline = createdAt + 10 * 60_000;
    if (Date.now() < deadline) {
      await this.ctx.storage.setAlarm(deadline);
      return;
    }
    const envelope = await systemCloseEnvelope(this.cachedState.roomId, this.cachedState.lamport + 1, Date.now());
    const saved = await this.acceptEnvelope(envelope);
    if (saved) this.broadcast({ type: "event", envelope });
  }

  private allowActorWrite(actorId: string): boolean {
    const now = Date.now();
    const recent = (this.actorWriteWindow.get(actorId) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= 60) return false;
    recent.push(now);
    this.actorWriteWindow.set(actorId, recent);
    return true;
  }

  private async claimActivePlayer(name: string, roomId: string): Promise<boolean> {
    const response = await this.env.DUEL_ROOM.getByName("__directory").fetch("https://duel.internal/active-player", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "claim", name, roomId })
    });
    const result = (await response.json()) as { ok?: boolean };
    return result.ok === true;
  }

  private async releaseActivePlayer(name: string, roomId: string): Promise<void> {
    await this.env.DUEL_ROOM.getByName("__directory").fetch("https://duel.internal/active-player", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "release", name, roomId })
    });
  }

  private async releaseActiveRoom(roomId: string): Promise<void> {
    await this.env.DUEL_ROOM.getByName("__directory").fetch("https://duel.internal/active-player", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "release-room", roomId })
    });
  }

  private listEvents(): SignedEnvelope[] {
    this.hydrateEvents();
    return this.eventsCache!;
  }

  // 把聊天 @提及 / 封禁 / 禁言等系统事件写入全局通知中心（TicketStore）。
  // 事件已持久化后才调用，DO 重启时由 hydrateEvents 直接重建状态、不会重放本逻辑，因此不会产生重复通知。
  private pushEventNotifications(event: DuelEvent): Promise<void> {
    const roomId = event.roomId || "";
    const link = `room=${encodeURIComponent(roomId)}&secret=${encodeURIComponent(this.roomSecret ?? "")}`;
    const players = this.cachedState.players ?? {};
    const actorName = players[event.actorId]?.luoguName ?? "有人";
    const push = (recipient: string, text: string, kind = "status"): void => {
      const name = normalizeName(recipient);
      if (!name) return;
      const body = JSON.stringify({ recipient: name, text, kind, link });
      void this.env.TICKET_STORE.getByName("__tickets")
        .fetch(new Request("https://duel.internal/api/system-notify", { method: "POST", headers: { "content-type": "application/json" }, body }))
        .catch(() => undefined);
    };
    try {
      if (event.type === "chat.sent") {
        const mentions = Array.from(new Set(
          [...event.text.matchAll(/@([^\s@，。、！？；：,.;:!?()（）\[\]【】<>《》"'「」“”·]+)/gu)].map((match) => normalizeName(match[1]))
        )).filter((name) => name && name !== normalizeName(actorName));
        for (const name of mentions) push(name, `${actorName} 在房间聊天中 @ 了你`, "mention");
        return Promise.resolve();
      }
      if (event.type === "player.kicked") {
        const target = event.targetName || players[event.targetId]?.luoguName || "";
        if (target) push(target, event.system ? "你因违规已被系统封禁，如有异议请提交申诉工单" : `你已被${event.by || actorName}移出房间`);
        return Promise.resolve();
      }
      if (event.type === "player.unkicked" && event.targetName) {
        push(event.targetName, "你已被解除封禁");
        return Promise.resolve();
      }
      if (event.type === "player.muted") {
        const target = event.targetName || players[event.targetId]?.luoguName || "";
        if (target) push(target, `你已被${actorName}禁言`);
        return Promise.resolve();
      }
      if (event.type === "player.unmuted") {
        const target = event.targetName || players[event.targetId]?.luoguName || "";
        if (target) push(target, "你已被解除禁言");
        return Promise.resolve();
      }
      if (event.type === "room.muted" || event.type === "room.unmuted") {
        const text = event.type === "room.muted" ? "房间已被全员禁言" : "房间已解除全员禁言";
        for (const player of Object.values(players)) {
          if (player.luoguName && player.luoguName !== actorName && isPlayingSeat(player.team)) push(player.luoguName, text);
        }
        return Promise.resolve();
      }
    } catch { /* 通知失败不影响主流程 */ }
    return Promise.resolve();
  }

  private hydrateEvents(): void {
    if (this.eventsCache) return;
    const snapshot = this.readSnapshot<SignedEnvelope[]>("events");
    if (snapshot) {
      this.eventsCache = snapshot;
    } else {
      this.eventsCache = this.ctx.storage.sql
        .exec<{ envelope: string }>("SELECT envelope FROM events ORDER BY lamport ASC, issued_at ASC, id ASC LIMIT 1000")
        .toArray()
        .map((row) => JSON.parse(row.envelope) as SignedEnvelope);
      this.writeSnapshot("events", this.eventsCache);
    }
    this.eventsCache.sort(compareEnvelopes);
    this.eventIds = new Set(this.eventsCache.map((item) => item.event.id));
    this.firstEvent = this.eventsCache[0]?.event ?? null;
    const roomId = this.firstEvent?.roomId ?? "";
    this.cachedState = roomId ? applyEvents(roomId, this.eventsCache.map((item) => item.event)) : createInitialState("");
  }

  private async updateDirectory(roomId: string, latestEvent: DuelEvent): Promise<void> {
    if (roomId === "global" || roomId === "__directory") return;
    const state = this.cachedState.roomId === roomId ? this.cachedState : applyEvents(roomId, this.listEvents().map((item) => item.event));
    const directory = this.env.DUEL_ROOM.getByName("__directory");
    const firstEvent = this.firstEvent ?? latestEvent;
    const firstPlayer = Object.values(state.players)[0];
    const declaredHost = firstEvent.type === "room.configured"
      ? firstEvent.hostName
      : latestEvent.type === "room.configured"
        ? latestEvent.hostName
        : undefined;
    const redPlayers = Object.values(state.players).filter((player) => player.team === "red").map((player) => player.luoguName);
    const bluePlayers = Object.values(state.players).filter((player) => player.team === "blue").map((player) => player.luoguName);
    const difficulties = problemDifficulties(state.problems);
    // 作弊封禁信息从事件流推导：close 原因含"作弊"，且之前有 system 踢人事件。
    const cheaterName = deriveCheatBannedName(this.eventsCache ?? this.listEvents());
    const listing: RoomListing = {
      roomId,
      secret: "",
      host: state.players[state.hostId ?? ""]?.luoguName ?? firstPlayer?.luoguName ?? declaredHost ?? "待同步",
      createdAt: firstEvent.issuedAt,
      problemCount: state.problems.length,
      status: state.closed || state.phase === "finished" ? "finished" : state.phase === "arena" ? "arena" : "lobby",
      startedAt: state.startedAt,
      endedAt: state.closed || state.phase === "finished" ? state.endedAt ?? latestEvent.issuedAt : undefined,
      winner: state.winner,
      rated: state.rated,
      averageDifficulty: difficulties.length ? average(difficulties) : undefined,
      minimumDifficulty: difficulties.length ? Math.min(...difficulties) : undefined,
      maximumDifficulty: difficulties.length ? Math.max(...difficulties) : undefined,
      closedReason: state.closed?.reason,
      redPlayers,
      bluePlayers,
      cheatBanned: cheaterName ? true : undefined,
      cheaterName: cheaterName ?? undefined
    };
    const attachmentSecret = await this.readSecret();
    if (attachmentSecret) listing.secret = attachmentSecret;
    await directory.fetch("https://duel.internal/directory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ listing })
    });
  }

  private async handleDirectory(request: Request): Promise<Response> {
    if (request.method === "GET") {
      await this.ctx.storage.setAlarm(Date.now() + DIRECTORY_PRUNE_INTERVAL_MS);
      // 边缘缓存 300s 即可：房间目录靠 WebSocket 实时推送，HTTP 仅作兜底/手动刷新，
      // 过长缓存（24h）会让“已结束/平局”的房间在列表里长时间停留在“进行中”。
      return Response.json({ rooms: this.listRooms() }, { headers: noStoreHeaders() });
    }
    if (request.method === "POST") {
      this.directoryObject = true;
      await this.ctx.storage.put("directory-object", true);
      const body = (await request.json()) as { listing?: RoomListing };
      if (!body.listing?.roomId) return jsonError("missing listing", 400);
      this.hydrateDirectory();
      const previous = this.listingsCache!.get(body.listing.roomId);
      if ((body.listing.host === "unknown" || body.listing.host === "待同步") && previous?.host && previous.host !== "unknown" && previous.host !== "待同步") {
        body.listing.host = previous.host;
      }
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO listings (room_id, listing, updated_at) VALUES (?, ?, ?)",
        body.listing.roomId,
        JSON.stringify(body.listing),
        Date.now()
      );
      this.registerListingUsers(body.listing);
      await this.applyFinishedListingResult(body.listing);
      this.listingsCache!.set(body.listing.roomId, body.listing);
      await this.pruneDirectory();
      this.writeSnapshot("directory", [...this.listingsCache!.values()]);
      await this.ctx.storage.setAlarm(Date.now() + DIRECTORY_PRUNE_INTERVAL_MS);
      this.broadcastDirectory();
      return Response.json({ ok: true });
    }
    if (request.method === "DELETE") {
      const body = (await request.json()) as { roomId?: string };
      if (body.roomId) {
        this.ctx.storage.sql.exec("DELETE FROM listings WHERE room_id = ?", body.roomId);
        this.hydrateDirectory();
        this.listingsCache!.delete(body.roomId);
        this.writeSnapshot("directory", [...this.listingsCache!.values()]);
        this.broadcastDirectory();
      }
      return Response.json({ ok: true });
    }
    return jsonError("method not allowed", 405);
  }

  private async handleActivePlayer(request: Request): Promise<Response> {
    if (request.method !== "POST") return jsonError("method not allowed", 405);
    const body = (await request.json()) as { action?: string; name?: string; roomId?: string };
    const roomId = body.roomId?.trim() || "";
    if (!roomId) return jsonError("missing room", 400);

    if (body.action === "release-room") {
      this.ctx.storage.sql.exec("DELETE FROM active_players WHERE room_id = ?", roomId);
      return Response.json({ ok: true });
    }

    const nameKey = normalizeName(body.name || "");
    if (!nameKey) return jsonError("missing player", 400);
    if (body.action === "release") {
      this.ctx.storage.sql.exec("DELETE FROM active_players WHERE name_key = ? AND room_id = ?", nameKey, roomId);
      return Response.json({ ok: true });
    }
    if (body.action !== "claim") return jsonError("bad action", 400);

    const existing = this.ctx.storage.sql
      .exec<{ room_id: string; updated_at: number }>("SELECT room_id, updated_at FROM active_players WHERE name_key = ? LIMIT 1", nameKey)
      .toArray()[0];
    if (existing && existing.room_id !== roomId && Date.now() - existing.updated_at < 24 * 60 * 60 * 1000) {
      return Response.json({ ok: false, roomId: existing.room_id }, { status: 409 });
    }
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO active_players (name_key, room_id, updated_at) VALUES (?, ?, ?)",
      nameKey,
      roomId,
      Date.now()
    );
    return Response.json({ ok: true });
  }

  private handleUsers(request: Request): Response {
    if (request.method !== "GET") return jsonError("method not allowed", 405);
    return Response.json({ users: this.listUsers() }, { headers: noStoreHeaders() });
  }

  // 规则考试通过状态：由 worker 持久化（按规范化洛谷用户名），避免用户更换设备后重新考试。
  private handleExamStatus(request: Request): Response {
    if (request.method !== "GET") return jsonError("method not allowed", 405);
    const user = (new URL(request.url)).searchParams.get("user")?.trim() ?? "";
    if (!user) return jsonError("missing user", 400);
    const passed = this.readExamPassed(normalizeName(user));
    return Response.json({ passed }, { headers: { "cache-control": "no-store" } });
  }

  private async handleExamPass(request: Request): Promise<Response> {
    if (request.method !== "POST") return jsonError("method not allowed", 405);
    const body = await (request.json() as unknown as Promise<{ user?: string }>).catch(() => null);
    const name = (body?.user ?? "").trim();
    if (!name) return jsonError("missing user", 400);
    this.writeExamPassed(normalizeName(name));
    return Response.json({ ok: true });
  }

  private readExamPassed(nameKey: string): boolean {
    this.hydrateExamPassed();
    return this.examPassedCache!.has(nameKey);
  }

  private writeExamPassed(nameKey: string): void {
    this.hydrateExamPassed();
    this.examPassedCache!.add(nameKey);
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO exam_passed (name_key, passed_at) VALUES (?, ?)",
      nameKey,
      Date.now()
    );
    this.writeSnapshot("exam-passed", [...this.examPassedCache!]);
  }

  private hydrateExamPassed(): void {
    if (this.examPassedCache) return;
    const snapshot = this.readSnapshot<string[]>("exam-passed");
    if (snapshot) {
      this.examPassedCache = new Set(snapshot);
      return;
    }
    const rows = this.ctx.storage.sql.exec<{ name_key: string }>("SELECT name_key FROM exam_passed").toArray();
    this.examPassedCache = new Set(rows.map((row) => row.name_key));
    this.writeSnapshot("exam-passed", [...this.examPassedCache]);
  }

  private async handleUser(request: Request, rawName: string): Promise<Response> {
    const name = rawName.trim();
    if (!name) return jsonError("missing name", 400);
    if (request.method === "GET") {
      const user = this.readUser(name);
      return user ? Response.json({ user }, { headers: noStoreHeaders() }) : jsonError("not found", 404);
    }
    if (request.method === "POST") {
      const body = (await request.json()) as Partial<UserRecord>;
      const requestedRating = typeof body.rating === "number" && Number.isFinite(body.rating) ? Math.round(body.rating) : undefined;
      if (requestedRating !== undefined && !adminNames.has(normalizeName(request.headers.get("x-admin-name") || ""))) {
        return jsonError("admin required", 403);
      }
      this.hydrateBannedUsers();
      if (this.bannedUsersCache!.has(normalizeName(name))) return jsonError("user is banned", 410);
      const user = this.upsertUser({
        name,
        avatar: stringField(body as Record<string, unknown>, "avatar") || undefined,
        color: stringField(body as Record<string, unknown>, "color") || undefined,
        profileHtml: typeof body.profileHtml === "string" ? body.profileHtml.slice(0, 20_000) : undefined,
        rating: requestedRating === undefined ? undefined : Math.max(0, Math.min(10_000, requestedRating))
      });
      this.broadcastDirectory();
      return Response.json({ user });
    }
    return jsonError("method not allowed", 405);
  }

  private handleClearAll(request: Request): Response {
    if (request.method !== "POST") return jsonError("method not allowed", 405);
    for (const table of ["events", "listings", "users", "processed_results", "banned_users", "active_players", "low_room_days", "snapshots"]) {
      this.ctx.storage.sql.exec(`DELETE FROM ${table}`);
    }
    this.eventsCache = [];
    this.eventIds = new Set();
    this.cachedState = createInitialState("");
    this.firstEvent = null;
    this.listingsCache = new Map();
    this.usersCache = new Map();
    this.bannedUsersCache = new Set();
    this.processedResultsCache = new Set();
    this.broadcastDirectory();
    return Response.json({ ok: true });
  }

  private async handleClearRuntimeData(request: Request): Promise<Response> {
    if (request.method !== "POST") return jsonError("method not allowed", 405);
    this.hydrateDirectory();
    this.hydrateEvents();
    const retainedEvents = this.activeGlobalBanEvents();
    const roomListings = [...this.listingsCache!.values()];
    let clearedRooms = 0;
    for (let offset = 0; offset < roomListings.length; offset += 25) {
      const batch = roomListings.slice(offset, offset + 25);
      const results = await Promise.all(batch.map(async (listing) => {
        const secret = listing.secret || "public-room";
        try {
          await this.env.DUEL_ROOM.getByName(`${listing.roomId}:${secret}`).fetch("https://duel.internal/clear-room", { method: "POST" });
          return true;
        } catch {
          // The directory entry is removed even when an old room object is unavailable.
          return false;
        }
      }));
      clearedRooms += results.filter(Boolean).length;
    }

    this.ctx.storage.sql.exec("DELETE FROM listings");
    this.ctx.storage.sql.exec("DELETE FROM processed_results");
    this.ctx.storage.sql.exec("DELETE FROM active_players");
    this.ctx.storage.sql.exec("DELETE FROM low_room_days");
    this.ctx.storage.sql.exec("DELETE FROM events");
    this.ctx.storage.sql.exec("DELETE FROM snapshots WHERE snapshot_key NOT IN ('users', 'banned-users')");
    for (const envelope of retainedEvents) {
      const event = envelope.event;
      this.ctx.storage.sql.exec(
        "INSERT INTO events (id, room_id, issued_at, lamport, envelope) VALUES (?, ?, ?, ?, ?)",
        event.id,
        event.roomId,
        event.issuedAt,
        event.lamport,
        JSON.stringify(envelope)
      );
    }
    this.eventsCache = retainedEvents;
    this.eventIds = new Set(retainedEvents.map((item) => item.event.id));
    this.firstEvent = retainedEvents[0]?.event ?? null;
    this.cachedState = retainedEvents.length ? applyEvents("global", retainedEvents.map((item) => item.event)) : createInitialState("");
    this.listingsCache = new Map();
    this.processedResultsCache = new Set();
    this.writeSnapshot("events", retainedEvents);
    this.writeSnapshot("directory", []);
    this.writeSnapshot("processed-results", []);
    await this.env.DUEL_ROOM.getByName("global:public-lobby").fetch("https://duel.internal/clear-global-chat", { method: "POST" });
    await this.ctx.storage.setAlarm(Date.now() + DIRECTORY_PRUNE_INTERVAL_MS);
    this.broadcastDirectory();
    return Response.json({ ok: true, clearedRooms, retainedBans: retainedEvents.filter((item) => item.event.type === "player.kicked").length });
  }

  private async handleClearGlobalChat(request: Request): Promise<Response> {
    if (request.method !== "POST") return jsonError("method not allowed", 405);
    this.hydrateEvents();
    const retainedEvents = this.activeGlobalBanEvents();
    this.ctx.storage.sql.exec("DELETE FROM events");
    this.ctx.storage.sql.exec("DELETE FROM snapshots WHERE snapshot_key = 'events'");
    for (const envelope of retainedEvents) {
      const event = envelope.event;
      this.ctx.storage.sql.exec(
        "INSERT INTO events (id, room_id, issued_at, lamport, envelope) VALUES (?, ?, ?, ?, ?)",
        event.id,
        event.roomId,
        event.issuedAt,
        event.lamport,
        JSON.stringify(envelope)
      );
    }
    this.eventsCache = retainedEvents;
    this.eventIds = new Set(retainedEvents.map((item) => item.event.id));
    this.firstEvent = retainedEvents[0]?.event ?? null;
    this.cachedState = retainedEvents.length ? applyEvents("global", retainedEvents.map((item) => item.event)) : createInitialState("global");
    this.writeSnapshot("events", retainedEvents);
    this.broadcast({ type: "sync", envelopes: retainedEvents });
    return Response.json({ ok: true, retainedBans: retainedEvents.filter((item) => item.event.type === "player.kicked").length });
  }

  private activeGlobalBanEvents(): SignedEnvelope[] {
    const moderation = applyEvents("global", this.eventsCache!.map((item) => item.event));
    const activeBans = new Set(Object.keys(moderation.banned));
    const banActors = new Set(
      this.eventsCache!
        .filter((item) => item.event.type === "player.kicked" && activeBans.has(normalizeName(item.event.targetName || "")))
        .map((item) => item.event.actorId)
    );
    // 保留所有封禁/禁言事件（定义 globalModeration 权威状态），以及当前被封禁者的进入事件。
    const moderationTypes = new Set(["player.kicked", "player.muted", "player.unmuted", "player.unkicked"]);
    return this.eventsCache!.filter((item) =>
      moderationTypes.has(item.event.type) ||
      (item.event.type === "player.joined" && banActors.has(item.event.actorId))
    );
  }

  private async handleCompact(request: Request): Promise<Response> {
    if (request.method !== "POST") return jsonError("method not allowed", 405);
    this.hydrateEvents();
    const beforeEvents = this.eventsCache!.length;
    this.hydrateDirectory();
    const cutoff = Date.now() - DATA_RETENTION_MS;
    let clearedRooms = 0;
    for (const listing of [...this.listingsCache!.values()]) {
      const at = listing.endedAt ?? listing.startedAt ?? listing.createdAt;
      if (at < cutoff) {
        this.ctx.storage.sql.exec("DELETE FROM listings WHERE room_id = ?", listing.roomId);
        this.listingsCache!.delete(listing.roomId);
        this.processedResultsCache?.delete(listing.roomId);
        const secret = listing.secret || "public-room";
        try {
          await this.env.DUEL_ROOM.getByName(`${listing.roomId}:${secret}`).fetch("https://duel.internal/clear-room", { method: "POST" });
          clearedRooms += 1;
        } catch {
          // The directory entry is gone; an unavailable old room can be retried on a later cleanup.
        }
      }
    }
    this.writeSnapshot("directory", [...this.listingsCache!.values()]);
    if (this.processedResultsCache) this.writeSnapshot("processed-results", [...this.processedResultsCache]);
    this.broadcastDirectory();
    return Response.json({ ok: true, directoryEvents: beforeEvents, clearedRooms, listings: this.listingsCache!.size });
  }

  private async handleClearRoom(request: Request): Promise<Response> {
    if (request.method !== "POST") return jsonError("method not allowed", 405);
    this.ctx.storage.sql.exec("DELETE FROM events");
    await this.ctx.storage.delete("secret");
    await this.ctx.storage.deleteAlarm();
    this.eventsCache = [];
    this.eventIds = new Set();
    this.cachedState = createInitialState("");
    this.firstEvent = null;
    this.roomSecret = "";
    this.ctx.storage.sql.exec("DELETE FROM snapshots WHERE snapshot_key = 'events'");
    return Response.json({ ok: true });
  }

  private async pruneDirectory(): Promise<void> {
    this.hydrateDirectory();
    const cutoff = Date.now() - DATA_RETENTION_MS;
    const expired = [...this.listingsCache!.values()]
      .filter((listing) => (listing.endedAt ?? listing.startedAt ?? listing.createdAt) < cutoff);
    const overflow = [...this.listingsCache!.values()]
      .filter((listing) => !expired.some((old) => old.roomId === listing.roomId))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(500, 525);
    const stale = [...expired, ...overflow];
    for (const listing of stale) {
      this.ctx.storage.sql.exec("DELETE FROM listings WHERE room_id = ?", listing.roomId);
      this.ctx.storage.sql.exec("DELETE FROM processed_results WHERE room_id = ?", listing.roomId);
      this.ctx.storage.sql.exec("DELETE FROM active_players WHERE room_id = ?", listing.roomId);
      this.listingsCache!.delete(listing.roomId);
      this.processedResultsCache?.delete(listing.roomId);
      const secret = listing.secret || "public-room";
      await this.env.DUEL_ROOM.getByName(`${listing.roomId}:${secret}`).fetch("https://duel.internal/clear-room", { method: "POST" });
    }
    this.ctx.storage.sql.exec("DELETE FROM active_players WHERE updated_at < ?", Date.now() - DATA_RETENTION_MS);
    if (stale.length) this.writeSnapshot("directory", [...this.listingsCache!.values()]);
  }

  private async isDirectoryObject(): Promise<boolean> {
    if (this.directoryObject !== null) return this.directoryObject;
    this.directoryObject = (await this.ctx.storage.get<boolean>("directory-object")) === true;
    return this.directoryObject;
  }

  private registerListingUsers(listing: RoomListing): void {
    for (const name of listingNames(listing)) {
      if (!this.readUser(name)) this.upsertUser({ name });
    }
  }

  private async applyFinishedListingResult(listing: RoomListing): Promise<void> {
    if (listing.status !== "finished") return;
    this.hydrateProcessedResults();
    if (this.processedResultsCache!.has(listing.roomId)) return;

    // 作弊场：
    // - 作弊者保持原样（不封禁、不清零、不扣 rating），等待管理员在自动工单里裁定；
    // - 其余参赛者每人 +10 Rating 作为本场被作废的补偿（不计入胜负场次）；
    // - 跳过正常 ELO 结算（该场没有胜负结果）。
    if (listing.cheatBanned) {
      this.applyCheatCompensation(listing);
      this.ctx.storage.sql.exec("INSERT INTO processed_results (room_id, processed_at) VALUES (?, ?)", listing.roomId, Date.now());
      this.processedResultsCache!.add(listing.roomId);
      this.writeSnapshot("processed-results", [...this.processedResultsCache!]);
      return;
    }

    if (listing.rated === false || listing.winner === "draw" || !listing.winner) return;
    const red = dedupeNames(listing.redPlayers ?? []);
    const blue = dedupeNames(listing.bluePlayers ?? []);
    if (!red.length || !blue.length) return;

    const redRows = red.map((name) => this.upsertUser({ name }));
    const blueRows = blue.map((name) => this.upsertUser({ name }));
    const redAvg = average(redRows.map((user) => user.rating));
    const blueAvg = average(blueRows.map((user) => user.rating));
    const redScore = listing.winner === "red" ? 1 : 0;
    const redExpected = 1 / (1 + 10 ** ((blueAvg - redAvg) / 400));
    const averageDifficulty = clampNumber(listing.averageDifficulty ?? 4, 1, 8);
    const difficultyK = 42 + averageDifficulty * 7;
    const delta = Math.round(difficultyK * (redScore - redExpected));
    for (const user of redRows) this.writeUser(applyRatingDelta(user, delta, redScore === 1));
    for (const user of blueRows) this.writeUser(applyRatingDelta(user, -delta, redScore === 0));
    this.ctx.storage.sql.exec("INSERT INTO processed_results (room_id, processed_at) VALUES (?, ?)", listing.roomId, Date.now());
    this.processedResultsCache!.add(listing.roomId);
    this.writeSnapshot("processed-results", [...this.processedResultsCache!]);
  }

  // 作弊场补偿：除作弊者外的所有参赛者每人 +10 Rating，不计入胜负场次。
  private applyCheatCompensation(listing: RoomListing): void {
    const cheaterKey = normalizeName((listing.cheaterName ?? "").trim());
    const others = dedupeNames([...(listing.redPlayers ?? []), ...(listing.bluePlayers ?? [])])
      .filter((name) => normalizeName(name) !== cheaterKey);
    for (const name of others) {
      this.writeUser(applyCompensationDelta(this.upsertUser({ name }), CHEAT_COMPENSATION_RATING));
    }
  }

  // 取目标房间的当前 lamport +1，用于系统生成的 moderation 信封。
  // 此前这些信封直接用 Date.now() 当 lamport（约 1.7e12），与真实事件 lamport 序列脱节：
  // 管理员若从过期快照发出解封事件（lamport 偏小），重放事件流时解封会排在封禁之前，
  // 最终表现为"手动解封过一段时间又被自动封禁"。
  private async nextLamport(objectName: string): Promise<number> {
    try {
      const response = await this.env.DUEL_ROOM.getByName(objectName).fetch("https://duel.internal/lamport");
      if (!response.ok) return Date.now();
      const data = (await response.json()) as { lamport?: number };
      return typeof data.lamport === "number" && Number.isFinite(data.lamport) ? data.lamport + 1 : Date.now();
    } catch {
      return Date.now();
    }
  }

  // 把房间内的解封事件同步回各进行中比赛房间，清除其房间级 banned/kicked，
  // 使手动解封真正生效（否则该房间重放记录会再次自动封禁）。尽力而为：个别房间不可用不影响全局解封落地。
  private async propagateGlobalUnban(event: Extract<DuelEvent, { type: "player.unkicked" }>): Promise<void> {
    try {
      const now = Date.now();
      for (const listing of this.listRooms()) {
        if (listing.roomId === "global") continue;
        const objectName = `${listing.roomId}:${listing.secret}`;
        const envelope = await systemUnkickEnvelope(listing.roomId, await this.nextLamport(objectName), now, event.targetName);
        const response = await this.env.DUEL_ROOM.getByName(`${listing.roomId}:${listing.secret}`).fetch("https://duel.internal/event", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ envelope })
        });
        if (!response.ok) throw new Error(`global unban propagate returned ${response.status}`);
      }
    } catch {
      // 房间级解封为尽力而为：个别房间不可用不影响全局解封已落地。
    }
  }

  // 把房间内的封禁/禁言事件同步到全局 moderation 房间（global:public-lobby），
  // 使其真正"全局化"：被房间内管理员封禁的用户在所有房间实时受限，主页遮罩也会显示。
  // 仅转发实际封禁（state.banned 已写入，准备房移除观赛者不算）与管理员禁言/解禁言。
  private async propagateGlobalModeration(
    event: Extract<DuelEvent, { type: "player.kicked" | "player.muted" | "player.unmuted" | "player.unkicked" }>
  ): Promise<void> {
    try {
      const now = Date.now();
      const globalName = "global:public-lobby";
      const postToGlobal = async (envelope: SignedEnvelope) => {
        const response = await this.env.DUEL_ROOM.getByName(globalName).fetch("https://duel.internal/event", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ envelope })
        });
        if (!response.ok) throw new Error(`global moderation returned ${response.status}`);
      };
      if (event.type === "player.kicked") {
        if (!this.cachedState.banned[normalizeName(event.targetName || "")]) return;
        await postToGlobal(await systemKickEnvelope("global", await this.nextLamport(globalName), now, `name:${normalizeName(event.targetName || "")}`, event.targetName || "", event.reason || "管理员封禁"));
        return;
      }
      if (event.type === "player.unkicked") {
        await postToGlobal(await systemUnkickEnvelope("global", await this.nextLamport(globalName), now, event.targetName));
        return;
      }
      // 禁言/解禁言：仅管理员操作全局化（房主房间内禁言保持房间级）。
      const actorName = this.cachedState.players[event.actorId]?.luoguName ?? "";
      if (!isAdminName(normalizeName(actorName))) return;
      if (event.type === "player.muted") {
        await postToGlobal(await systemMuteEnvelope("global", await this.nextLamport(globalName), now, `name:${normalizeName(event.targetName || "")}`, event.targetName || ""));
      } else if (event.type === "player.unmuted") {
        await postToGlobal(await systemUnmuteEnvelope("global", await this.nextLamport(globalName), now, `name:${normalizeName(event.targetName || "")}`, event.targetName || ""));
      }
    } catch {
      // 全局同步失败不影响本房间事件落地。
    }
  }

  private readUser(name: string): UserRecord | null {
    this.hydrateUsers();
    const key = normalizeName(name);
    return this.usersCache!.get(key) ?? null;
  }

  private upsertUser(input: { name: string; avatar?: string; color?: string; profileHtml?: string; rating?: number }): UserRecord {
    const existing = this.readUser(input.name);
    const nextRating = input.rating ?? existing?.rating ?? 1300;
    const now = Date.now();
    const ratingHistory = existing?.ratingHistory?.length
      ? [...existing.ratingHistory]
      : [{ at: existing?.updatedAt ?? now, rating: existing?.rating ?? nextRating }];
    if (existing && input.rating !== undefined && nextRating !== existing.rating) ratingHistory.push({ at: now, rating: nextRating });
    const user: UserRecord = {
      name: existing?.name || input.name.trim(),
      rating: nextRating,
      wins: existing?.wins ?? 0,
      losses: existing?.losses ?? 0,
      games: existing?.games ?? 0,
      avatar: input.avatar ?? existing?.avatar,
      color: input.color ?? existing?.color,
      profileHtml: input.profileHtml ?? existing?.profileHtml,
      ratingHistory: ratingHistory.slice(-100),
      updatedAt: now
    };
    return this.writeUser(user);
  }

  private writeUser(user: UserRecord): UserRecord {
    const key = normalizeName(user.name);
    this.hydrateBannedUsers();
    if (this.bannedUsersCache!.has(key)) return user;
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO users (name_key, user_json, updated_at) VALUES (?, ?, ?)",
      key,
      JSON.stringify(user),
      user.updatedAt
    );
    this.hydrateUsers();
    this.usersCache!.set(key, user);
    this.writeSnapshot("users", [...this.usersCache!.values()]);
    return user;
  }

  private removeUser(name: string): void {
    const key = normalizeName(name);
    if (!key) return;
    this.ctx.storage.sql.exec("DELETE FROM users WHERE name_key = ?", key);
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO banned_users (name_key, detected_at) VALUES (?, ?)",
      key,
      Date.now()
    );
    this.hydrateUsers();
    this.hydrateBannedUsers();
    this.usersCache!.delete(key);
    this.bannedUsersCache!.add(key);
    this.writeSnapshot("users", [...this.usersCache!.values()]);
    this.writeSnapshot("banned-users", [...this.bannedUsersCache!]);
  }

  private listRooms(): RoomListing[] {
    this.hydrateDirectory();
    const maxAge = Date.now() - DATA_RETENTION_MS;
    return [...this.listingsCache!.values()]
      .map((room) => room.host === "unknown" || room.host === "待同步"
        ? { ...room, host: room.redPlayers?.[0] ?? room.bluePlayers?.[0] ?? "待同步" }
        : room)
      .map((room) => room.status === "lobby" && Date.now() - room.createdAt >= 10 * 60_000
        ? { ...room, status: "finished" as const, endedAt: room.createdAt + 10 * 60_000, closedReason: "房间创建 10 分钟仍未开始，已自动关闭" }
        : room)
      .filter((room) => room.createdAt >= maxAge || (room.endedAt ?? room.startedAt ?? room.createdAt) >= maxAge)
      .sort((a, b) => (b.endedAt ?? b.startedAt ?? b.createdAt) - (a.endedAt ?? a.startedAt ?? a.createdAt))
      .slice(0, 500);
  }

  private listUsers(): UserRecord[] {
    this.hydrateUsers();
    return [...this.usersCache!.values()]
      .filter((user) => !isPlaceholderName(user.name))
      .sort((a, b) => b.rating - a.rating || b.wins - a.wins || a.name.localeCompare(b.name))
      .slice(0, 1000);
  }

  private hydrateDirectory(): void {
    if (this.listingsCache) return;
    const snapshot = this.readSnapshot<RoomListing[]>("directory");
    if (snapshot) {
      this.listingsCache = new Map(snapshot.map((listing) => [listing.roomId, listing]));
      return;
    }
    const rows = this.ctx.storage.sql.exec<{ listing: string }>("SELECT listing FROM listings").toArray();
    this.listingsCache = new Map(rows.map((row) => {
      const listing = JSON.parse(row.listing) as RoomListing;
      return [listing.roomId, listing];
    }));
    this.writeSnapshot("directory", [...this.listingsCache.values()]);
  }

  private hydrateUsers(): void {
    if (this.usersCache) return;
    this.hydrateBannedUsers();
    const snapshot = this.readSnapshot<UserRecord[]>("users");
    if (snapshot) {
      this.usersCache = new Map(snapshot.flatMap((user) => this.bannedUsersCache!.has(normalizeName(user.name)) ? [] : [[normalizeName(user.name), user]]));
      return;
    }
    const rows = this.ctx.storage.sql
      .exec<{ user_json: string }>("SELECT user_json FROM users")
      .toArray();
    this.usersCache = new Map();
    for (const row of rows) {
      const user = JSON.parse(row.user_json) as UserRecord;
      const key = normalizeName(user.name);
      if (!this.bannedUsersCache!.has(key)) this.usersCache.set(key, user);
    }
    this.writeSnapshot("users", [...this.usersCache.values()]);
  }

  private hydrateBannedUsers(): void {
    if (this.bannedUsersCache) return;
    const snapshot = this.readSnapshot<string[]>("banned-users");
    if (snapshot) {
      this.bannedUsersCache = new Set(snapshot);
      return;
    }
    const rows = this.ctx.storage.sql
      .exec<{ name_key: string }>("SELECT name_key FROM banned_users")
      .toArray();
    this.bannedUsersCache = new Set(rows.map((row) => row.name_key));
    this.writeSnapshot("banned-users", [...this.bannedUsersCache]);
  }

  private hydrateProcessedResults(): void {
    if (this.processedResultsCache) return;
    const snapshot = this.readSnapshot<string[]>("processed-results");
    if (snapshot) {
      this.processedResultsCache = new Set(snapshot);
      return;
    }
    const rows = this.ctx.storage.sql
      .exec<{ room_id: string }>("SELECT room_id FROM processed_results")
      .toArray();
    this.processedResultsCache = new Set(rows.map((row) => row.room_id));
    this.writeSnapshot("processed-results", [...this.processedResultsCache]);
  }

  private readSnapshot<T>(key: string): T | null {
    const row = this.ctx.storage.sql
      .exec<{ snapshot_json: string }>("SELECT snapshot_json FROM snapshots WHERE snapshot_key = ? LIMIT 1", key)
      .toArray()[0];
    if (!row) return null;
    try {
      return JSON.parse(row.snapshot_json) as T;
    } catch {
      this.ctx.storage.sql.exec("DELETE FROM snapshots WHERE snapshot_key = ?", key);
      return null;
    }
  }

  private writeSnapshot(key: string, value: unknown): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO snapshots (snapshot_key, snapshot_json, updated_at) VALUES (?, ?, ?)",
      key,
      JSON.stringify(value),
      Date.now()
    );
  }

  private async rememberSecret(secret: string): Promise<void> {
    if (this.roomSecret === secret) return;
    this.roomSecret = secret;
    await this.ctx.storage.put("secret", secret);
  }

  private async readSecret(): Promise<string | null> {
    if (this.roomSecret !== null) return this.roomSecret;
    this.roomSecret = await this.ctx.storage.get<string>("secret") ?? "";
    return this.roomSecret;
  }

  private broadcastDirectory(): void {
    this.broadcast({ type: "directory", rooms: this.listRooms() }, "directory");
    this.broadcast({ type: "users", users: this.listUsers() }, "directory");
  }

  private broadcast(payload: unknown, kind: SocketKind = "room"): void {
    const message = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as { kind?: SocketKind } | undefined;
      if ((attachment?.kind ?? "room") !== kind) continue;
      try {
        ws.send(message);
      } catch {
        // 失效连接由运行时回收，不能让单个连接中断整次广播。
      }
    }
  }

  private async handleLowRoomLimit(request: Request): Promise<Response> {
    const dayKey = chinaDayKey(Date.now());
    const existing = this.ctx.storage.sql
      .exec<{ room_id: string }>("SELECT room_id FROM low_room_days WHERE day_key = ? LIMIT 1", dayKey)
      .toArray()[0];
    if (request.method === "GET") return Response.json({ allowed: !existing, dayKey, roomId: existing?.room_id ?? null });
    if (request.method !== "POST") return jsonError("method not allowed", 405);
    const body = (await request.json()) as { roomId?: string };
    const roomId = body.roomId?.trim() || "";
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(roomId)) return jsonError("invalid room", 400);
    if (existing && existing.room_id !== roomId) {
      return jsonError("daily low difficulty room limit reached", 429);
    }
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO low_room_days (day_key, room_id, created_at) VALUES (?, ?, ?)",
      dayKey,
      roomId,
      Date.now()
    );
    this.ctx.storage.sql.exec("DELETE FROM low_room_days WHERE day_key < ?", chinaDayKey(Date.now() - 3 * 24 * 60 * 60_000));
    return Response.json({ ok: true, dayKey });
  }
}

export class TicketStore extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS tickets (
          id TEXT PRIMARY KEY,
          project TEXT NOT NULL,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          author TEXT NOT NULL,
          author_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open',
          assignee TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          closed_at INTEGER,
          closed_reason TEXT,
          reply_count INTEGER NOT NULL DEFAULT 0,
          last_reply_at INTEGER
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS comments (
          id TEXT PRIMARY KEY,
          ticket_id TEXT NOT NULL,
          author TEXT NOT NULL,
          author_id TEXT NOT NULL,
          body TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          mentions TEXT NOT NULL DEFAULT '[]'
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS notifications (
          id TEXT PRIMARY KEY,
          recipient TEXT NOT NULL,
          ticket_id TEXT NOT NULL,
          ticket_title TEXT NOT NULL,
          kind TEXT NOT NULL,
          text TEXT NOT NULL,
          read INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          link TEXT
        )
      `);
      // 存量库补列（新库建表时已包含 link，ALTER 会失败，静默忽略）。
      try { this.ctx.storage.sql.exec(`ALTER TABLE notifications ADD COLUMN link TEXT`); } catch { /* 列已存在 */ }
      this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS idx_comments_ticket ON comments(ticket_id, created_at)`);
      this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS idx_notif_recipient ON notifications(recipient, created_at)`);
      this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS idx_tickets_updated ON tickets(updated_at)`);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/api/tickets" && request.method === "GET") return await this.listTickets(url);
      if (path === "/api/tickets" && request.method === "POST") return await this.createTicket(request);
      // auto-report 必须先于 /api/tickets/:id 匹配，否则 POST 会被通用路由判为 405。
      if (path === "/api/tickets/auto-report" && request.method === "POST") return await this.createAutoReportTicket(request);
      const contentMatch = path.match(/^\/api\/tickets\/([^/]+)\/content$/);
      if (contentMatch) {
        const id = decodeURIComponent(contentMatch[1]);
        if (request.method === "PATCH") return await this.editTicketContent(request, id);
        return jsonError("method not allowed", 405);
      }
      const ticketIdMatch = path.match(/^\/api\/tickets\/([^/]+)$/);
      if (ticketIdMatch) {
        const id = decodeURIComponent(ticketIdMatch[1]);
        if (request.method === "GET") return await this.getTicket(id);
        if (request.method === "PATCH") return await this.updateTicket(request, id);
        if (request.method === "DELETE") return await this.deleteTicket(request, id);
        return jsonError("method not allowed", 405);
      }
      const commentMatch = path.match(/^\/api\/tickets\/([^/]+)\/comments$/);
      if (commentMatch && request.method === "POST") return await this.addComment(request, decodeURIComponent(commentMatch[1]));
      if (path === "/api/notifications" && request.method === "GET") return await this.listNotifications(url);
      if (path === "/api/notifications/read-all" && request.method === "POST") return await this.markAllRead(request);
      if (path === "/api/system-notify" && request.method === "POST") return await this.systemNotify(request);
      const notifMatch = path.match(/^\/api\/notifications\/([^/]+)\/read$/);
      if (notifMatch && request.method === "POST") return await this.markRead(notifMatch[1]);
      return jsonError("not found", 404);
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : "ticket error", 500);
    }
  }

  private query(sql: string, args: unknown[] = []): Array<Record<string, unknown>> {
    const cursor = this.ctx.storage.sql.exec(sql, ...(args as Array<unknown>));
    return cursor.toArray() as Array<Record<string, unknown>>;
  }

  private one(sql: string, args: unknown[] = []): Record<string, unknown> | null {
    const rows = this.query(sql, args);
    return rows[0] ?? null;
  }

  private ticketFromRow(row: Record<string, unknown>): Record<string, unknown> {
    return {
      id: row.id,
      project: row.project,
      type: row.type,
      title: row.title,
      description: row.description,
      author: row.author,
      authorId: row.author_id,
      status: row.status,
      assignee: row.assignee ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      closedAt: row.closed_at ?? null,
      closedReason: row.closed_reason ?? null,
      replyCount: row.reply_count,
      lastReplyAt: row.last_reply_at ?? null
    };
  }

  private commentFromRow(row: Record<string, unknown>): Record<string, unknown> {
    let mentions: string[] = [];
    try {
      mentions = JSON.parse(String(row.mentions ?? "[]")) as string[];
    } catch {
      mentions = [];
    }
    return {
      id: row.id,
      ticketId: row.ticket_id,
      author: row.author,
      authorId: row.author_id,
      body: row.body,
      createdAt: row.created_at,
      mentions
    };
  }

  private notifFromRow(row: Record<string, unknown>): Record<string, unknown> {
    return {
      id: row.id,
      recipient: row.recipient,
      ticketId: row.ticket_id,
      ticketTitle: row.ticket_title,
      kind: row.kind,
      text: row.text,
      read: Number(row.read) === 1,
      createdAt: row.created_at,
      link: row.link ?? null
    };
  }

  private insertNotification(recipient: string, ticketId: string, ticketTitle: string, kind: string, text: string, link: string | null = null): void {
    if (!recipient) return;
    this.ctx.storage.sql.exec(
      `INSERT INTO notifications (id, recipient, ticket_id, ticket_title, kind, text, read, created_at, link) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      crypto.randomUUID(),
      recipient,
      ticketId,
      ticketTitle,
      kind,
      text,
      Date.now(),
      link
    );
  }

  private async listTickets(url: URL): Promise<Response> {
    const p = url.searchParams;
    const clauses: string[] = [];
    const args: unknown[] = [];
    const project = p.get("project");
    if (project) {
      clauses.push("project = ?");
      args.push(project);
    }
    const type = p.get("type");
    if (type) {
      clauses.push("type = ?");
      args.push(type);
    }
    const status = p.get("status");
    if (status) {
      clauses.push("status = ?");
      args.push(status);
    }
    const author = p.get("author");
    if (author) {
      clauses.push("author = ?");
      args.push(author);
    }
    const assignee = p.get("assignee");
    if (assignee) {
      clauses.push("assignee = ?");
      args.push(assignee);
    }
    const q = (p.get("q") || "").trim();
    if (q) {
      // 极宽松匹配：标题或描述包含子串即命中（哪怕只有一个相同字符）。
      clauses.push("(title LIKE ? OR description LIKE ?)");
      args.push(`%${q}%`, `%${q}%`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.query(`SELECT * FROM tickets ${where} ORDER BY COALESCE(last_reply_at, updated_at) DESC LIMIT 200`, args);
    let tickets = rows.map((row) => this.ticketFromRow(row));
    if (q) {
      const term = q.toLowerCase();
      tickets = tickets
        .map((t) => {
          const title = String(t.title || "").toLowerCase();
          const desc = String(t.description || "").toLowerCase();
          let score = 0;
          if (title.includes(term)) score += 10;
          score += (title.split(term).length - 1) * 3;
          score += desc.split(term).length - 1;
          return { t, score };
        })
        .sort((a, b) => b.score - a.score || (Number(b.t.updatedAt) - Number(a.t.updatedAt)))
        .map((entry) => entry.t);
    }
    return Response.json({ tickets });
  }

  private async createTicket(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return jsonError("invalid body", 400);
    const project = String(body.project || "");
    const type = String(body.type || "");
    const title = String(body.title || "").trim();
    const description = String(body.description || "");
    const author = String(body.author || "").trim();
    const authorId = String(body.authorId || "");
    if (!["vjudge-duel", "gengen-rmj"].includes(project)) return jsonError("invalid project", 400);
    if (!["appeal", "report", "suggestion", "bug"].includes(type)) return jsonError("invalid type", 400);
    if (title.length < 5 || title.length > 100) return jsonError("标题长度需为 5-100 字符", 400);
    if (!description.trim()) return jsonError("工单描述不能为空", 400);
    if (description.length > 20000) return jsonError("描述过长", 400);
    if (!author || !authorId) return jsonError("missing author", 400);
    const now = Date.now();
    const id = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      `INSERT INTO tickets (id, project, type, title, description, author, author_id, status, assignee, created_at, updated_at, reply_count) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?, 0)`,
      id,
      project,
      type,
      title,
      description,
      author,
      authorId,
      now,
      now
    );
    const row = this.one("SELECT * FROM tickets WHERE id = ?", [id]);
    return Response.json({ ticket: row ? this.ticketFromRow(row) : null }, { status: 201 });
  }

  // 内部系统调用：自动发起“举报用户”工单（作弊自动检测触发）。
  // 仅接受带合法内部鉴权头的请求，避免外部伪造。
  private async createAutoReportTicket(request: Request): Promise<Response> {
    if (request.headers.get("x-vd-claim") !== INTERNAL_CLAIM) return jsonError("forbidden", 403);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return jsonError("invalid body", 400);
    const cheaterName = String(body.cheaterName || "").trim();
    const roomId = String(body.roomId || "").trim();
    const secret = String(body.secret || "").trim();
    if (!cheaterName || !roomId) return jsonError("missing fields", 400);
    const now = Date.now();
    const id = crypto.randomUUID();
    const title = `举报用户 ${cheaterName} 比赛疑似作弊`;
    const description = `用户 ${cheaterName} 在 https://duel.gengen.qzz.io/#room=${roomId}&secret=${secret} 提交记录异常，疑似有作弊嫌疑`;
    this.ctx.storage.sql.exec(
      `INSERT INTO tickets (id, project, type, title, description, author, author_id, status, assignee, created_at, updated_at, reply_count) VALUES (?, 'vjudge-duel', 'report', ?, ?, ?, 'vdsystem', 'processing', ?, ?, ?, 0)`,
      id, title, description, CHEAT_TICKET_AUTHOR, CHEAT_TICKET_ASSIGNEE, now, now
    );
    // 自动评论：VDsystem @ 用户，提醒其注意这条工单。
    const commentId = crypto.randomUUID();
 
    const commentBody = `@${cheaterName} 你可能在此比赛中作弊，请提供更详细的内容以方便我们的调查，\n @Gcend @General0826 @sLMxf @liyifan202201 @GCSG01 @imzfx_Square 请管理员参与审查`;
    this.ctx.storage.sql.exec(
      `INSERT INTO comments (id, ticket_id, author, author_id, body, created_at, mentions) VALUES (?, ?, ?, 'vdsystem', ?, ?, ?)`,
      commentId, id, CHEAT_TICKET_AUTHOR, commentBody, now, JSON.stringify([normalizeName(cheaterName)])
    );
    this.ctx.storage.sql.exec(`UPDATE tickets SET reply_count = 1, last_reply_at = ?, updated_at = ? WHERE id = ?`, now, now, id);
    this.insertNotification(normalizeName(cheaterName), id, title, "mention", `${CHEAT_TICKET_AUTHOR} 在工单《${title}》中 @ 了你`);
    const row = this.one("SELECT * FROM tickets WHERE id = ?", [id]);
    return Response.json({ ticket: row ? this.ticketFromRow(row) : null }, { status: 201 });
  }

  private async getTicket(id: string): Promise<Response> {
    const ticket = this.one("SELECT * FROM tickets WHERE id = ?", [id]);
    if (!ticket) return jsonError("ticket not found", 404);
    const comments = this.query("SELECT * FROM comments WHERE ticket_id = ? ORDER BY created_at ASC", [id]);
    return Response.json({ ticket: this.ticketFromRow(ticket), comments: comments.map((row) => this.commentFromRow(row)) });
  }

  private async addComment(request: Request, ticketId: string): Promise<Response> {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return jsonError("invalid body", 400);
    const author = String(body.author || "").trim();
    const authorId = String(body.authorId || "");
    const commentBody = String(body.body || "");
    if (!author || !authorId) return jsonError("missing author", 400);
    if (!commentBody.trim()) return jsonError("评论内容不能为空", 400);
    if (commentBody.length > 5000) return jsonError("评论过长", 400);
    const ticket = this.one("SELECT * FROM tickets WHERE id = ?", [ticketId]);
    if (!ticket) return jsonError("ticket not found", 404);
    const ticketTitle = String(ticket.title);
    const ticketAuthor = String(ticket.author);
    const now = Date.now();
    const commentId = crypto.randomUUID();
    // 宽松匹配 @提及：支持中文/Unicode 用户名，遇到空白或常见标点即截止。
    const mentionPattern = /@([^\s@，。、！？；：,.;:!?()（）\[\]【】<>《》"'「」“”·]+)/gu;
    const mentions = Array.from(
      new Set([...commentBody.matchAll(mentionPattern)].map((match) => normalizeName(match[1])))
    ).filter((name) => name && name !== normalizeName(author));
    this.ctx.storage.sql.exec(
      `INSERT INTO comments (id, ticket_id, author, author_id, body, created_at, mentions) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      commentId,
      ticketId,
      author,
      authorId,
      commentBody,
      now,
      JSON.stringify(mentions)
    );
    this.ctx.storage.sql.exec(
      `UPDATE tickets SET reply_count = reply_count + 1, last_reply_at = ?, updated_at = ? WHERE id = ?`,
      now,
      now,
      ticketId
    );
    const notified = new Set<string>();
    const authorNorm = normalizeName(author);
    const ticketAuthorNorm = normalizeName(ticketAuthor);
    for (const name of mentions) {
      if (name === ticketAuthorNorm) continue;
      if (notified.has(name)) continue;
      notified.add(name);
      this.insertNotification(name, ticketId, ticketTitle, "mention", `${author} 在工单《${ticketTitle}》中 @ 了你`);
    }
    if (authorNorm !== ticketAuthorNorm && !notified.has(ticketAuthorNorm)) {
      this.insertNotification(ticketAuthorNorm, ticketId, ticketTitle, "reply", `${author} 回复了您的工单《${ticketTitle}》`);
    }
    const updatedTicket = this.one("SELECT * FROM tickets WHERE id = ?", [ticketId]);
    const comments = this.query("SELECT * FROM comments WHERE ticket_id = ? ORDER BY created_at ASC", [ticketId]);
    return Response.json({ ticket: updatedTicket ? this.ticketFromRow(updatedTicket) : null, comments: comments.map((row) => this.commentFromRow(row)) });
  }

  private async updateTicket(request: Request, id: string): Promise<Response> {
    const actor = normalizeName(request.headers.get("x-admin-name") || "");
    if (!adminNames.has(actor)) return jsonError("admin required", 403);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return jsonError("invalid body", 400);
    const ticket = this.one("SELECT * FROM tickets WHERE id = ?", [id]);
    if (!ticket) return jsonError("ticket not found", 404);
    const prevStatus = String(ticket.status);
    let status = prevStatus;
    if (typeof body.status === "string" && body.status) {
      if (!["open", "processing", "closed", "done"].includes(body.status)) return jsonError("invalid status", 400);
      status = body.status;
    }
    let assignee: string | null = (ticket.assignee as string | null) ?? null;
    if (body.assignee !== undefined) assignee = body.assignee ? String(body.assignee).trim() : null;
    let closedAt = (ticket.closed_at as number | null) ?? null;
    let closedReason = (ticket.closed_reason as string | null) ?? null;
    if (status === "closed") {
      closedAt = Date.now();
      closedReason = typeof body.closedReason === "string" && body.closedReason.trim() ? body.closedReason.trim() : (closedReason || "管理员关单");
    } else if (status !== "closed" && prevStatus === "closed") {
      closedAt = null;
      closedReason = null;
    }
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `UPDATE tickets SET status = ?, assignee = ?, closed_at = ?, closed_reason = ?, updated_at = ? WHERE id = ?`,
      status,
      assignee,
      closedAt,
      closedReason,
      now,
      id
    );
    const ticketTitle = String(ticket.title);
    const ticketAuthor = String(ticket.author);
    if (status !== prevStatus) {
      const label = status === "closed" ? "已经被关单" : status === "processing" ? "处理中" : status === "done" ? "已完成" : "已重新打开";
      const text = status === "closed" ? `您提交的工单《${ticketTitle}》已经被关单` : `您提交的工单《${ticketTitle}》${label}`;
      this.insertNotification(normalizeName(ticketAuthor), id, ticketTitle, "status", text);
    }
    if (body.assignee !== undefined && assignee && normalizeName(assignee) !== normalizeName(ticketAuthor)) {
      this.insertNotification(normalizeName(assignee), id, ticketTitle, "assign", `您被指定为工单《${ticketTitle}》的责任人`);
    }
    const updated = this.one("SELECT * FROM tickets WHERE id = ?", [id]);
    return Response.json({ ticket: updated ? this.ticketFromRow(updated) : null });
  }

  // 工单创建者（或管理员）修改标题/描述。
  private async editTicketContent(request: Request, id: string): Promise<Response> {
    const actor = normalizeName(request.headers.get("x-actor-name") || "");
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return jsonError("invalid body", 400);
    const ticket = this.one("SELECT * FROM tickets WHERE id = ?", [id]);
    if (!ticket) return jsonError("ticket not found", 404);
    if (!adminNames.has(actor) && normalizeName(String(ticket.author)) !== actor) return jsonError("permission denied", 403);
    let title = String(body.title ?? "").trim();
    let description = String(body.description ?? "").trim();
    if (body.title !== undefined) {
      if (title.length < 5 || title.length > 100) return jsonError("标题长度需为 5-100 字符", 400);
    } else {
      title = String(ticket.title);
    }
    if (body.description !== undefined) {
      if (!description) return jsonError("工单描述不能为空", 400);
      if (description.length > 20000) return jsonError("描述过长", 400);
    } else {
      description = String(ticket.description);
    }
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `UPDATE tickets SET title = ?, description = ?, updated_at = ? WHERE id = ?`,
      title,
      description,
      now,
      id
    );
    const row = this.one("SELECT * FROM tickets WHERE id = ?", [id]);
    return Response.json({ ticket: row ? this.ticketFromRow(row) : null });
  }

  private async deleteTicket(request: Request, id: string): Promise<Response> {
    const actor = normalizeName(request.headers.get("x-admin-name") || "");
    if (!adminNames.has(actor)) return jsonError("admin required", 403);
    const ticket = this.one("SELECT * FROM tickets WHERE id = ?", [id]);
    if (!ticket) return jsonError("ticket not found", 404);
    this.ctx.storage.sql.exec("DELETE FROM comments WHERE ticket_id = ?", id);
    this.ctx.storage.sql.exec("DELETE FROM notifications WHERE ticket_id = ?", id);
    this.ctx.storage.sql.exec("DELETE FROM tickets WHERE id = ?", id);
    return Response.json({ ok: true });
  }

  private async systemNotify(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return jsonError("invalid body", 400);
    const recipient = normalizeName(String(body.recipient || "").trim());
    const text = String(body.text || "").trim();
    const kind = ["mention", "status", "assign", "reply", "system"].includes(String(body.kind)) ? String(body.kind) : "status";
    const link = String(body.link || "");
    if (!recipient) return jsonError("missing recipient", 400);
    if (!text) return jsonError("missing text", 400);
    this.insertNotification(recipient, "", "", kind, text, link || null);
    return Response.json({ ok: true });
  }

  private async listNotifications(url: URL): Promise<Response> {
    const name = normalizeName(url.searchParams.get("name") || "");
    if (!name) return jsonError("missing name", 400);
    const rows = this.query("SELECT * FROM notifications WHERE recipient = ? ORDER BY created_at DESC LIMIT 100", [name]);
    const unreadRow = this.one("SELECT COUNT(*) AS c FROM notifications WHERE recipient = ? AND read = 0", [name]);
    const unread = Number(unreadRow?.c ?? 0);
    return Response.json({ notifications: rows.map((row) => this.notifFromRow(row)), unread });
  }

  private async markAllRead(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const name = normalizeName(String(body?.name || ""));
    if (!name) return jsonError("missing name", 400);
    this.ctx.storage.sql.exec("UPDATE notifications SET read = 1 WHERE recipient = ?", name);
    return Response.json({ ok: true });
  }

  private async markRead(id: string): Promise<Response> {
    this.ctx.storage.sql.exec("UPDATE notifications SET read = 1 WHERE id = ?", id);
    return Response.json({ ok: true });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const manualClaimPath = /^\/api\/rooms\/[^/]+\/manual-claim$/.test(url.pathname);
    if (manualClaimPath && request.method === "OPTIONS") return manualClaimCors(new Response(null, { status: 204 }));
    if (url.pathname.startsWith("/api/")) {
      const blocked = await protectApiRequest(request, url, env);
      if (blocked) return blocked;
    }
    if (env.MAINTENANCE === "1" && !url.pathname.startsWith("/api/admin/")) {
      return new Response(maintenanceHtml(), {
        status: 503,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
      });
    }
    if (url.pathname === "/api/admin-names") return Response.json({ names: Array.from(adminNames) });
    if (url.pathname === "/api/auth/vjudge/verify" && request.method === "POST") return verifyVJudgeLogin(request, env);
    const problemBankMatch = url.pathname.match(/^\/api\/problem-bank\/(luogu|codeforces|atcoder)$/);
    if (problemBankMatch && request.method === "GET") {
      return proxyProblemBank(request, problemBankMatch[1] as ProblemBankSource, ctx);
    }
    // Vditor 运行时静态资源（同源 /vditor/3.11.2/dist/*，主源 BootCDN，详见 proxyVditorAsset）。
    // 路径带版本号：旧版本曾把 /vditor/dist/* 交给 SPA fallback（返回 index.html）且被边缘缓存，
    // 换新路径避开被污染的缓存条目；wrangler.jsonc 已把 /vditor/* 加入 run_worker_first。
    const vditorAssetMatch = url.pathname.match(/^\/vditor\/3\.11\.2\/dist\/([\w./-]+\.(?:js|mjs|css|png|svg|gif|jpe?g|webp|json|woff2?|ttf|eot|otf|map))$/);
    if (vditorAssetMatch && request.method === "GET") {
      return proxyVditorAsset(vditorAssetMatch[1]);
    }
    if (url.pathname === "/api/vjudge/status" && request.method === "GET") return fetchVJudgeStatus(url, request, env);
    if (url.pathname === "/api/room-limit/low" && request.method === "GET") {
      const name = normalizeName(url.searchParams.get("name") || "");
      if (!name) return jsonError("missing name", 400);
      return env.DUEL_ROOM.getByName(`__low-room-limit:${name}`).fetch("https://duel.internal/low-room-limit");
    }
    if (url.pathname === "/api/rooms" && request.method === "GET") {
      return directoryJsonResponse(request, env, "https://duel.internal/directory");
    }
    if (url.pathname === "/api/rooms/ws") return env.DUEL_ROOM.getByName("__directory").fetch(new Request("https://duel.internal/directory/ws", request));
    if (url.pathname === "/api/users" && request.method === "GET") {
      return directoryJsonResponse(request, env, "https://duel.internal/users");
    }
    // 规则考试通过状态（按洛谷用户名持久化于 __directory，跨设备生效）。
    if (url.pathname === "/api/exam/status" && request.method === "GET") {
      const user = url.searchParams.get("user")?.trim() ?? "";
      if (!user) return jsonError("missing user", 400);
      return env.DUEL_ROOM.getByName("__directory").fetch(new Request(`https://duel.internal/exam/status?user=${encodeURIComponent(user)}`, request));
    }
    if (url.pathname === "/api/exam/pass" && request.method === "POST") {
      return env.DUEL_ROOM.getByName("__directory").fetch(new Request("https://duel.internal/exam/pass", request));
    }
    if (url.pathname === "/api/admin/clear-all" && request.method === "POST") {
      const actor = normalizeName(request.headers.get("x-admin-name") || "");
      if (!adminNames.has(actor)) return jsonError("admin required", 403);
      return env.DUEL_ROOM.getByName("__directory").fetch("https://duel.internal/clear-all", request);
    }
    if (url.pathname === "/api/admin/clear-runtime-data" && request.method === "POST") {
      const actor = normalizeName(request.headers.get("x-admin-name") || "");
      if (!adminNames.has(actor)) return jsonError("admin required", 403);
      return env.DUEL_ROOM.getByName("__directory").fetch("https://duel.internal/clear-runtime-data", request);
    }
    if (url.pathname === "/api/admin/compact" && request.method === "POST") {
      const actor = normalizeName(request.headers.get("x-admin-name") || "");
      if (!adminNames.has(actor)) return jsonError("admin required", 403);
      return env.DUEL_ROOM.getByName("__directory").fetch("https://duel.internal/compact", request);
    }
    const adminRoomClear = url.pathname.match(/^\/api\/admin\/rooms\/([^/]+)\/clear$/);
    if (adminRoomClear && request.method === "POST") {
      const actor = normalizeName(request.headers.get("x-admin-name") || "");
      if (!adminNames.has(actor)) return jsonError("admin required", 403);
      const roomId = decodeURIComponent(adminRoomClear[1]);
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(roomId)) return jsonError("invalid room", 400);
      const secret = url.searchParams.get("secret") || "public-room";
      return env.DUEL_ROOM.getByName(`${roomId}:${secret}`).fetch("https://duel.internal/clear-room", { method: "POST" });
    }
    const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
    if (userMatch) {
      return env.DUEL_ROOM.getByName("__directory").fetch(new Request(`https://duel.internal/users/${userMatch[1]}`, request));
    }

    const roomMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/(ws|snapshot|event|manual-claim|clear)$/);
    if (roomMatch) {
      const roomId = decodeURIComponent(roomMatch[1]);
      const action = roomMatch[2];
      const secret = url.searchParams.get("secret") || "public-room";
      const stub = env.DUEL_ROOM.getByName(`${roomId}:${secret}`);
      const internalAction = action === "clear" ? "clear-room" : action;
      const response = await stub.fetch(new Request(`https://duel.internal/${internalAction}?secret=${encodeURIComponent(secret)}`, request));
      return action === "manual-claim" ? manualClaimCors(response) : response;
    }

    if (url.pathname.startsWith("/api/tickets") || url.pathname.startsWith("/api/notifications")) {
      return env.TICKET_STORE.getByName("__tickets").fetch(new Request(`https://duel.internal${url.pathname}${url.search}`, request));
    }

    const assetResponse = await env.ASSETS.fetch(request);
    if (request.method !== "GET" || !assetResponse.ok) return assetResponse;
    const pathname = new URL(request.url).pathname;
    const headers = new Headers(assetResponse.headers);
    // 仅对真实静态资源（带扩展名且非 .html）做长边缘缓存；SPA 路由（/、/exam、/user/...）
    // 的 HTML 一律 no-store，否则边缘会缓存住旧版页面、掩盖门禁/重定向修复。
    const isStaticAsset = /\.[a-z0-9]+$/i.test(pathname) && !pathname.endsWith(".html");
    if (isStaticAsset) {
      headers.set("cache-control", "public, max-age=0, must-revalidate, s-maxage=86400, stale-while-revalidate=604800");
    } else {
      headers.set("cache-control", "no-store");
    }
    return new Response(assetResponse.body, { status: assetResponse.status, statusText: assetResponse.statusText, headers });
  }
};

const manualClaimCors = (response: Response): Response => {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "POST, OPTIONS");
  headers.set("access-control-allow-headers", "content-type");
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};

type ProblemBankSource = "luogu" | "codeforces" | "atcoder";

const problemBankSources: Record<ProblemBankSource, { url: string; accept: string }> = {
  luogu: {
    url: "https://cdn.luogu.com.cn/problemset-open/latest.ndjson.gz",
    accept: "application/gzip, application/octet-stream"
  },
  codeforces: {
    url: "https://codeforces.com/api/problemset.problems",
    accept: "application/json"
  },
  atcoder: {
    url: "https://kenkoooo.com/atcoder/resources/problem-models.json",
    accept: "application/json"
  }
};

const problemBankCacheSeconds = 30 * 24 * 60 * 60;

const proxyProblemBank = async (request: Request, source: ProblemBankSource, ctx: ExecutionContext): Promise<Response> => {
  try {
    const cacheUrl = new URL(request.url);
    cacheUrl.search = "";
    const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
    const cache = (caches as CacheStorage & { default: Cache }).default;
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const config = problemBankSources[source];
    const upstream = await fetchExternalWith403Fallback(config.url, {
      headers: { accept: config.accept },
      cf: { cacheEverything: true, cacheTtl: problemBankCacheSeconds },
      signal: AbortSignal.timeout(300_000)
    });
    if (!upstream.ok) return jsonError(`${source} problem bank upstream returned ${upstream.status}`, 502);

    const headers = new Headers(upstream.headers);
    headers.set("cache-control", `public, max-age=${problemBankCacheSeconds}, s-maxage=${problemBankCacheSeconds}`);
    headers.delete("set-cookie");
    const response = new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers
    });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : `${source} problem bank proxy failed`, 502);
  }
};

// Vditor 运行时静态资源代理。
// Vditor 内部硬编码请求 `${cdn}/dist/...`，而 BootCDN（cdnjs 镜像）上的 vditor 是扁平目录
// （无 dist/ 前缀，如 .../vditor/3.11.2/js/i18n/zh_CN.js），无法直接作为 cdn 使用。
// 因此在 Worker 上暴露同源路径 /vditor/3.11.2/dist/*（已加入 run_worker_first）：
// 主源 BootCDN（去掉 dist 前缀），BootCDN 缺失的文件（emoji 图片等）回退 jsdelivr（npm dist 布局），
// 全部经 Cloudflare 边缘缓存，客户端同源加载最快。
// 注意：KaTeX 字体（woff/ttf）经由 katex.min.css 的相对路径也会走本代理，扩展名白名单需包含字体格式。
const VDITOR_BOOTCDN_BASE = "https://cdn.bootcdn.net/ajax/libs/vditor/3.11.2";
const VDITOR_FALLBACK_BASE = "https://cdn.jsdelivr.net/npm/vditor@3.11.2/dist";
const vditorAssetCacheSeconds = 365 * 24 * 60 * 60;

const proxyVditorAsset = async (assetPath: string): Promise<Response> => {
  if (assetPath.includes("..")) return jsonError("invalid path", 400);
  for (const base of [VDITOR_BOOTCDN_BASE, VDITOR_FALLBACK_BASE]) {
    try {
      const upstream = await fetch(`${base}/${assetPath}`, {
        cf: {
          cacheEverything: true,
          cacheTtl: vditorAssetCacheSeconds,
          cacheTtlByStatus: { "200-299": vditorAssetCacheSeconds, "404": 0, "500-599": 0 }
        },
        signal: AbortSignal.timeout(15_000)
      });
      if (!upstream.ok || !upstream.body) continue;
      const headers = new Headers();
      // BootCDN 对字体返回 application/octet-stream，部分浏览器会拒绝在 @font-face 中使用，
      // 这里按扩展名显式覆盖正确的 MIME 类型。
      const ext = assetPath.slice(assetPath.lastIndexOf(".") + 1).toLowerCase();
      const fontTypes: Record<string, string> = { woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", otf: "font/otf", eot: "application/vnd.ms-fontobject" };
      headers.set("content-type", fontTypes[ext] ?? upstream.headers.get("content-type") ?? "application/octet-stream");
      headers.set("cache-control", `public, max-age=${vditorAssetCacheSeconds}, immutable`);
      return new Response(upstream.body, { status: 200, headers });
    } catch {
      // 尝试下一个源
    }
  }
  return jsonError("vditor asset not found", 404);
};

const fetchVJudgeStatus = async (requestUrl: URL, request: Request, env: Env): Promise<Response> => {
  const oj = requestUrl.searchParams.get("oj") || "";
  const problem = (requestUrl.searchParams.get("problem") || "").trim();
  const since = Number(requestUrl.searchParams.get("since") || 0);
  const requester = (requestUrl.searchParams.get("requester") || "").trim();
  const allowedOjs = new Set(["AtCoder", "CodeForces", "洛谷"]);
  if (!allowedOjs.has(oj) || !/^[A-Za-z0-9_.-]{1,80}$/.test(problem) || !/^[A-Za-z0-9_.-]{1,40}$/.test(requester) || !Number.isFinite(since) || since < 0) return jsonError("invalid VJudge status query", 400);
  const clientKey = `${request.headers.get("cf-connecting-ip") || "local"}:${requester.toLowerCase()}`;
  const judgeLimit = await env.JUDGE_RATE_LIMITER.limit({ key: clientKey });
  if (!judgeLimit.success) {
    return Response.json(
      { error: "判题请求过于频繁，请稍后重试" },
      { status: 429, headers: { "cache-control": "no-store", "retry-after": "5" } }
    );
  }

  try {
    const records: Array<Record<string, unknown>> = [];
    const pageSize = 100;
    let start = 0;
    for (let page = 0; page < 40; page += 1) {
      const upstreamUrl = new URL("https://vjudge.net/status/data");
      upstreamUrl.searchParams.set("start", String(start));
      upstreamUrl.searchParams.set("length", String(pageSize));
      upstreamUrl.searchParams.set("OJId", oj);
      upstreamUrl.searchParams.set("probNum", problem);
      const upstream = await fetchExternalWith403Fallback(upstreamUrl, {
        headers: { accept: "application/json", referer: "https://vjudge.net/status", "cache-control": "no-cache" },
        cf: { cacheTtl: 0 },
        signal: AbortSignal.timeout(12_000)
      });
      if (!upstream.ok) return jsonError(`VJudge status upstream returned ${upstream.status}`, 502);
      const payload = (await upstream.json()) as { data?: Array<Record<string, unknown>>; recordsFiltered?: number; recordsTotal?: number };
      const pageRecords = payload.data ?? [];
      if (!pageRecords.length) break;
      records.push(...pageRecords);
      const pageTimes = pageRecords
        .map((record) => Number(record.time))
        .filter(Number.isFinite)
        .map((time) => time > 0 && time < 10_000_000_000 ? time * 1000 : time);
      if (since && pageTimes.some((time) => time < since)) break;
      start += pageRecords.length;
      const total = Number(payload.recordsFiltered ?? payload.recordsTotal);
      if ((Number.isFinite(total) && start >= total) || (!Number.isFinite(total) && pageRecords.length < pageSize)) break;
    }
    const seen = new Set<string>();
    let filteredBySinceCount = 0;
    let passedCount = 0;
    const data = records.flatMap((record) => {
      const userId = typeof record.userId === "number" || typeof record.userId === "string" ? record.userId : undefined;
      const userName = typeof record.userName === "string" ? record.userName : "";
      const status = typeof record.status === "string" ? record.status : "";
      const rawTime = typeof record.time === "number" ? record.time : Number(record.time);
      const time = rawTime > 0 && rawTime < 10_000_000_000 ? rawTime * 1000 : rawTime;
      const runId = typeof record.runId === "number" || typeof record.runId === "string" ? record.runId : "";
      const key = `${runId || userId}:${time}`;
      if (userId === undefined || !status || !Number.isFinite(time) || time < since || seen.has(key)) {
        if (time < since) filteredBySinceCount++;
        return [];
      }
      passedCount++;
      seen.add(key);
      return [{ userId, userName, status, time, runId }];
    });
    if (since > 0) console.log(`[fetchVJudgeStatus] since=${since} (${new Date(since).toISOString()}), ` +
      `totalFetched=${records.length}, passed=${passedCount}, filteredBySince=${filteredBySinceCount}`);
    return Response.json({ data }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "VJudge status request failed", 502);
  }
};

const directoryJsonResponse = async (request: Request, env: Env, internalUrl: string): Promise<Response> => {
  try {
    const response = await env.DUEL_ROOM.getByName("__directory").fetch(internalUrl);
    if (!response.ok) return jsonError(`directory returned ${response.status}`, response.status);
    const payload = await response.json();
    const body = JSON.stringify(payload);
    // 不缓存：房间目录/用户列表是高频变化数据（比赛结束、评分更新），
    // 之前的 20s Cache-API 缓存 + s-maxage=20 会让排行榜/大厅显示陈旧数据。
    const complete = new Response(body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-length": String(new TextEncoder().encode(body).byteLength),
        "cache-control": "no-store"
      }
    });
    return complete;
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "directory response incomplete", 502);
  }
};

const verifyVJudgeLogin = async (request: Request, env: Env): Promise<Response> => {
  const body = (await request.json().catch(() => null)) as { username?: unknown; method?: unknown; code?: unknown } | null;
  const username = typeof body?.username === "string" ? body.username.trim() : "";
  const method = body?.method === "school" ? "school" : "recent";
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!/^[A-Za-z0-9_.-]{1,40}$/.test(username)) return jsonError("请输入有效的 VJudge 用户名", 400);
  if (method === "school" && !/^\d{6}$/.test(code)) return jsonError("请先生成 6 位学校验证码", 400);

  try {
    const profileUrl = new URL(`https://vjudge.net/user/${encodeURIComponent(username)}`);
    profileUrl.searchParams.set("_", String(Date.now()));
    const response = await fetchExternalWith403Fallback(profileUrl, {
      headers: { accept: "text/html", "cache-control": "no-cache", pragma: "no-cache" },
      cf: { cacheTtl: 0 },
      signal: AbortSignal.timeout(10_000)
    });
    if (response.status === 404) return jsonError("未找到该 VJudge 用户", 404);
    if (!response.ok) throw new Error(`VJudge 返回 ${response.status}`);
    const html = await response.text();
    if (method === "school") {
      const school = extractProfileField(html, "user.profile.school");
      if (!school.includes(code)) return jsonError(`学校字段中没有找到验证码 ${code}`, 403);
    } else {
      const lastSeen = extractProfileField(html, "user.profile.last_seen");
      if (!isRecentVJudgeActivity(lastSeen)) return jsonError("登录信息为"+`"${lastSeen}"`, 403);
    }
    const avatar = extractVJudgeAvatar(html);
    const saved = await env.DUEL_ROOM.getByName("__directory").fetch(
      new Request(`https://duel.internal/users/${encodeURIComponent(username)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: username, avatar })
      })
    );
    if (!saved.ok) throw new Error("用户资料保存失败");
    return Response.json({ session: { username, avatar, signedInAt: Date.now() } }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "VJudge 验证失败", 502);
  }
};

const isRecentVJudgeActivity = (value: string): boolean => {
  const normalized = value.trim().toLowerCase();
  if (normalized === "just now") return true;
  const seconds = normalized.match(/^(\d+)\s*(?:sec|secs|second|seconds)\s+ago$/)?.[1];
  return seconds !== undefined && Number(seconds) <= 3;
};

const external403Fallback = "https://liyifan202201-bug.hf.space/";

// The proxy is only a one-shot fallback for known public OJ sources. Normal
// traffic stays on the origin, and client-controlled URLs can never use it.
const fetchExternalWith403Fallback = async (input: string | URL, init?: RequestInit): Promise<Response> => {
  const target = new URL(input.toString());
  const allowedHosts = new Set(["vjudge.net", "codeforces.com", "kenkoooo.com", "cdn.luogu.com.cn"]);
  const response = await fetch(target, init);
  if (response.status !== 403 || !allowedHosts.has(target.hostname)) return response;

  const proxyUrl = new URL(external403Fallback);
  proxyUrl.searchParams.set("url", target.toString());
  return fetch(proxyUrl, init);
};

const extractProfileField = (html: string, i18nKey: string): string => {
  const marker = `data-i18n="${i18nKey}"`;
  const start = html.indexOf(marker);
  if (start < 0) return "";
  const field = html.slice(start, html.indexOf("</div>", start) + 6);
  const value = field.match(/<dd[^>]*>([\s\S]*?)<\/dd>/i)?.[1] ?? "";
  return decodeHtml(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
};

const extractVJudgeAvatar = (html: string): string | undefined => {
  const tag = html.match(/<img\b[^>]*\bid=["']user_avatar["'][^>]*>/i)?.[0] ?? "";
  const src = tag.match(/\bsrc=["']([^"']+)["']/i)?.[1];
  if (!src) return undefined;
  try {
    return new URL(decodeHtml(src), "https://vjudge.net").toString();
  } catch {
    return undefined;
  }
};

const decodeHtml = (value: string): string => value
  .replace(/&amp;/g, "&")
  .replace(/&quot;/g, "\"")
  .replace(/&#39;/g, "'")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">");

const stringField = (source: Record<string, unknown> | undefined, key: string): string => {
  const value = source?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
};

const normalizeName = (name: string): string => name.trim().toLowerCase();

const isPlaceholderName = (name: string): boolean => {
  const normalized = normalizeName(name);
  return !normalized || normalized === "unknown" || normalized === "待同步";
};

const protectApiRequest = async (request: Request, url: URL, env: Env): Promise<Response | null> => {
  if (!new Set(["GET", "POST", "PATCH", "DELETE"]).has(request.method)) return jsonError("method not allowed", 405);
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > 256 * 1024) return jsonError("request body too large", 413);
  if (request.method !== "GET") {
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) return jsonError("cross-site request rejected", 403);
  }
  const clientKey = request.headers.get("cf-connecting-ip") || "local";
  const outcome = await env.API_RATE_LIMITER.limit({ key: clientKey });
  return outcome.success ? null : Response.json(
    { error: "too many requests" },
    { status: 429, headers: { "cache-control": "no-store", "retry-after": "60" } }
  );
};

const dedupeNames = (names: string[]): string[] => {
  const seen = new Set<string>();
  return names.flatMap((name) => {
    const trimmed = name.trim();
    const key = normalizeName(trimmed);
    if (isPlaceholderName(trimmed) || seen.has(key)) return [];
    seen.add(key);
    return [trimmed];
  });
};

const listingNames = (listing: RoomListing): string[] =>
  dedupeNames([listing.host, ...(listing.redPlayers ?? []), ...(listing.bluePlayers ?? [])]);

const average = (values: number[]): number =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 1300;

const problemDifficulties = (problems: Problem[]): number[] =>
  problems
    .map((problem) => Number(problem.difficulty))
    .filter((difficulty) => Number.isFinite(difficulty) && difficulty >= 1 && difficulty <= 8);

const isLowDifficultyRoom = (problems: Problem[]): boolean => {
  const difficulties = problemDifficulties(problems);
  return difficulties.length > 0 && Math.min(...difficulties) <= 2;
};

// 按题目难度色决定开赛后最短可 AC 时间，用于作弊检测：
// 红(1) 无限制；橙黄(2-3) 60s；绿(4) 3min；青蓝(5-6) 5min；紫黑(7-8) 10min。
const minSolveMsForDifficulty = (difficulty: number | undefined): number => {
  const level = Number(difficulty);
  // 未知难度（如自定义题目）按橙黄档 60s 兜底，避免完全无检测；红题(<=1)不设下限。
  if (!Number.isFinite(level)) return 60_000;
  if (level <= 1) return 0;
  if (level <= 3) return 60_000;
  if (level <= 4) return 3 * 60_000;
  if (level <= 6) return 5 * 60_000;
  return 10 * 60_000;
};

const chinaDayKey = (timestamp: number): string =>
  new Date(timestamp + 8 * 60 * 60_000).toISOString().slice(0, 10);

const clampNumber = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : minimum));

const applyRatingDelta = (user: UserRecord, delta: number, won: boolean): UserRecord => ({
  ...user,
  rating: Math.max(0, user.rating + delta),
  wins: user.wins + (won ? 1 : 0),
  losses: user.losses + (won ? 0 : 1),
  games: user.games + 1,
  ratingHistory: [...(user.ratingHistory?.length ? user.ratingHistory : [{ at: user.updatedAt, rating: user.rating }]), { at: Date.now(), rating: Math.max(0, user.rating + delta) }].slice(-100),
  updatedAt: Date.now()
});

// 作弊场补偿：非作弊参赛者每人 +10 Rating，不计入胜负场次（本场没有胜负结果）。
const applyCompensationDelta = (user: UserRecord, delta: number): UserRecord => ({
  ...user,
  rating: Math.max(0, user.rating + delta),
  ratingHistory: [...(user.ratingHistory?.length ? user.ratingHistory : [{ at: user.updatedAt, rating: user.rating }]), { at: Date.now(), rating: Math.max(0, user.rating + delta) }].slice(-100),
  updatedAt: Date.now()
});

// 从事件流推导作弊者名称：room.closed 原因含"作弊"。
// - 自动检测路径：不再踢人，作弊者姓名写在 close reason 分隔符之后。
// - 管理员手动封禁路径：保留踢人事件，取最后一条踢人事件的 targetName。
const deriveCheatBannedName = (envelopes: SignedEnvelope[]): string | null => {
  const closeEvent = envelopes.find((item) => item.event.type === "room.closed" && (item.event.reason ?? "").includes("作弊"))?.event as Extract<DuelEvent, { type: "room.closed" }> | undefined;
  if (!closeEvent) return null;
  let cheater: string | null = null;
  for (const item of envelopes) {
    const event = item.event;
    if (event.type === "player.kicked" && event.issuedAt <= closeEvent.issuedAt) {
      cheater = event.targetName ?? cheater;
    }
  }
  if (!cheater) {
    const sep = (closeEvent.reason ?? "").split(CHEAT_CLOSE_SEPARATOR);
    if (sep.length > 1) cheater = sep[1].trim() || null;
  }
  return cheater;
};

const compareEnvelopes = (a: SignedEnvelope, b: SignedEnvelope): number =>
  a.event.lamport - b.event.lamport || a.event.issuedAt - b.event.issuedAt || a.event.id.localeCompare(b.event.id);

// 高频变化的动态数据（用户评分/房间目录）禁止任何缓存（浏览器 + CDN）：
// 之前 /api/users 与 /api/users/:name 带 s-maxage=86400，打完比赛评分更新后，
// 排行榜/个人页仍被 CDN 缓存 24 小时、显示旧 rating。
const noStoreHeaders = (): HeadersInit => ({ "cache-control": "no-store" });

const isPlayingSeat = (seat: unknown): boolean => seat === "red" || seat === "blue";
const systemStartEnvelope = async (roomId: string, lamport: number, issuedAt: number): Promise<SignedEnvelope> => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const actorId = await keyId(publicKey);
  const event: DuelEvent = {
    type: "game.started",
    roomId,
    actorId,
    id: crypto.randomUUID(),
    lamport,
    issuedAt
  };
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, textBytes(stableStringify(event)));
  return { publicKey, event, signature: btoa(String.fromCharCode(...new Uint8Array(signature))) };
};

const systemJudgeEnvelope = async (roomId: string, lamport: number, issuedAt: number, record: FeedRecord): Promise<SignedEnvelope> => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const actorId = await keyId(publicKey);
  const event: DuelEvent = {
    type: "judge.recordSeen",
    roomId,
    actorId,
    id: crypto.randomUUID(),
    lamport,
    issuedAt,
    record
    // 不设 cheatExempt —— Manual Claim（包括 VJudge++ 插件调用）同样走全套作弊检测。
  };
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, textBytes(stableStringify(event)));
  return { publicKey, event, signature: btoa(String.fromCharCode(...new Uint8Array(signature))) };
};

const systemCloseEnvelope = async (roomId: string, lamport: number, issuedAt: number, reason = "已自动关闭", actorName = "gcend"): Promise<SignedEnvelope> => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const actorId = await keyId(publicKey);
  const event: DuelEvent = {
    type: "room.closed",
    roomId,
    actorId,
    id: crypto.randomUUID(),
    lamport,
    issuedAt,
    actorName,
    reason,
    system: true
  };
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, textBytes(stableStringify(event)));
  return { publicKey, event, signature: btoa(String.fromCharCode(...new Uint8Array(signature))) };
};

const systemKickEnvelope = async (roomId: string, lamport: number, issuedAt: number, targetId: string, targetName: string, reason: string): Promise<SignedEnvelope> => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const actorId = await keyId(publicKey);
  const event: DuelEvent = {
    type: "player.kicked",
    roomId,
    actorId,
    id: crypto.randomUUID(),
    lamport,
    issuedAt,
    targetId,
    targetName,
    reason,
    system: true,
    by: "System"
  };
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, textBytes(stableStringify(event)));
  return { publicKey, event, signature: btoa(String.fromCharCode(...new Uint8Array(signature))) };
};

// 以下 system 信封用于把房间内的封禁/禁言同步到全局 moderation 房间，
// 使"封禁和禁言都是全局的"在实时状态上生效（全局房间已支持 system 分支）。
const systemMuteEnvelope = async (roomId: string, lamport: number, issuedAt: number, targetId: string, targetName: string): Promise<SignedEnvelope> => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const actorId = await keyId(publicKey);
  const event: DuelEvent = {
    type: "player.muted",
    roomId,
    actorId,
    id: crypto.randomUUID(),
    lamport,
    issuedAt,
    targetId,
    targetName,
    system: true
  };
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, textBytes(stableStringify(event)));
  return { publicKey, event, signature: btoa(String.fromCharCode(...new Uint8Array(signature))) };
};

const systemUnmuteEnvelope = async (roomId: string, lamport: number, issuedAt: number, targetId: string, targetName: string): Promise<SignedEnvelope> => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const actorId = await keyId(publicKey);
  const event: DuelEvent = {
    type: "player.unmuted",
    roomId,
    actorId,
    id: crypto.randomUUID(),
    lamport,
    issuedAt,
    targetId,
    targetName,
    system: true
  };
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, textBytes(stableStringify(event)));
  return { publicKey, event, signature: btoa(String.fromCharCode(...new Uint8Array(signature))) };
};

const systemUnkickEnvelope = async (roomId: string, lamport: number, issuedAt: number, targetName: string): Promise<SignedEnvelope> => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const actorId = await keyId(publicKey);
  const event: DuelEvent = {
    type: "player.unkicked",
    roomId,
    actorId,
    id: crypto.randomUUID(),
    lamport,
    issuedAt,
    targetName,
    system: true
  };
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, textBytes(stableStringify(event)));
  return { publicKey, event, signature: btoa(String.fromCharCode(...new Uint8Array(signature))) };
};

const systemPlayerLeaveEnvelope = async (roomId: string, lamport: number, issuedAt: number, targetActorId: string): Promise<SignedEnvelope> => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const actorId = await keyId(publicKey);
  const event: DuelEvent = {
    type: "player.left",
    roomId,
    actorId: targetActorId,
    id: crypto.randomUUID(),
    lamport,
    issuedAt
  };
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, textBytes(stableStringify(event)));
  return { publicKey, event, signature: btoa(String.fromCharCode(...new Uint8Array(signature))) };
};

const systemPlayerReadyEnvelope = async (roomId: string, lamport: number, issuedAt: number, targetActorId: string, ready: boolean): Promise<SignedEnvelope> => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const signedById = await keyId(publicKey);
  const event: DuelEvent = {
    type: "player.readyChanged",
    roomId,
    actorId: targetActorId,
    id: crypto.randomUUID(),
    lamport,
    issuedAt,
    ready
  };
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, textBytes(stableStringify(event)));
  return { publicKey, event, signature: btoa(String.fromCharCode(...new Uint8Array(signature))) };
};

const keyId = async (publicKey: JsonWebKey): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", textBytes(stableStringify(publicKey)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 24);
};

const textBytes = (value: string): ArrayBuffer => {
  const encoded = new TextEncoder().encode(value);
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
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
const directoryFingerprint = (state: ReturnType<typeof createInitialState>): string => JSON.stringify({
  phase: state.phase,
  hostId: state.hostId,
  startedAt: state.startedAt,
  endedAt: state.endedAt,
  winner: state.winner,
  closed: state.closed,
  rated: state.rated,
  problemCount: state.problems.length,
  players: Object.values(state.players)
    .map((player) => [player.id, player.luoguName, player.team, player.online])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
});

const maintenanceHtml = (): string => `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VJudge Duel Maintenance</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1016;color:#eef4ff;font:16px/1.6 system-ui,sans-serif}
main{max-width:560px;padding:28px;border:1px solid #263241;border-radius:8px;background:#111820;box-shadow:0 20px 70px #0008}
h1{margin:0 0 8px;font-size:24px}p{margin:0;color:#a8b3c1}
</style>
<main><h1>VJudge Duel 维护中</h1><p>维护时间：2026-07-23 15:00-16:00。请勿重复刷新，维护完成后服务将自动恢复。</p></main>`;

const jsonError = (message: string, status: number): Response => Response.json({ error: message }, { status });
