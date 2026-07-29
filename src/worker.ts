/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";
import { applyEvent, applyEvents, canStart, createInitialState, isTeam, privateChatViolation } from "./domain";
import type { DuelEvent, FeedRecord, Problem, SignedEnvelope } from "./types";

type Env = {
  DUEL_ROOM: DurableObjectNamespace<DuelRoom>;
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

export class DuelRoom extends DurableObject<Env> {
  private eventsCache: SignedEnvelope[] | null = null;
  private eventIds = new Set<string>();
  private cachedState = createInitialState("");
  private firstEvent: DuelEvent | null = null;
  private roomSecret: string | null = null;
  // 比赛开始的服务器时间戳。detectCheatAndBan 用它而非客户端 startedAt 计算 elapsed，
  // 避免"VJudge 提交时间(record.at) vs 客户端比赛开始时间"跨时钟比较在客户端时钟偏慢时
  // 把 30s AC 算成 >=180s 从而漏判。服务端(Cloudflare)与 VJudge 均为 NTP 同步，偏差很小。
  private matchStartServerMs: number | null = null;
  // 作弊检测广播顺序锁：在 detectCheatAndBan 中，kick 必须先于 close 广播到客户端。
  // 若 acceptEnvelope(kick) 内部触发了 auto-close，这里标记后由 detectCheatAndBan 统一广播。
  private _inCheatDetection = false;
  private _autoCloseEnvelope: SignedEnvelope | null = null;
  private listingsCache: Map<string, RoomListing> | null = null;
  private usersCache: Map<string, UserRecord> | null = null;
  private bannedUsersCache: Set<string> | null = null;
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
    // 作弊检测：比赛进行中，过快 AC（按题目难度）或同一人两次 AC 间隔过短，由 System 直接封禁。
    // 用 previousPhase 而非当前 phase：若作弊 AC 同时是制胜 AC，applyEvent 内的 updateWinner
    // 会先把 phase 翻成 finished，此时仍需检测并在下方 detectCheatAndBan 里覆盖胜利。
    if (event.type === "judge.recordSeen") {
      console.log(`[acceptEnvelope] judge.recordSeen: previousPhase=${previousPhase}, currentPhase=${this.cachedState.phase}, ` +
        `recordStatus=${event.record.status}, recordAt=${event.record.at}, ` +
        `stateStartedAt=${this.cachedState.startedAt}, willCallDetect=${event.roomId !== "global" && previousPhase === "arena"}`);
    }
    if (event.roomId !== "global" && event.type === "judge.recordSeen" && previousPhase === "arena") {
      await this.detectCheatAndBan(event);
    }
    // 记录比赛开始的服务器时间，供 detectCheatAndBan 跨时钟稳健地计算 elapsed。
    if (event.roomId !== "global" && event.type === "game.started" && this.cachedState.phase === "arena") {
      this.matchStartServerMs = Date.now();
    }
    // 比赛进行中（arena）任意封禁 => 直接取消对决，由 directory 落地惩罚。
    if (event.roomId !== "global" && event.type === "player.kicked" && this.cachedState.phase === "arena") {
      const closeEnvelope = await systemCloseEnvelope(
        this.cachedState.roomId,
        this.cachedState.lamport + 1,
        Date.now(),
        "检测到作弊，对决取消"
      );
      const savedClose = await this.acceptEnvelope(closeEnvelope);
      // 作弊检测流程中，kick 必须先于 close 广播。此处只暂存 close，由 detectCheatAndBan 在 kick 广播后统一发出。
      if (savedClose && this._inCheatDetection) {
        this._autoCloseEnvelope = closeEnvelope;
      } else if (savedClose) {
        this.broadcast({ type: "event", envelope: closeEnvelope });
      }
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

  private async detectCheatAndBan(event: Extract<DuelEvent, { type: "judge.recordSeen" }>): Promise<void> {
    const record = event.record;
    if (record.status !== "OK" || event.cheatExempt) {
      if (record.status !== "OK") console.log(`[detectCheatAndBan] skip: status=${record.status}, cheater=${record.luoguName}, pid=${record.pid}`);
      return;
    }
    const state = this.cachedState;
    // 优先用服务器端记录的开赛时间，规避客户端时钟与 VJudge 时钟偏移导致的 elapsed 误算。
    const startedAt = this.matchStartServerMs ?? state.startedAt ?? 0;
    const player = Object.values(state.players).find((item) => normalizeName(item.luoguName) === normalizeName(record.luoguName));
    if (!player || !isTeam(player.team)) {
      console.log(`[detectCheatAndBan] skip: player=${!!player}, team=${player?.team}, cheater=${record.luoguName}`);
      return;
    }
    const problem = state.problems.find((item) => item.pid.toLowerCase() === record.pid.toLowerCase());
    const minMs = minSolveMsForDifficulty(problem?.difficulty);
    const elapsed = record.at - startedAt;
    const tooFastFromStart = minMs > 0 && elapsed >= 0 && elapsed < minMs;
    console.log(`[detectCheatAndBan] cheater=${record.luoguName}, pid=${record.pid}, difficulty=${problem?.difficulty}, ` +
      `recordAt=${record.at}, startedAt=${startedAt}, matchStartServerMs=${this.matchStartServerMs}, ` +
      `elapsed=${elapsed}ms, minMs=${minMs}ms, tooFastFromStart=${tooFastFromStart}`);
    let lastOkAt: number | null = null;
    for (const feed of state.feed) {
      // 同一玩家（不限队伍）的历史 AC 记录。
      if (normalizeName(feed.luoguName) === normalizeName(record.luoguName) && feed.status === "OK" && feed.at < record.at) {
        if (lastOkAt === null || feed.at > lastOkAt) lastOkAt = feed.at;
      }
    }
    // 同一玩家两次 AC 间隔过短（按题目难度最短时间映射，不再固定 60s）即判定作弊。
    const tooFastConsecutive = minMs > 0 && lastOkAt !== null && record.at - lastOkAt < minMs;
    if (!tooFastFromStart && !tooFastConsecutive) {
      console.log(`[detectCheatAndBan] NOT triggered: tooFastFromStart=${tooFastFromStart}, tooFastConsecutive=${tooFastConsecutive}, ` +
        `lastOkAt=${lastOkAt}, consecutiveGap=${lastOkAt !== null ? record.at - lastOkAt : "N/A"}`);
      return;
    }
    console.log(`[detectCheatAndBan] CHEAT DETECTED: cheater=${record.luoguName}, will ban now`);
    const reason = "自动检测——作弊";
    const kickEnvelope = await systemKickEnvelope(
      this.cachedState.roomId,
      this.cachedState.lamport + 1,
      Date.now(),
      player.id,
      player.luoguName,
      reason
    );
    this._inCheatDetection = true;
    this._autoCloseEnvelope = null;
    const savedKick = await this.acceptEnvelope(kickEnvelope);
    this._inCheatDetection = false;
    if (savedKick) this.broadcast({ type: "event", envelope: kickEnvelope });
    if (this._autoCloseEnvelope) {
      this.broadcast({ type: "event", envelope: this._autoCloseEnvelope });
      this._autoCloseEnvelope = null;
    } else if (!this.cachedState.closed) {
      const closeEnvelope = await systemCloseEnvelope(
        this.cachedState.roomId,
        this.cachedState.lamport + 1,
        Date.now(),
        "检测到作弊，对决取消"
      );
      const savedClose = await this.acceptEnvelope(closeEnvelope);
      if (savedClose) this.broadcast({ type: "event", envelope: closeEnvelope });
    }
  }

  async alarm(): Promise<void> {
    if (await this.isDirectoryObject()) {
      await this.pruneDirectory();
      await this.ctx.storage.setAlarm(Date.now() + DIRECTORY_PRUNE_INTERVAL_MS);
      this.broadcastDirectory();
      return;
    }
    await this.expireStaleLobby();
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
      return Response.json({ rooms: this.listRooms() }, { headers: cacheHeaders(60, 24 * 60 * 60) });
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
    return Response.json({ users: this.listUsers() }, { headers: cacheHeaders(60, 24 * 60 * 60) });
  }

  private async handleUser(request: Request, rawName: string): Promise<Response> {
    const name = rawName.trim();
    if (!name) return jsonError("missing name", 400);
    if (request.method === "GET") {
      const user = this.readUser(name);
      return user ? Response.json({ user }, { headers: cacheHeaders(60, 24 * 60 * 60) }) : jsonError("not found", 404);
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
    const banEvents = this.eventsCache!.filter((item) =>
      item.event.type === "player.kicked" && activeBans.has(normalizeName(item.event.targetName || ""))
    );
    const banActors = new Set(banEvents.map((item) => item.event.actorId));
    return this.eventsCache!.filter((item) =>
      (item.event.type === "player.joined" && banActors.has(item.event.actorId)) || banEvents.includes(item)
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

    // 作弊封禁：作弊者 Rating 清零，其余参赛者每人 +10 Rating，并对作弊者执行全局封禁。
    if (listing.cheatBanned && listing.cheaterName) {
      this.applyCheatResult(listing);
      this.ctx.storage.sql.exec("INSERT INTO processed_results (room_id, processed_at) VALUES (?, ?)", listing.roomId, Date.now());
      this.processedResultsCache!.add(listing.roomId);
      this.writeSnapshot("processed-results", [...this.processedResultsCache!]);
      await this.enforceGlobalCheatBan(listing.cheaterName);
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

  private applyCheatResult(listing: RoomListing): void {
    const cheaterName = (listing.cheaterName ?? "").trim();
    if (!cheaterName) return;
    const cheaterKey = normalizeName(cheaterName);
    // 作弊者 Rating 重置为 0（必须在写入 banned_users 之前完成，writeUser 会拒绝已封禁用户）。
    this.writeUser(applyCheatPenalty(this.upsertUser({ name: cheaterName })));
    const others = dedupeNames([...(listing.redPlayers ?? []), ...(listing.bluePlayers ?? [])])
      .filter((name) => normalizeName(name) !== cheaterKey);
    for (const name of others) {
      this.writeUser(applyCheatCompensation(this.upsertUser({ name })));
    }
  }

  // 对作弊者发布全局（global 房间）系统封禁事件，使其返回主界面时持续看到封禁遮罩，
  // 并阻止其再次创建/加入房间。rating 清零已在 applyCheatResult 中完成。
  private async enforceGlobalCheatBan(cheaterName: string): Promise<void> {
    try {
      const reason = "自动检测——作弊";
      const now = Date.now();
      const envelope = await systemKickEnvelope("global", now, now, `name:${normalizeName(cheaterName)}`, cheaterName, reason);
      const response = await this.env.DUEL_ROOM.getByName("global:public-lobby").fetch("https://duel.internal/event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ envelope })
      });
      if (!response.ok) throw new Error(`global ban returned ${response.status}`);
    } catch {
      // Rating 惩罚已落地；全局封禁失败仅影响主页遮罩，不影响本场清理。
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
    if (url.pathname === "/api/auth/vjudge/verify" && request.method === "POST") return verifyVJudgeLogin(request, env);
    const problemBankMatch = url.pathname.match(/^\/api\/problem-bank\/(luogu|codeforces|atcoder)$/);
    if (problemBankMatch && request.method === "GET") {
      return proxyProblemBank(request, problemBankMatch[1] as ProblemBankSource, ctx);
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

    const assetResponse = await env.ASSETS.fetch(request);
    if (request.method !== "GET" || !assetResponse.ok) return assetResponse;
    const pathname = new URL(request.url).pathname;
    const headers = new Headers(assetResponse.headers);
    if (pathname === "/" || pathname.endsWith(".html")) {
      headers.set("cache-control", "no-store");
    } else {
      headers.set("cache-control", "public, max-age=0, must-revalidate, s-maxage=86400, stale-while-revalidate=604800");
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
    const publicUrl = new URL(request.url);
    publicUrl.search = "";
    const cacheKey = new Request(publicUrl.toString(), { method: "GET" });
    const cache = (caches as CacheStorage & { default: Cache }).default;
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const response = await env.DUEL_ROOM.getByName("__directory").fetch(internalUrl);
    if (!response.ok) return jsonError(`directory returned ${response.status}`, response.status);
    const payload = await response.json();
    const body = JSON.stringify(payload);
    const complete = new Response(body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-length": String(new TextEncoder().encode(body).byteLength),
        "cache-control": "public, max-age=20, s-maxage=20, stale-while-revalidate=20"
      }
    });
    await cache.put(cacheKey, complete.clone());
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
  if (!new Set(["GET", "POST", "DELETE"]).has(request.method)) return jsonError("method not allowed", 405);
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

// 作弊惩罚：Rating 直接清零（不改动胜负场次，比赛已取消）。
const applyCheatPenalty = (user: UserRecord): UserRecord => ({
  ...user,
  rating: 0,
  ratingHistory: [...(user.ratingHistory?.length ? user.ratingHistory : [{ at: user.updatedAt, rating: user.rating }]), { at: Date.now(), rating: 0 }].slice(-100),
  updatedAt: Date.now()
});

// 作弊补偿：其余参赛者每人 +10 Rating（不计入胜负场次）。
const applyCheatCompensation = (user: UserRecord): UserRecord => ({
  ...user,
  rating: user.rating + 10,
  ratingHistory: [...(user.ratingHistory?.length ? user.ratingHistory : [{ at: user.updatedAt, rating: user.rating }]), { at: Date.now(), rating: user.rating + 10 }].slice(-100),
  updatedAt: Date.now()
});

// 从事件流推导作弊者名称：room.closed 原因含"作弊"，取其之前最后一条 system 踢人事件的 targetName。
const deriveCheatBannedName = (envelopes: SignedEnvelope[]): string | null => {
  const closeEvent = envelopes.find((item) => item.event.type === "room.closed" && (item.event.reason ?? "").includes("作弊"))?.event as Extract<DuelEvent, { type: "room.closed" }> | undefined;
  if (!closeEvent) return null;
  let cheater: string | null = null;
  for (const item of envelopes) {
    const event = item.event;
    if (event.type === "player.kicked" && event.system && event.issuedAt <= closeEvent.issuedAt) {
      cheater = event.targetName ?? cheater;
    }
  }
  return cheater;
};

const compareEnvelopes = (a: SignedEnvelope, b: SignedEnvelope): number =>
  a.event.lamport - b.event.lamport || a.event.issuedAt - b.event.issuedAt || a.event.id.localeCompare(b.event.id);

const cacheHeaders = (_browserMaxAge: number, edgeMaxAge = _browserMaxAge): HeadersInit => ({
  "cache-control": `public, max-age=0, must-revalidate, s-maxage=${edgeMaxAge}, stale-while-revalidate=${edgeMaxAge * 4}`
});

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
