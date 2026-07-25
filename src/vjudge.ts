import type { FeedRecord, JudgeStatus, Problem } from "./types";

type StatusRow = {
  userId: number | string;
  userName: string;
  status: string;
  time: number;
  runId: number | string;
};

export const fetchVJudgeRecords = async (problem: Problem, users: string[], startedAt: number, requester: string): Promise<FeedRecord[]> => {
  const url = new URL("/api/vjudge/status", location.origin);
  url.searchParams.set("oj", vjudgeOj(problem));
  url.searchParams.set("problem", problem.pid);
  url.searchParams.set("since", String(startedAt));
  url.searchParams.set("requester", requester);
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
  const payload = (await response.json().catch(() => ({}))) as { data?: StatusRow[]; error?: string };
  if (!response.ok) throw new Error(payload.error || `VJudge status request failed: ${response.status}`);
  const names = new Map(users.map((name) => [name.trim().toLowerCase(), name]));
  return (payload.data ?? []).flatMap((row) => {
    const matchedName = names.get(row.userName.trim().toLowerCase());
    if (!matchedName || row.time < startedAt) return [];
    return [{
      id: `vjudge:${row.runId || row.userId}:${problem.platform ?? "luogu"}:${problem.pid}`,
      luoguName: matchedName,
      pid: problem.pid,
      at: row.time,
      status: normalizeVJudgeStatus(row.status),
      recordId: String(row.runId || `${row.userId}:${row.time}`)
    }];
  }).sort((a, b) => Number(a.status !== "OK") - Number(b.status !== "OK") || a.at - b.at || a.recordId.localeCompare(b.recordId));
};

const vjudgeOj = (problem: Problem): string =>
  problem.platform === "atcoder" ? "AtCoder" : problem.platform === "codeforces" ? "CodeForces" : "洛谷";

const normalizeVJudgeStatus = (status: string): JudgeStatus => {
  const normalized = status.trim().toLowerCase();
  if (normalized === "accepted") return "OK";
  if (normalized.includes("wrong answer")) return "WA";
  if (normalized.includes("time limit")) return "TL";
  if (normalized.includes("runtime error")) return "RE";
  if (normalized.includes("compilation error")) return "CE";
  if (normalized.includes("memory limit")) return "MLE";
  if (normalized.includes("output limit")) return "OLE";
  if (normalized.includes("pending") || normalized.includes("running") || normalized.includes("judging") || normalized.includes("processing")) return "PD";
  return "UKE";
};
