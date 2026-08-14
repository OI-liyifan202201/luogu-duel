import type {
  ChatMessage,
  DuelEvent,
  DuelState,
  FeedRecord,
  JudgeStatus,
  ModerationRecord,
  Player,
  Problem,
  Seat,
  Team,
  Vote,
  VoteKind
} from "./types";

const statusRank: Record<JudgeStatus, number> = {
  OK: 0,
  WA: 1,
  TL: 2,
  RE: 3,
  CE: 4,
  MLE: 5,
  OLE: 6,
  UKE: 7,
  PD: 8
};

export const ADMIN_NAMES = new Set(["general0826", "slmxf", "liyifan202201", "gcend", "gcsg01","imzfx_square"]);
export const SYSTEM_CHAT_PREFIX = "@@vjudge-duel-system:";

export type SystemChatCommand =
  | { kind: "room.configured"; problems: Problem[]; rated?: boolean; minimumDifficulty?: number }
  | { kind: "player.joined"; luoguName: string; team: Seat }
  | { kind: "player.teamChanged"; team: Seat }
  | { kind: "player.readyChanged"; ready: boolean }
  | { kind: "game.started" }
  | { kind: "vote.opened"; vote: Omit<Vote, "approvals" | "rejections" | "status" | "createdAt"> }
  | { kind: "vote.cast"; voteId: string; approve: boolean }
  | { kind: "vote.cancelled"; voteId: string }
  | { kind: "judge.recordSeen"; record: FeedRecord };

export const encodeSystemChatCommand = (command: SystemChatCommand): string =>
  `${SYSTEM_CHAT_PREFIX}${encodeURIComponent(JSON.stringify(command))}`;

export const createInitialState = (roomId: string): DuelState => ({
  roomId,
  phase: roomId === "global" ? "home" : "lobby",
  rated: true,
  players: {},
  problems: [],
  chats: [],
  feed: [],
  votes: {},
  system: [],
  muted: {},
  kicked: {},
  banned: {},
  lamport: 0
});

export const normalizePid = (pid: string): string => {
  const trimmed = pid.trim().toUpperCase();
  return /^P\d{1,5}$/.test(trimmed) ? trimmed : "";
};

export const normalizeName = (name: string): string => name.trim().toLowerCase();
export const isAdminName = (name: string): boolean => ADMIN_NAMES.has(normalizeName(name));
export const privateChatViolation = (text: string): string | null => {
  const normalized = text.toLowerCase();
  if (/<\s*iframe\b|&lt;\s*iframe\b/i.test(text)) return "私信不能包含 iframe";
  if (normalized.includes("https://www.luogu.com.cn/api/verify/captcha")) return "私信不能包含该验证码地址";
  if(normalized.includes("shabi") || normalized.includes("sb") || normalized.includes("tamade") || normalized.includes("tmd") || normalized.includes("fuck"))
    return "不合适用于";

  return null;
};
export const isTeam = (team: Seat | undefined): team is Team => team === "red" || team === "blue";
export const teamName = (team: Seat | undefined): string =>
  team === "red" ? "红方" : team === "blue" ? "蓝方" : "观赛";

export const makeProblemSet = (count: number, seed: string, manualInput: string): Problem[] => {
  const manual = manualInput
    .split(/[\s,，]+/)
    .map(normalizePid)
    .filter(Boolean);

  if (manual.length > 0) {
    return manual.slice(0, count).map((pid, index) => ({ pid, score: scoreForIndex(index) }));
  }

  const used = new Set<string>();
  const problems: Problem[] = [];
  const rng = seeded(seed);
  while (problems.length < count) {
    const pid = `P${1000 + Math.floor(rng() * 16001)}`;
    if (!used.has(pid)) {
      used.add(pid);
      problems.push({ pid, score: scoreForIndex(problems.length) });
    }
  }
  return problems;
};

export const sortProblemsByDifficulty = (problems: Problem[]): Problem[] =>
  shuffledProblems(problems)
    .sort((a, b) => (a.difficulty ?? 99) - (b.difficulty ?? 99))
    .map((problem, index) => ({ ...problem, score: scoreForIndex(index) }));

export const applyEvents = (roomId: string, events: DuelEvent[]): DuelState =>
  events
    .filter((event) => event.roomId === roomId)
    .sort(compareEvents)
    .reduce(applyEvent, createInitialState(roomId));

export const applyEvent = (state: DuelState, event: DuelEvent): DuelState => {
  // A completed room is an archive. Ignore late or retried room events during replay.
  // 例外：system 作弊封禁的 room.closed / player.kicked 需要穿透——
  // 当作弊 AC 同时是制胜 AC 时，updateWinner 已将 phase 翻为 finished，
  // 但 system 封禁事件（踢人 + 关房）仍需覆盖胜利并执行惩罚。
  if (state.roomId !== "global" && state.phase === "finished"
    && !(event.type === "room.closed" && event.system)
    && !(event.type === "player.kicked" && event.system)) return state;
  const next = cloneState(state);
  next.lamport = Math.max(next.lamport, event.lamport);

  switch (event.type) {
    case "room.configured":
      configureRoom(next, event.actorId, event.problems, event.issuedAt, event.rated, event.minimumDifficulty);
      break;
    case "player.joined":
      joinPlayer(next, event.actorId, event.luoguName, event.team, event.issuedAt);
      break;
    case "player.teamChanged":
      if (next.players[event.actorId] && next.phase === "lobby" && !isRestricted(next, event.actorId) && !(next.hostId === event.actorId && event.team === "spectator")) {
        const team = next.phase === "lobby" ? event.team : "spectator";
        next.players[event.actorId].team = team;
        next.players[event.actorId].ready = false;
        pushSystem(next, `${nameOf(next, event.actorId)} 切换到 ${teamName(team)}`, event.issuedAt);
      }
      break;
    case "player.left":
      leavePlayer(next, event.actorId, event.issuedAt);
      break;
    case "player.readyChanged":
      if (next.players[event.actorId] && next.phase === "lobby" && isTeam(next.players[event.actorId].team) && !isRestricted(next, event.actorId)) {
        next.players[event.actorId].ready = event.ready;
      }
      break;
    case "game.started":
      if (canAcceptStart(next)) {
        next.phase = "arena";
        next.startedAt = event.issuedAt;
        pushSystem(next, `${matchTitle(next)} 开始`, event.issuedAt);
      }
      break;
    case "chat.sent":
      if (!applySystemChatCommand(next, event)) pushChat(next, event);
      break;
    case "vote.opened":
      openVote(next, event.vote, event.issuedAt, event.actorId);
      break;
    case "vote.cast":
      castVote(next, event.voteId, event.actorId, event.approve, event.issuedAt);
      break;
    case "vote.cancelled":
      cancelVote(next, event.voteId, event.actorId, event.issuedAt);
      break;
    case "judge.recordSeen":
      pushFeed(next, event.record);
      claimIfAccepted(next, event.record, event.id);
      break;
    case "room.closed":
      closeRoom(next, event);
      break;
    case "player.kicked":
      kickPlayer(next, event);
      break;
    case "player.unkicked":
      unkickPlayer(next, event.actorId, event.targetName, event.issuedAt, event.system);
      break;
    case "player.muted":
      mutePlayer(next, event.actorId, event.targetId, event.targetName, event.issuedAt, event.system);
      break;
    case "player.unmuted":
      unmutePlayer(next, event.actorId, event.targetId, event.targetName, event.issuedAt, event.system);
      break;
    case "room.muted":
      if (isRoomModerator(next, event.actorId) && !next.muted["__room__"]) {
        next.muted["__room__"] = true;
        pushSystem(next, "房间已开启全员禁言", event.issuedAt);
      }
      break;
    case "room.unmuted":
      if (isRoomModerator(next, event.actorId) && next.muted["__room__"]) {
        delete next.muted["__room__"];
        pushSystem(next, "房间已解除全员禁言", event.issuedAt);
      }
      break;
  }

  updateWinner(next, event.issuedAt);
  return next;
};

export const participants = (state: DuelState): Player[] =>
  Object.values(state.players).filter((player) => isTeam(player.team) && !isRestricted(state, player.id));

export const participantIds = (state: DuelState): string[] =>
  participants(state)
    .map((player) => player.id)
    .sort();

export const canStart = (state: DuelState): boolean => {
  const players = participants(state);
  return (
    state.phase === "lobby" &&
    state.problems.length > 0 &&
    players.length >= 2 &&
    players.every((p) => p.ready) &&
    players.some((p) => p.team === "red") &&
    players.some((p) => p.team === "blue")
  );
};

// Readiness is required before a host creates the start event, but not while
// replaying that already-created event: ready events can be ordered differently
// across clients with concurrent Lamport clocks.
export const canAcceptStart = (state: DuelState): boolean => {
  const players = participants(state);
  return (
    state.phase === "lobby" &&
    state.problems.length > 0 &&
    players.length >= 2 &&
    players.some((player) => player.team === "red") &&
    players.some((player) => player.team === "blue")
  );
};

export const canCloseRoom = (state: DuelState, actorId: string, actorName: string): boolean =>
  isAdminName(actorName) || (state.phase === "lobby" && state.hostId === actorId);

const isRoomModerator = (state: DuelState, actorId: string): boolean => {
  const player = state.players[actorId];
  return Boolean(player && (state.hostId === actorId || isAdminName(player.luoguName)));
};

export const visibleChats = (state: DuelState, viewerId: string): ChatMessage[] => {
  const viewer = state.players[viewerId];
  return state.chats.filter((chat) => chat.visibility === "all" || (isTeam(viewer?.team) && chat.team === viewer.team));
};

export const scoreOf = (state: DuelState, team: Team): number =>
  state.problems.reduce((sum, problem) => sum + (problem.solvedBy?.team === team ? problem.score : 0), 0);

export const winThreshold = (state: DuelState): number => {
  const raw = Math.ceil(state.problems.reduce((sum, problem) => sum + problem.score, 0) / 2);
  const ending = raw % 100;
  if (ending === 25) return raw + 25;
  if (ending === 75) return raw - 25;
  return raw;
};

export const requiredVoters = (state: DuelState, vote: Vote): string[] => {
  if (vote.kind === "surrender" && vote.team) {
    return participantIds(state).filter((id) => state.players[id]?.team === vote.team);
  }
  return participantIds(state);
};

export const createReplacementProblem = (state: DuelState, seed: string, targetPid: string): Problem => {
  const used = new Set(state.problems.map((p) => p.pid));
  const rng = seeded(`${seed}:${targetPid}:${state.problems.length}`);
  for (let attempt = 0; attempt < 5000; attempt += 1) {
    const pid = `P${1000 + Math.floor(rng() * 16001)}`;
    if (!used.has(pid)) {
      const old = state.problems.find((p) => p.pid === targetPid);
      return { pid, score: old?.score ?? scoreForIndex(state.problems.length) };
    }
  }
  return { pid: `P${17000 + state.problems.length + 1}`, score: scoreForIndex(state.problems.length) };
};

export const buildVote = (
  kind: VoteKind,
  proposer: Player,
  targetPid?: string,
  replacement?: Problem
): Omit<Vote, "approvals" | "rejections" | "status" | "createdAt"> => ({
  id: crypto.randomUUID(),
  kind,
  proposerId: proposer.id,
  team: kind === "surrender" && isTeam(proposer.team) ? proposer.team : undefined,
  targetPid,
  replacement
});

const configureRoom = (state: DuelState, actorId: string, problems: Problem[], at: number, rated = true, minimumDifficulty?: number) => {
  if (state.problems.length > 0 || problems.length === 0) return;
  state.hostId = state.hostId ?? actorId;
  state.rated = rated;
  state.minimumDifficulty = Number.isFinite(minimumDifficulty)
    ? Math.max(1, Math.min(8, Number(minimumDifficulty)))
    : problemDifficultyFloor(problems);
  state.problems = sortProblemsByDifficulty(problems);
  pushSystem(state, `房间题目已生成，共 ${problems.length} 题`, at);
};

const joinPlayer = (state: DuelState, actorId: string, luoguName: string, requestedSeat: Seat, at: number) => {
  const name = luoguName.trim() || shortId(actorId);
  const banned = state.banned[normalizeName(name)];
  const duplicateId = Object.values(state.players).find((player) => player.id !== actorId && normalizeName(player.luoguName) === normalizeName(name))?.id;
  const duplicate = duplicateId ? state.players[duplicateId] : undefined;
  if (duplicateId) {
    delete state.players[duplicateId];
    if (state.hostId === duplicateId) state.hostId = actorId;
    if (state.kicked[duplicateId]) {
      state.kicked[actorId] = state.kicked[duplicateId];
      delete state.kicked[duplicateId];
    }
    if (state.muted[duplicateId]) {
      state.muted[actorId] = true;
      delete state.muted[duplicateId];
    }
  }
  const joiningAsHost = state.roomId !== "global" && !state.hostId;
  const previous = state.players[actorId] ?? duplicate;
  const selectedTeam = previous?.team ?? requestedSeat;
  const team = banned
    ? "spectator"
    : state.phase !== "lobby"
      ? isTeam(previous?.team) ? previous.team : "spectator"
      : joiningAsHost && selectedTeam === "spectator" ? "red" : selectedTeam;
  state.hostId = state.hostId ?? actorId;
  state.players[actorId] = {
    id: actorId,
    luoguName: name,
    team,
    ready: team === "spectator" ? false : (state.players[actorId]?.ready ?? duplicate?.ready ?? false),
    online: !banned
  };
  if (banned) {
    state.kicked[actorId] = banned;
    pushSystem(state, `已阻止被封禁用户 ${name} 加入：${banned.reason}`, at);
  } else if (state.roomId !== "global" && team !== "spectator") {
    pushSystem(state, `${name} 加入 ${teamName(team)}`, at);
  }
};

const leavePlayer = (state: DuelState, actorId: string, at: number) => {
  const player = state.players[actorId];
  if (!player || state.phase === "finished") return;
  const leavingTeam = player.team;
  delete state.players[actorId];
  delete state.muted[actorId];
  delete state.kicked[actorId];
  if (state.hostId === actorId) state.hostId = Object.keys(state.players)[0];
  if (state.roomId !== "global" && leavingTeam !== "spectator") pushSystem(state, `${player.luoguName} 退出房间`, at);
  // 成员退出会改变法定人数：重新结算所有进行中的投票。
  // 例如 4/5 通过时若 2 人退出，剩余 3 人若已全部同意，应当立刻换题/平局/投降，
  // 而不能因为“离开”动作本身没有触发 settleVote 而让投票卡在“已通过但未生效”。
  for (const vote of Object.values(state.votes)) {
    if (vote.status !== "open") continue;
    delete vote.approvals[actorId];
    delete vote.rejections[actorId];
    settleVote(state, vote, at);
  }
  // 对方整队无人 -> 我方直接胜利
  if (state.phase === "arena") {
    const reds = Object.values(state.players).filter((entry) => entry.team === "red").length;
    const blues = Object.values(state.players).filter((entry) => entry.team === "blue").length;
    if (reds > 0 && blues === 0) {
      state.phase = "finished";
      state.endedAt = at;
      state.winner = "red";
      if (state.roomId !== "global") pushSystem(state, "蓝方已无人，红方直接获胜", at);
    } else if (blues > 0 && reds === 0) {
      state.phase = "finished";
      state.endedAt = at;
      state.winner = "blue";
      if (state.roomId !== "global") pushSystem(state, "红方已无人，蓝方直接获胜", at);
    }
  }
};

const applySystemChatCommand = (state: DuelState, event: Extract<DuelEvent, { type: "chat.sent" }>): boolean => {
  const command = decodeSystemChatCommand(event.text);
  if (!command) return false;
  switch (command.kind) {
    case "room.configured":
      configureRoom(state, event.actorId, command.problems, event.issuedAt, command.rated, command.minimumDifficulty);
      return true;
    case "player.joined":
      joinPlayer(state, event.actorId, command.luoguName, command.team, event.issuedAt);
      return true;
    case "player.teamChanged":
      if (state.players[event.actorId] && state.phase === "lobby" && !isRestricted(state, event.actorId) && !(state.hostId === event.actorId && command.team === "spectator")) {
        state.players[event.actorId].team = command.team;
        state.players[event.actorId].ready = false;
      }
      return true;
    case "player.readyChanged":
      if (state.players[event.actorId] && state.phase === "lobby" && isTeam(state.players[event.actorId].team) && !isRestricted(state, event.actorId)) {
        state.players[event.actorId].ready = command.ready;
      }
      return true;
    case "game.started":
      if (canAcceptStart(state)) {
        state.phase = "arena";
        state.startedAt = event.issuedAt;
        pushSystem(state, `${matchTitle(state)} 开始`, event.issuedAt);
      }
      return true;
    case "vote.opened":
      openVote(state, command.vote, event.issuedAt, event.actorId);
      return true;
    case "vote.cast":
      castVote(state, command.voteId, event.actorId, command.approve, event.issuedAt);
      return true;
    case "vote.cancelled":
      cancelVote(state, command.voteId, event.actorId, event.issuedAt);
      return true;
    case "judge.recordSeen":
      pushFeed(state, command.record);
      claimIfAccepted(state, command.record, event.id);
      return true;
  }
};

const decodeSystemChatCommand = (text: string): SystemChatCommand | null => {
  if (!text.startsWith(SYSTEM_CHAT_PREFIX)) return null;
  try {
    return JSON.parse(decodeURIComponent(text.slice(SYSTEM_CHAT_PREFIX.length))) as SystemChatCommand;
  } catch {
    return null;
  }
};

const pushChat = (state: DuelState, event: Extract<DuelEvent, { type: "chat.sent" }>) => {
  const player = state.players[event.actorId];
  if (!player || (state.muted["__room__"] && !isRoomModerator(state, event.actorId)) || isMutedPlayer(state, player) || isRestricted(state, event.actorId) || event.text.trim().length === 0) return;
  state.chats.push({
    id: event.id,
    actorId: event.actorId,
    luoguName: player.luoguName,
    team: player.team,
    visibility: event.visibility,
    text: event.text.trim().slice(0, 500),
    at: event.issuedAt
  });
};

const closeRoom = (state: DuelState, event: Extract<DuelEvent, { type: "room.closed" }>): void => {
  if (!event.system && !canCloseRoom(state, event.actorId, event.actorName)) return;
  if (state.phase === "finished" && !event.system) return;
  state.phase = "finished";
  state.endedAt = event.issuedAt;
  state.closed = { reason: event.reason.trim() || "房间已关闭", by: event.actorName, at: event.issuedAt };
  // system 作弊封禁覆盖已结束比赛：清除作弊 AC 产生的胜利，使该房间按"作弊取消"处理。
  if (event.system) state.winner = undefined;
  pushSystem(state, `房间已关闭：${state.closed.reason}`, event.issuedAt);
};

const kickPlayer = (state: DuelState, event: Extract<DuelEvent, { type: "player.kicked" }>): void => {
  const { actorId, targetId, targetName, reason, issuedAt: at, system, by } = event;
  const resolvedTargetId = state.players[targetId]
    ? targetId
    : Object.values(state.players).find((player) => normalizeName(player.luoguName) === normalizeName(targetName || ""))?.id;
  const target = resolvedTargetId ? state.players[resolvedTargetId] : undefined;
  const finalTargetName = target?.luoguName || targetName || targetId;
  if (system) {
    // 房主保护仅对真实比赛房间生效：global 大厅的 hostId 只是"历史上第一个进入大厅的人"，
    // 若目标恰好是该用户，全局封禁会被静默丢弃（表现为管理面板点封禁无反应）。
    if (state.roomId !== "global" && resolvedTargetId && state.hostId === resolvedTargetId) return;
    const record: ModerationRecord = {
      reason: `${reason.trim() || "系统封禁"}`,
      by: by ?? "System",
      at
    };
    state.kicked[resolvedTargetId ?? targetId] = record;
    state.banned[normalizeName(finalTargetName)] = record;
    if (target) {
      // 自动封禁：保留其原有座位（不强制移至观赛席），仅取消就绪/在线与禁言状态。
      target.ready = false;
      target.online = false;
      delete state.muted[target.id];
    }
    delete state.muted[`name:${normalizeName(finalTargetName)}`];
    pushSystem(state, `${finalTargetName} 已被 ${by ?? "System"} 封禁：${record.reason}`, at);
    return;
  }
  const actor = state.players[actorId];
  // global 大厅不设房主保护（hostId 无实际意义），且 resolvedTargetId 可能为 undefined，
  // `undefined === undefined` 会把封禁静默吞掉。
  if (!actor || (state.roomId !== "global" && resolvedTargetId && state.hostId === resolvedTargetId) || isAdminName(finalTargetName)) return;
  const lobbyKick = state.phase === "lobby" && (state.hostId === actorId || isAdminName(actor.luoguName));
  if (!lobbyKick && !isAdminName(actor.luoguName)) return;
  if (lobbyKick) {
    if (!target) return;
    delete state.players[resolvedTargetId!];
    delete state.muted[resolvedTargetId!];
    delete state.kicked[resolvedTargetId!];
    pushSystem(state, `${finalTargetName} 已被${state.hostId === actorId ? "房主" : "管理员"}移出准备房`, at);
    return;
  }
  const record: ModerationRecord = {
    reason: `${reason.trim() || "管理员封禁"}`,
    by: actor.luoguName,
    at
  };
  state.kicked[targetId] = record;
  state.banned[normalizeName(finalTargetName)] = record;
  if (target) {
    target.team = "spectator";
    target.ready = false;
    target.online = false;
    delete state.muted[target.id];
  }
  delete state.muted[`name:${normalizeName(finalTargetName)}`];
  pushSystem(state, `${finalTargetName} 已被 ${actor.luoguName} 封禁：${record.reason}`, at);
};

const unkickPlayer = (state: DuelState, actorId: string, targetName: string, at: number, system?: boolean) => {
  // system 信封（来自全局封禁的跨房间同步）无需管理员身份即可解除封禁。
  if (!system) {
    const actor = state.players[actorId];
    if (!actor || !isAdminName(actor.luoguName)) return;
  }
  const normalizedTarget = normalizeName(targetName);
  delete state.banned[normalizedTarget];
  for (const player of Object.values(state.players)) {
    if (normalizeName(player.luoguName) === normalizedTarget) {
      delete state.kicked[player.id];
      player.online = true;
    }
  }
  pushSystem(state, `${system ? "系统" : state.players[actorId]?.luoguName ?? "管理员"} 已解除 ${targetName} 的封禁`, at);
};

const mutePlayer = (state: DuelState, actorId: string, targetId: string, targetName: string | undefined, at: number, system?: boolean) => {
  const actor = state.players[actorId];
  const target = state.players[targetId];
  const finalTargetName = target?.luoguName || targetName || targetId;
  // system 信封（来自全局禁言的跨房间同步）无需管理员身份即可执行。
  if (!system && (!actor || !isAdminName(actor.luoguName) || isAdminName(finalTargetName))) return;
  if (system && isAdminName(finalTargetName)) return;
  state.muted[targetId] = true;
  state.muted[`name:${normalizeName(finalTargetName)}`] = true;
  pushSystem(state, `${finalTargetName} 已被 ${system ? "系统" : actor.luoguName} 禁言`, at);
};

const unmutePlayer = (state: DuelState, actorId: string, targetId: string, targetName: string | undefined, at: number, system?: boolean) => {
  const actor = state.players[actorId];
  const target = state.players[targetId];
  const finalTargetName = target?.luoguName || targetName || targetId;
  if (!system && (!actor || !isAdminName(actor.luoguName))) return;
  delete state.muted[targetId];
  delete state.muted[`name:${normalizeName(finalTargetName)}`];
  pushSystem(state, `${system ? "系统" : actor.luoguName} 已解除 ${finalTargetName} 的禁言`, at);
};

const openVote = (
  state: DuelState,
  voteInput: Omit<Vote, "approvals" | "rejections" | "status" | "createdAt">,
  createdAt: number,
  actorId: string
) => {
  if (!isTeam(state.players[actorId]?.team) || isRestricted(state, actorId) || state.votes[voteInput.id]) return;
  // Auto-deduplicate: never open a second vote of the same kind that is still open.
  // draw -> one open draw proposal per room; surrender -> one per team;
  // replace/delete-problem -> one per target problem.
  if (Object.values(state.votes).some((vote) => vote.status === "open" && vote.kind === voteInput.kind && (
    voteInput.kind === "replace-problem" || voteInput.kind === "delete-problem"
      ? vote.targetPid === voteInput.targetPid
      : voteInput.kind === "surrender"
        ? vote.team === voteInput.team
        : true
  ))) return;
  const vote: Vote = {
    ...voteInput,
    approvals: { [actorId]: true },
    rejections: {},
    status: "open",
    createdAt
  };
  state.votes[vote.id] = vote;
  pushSystem(state, vote.kind === "surrender" ? `${teamName(vote.team)}发起投降` : `${nameOf(state, actorId)} 发起${voteLabel(vote)}`, createdAt);
  settleVote(state, vote, createdAt);
};

const castVote = (state: DuelState, voteId: string, actorId: string, approve: boolean, at: number) => {
  const vote = state.votes[voteId];
  if (!vote || vote.status !== "open" || !requiredVoters(state, vote).includes(actorId)) return;
  if (approve) {
    vote.approvals[actorId] = true;
    delete vote.rejections[actorId];
  } else {
    vote.rejections[actorId] = true;
    vote.status = "rejected";
    pushSystem(state, `${nameOf(state, actorId)} 拒绝${voteLabel(vote)}`, at);
  }
  settleVote(state, vote, at);
};

const cancelVote = (state: DuelState, voteId: string, actorId: string, at: number) => {
  const vote = state.votes[voteId];
  if (!vote || vote.status !== "open" || vote.proposerId !== actorId) return;
  vote.status = "cancelled";
  pushSystem(state, `${nameOf(state, actorId)} 取消${voteLabel(vote)}`, at);
};

const settleVote = (state: DuelState, vote: Vote, at: number) => {
  if (vote.status !== "open") return;
  const voters = requiredVoters(state, vote);
  if (voters.length === 0 || !voters.every((id) => vote.approvals[id])) return;
  vote.status = "passed";
  if (vote.kind === "replace-problem" && vote.targetPid && vote.replacement) {
    const replacement = vote.replacement;
    state.problems = sortProblemsByDifficulty(state.problems.map((p) => (p.pid === vote.targetPid ? { ...replacement } : p)));
    pushSystem(state, `${vote.targetPid} 已更换为 ${replacement.pid}`, at);
  }
  if (vote.kind === "delete-problem" && vote.targetPid) {
    state.problems = sortProblemsByDifficulty(state.problems.filter((p) => p.pid !== vote.targetPid));
    pushSystem(state, `${vote.targetPid} 已删除`, at);
  }
  if (vote.kind === "draw") {
    state.phase = "finished";
    state.endedAt = at;
    state.winner = "draw";
    pushSystem(state, "双方同意平局", at);
  }
  if (vote.kind === "surrender" && vote.team) {
    state.phase = "finished";
    state.endedAt = at;
    state.winner = vote.team === "red" ? "blue" : "red";
    pushSystem(state, `${teamName(vote.team)} 投降`, at);
  }
};

const pushFeed = (state: DuelState, record: FeedRecord) => {
  const existing = state.feed.findIndex((item) => item.recordId === record.recordId && item.pid === record.pid);
  if (existing >= 0) {
    if (state.feed[existing].status === record.status && state.feed[existing].at === record.at) return;
    state.feed[existing] = record;
  } else {
    state.feed.push(record);
  }
  state.feed.sort(
    (a, b) =>
      b.at - a.at ||
      statusRank[a.status] - statusRank[b.status] ||
      a.luoguName.localeCompare(b.luoguName) ||
      a.pid.localeCompare(b.pid)
  );
  state.feed = state.feed.slice(0, 120);
};

const claimIfAccepted = (state: DuelState, record: FeedRecord, eventId: string) => {
  if (record.status !== "OK") return;
  const player = Object.values(state.players).find((p) => p.luoguName === record.luoguName);
  const problem = state.problems.find((p) => p.pid === record.pid);
  if (!player || !problem || !isTeam(player.team)) return;
  const candidate = {
    team: player.team,
    playerId: player.id,
    luoguName: player.luoguName,
    recordId: record.recordId || eventId,
    at: record.at
  };
  const current = problem.solvedBy;
  if (!current || candidate.at < current.at || (candidate.at === current.at && candidate.recordId < current.recordId)) {
    problem.solvedBy = candidate;
    pushSystem(state, `${teamName(player.team)} ${player.luoguName} 抢占 ${record.pid}`, record.at);
  }
};

const updateWinner = (state: DuelState, at: number) => {
  if (state.phase === "finished" || state.problems.length === 0) return;
  const threshold = winThreshold(state);
  if (scoreOf(state, "red") >= threshold) {
    state.phase = "finished";
    state.endedAt = at;
    state.winner = "red";
  }
  if (scoreOf(state, "blue") >= threshold) {
    state.phase = "finished";
    state.endedAt = at;
    state.winner = "blue";
  }
};

const compareEvents = (a: DuelEvent, b: DuelEvent): number =>
  a.lamport - b.lamport || a.issuedAt - b.issuedAt || a.id.localeCompare(b.id);

const cloneState = (state: DuelState): DuelState => ({
  ...state,
  closed: state.closed ? { ...state.closed } : undefined,
  players: Object.fromEntries(Object.entries(state.players).map(([id, p]) => [id, { ...p }])),
  problems: state.problems.map((problem) => ({
    ...problem,
    solvedBy: problem.solvedBy ? { ...problem.solvedBy } : undefined
  })),
  chats: [...state.chats],
  feed: [...state.feed],
  votes: Object.fromEntries(
    Object.entries(state.votes).map(([id, vote]) => [
      id,
      {
        ...vote,
        replacement: vote.replacement ? { ...vote.replacement } : undefined,
        approvals: { ...vote.approvals },
        rejections: { ...vote.rejections }
      }
    ])
  ),
  system: state.system.map((message) => ({ ...message })),
  muted: { ...state.muted },
  kicked: cloneModerationMap(state.kicked),
  banned: cloneModerationMap(state.banned)
});

const cloneModerationMap = (map: Record<string, ModerationRecord>): Record<string, ModerationRecord> =>
  Object.fromEntries(Object.entries(map).map(([key, value]) => [key, { ...value }]));

const pushSystem = (state: DuelState, text: string, at: number) => {
  const last = state.system[state.system.length - 1];
  if (last && last.text === text) return;
  state.system.push({
    id: `${at}:${state.system.length}:${text}`,
    text,
    at
  });
};

const isRestricted = (state: DuelState, id: string): boolean => {
  const player = state.players[id];
  return Boolean(state.kicked[id] || (player && state.banned[normalizeName(player.luoguName)]));
};

const isMutedPlayer = (state: DuelState, player: Player): boolean =>
  Boolean(state.muted[player.id] || state.muted[`name:${normalizeName(player.luoguName)}`]);

const scoreForIndex = (index: number): number => 100 + index * 50;

const problemDifficultyFloor = (problems: Problem[]): number | undefined => {
  const levels = problems.map((problem) => Number(problem.difficulty)).filter((level) => Number.isFinite(level));
  return levels.length ? Math.min(...levels) : undefined;
};

const shuffledProblems = (problems: Problem[]): Problem[] => {
  const identity = problems
    .map((problem) => `${problem.platform ?? "luogu"}:${problem.pid}:${problem.difficulty ?? 99}`)
    .sort()
    .join("|");
  const rng = seeded(`problem-order:${identity}`);
  const shuffled = [...problems];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const target = Math.floor(rng() * (index + 1));
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  return shuffled;
};

const seeded = (seed: string): (() => number) => {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const matchTitle = (state: DuelState): string => {
  const red = participants(state)
    .filter((p) => p.team === "red")
    .map((p) => p.luoguName)
    .join(" / ");
  const blue = participants(state)
    .filter((p) => p.team === "blue")
    .map((p) => p.luoguName)
    .join(" / ");
  return `${red || "红方"} vs ${blue || "蓝方"}`;
};

const voteLabel = (vote: Pick<Vote, "kind" | "targetPid">): string => {
  if (vote.kind === "replace-problem") return `换题 ${vote.targetPid}`;
  if (vote.kind === "delete-problem") return `删题 ${vote.targetPid}`;
  if (vote.kind === "draw") return "平局";
  return "投降";
};

const nameOf = (state: DuelState, id: string): string => state.players[id]?.luoguName ?? shortId(id);
const shortId = (id: string): string => id.slice(0, 6);
