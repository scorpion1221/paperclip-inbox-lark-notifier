import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import pino from "pino";
import { WebSocket } from "ws";
import { z } from "zod";

const RELEVANT_ISSUE_ACTIONS = [
  "issue.created",
  "issue.updated",
  "issue.comment_added",
  "issue.read_marked",
  "issue.read_unmarked",
  "issue.inbox_archived",
  "issue.inbox_unarchived",
] as const;

const RELEVANT_ISSUE_ACTION_SET = new Set<string>(RELEVANT_ISSUE_ACTIONS);
const LOCAL_INBOX_ACTION_SET = new Set<string>([
  "issue.read_marked",
  "issue.read_unmarked",
  "issue.inbox_archived",
  "issue.inbox_unarchived",
]);
const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

const inboxIssueSchema = z.object({
  id: z.string().min(1),
  identifier: z.string().nullable().optional(),
  title: z.string(),
  status: z.string(),
  priority: z.string(),
  updatedAt: z.string(),
  lastActivityAt: z.string().nullable().optional(),
  isUnreadForMe: z.boolean().optional(),
});

const inboxIssuesResponseSchema = z.array(inboxIssueSchema);

const liveEventSchema = z.object({
  id: z.number(),
  companyId: z.string(),
  type: z.string(),
  createdAt: z.string(),
  payload: z.record(z.unknown()),
  actorType: z.string().optional(),
  actorId: z.string().optional(),
});

const issueCommentSchema = z.object({
  id: z.string().min(1),
  body: z.string(),
  createdAt: z.string(),
});

const issueCommentsResponseSchema = z.array(issueCommentSchema);

const webhookDestinationSchema = z.object({
  type: z.literal("webhook"),
  webhookUrl: z.string().url(),
  mentionOpenId: z.string().min(1).optional(),
});

const receiveIdDestinationSchema = z.object({
  type: z.union([z.literal("open_id"), z.literal("chat_id")]),
  receiveId: z.string().min(1),
});

const larkDestinationSchema = z.union([webhookDestinationSchema, receiveIdDestinationSchema]);

const companyConfigSchema = z.object({
  companyId: z.string().min(1),
  companyName: z.string().min(1).optional(),
  agentApiKey: z.string().min(1),
  paperclipBaseUrl: z.string().url().optional(),
  destinationsByUserId: z.record(z.string().min(1), larkDestinationSchema),
});

const notifierConfigBaseSchema = z.object({
  apiUrl: z.string().url(),
  companyId: z.string().optional().default(""),
  companyName: z.string().min(1).optional(),
  agentApiKey: z.string().optional().default(""),
  paperclipBaseUrl: z.string().url(),
  dryRun: z.boolean().default(false),
  logLevel: z.enum(LOG_LEVELS).default("info"),
  destinationsByUserId: z.record(z.string().min(1), larkDestinationSchema).optional().default({}),
  larkAppId: z.string().min(1).optional(),
  larkAppSecret: z.string().min(1).optional(),
  companies: z.array(companyConfigSchema).optional(),
  requestTimeoutMs: z.number().int().positive().default(10_000),
  reconnectBaseMs: z.number().int().positive().default(1_000),
  reconnectMaxMs: z.number().int().positive().default(30_000),
  deliveryRetryCount: z.number().int().min(0).default(3),
  deliveryRetryBaseMs: z.number().int().positive().default(1_000),
  deliveryRetryMaxMs: z.number().int().positive().default(8_000),
  pollIntervalMs: z.number().int().positive().default(30_000),
  pingIntervalMs: z.number().int().positive().default(30_000),
  pingTimeoutMs: z.number().int().positive().default(10_000),
  createdVisibilityRetryCount: z.number().int().min(0).default(6),
  createdVisibilityRetryBaseMs: z.number().int().positive().default(500),
  createdVisibilityRetryMaxMs: z.number().int().positive().default(4_000),
});

const notifierConfigSchema = notifierConfigBaseSchema.superRefine((value, ctx) => {
  const hasCompanies = value.companies && value.companies.length > 0;
  const hasLegacy = Boolean(value.companyId) && Boolean(value.agentApiKey) && Object.keys(value.destinationsByUserId).length > 0;

  if (!hasCompanies && !hasLegacy) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["companies"],
      message:
        "Either 'companies' array must be non-empty, or legacy single-company fields (companyId, agentApiKey, destinationsByUserId) must be provided.",
    });
  }

  // Collect all destinations across all companies + legacy
  const allDestinations: z.infer<typeof larkDestinationSchema>[] = [];
  if (hasLegacy) {
    allDestinations.push(...Object.values(value.destinationsByUserId));
  }
  if (value.companies) {
    for (const company of value.companies) {
      allDestinations.push(...Object.values(company.destinationsByUserId));
    }
  }

  const needsBotCredentials = allDestinations.some(
    (destination) => destination.type === "open_id" || destination.type === "chat_id",
  );

  if (needsBotCredentials && (!value.larkAppId || !value.larkAppSecret)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["larkAppId"],
      message: "Lark app credentials are required for open_id/chat_id destinations.",
    });
  }
});

const partialNotifierConfigSchema = notifierConfigBaseSchema.partial();

export type RelevantIssueAction = (typeof RELEVANT_ISSUE_ACTIONS)[number];
export type InboxIssueSummary = z.infer<typeof inboxIssueSchema>;
export type IssueCommentSummary = z.infer<typeof issueCommentSchema>;
export type LarkDestination = z.infer<typeof larkDestinationSchema>;
export type NotifierConfig = z.infer<typeof notifierConfigSchema>;
export type CompanyConfig = z.infer<typeof companyConfigSchema>;
export type InboxSnapshot = Map<string, InboxIssueSummary>;
export type LiveEvent = z.infer<typeof liveEventSchema>;

export async function resolveDirectIssueFallback(input: {
  additions: InboxIssueSummary[];
  nextSnapshot: InboxSnapshot;
  context: Pick<RefreshContext, "action" | "issueId">;
  fetchIssueById: (issueId: string) => Promise<InboxIssueSummary | null>;
  onResolved?: (issue: InboxIssueSummary) => void;
}): Promise<{ additions: InboxIssueSummary[]; nextSnapshot: InboxSnapshot }> {
  const { additions, nextSnapshot, context, fetchIssueById, onResolved } = input;

  if (additions.length > 0 || !context.issueId || !shouldNotifyForAction(context.action)) {
    return { additions, nextSnapshot };
  }

  const directIssue = await fetchIssueById(context.issueId);
  if (!directIssue) {
    return { additions, nextSnapshot };
  }

  nextSnapshot.set(directIssue.id, directIssue);
  onResolved?.(directIssue);

  return {
    additions: [directIssue],
    nextSnapshot,
  };
}

export function resolveCompanies(config: NotifierConfig): CompanyConfig[] {
  if (config.companies && config.companies.length > 0) {
    return config.companies.map((company) => ({
      ...company,
      paperclipBaseUrl: company.paperclipBaseUrl ?? config.paperclipBaseUrl,
    }));
  }

  return [
    {
      companyId: config.companyId!,
      companyName: config.companyName,
      agentApiKey: config.agentApiKey!,
      paperclipBaseUrl: config.paperclipBaseUrl,
      destinationsByUserId: config.destinationsByUserId,
    },
  ];
}

interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  onRetry?: (attempt: number, err: unknown) => void;
}

interface HttpRequestOptions extends RequestInit {
  retries?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  timeoutMs?: number;
}

interface LarkCardContext {
  action: string;
  paperclipBaseUrl: string;
  replySnippet?: string | null;
  userId: string;
  actorName?: string | null;
  previousStatus?: string | null;
  previousPriority?: string | null;
  companyName?: string | null;
}

interface RefreshContext {
  action: string;
  issueId?: string | null;
  replySnippet?: string | null;
  actorType?: string | null;
  actorId?: string | null;
  actorName?: string | null;
  previousStatus?: string | null;
  previousPriority?: string | null;
}

type LarkHeaderTemplate =
  | "blue"
  | "wathet"
  | "turquoise"
  | "green"
  | "yellow"
  | "orange"
  | "red"
  | "carmine"
  | "violet"
  | "purple"
  | "indigo"
  | "grey"
  | "default";

class HttpStatusError extends Error {
  status: number;
  bodyText: string;

  constructor(status: number, bodyText: string) {
    super(`HTTP ${status}`);
    this.name = "HttpStatusError";
    this.status = status;
    this.bodyText = bodyText;
  }
}

function readEnvInt(raw: string | undefined, fallback: number) {
  if (!raw || raw.trim().length === 0) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

function readEnvBoolean(raw: string | undefined, fallback = false) {
  if (!raw || raw.trim().length === 0) return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function readFirstEnvString(env: NodeJS.ProcessEnv, keys: string[]) {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) {
      return value;
    }
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readJsonFile(filePath: string, label: string) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch (err) {
    throw new Error(`Invalid ${label} at ${filePath}: ${(err as Error).message}`);
  }
}

function parseDestinationsInput(input: unknown, label: string) {
  if (input == null || input === "") {
    return {};
  }

  if (typeof input === "string") {
    try {
      return JSON.parse(input) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`Invalid ${label}: ${(err as Error).message}`);
    }
  }

  if (isRecord(input)) {
    return input;
  }

  throw new Error(`Invalid ${label}: expected a JSON object.`);
}

export function loadNotifierConfig(env: NodeJS.ProcessEnv = process.env): NotifierConfig {
  const configFilePath = env.PAPERCLIP_INBOX_LARK_CONFIG_FILE?.trim();
  const destinationsFilePath = env.PAPERCLIP_INBOX_LARK_DESTINATIONS_FILE?.trim();
  const rawConfigFromFile = configFilePath
    ? (readJsonFile(configFilePath, "PAPERCLIP_INBOX_LARK_CONFIG_FILE") as Record<string, unknown>)
    : {};
  const configFromFile = partialNotifierConfigSchema.parse(rawConfigFromFile);
  const destinationsFromFile = destinationsFilePath
    ? parseDestinationsInput(
        readJsonFile(destinationsFilePath, "PAPERCLIP_INBOX_LARK_DESTINATIONS_FILE"),
        "PAPERCLIP_INBOX_LARK_DESTINATIONS_FILE",
      )
    : undefined;

  const apiUrl =
    env.PAPERCLIP_INBOX_NOTIFIER_API_URL?.trim() ||
    configFromFile.apiUrl ||
    env.PAPERCLIP_API_URL?.trim() ||
    "";
  const companyId =
    env.PAPERCLIP_INBOX_NOTIFIER_COMPANY_ID?.trim() ||
    configFromFile.companyId ||
    env.PAPERCLIP_COMPANY_ID?.trim() ||
    "";
  const companyName =
    env.PAPERCLIP_INBOX_NOTIFIER_COMPANY_NAME?.trim() ||
    configFromFile.companyName ||
    undefined;
  const agentApiKey =
    env.PAPERCLIP_INBOX_NOTIFIER_AGENT_API_KEY?.trim() ||
    configFromFile.agentApiKey ||
    "";
  const paperclipBaseUrl =
    env.PAPERCLIP_INBOX_NOTIFIER_BASE_URL?.trim() ||
    configFromFile.paperclipBaseUrl ||
    env.PAPERCLIP_PUBLIC_URL?.trim() ||
    apiUrl;
  const destinationsByUserId =
    env.PAPERCLIP_INBOX_LARK_DESTINATIONS_JSON?.trim().length
      ? parseDestinationsInput(env.PAPERCLIP_INBOX_LARK_DESTINATIONS_JSON, "PAPERCLIP_INBOX_LARK_DESTINATIONS_JSON")
      : destinationsFromFile ??
        parseDestinationsInput(configFromFile.destinationsByUserId, "config.destinationsByUserId");

  // Pass through companies from config file (not loaded from env vars)
  const companies = isRecord(rawConfigFromFile) && Array.isArray(rawConfigFromFile.companies)
    ? rawConfigFromFile.companies
    : undefined;

  return notifierConfigSchema.parse({
    apiUrl,
    companyId,
    companyName,
    agentApiKey,
    paperclipBaseUrl,
    dryRun: readEnvBoolean(env.PAPERCLIP_INBOX_LARK_DRY_RUN, configFromFile.dryRun ?? false),
    logLevel: (env.PAPERCLIP_INBOX_LARK_LOG_LEVEL?.trim() || configFromFile.logLevel || "info").toLowerCase(),
    destinationsByUserId,
    companies,
    larkAppId:
      readFirstEnvString(env, ["PAPERCLIP_INBOX_LARK_APP_ID", "LARK_APP_ID", "FEISHU_APP_ID"]) ||
      configFromFile.larkAppId ||
      undefined,
    larkAppSecret:
      readFirstEnvString(env, [
        "PAPERCLIP_INBOX_LARK_APP_SECRET",
        "LARK_APP_SECRET",
        "FEISHU_APP_SECRET",
      ]) ||
      configFromFile.larkAppSecret ||
      undefined,
    requestTimeoutMs: readEnvInt(
      env.PAPERCLIP_INBOX_LARK_REQUEST_TIMEOUT_MS,
      configFromFile.requestTimeoutMs ?? 10_000,
    ),
    reconnectBaseMs: readEnvInt(
      env.PAPERCLIP_INBOX_LARK_RECONNECT_BASE_MS,
      configFromFile.reconnectBaseMs ?? 1_000,
    ),
    reconnectMaxMs: readEnvInt(
      env.PAPERCLIP_INBOX_LARK_RECONNECT_MAX_MS,
      configFromFile.reconnectMaxMs ?? 30_000,
    ),
    deliveryRetryCount: readEnvInt(
      env.PAPERCLIP_INBOX_LARK_DELIVERY_RETRY_COUNT,
      configFromFile.deliveryRetryCount ?? 3,
    ),
    deliveryRetryBaseMs: readEnvInt(
      env.PAPERCLIP_INBOX_LARK_DELIVERY_RETRY_BASE_MS,
      configFromFile.deliveryRetryBaseMs ?? 1_000,
    ),
    deliveryRetryMaxMs: readEnvInt(
      env.PAPERCLIP_INBOX_LARK_DELIVERY_RETRY_MAX_MS,
      configFromFile.deliveryRetryMaxMs ?? 8_000,
    ),
    pollIntervalMs: readEnvInt(
      env.PAPERCLIP_INBOX_LARK_POLL_INTERVAL_MS,
      configFromFile.pollIntervalMs ?? 30_000,
    ),
    createdVisibilityRetryCount: readEnvInt(
      env.PAPERCLIP_INBOX_LARK_CREATED_VISIBILITY_RETRY_COUNT,
      configFromFile.createdVisibilityRetryCount ?? 6,
    ),
    createdVisibilityRetryBaseMs: readEnvInt(
      env.PAPERCLIP_INBOX_LARK_CREATED_VISIBILITY_RETRY_BASE_MS,
      configFromFile.createdVisibilityRetryBaseMs ?? 500,
    ),
    createdVisibilityRetryMaxMs: readEnvInt(
      env.PAPERCLIP_INBOX_LARK_CREATED_VISIBILITY_RETRY_MAX_MS,
      configFromFile.createdVisibilityRetryMaxMs ?? 4_000,
    ),
  });
}

function readPayloadAction(event: LiveEvent) {
  return readString(event.payload.action);
}

function readPayloadEntityType(event: LiveEvent) {
  return readString(event.payload.entityType);
}

function readPayloadEntityId(event: LiveEvent) {
  return readString(event.payload.entityId);
}

function readPayloadUserId(event: LiveEvent) {
  const details = isRecord(event.payload.details) ? event.payload.details : null;
  return details ? readString(details.userId) : null;
}

function readPayloadBodySnippet(event: LiveEvent) {
  const details = isRecord(event.payload.details) ? event.payload.details : null;
  return details ? readString(details.bodySnippet) : null;
}

function readEventActorType(event: LiveEvent) {
  return readString(event.actorType);
}

function readEventActorId(event: LiveEvent) {
  return readString(event.actorId);
}

function readPayloadPrevious(event: LiveEvent): Record<string, unknown> | null {
  const details = isRecord(event.payload.details) ? event.payload.details : null;
  if (!details) return null;
  return isRecord(details._previous) ? details._previous : null;
}

function readPayloadIdentifier(event: LiveEvent): string | null {
  const details = isRecord(event.payload.details) ? event.payload.details : null;
  return details ? readString(details.identifier) : null;
}

export function isRelevantActivityEvent(event: LiveEvent) {
  const action = readPayloadAction(event);
  return (
    event.type === "activity.logged" &&
    readPayloadEntityType(event) === "issue" &&
    action !== null &&
    RELEVANT_ISSUE_ACTION_SET.has(action)
  );
}

export function resolveRefreshUserIds(event: LiveEvent, configuredUserIds: string[]) {
  const action = readPayloadAction(event);
  if (!action) return [];

  const payloadUserId = readPayloadUserId(event);
  if (LOCAL_INBOX_ACTION_SET.has(action) && payloadUserId && configuredUserIds.includes(payloadUserId)) {
    return [payloadUserId];
  }

  return configuredUserIds;
}

export function createInboxSnapshot(issues: InboxIssueSummary[]): InboxSnapshot {
  const snapshot: InboxSnapshot = new Map();
  for (const issue of issues) {
    snapshot.set(issue.id, issue);
  }
  return snapshot;
}

export function diffAddedIssues(previous: InboxSnapshot | null, nextIssues: InboxIssueSummary[]) {
  if (!previous) return [];
  return nextIssues.filter((issue) => !previous.has(issue.id));
}

function didIssueSummaryChange(previous: InboxIssueSummary, next: InboxIssueSummary) {
  return (
    previous.title !== next.title ||
    previous.status !== next.status ||
    previous.priority !== next.priority ||
    previous.updatedAt !== next.updatedAt ||
    (previous.lastActivityAt ?? null) !== (next.lastActivityAt ?? null)
  );
}

export function diffChangedIssues(previous: InboxSnapshot | null, nextIssues: InboxIssueSummary[]) {
  if (!previous) return [];
  return nextIssues.filter((issue) => {
    const previousIssue = previous.get(issue.id);
    return previousIssue ? didIssueSummaryChange(previousIssue, issue) : false;
  });
}

export function shouldNotifyForAction(action: string) {
  return !LOCAL_INBOX_ACTION_SET.has(action) && action !== "bootstrap";
}

export function planIssueNotifications(input: {
  action: string;
  previousSnapshot: InboxSnapshot | null;
  nextIssues: InboxIssueSummary[];
  targetIssueId?: string | null;
}) {
  if (!shouldNotifyForAction(input.action)) {
    return [];
  }

  if (input.targetIssueId) {
    const matchingIssue = input.nextIssues.find((issue) => issue.id === input.targetIssueId);
    return matchingIssue ? [matchingIssue] : [];
  }

  if (input.action === "poll") {
    const addedIssues = diffAddedIssues(input.previousSnapshot, input.nextIssues);
    const changedIssues = diffChangedIssues(input.previousSnapshot, input.nextIssues);
    const deduped = new Map<string, InboxIssueSummary>();
    for (const issue of [...addedIssues, ...changedIssues]) {
      deduped.set(issue.id, issue);
    }
    return [...deduped.values()];
  }

  return diffAddedIssues(input.previousSnapshot, input.nextIssues);
}

function deriveCompanyPrefix(identifier: string | null | undefined) {
  if (!identifier) return null;
  const dash = identifier.indexOf("-");
  if (dash <= 0) return null;
  return identifier.slice(0, dash);
}

function ensureTrailingSlash(value: string) {
  return value.endsWith("/") ? value : `${value}/`;
}

function buildIssueUrl(baseUrl: string, issue: InboxIssueSummary) {
  const prefix = deriveCompanyPrefix(issue.identifier);
  if (!prefix || !issue.identifier) return null;
  return new URL(`/${prefix}/issues/${issue.identifier}`, ensureTrailingSlash(baseUrl)).toString();
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) return "unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().replace(".000", "");
}

function normalizeCardText(value: string | null | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function truncateCardText(value: string | null | undefined, maxLength = 240) {
  const normalized = normalizeCardText(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function escapeMarkdownText(value: string) {
  return normalizeCardText(value).replace(/[\\`*_{}\[\]()#+\-.!|>]/g, "\\$&");
}

function escapeMarkdownLinkText(value: string) {
  return normalizeCardText(value).replace(/[\\\[\]]/g, "\\$&");
}

function inlineCode(value: string) {
  return `\`${normalizeCardText(value).replace(/[`\\]/g, "\\$&")}\``;
}

function humanizeStatus(value: string) {
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "backlog":
      return "待规划";
    case "todo":
      return "待处理";
    case "in_progress":
      return "进行中";
    case "in_review":
      return "评审中";
    case "done":
      return "已完成";
    case "blocked":
      return "已阻塞";
    case "cancelled":
    case "canceled":
      return "已取消";
    default:
      return normalizeCardText(value).replace(/[_-]+/g, " ");
  }
}

function humanizePriority(value: string) {
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "critical":
      return "紧急";
    case "high":
      return "高";
    case "medium":
      return "中";
    case "low":
      return "低";
    default:
      return normalizeCardText(value).replace(/[_-]+/g, " ");
  }
}

function humanizeAction(value: string) {
  switch (value) {
    case "issue.created":
      return "新建";
    case "issue.updated":
      return "更新";
    case "issue.comment_added":
      return "评论";
    case "issue.read_marked":
      return "标记已读";
    case "issue.read_unmarked":
      return "取消已读";
    case "issue.inbox_archived":
      return "归档";
    case "issue.inbox_unarchived":
      return "取消归档";
    default:
      return normalizeCardText(value).replace(/[._-]+/g, " ");
  }
}

function resolveHeaderTemplate(action: string, status: string): LarkHeaderTemplate {
  // Action-driven: action takes priority for the header color
  switch (action) {
    case "issue.created":
      return "blue";
    case "issue.comment_added":
      return "wathet";
    case "issue.updated":
      break; // fall through to status-driven
    default:
      break;
  }

  const normalized = status.trim().toLowerCase();

  switch (normalized) {
    case "backlog":
      return "grey";
    case "todo":
      return "blue";
    case "in_progress":
      return "orange";
    case "in_review":
      return "purple";
    case "done":
      return "green";
    case "cancelled":
    case "canceled":
      return "grey";
    case "blocked":
      return "red";
    default:
      return "blue";
  }
}

function resolveActionEmoji(action: string): string {
  switch (action) {
    case "issue.created":
      return "🆕";
    case "issue.updated":
      return "✏️";
    case "issue.comment_added":
      return "💬";
    default:
      return "📋";
  }
}

function resolveStatusTagColor(status: string): string {
  const normalized = status.trim().toLowerCase();
  switch (normalized) {
    case "backlog":
      return "neutral";
    case "todo":
      return "blue";
    case "in_progress":
      return "orange";
    case "in_review":
      return "purple";
    case "done":
      return "green";
    case "cancelled":
    case "canceled":
      return "neutral";
    case "blocked":
      return "red";
    default:
      return "neutral";
  }
}

function resolvePriorityTagColor(priority: string): string {
  const normalized = priority.trim().toLowerCase();
  if (["critical"].includes(normalized)) return "carmine";
  if (["high"].includes(normalized)) return "orange";
  if (["medium"].includes(normalized)) return "blue";
  if (["low"].includes(normalized)) return "neutral";
  return "neutral";
}

function buildCardPreview(issue: InboxIssueSummary) {
  const parts = [
    issue.identifier ? normalizeCardText(issue.identifier) : "Inbox item",
    normalizeCardText(issue.title),
  ].filter(Boolean);

  return parts.join(" · ").slice(0, 120);
}

function escapeFeishuIdentifier(value: string) {
  return value.replace(/[.\-]/g, "\\$&");
}

function resolveActionTitle(action: string): string {
  switch (action) {
    case "issue.created":
      return "🆕 新 Issue 提醒";
    case "issue.updated":
      return "✏️ Issue 状态更新提醒";
    case "issue.comment_added":
      return "💬 Issue 评论提醒";
    default:
      return "📋 Issue 更新提醒";
  }
}

function buildSubtitleMarkdown(companyName: string | null | undefined, identifier: string | null) {
  const escapedId = identifier ? escapeFeishuIdentifier(identifier) : null;
  if (companyName && escapedId) {
    return `<font color='grey'>${escapeFeishuIdentifier(companyName)} · ${escapedId}</font>`;
  }
  if (escapedId) {
    return `<font color='grey'>${escapedId}</font>`;
  }
  return null;
}

function buildMultiUrl(url: string) {
  return { url, pc_url: url, ios_url: url, android_url: url };
}

export function buildIssueCard(issue: InboxIssueSummary, context: LarkCardContext) {
  const issueUrl = buildIssueUrl(context.paperclipBaseUrl, issue);
  const issueTitle = normalizeCardText(issue.title) || "Untitled issue";
  const statusLabel = humanizeStatus(issue.status);
  const priorityLabel = humanizePriority(issue.priority);
  const identifierText = issue.identifier ? normalizeCardText(issue.identifier) : null;

  // --- Header ---
  const header = {
    template: resolveHeaderTemplate(context.action, issue.status),
    title: {
      tag: "plain_text",
      content: resolveActionTitle(context.action),
    },
    text_tag_list: [
      {
        tag: "text_tag",
        text: { tag: "plain_text", content: statusLabel },
        color: resolveStatusTagColor(issue.status),
      },
      {
        tag: "text_tag",
        text: { tag: "plain_text", content: priorityLabel },
        color: resolvePriorityTagColor(issue.priority),
      },
    ],
  };

  // --- Body elements ---
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const elements: any[] = [];

  // Subtitle notation line (company · identifier + optional label)
  const subtitleBase = buildSubtitleMarkdown(context.companyName, identifierText);
  if (subtitleBase) {
    let subtitleContent = subtitleBase;
    if (context.action === "issue.updated") {
      subtitleContent += "  **状态变更**";
    } else if (context.action === "issue.comment_added") {
      subtitleContent += "  **新增评论**";
    }
    elements.push({
      tag: "markdown",
      element_id: "subtitle",
      content: subtitleContent,
      text_size: "notation",
    });
  }

  // Issue title as heading with link
  const titleContent = issueUrl
    ? `**[${escapeMarkdownLinkText(issueTitle)}](${issueUrl})**`
    : `**${escapeMarkdownText(issueTitle)}**`;
  elements.push({
    tag: "markdown",
    element_id: "title",
    content: titleContent,
    text_size: "heading",
  });

  // ---- Template A: issue.created ----
  if (context.action === "issue.created") {
    if (context.actorName) {
      elements.push({
        tag: "column_set",
        element_id: "meta_row",
        flex_mode: "flow",
        horizontal_spacing: "default",
        columns: [
          {
            tag: "column",
            width: "auto",
            elements: [
              {
                tag: "markdown",
                content: `操作人: **${escapeMarkdownText(context.actorName)}**`,
                text_size: "normal",
              },
            ],
          },
        ],
      });
    }

    if (issueUrl) {
      elements.push({ tag: "hr", element_id: "divider" });
      elements.push({
        tag: "button",
        element_id: "open_btn",
        text: { tag: "plain_text", content: "查看详情" },
        type: "primary",
        width: "default",
        multi_url: buildMultiUrl(issueUrl),
      });
    }
  }

  // ---- Template B: issue.updated ----
  else if (context.action === "issue.updated") {
    const metaColumns: any[] = [];

    if (context.actorName) {
      metaColumns.push({
        tag: "column",
        width: "auto",
        elements: [
          {
            tag: "markdown",
            content: `操作人: **${escapeMarkdownText(context.actorName)}**`,
            text_size: "normal",
          },
        ],
      });
    }

    if (context.previousStatus && context.previousStatus !== issue.status) {
      const prevLabel = humanizeStatus(context.previousStatus);
      metaColumns.push({
        tag: "column",
        width: "auto",
        elements: [
          {
            tag: "markdown",
            content: `状态: ${prevLabel} → **${statusLabel}**`,
            text_size: "normal",
          },
        ],
      });
    }

    if (context.previousPriority && context.previousPriority !== issue.priority) {
      const prevLabel = humanizePriority(context.previousPriority);
      metaColumns.push({
        tag: "column",
        width: "auto",
        elements: [
          {
            tag: "markdown",
            content: `优先级: ${prevLabel} → **${priorityLabel}**`,
            text_size: "normal",
          },
        ],
      });
    }

    if (metaColumns.length > 0) {
      elements.push({
        tag: "column_set",
        element_id: "meta_row",
        flex_mode: "flow",
        horizontal_spacing: "default",
        columns: metaColumns,
      });
    }

    if (issueUrl) {
      elements.push({ tag: "hr", element_id: "divider" });
      elements.push({
        tag: "button",
        element_id: "open_btn",
        text: { tag: "plain_text", content: "查看详情" },
        type: "primary",
        width: "default",
        multi_url: buildMultiUrl(issueUrl),
      });
    }
  }

  // ---- Template C: issue.comment_added ----
  else if (context.action === "issue.comment_added") {
    if (context.actorName) {
      elements.push({
        tag: "column_set",
        element_id: "meta_row",
        flex_mode: "flow",
        horizontal_spacing: "default",
        columns: [
          {
            tag: "column",
            width: "auto",
            elements: [
              {
                tag: "markdown",
                content: `操作人: **${escapeMarkdownText(context.actorName)}**`,
                text_size: "normal",
              },
            ],
          },
        ],
      });
    }

    const replySnippet = truncateCardText(context.replySnippet);
    if (replySnippet) {
      elements.push({
        tag: "markdown",
        element_id: "reply",
        content: `<font color='grey'>评论内容</font>\n${escapeMarkdownText(replySnippet)}`,
        text_size: "normal",
      });
    }

    if (issueUrl) {
      elements.push({ tag: "hr", element_id: "divider" });
      elements.push({
        tag: "column_set",
        element_id: "action_row",
        flex_mode: "none",
        horizontal_spacing: "default",
        columns: [
          {
            tag: "column",
            width: "weighted",
            weight: 1,
            elements: [
              {
                tag: "button",
                element_id: "open_btn",
                text: { tag: "plain_text", content: "查看详情" },
                type: "default",
                width: "fill",
                multi_url: buildMultiUrl(issueUrl),
              },
            ],
          },
          {
            tag: "column",
            width: "weighted",
            weight: 1,
            elements: [
              {
                tag: "button",
                element_id: "reply_btn",
                text: { tag: "plain_text", content: "回复评论" },
                type: "primary",
                width: "fill",
                multi_url: buildMultiUrl(issueUrl),
              },
            ],
          },
        ],
      });
    }
  }

  // ---- Fallback for other actions ----
  else {
    if (issueUrl) {
      elements.push({ tag: "hr", element_id: "divider" });
      elements.push({
        tag: "button",
        element_id: "open_btn",
        text: { tag: "plain_text", content: "查看详情" },
        type: "primary",
        width: "default",
        multi_url: buildMultiUrl(issueUrl),
      });
    }
  }

  return {
    schema: "2.0",
    config: {
      enable_forward: true,
      update_multi: true,
      width_mode: "default",
      summary: {
        content: buildCardPreview(issue),
      },
    },
    header,
    body: {
      direction: "vertical",
      padding: "4px 12px 12px 12px",
      vertical_spacing: "8px",
      elements,
    },
  };
}

function injectWebhookMention(card: ReturnType<typeof buildIssueCard>, mentionOpenId: string) {
  return {
    ...card,
    body: {
      ...card.body,
      elements: card.body.elements.map((element) => {
        if (!isRecord(element) || element.element_id !== "title" || element.tag !== "markdown") {
          return element;
        }

        return {
          ...element,
          content: `<at id=${mentionOpenId}></at>\n${String(element.content ?? "")}`.trim(),
        };
      }),
    },
  };
}

function isTransientError(err: unknown) {
  if (err instanceof HttpStatusError) {
    return err.status === 408 || err.status === 429 || err.status >= 500;
  }

  if (err instanceof Error) {
    return err.name === "AbortError" || err.name === "TimeoutError" || err.name === "TypeError";
  }

  return false;
}

function readUnexpectedWebSocketStatus(err: unknown) {
  if (!(err instanceof Error)) return null;
  const match = err.message.match(/Unexpected server response:\s*(\d{3})/);
  if (!match) return null;
  const status = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(status) ? status : null;
}

async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= options.retries || !isTransientError(err)) {
        throw err;
      }

      attempt += 1;
      options.onRetry?.(attempt, err);
      const delay = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
      await sleep(delay);
    }
  }
}

async function parseJsonResponse(response: Response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function fetchJson<T>(input: string | URL, schema: z.ZodType<T>, init: HttpRequestOptions) {
  const timeoutMs = init.timeoutMs ?? 10_000;
  const retries = init.retries ?? 0;
  const retryBaseMs = init.retryBaseMs ?? 1_000;
  const retryMaxMs = init.retryMaxMs ?? 8_000;

  return withRetry(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(input, {
        ...init,
        signal: controller.signal,
      });

      const parsed = await parseJsonResponse(response);
      if (!response.ok) {
        throw new HttpStatusError(response.status, typeof parsed === "string" ? parsed : JSON.stringify(parsed));
      }

      return schema.parse(parsed);
    } finally {
      clearTimeout(timeout);
    }
  }, {
    retries,
    baseDelayMs: retryBaseMs,
    maxDelayMs: retryMaxMs,
  });
}

class LarkTokenProvider {
  private readonly config: NotifierConfig;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(config: NotifierConfig) {
    this.config = config;
  }

  async getToken() {
    const now = Date.now();
    if (this.token && this.token.expiresAt - 60_000 > now) {
      return this.token.value;
    }

    if (!this.config.larkAppId || !this.config.larkAppSecret) {
      throw new Error("Lark app credentials are required for open_id/chat_id deliveries.");
    }

    const responseSchema = z.object({
      code: z.number(),
      msg: z.string().optional(),
      tenant_access_token: z.string().optional(),
      expire: z.number().optional(),
    });

    const payload = await fetchJson(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      responseSchema,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app_id: this.config.larkAppId,
          app_secret: this.config.larkAppSecret,
        }),
        timeoutMs: this.config.requestTimeoutMs,
        retries: this.config.deliveryRetryCount,
        retryBaseMs: this.config.deliveryRetryBaseMs,
        retryMaxMs: this.config.deliveryRetryMaxMs,
      },
    );

    if (payload.code !== 0 || !payload.tenant_access_token) {
      throw new Error(`Failed to obtain Lark tenant access token: ${payload.msg ?? payload.code}`);
    }

    this.token = {
      value: payload.tenant_access_token,
      expiresAt: now + (payload.expire ?? 0) * 1000,
    };

    return payload.tenant_access_token;
  }
}

class LarkDeliveryClient {
  private readonly config: NotifierConfig;
  private readonly logger: pino.Logger;
  private readonly tokenProvider: LarkTokenProvider;

  constructor(config: NotifierConfig, logger: pino.Logger) {
    this.config = config;
    this.logger = logger;
    this.tokenProvider = new LarkTokenProvider(config);
  }

  async sendIssueCard(
    userId: string,
    destination: LarkDestination,
    issue: InboxIssueSummary,
    context: RefreshContext,
    companyOverrides?: { paperclipBaseUrl?: string; companyName?: string | null },
  ) {
    const card = buildIssueCard(issue, {
      action: context.action,
      paperclipBaseUrl: companyOverrides?.paperclipBaseUrl ?? this.config.paperclipBaseUrl,
      replySnippet: context.replySnippet,
      userId,
      actorName: context.actorName,
      previousStatus: context.previousStatus,
      previousPriority: context.previousPriority,
      companyName: companyOverrides?.companyName ?? this.config.companyName ?? null,
    });

    if (this.config.dryRun) {
      this.logger.info({
        action: context.action,
        dryRun: true,
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        userId,
        destinationType: destination.type,
        card,
      }, "dry-run Lark delivery");
      return;
    }

    let deliveryMetadata: { messageId?: string; chatId?: string } | null = null;

    await withRetry(async () => {
      if (destination.type === "webhook") {
        const webhookCard = destination.mentionOpenId ? injectWebhookMention(card, destination.mentionOpenId) : card;

        const payload = await fetchJson(destination.webhookUrl, z.any(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            msg_type: "interactive",
            card: webhookCard,
          }),
          timeoutMs: this.config.requestTimeoutMs,
        });

        if (isRecord(payload)) {
          const code =
            typeof payload.code === "number"
              ? payload.code
              : typeof payload.StatusCode === "number"
                ? payload.StatusCode
                : 0;
          if (code !== 0) {
            throw new Error(`Lark webhook delivery failed with code ${code}`);
          }
        }

        return;
      }

      const token = await this.tokenProvider.getToken();
      const endpoint = new URL("https://open.feishu.cn/open-apis/im/v1/messages");
      endpoint.searchParams.set("receive_id_type", destination.type);

      const payload = await fetchJson(
        endpoint,
        z.object({
          code: z.number(),
          msg: z.string().optional(),
          data: z
            .object({
              message_id: z.string().optional(),
              chat_id: z.string().optional(),
            })
            .optional(),
        }),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            receive_id: destination.receiveId,
            msg_type: "interactive",
            content: JSON.stringify(card),
          }),
          timeoutMs: this.config.requestTimeoutMs,
        },
      );

      if (payload.code !== 0) {
        throw new Error(`Lark IM delivery failed: ${payload.msg ?? payload.code}`);
      }

      deliveryMetadata = {
        messageId: payload.data?.message_id,
        chatId: payload.data?.chat_id,
      };
    }, {
      retries: this.config.deliveryRetryCount,
      baseDelayMs: this.config.deliveryRetryBaseMs,
      maxDelayMs: this.config.deliveryRetryMaxMs,
      onRetry: (attempt, err) => {
        this.logger.warn({
          attempt,
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          userId,
          destinationType: destination.type,
          err,
        }, "retrying Lark delivery");
      },
    });

    this.logger.info({
      action: context.action,
      dryRun: false,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      userId,
      destinationType: destination.type,
      ...(deliveryMetadata ?? {}),
    }, "Lark delivery sent");
  }
}

export class PaperclipInboxLarkNotifier {
  private readonly config: NotifierConfig;
  private readonly logger: pino.Logger;
  private readonly deliveryClient: LarkDeliveryClient;

  private stopped = false;
  private readonly sockets: WebSocket[] = [];
  private signalHandlersInstalled = false;

  constructor(config: NotifierConfig, logger = pino({ level: config.logLevel })) {
    this.config = config;
    this.logger = logger;
    this.deliveryClient = new LarkDeliveryClient(config, logger);
  }

  async run() {
    this.installSignalHandlers();
    const companies = resolveCompanies(this.config);
    this.logger.info({ companyCount: companies.length, companyIds: companies.map(c => c.companyId) }, "starting notifier");
    await Promise.all(companies.map(company => this.runCompany(company)));
  }

  stop() {
    this.stopped = true;
    for (const socket of this.sockets) {
      socket.close();
    }
    this.sockets.length = 0;
  }

  private installSignalHandlers() {
    if (this.signalHandlersInstalled) return;
    this.signalHandlersInstalled = true;

    const shutdown = () => {
      this.logger.info("shutting down inbox notifier");
      this.stop();
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }

  private async runCompany(company: CompanyConfig) {
    const companyLogger = this.logger.child({ companyId: company.companyId });
    const snapshotsByUserId = new Map<string, InboxSnapshot>();
    const refreshChainsByUserId = new Map<string, Promise<void>>();
    const agentCache = new Map<string, string>();

    const resolveActorName = (actorType: string | null | undefined, actorId: string | null | undefined): string | null => {
      if (!actorType) return null;
      if (actorType === "agent" && actorId) {
        return agentCache.get(actorId) ?? actorId;
      }
      if (actorType === "user") {
        return "用户";
      }
      return null;
    };

    const fetchAgentCache = async () => {
      try {
        const endpoint = new URL(
          `/api/companies/${encodeURIComponent(company.companyId)}/agents`,
          this.config.apiUrl,
        );

        const agentListSchema = z.array(
          z.object({
            id: z.string(),
            name: z.string().optional(),
          }).passthrough(),
        );

        const agents = await fetchJson(endpoint, agentListSchema, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${company.agentApiKey}`,
          },
          timeoutMs: this.config.requestTimeoutMs,
          retries: this.config.deliveryRetryCount,
          retryBaseMs: this.config.deliveryRetryBaseMs,
          retryMaxMs: this.config.deliveryRetryMaxMs,
        });

        for (const agent of agents) {
          if (agent.name) {
            agentCache.set(agent.id, agent.name);
          }
        }

        companyLogger.info({ agentCount: agentCache.size }, "loaded agent cache");
      } catch (err) {
        companyLogger.warn({ err }, "failed to load agent cache, actor names will be unavailable");
      }
    };

    const fetchMineInbox = async (userId: string) => {
      const endpoint = new URL("/api/agents/me/inbox/mine", this.config.apiUrl);
      endpoint.searchParams.set("userId", userId);

      return fetchJson(endpoint, inboxIssuesResponseSchema, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${company.agentApiKey}`,
        },
        timeoutMs: this.config.requestTimeoutMs,
        retries: this.config.deliveryRetryCount,
        retryBaseMs: this.config.deliveryRetryBaseMs,
        retryMaxMs: this.config.deliveryRetryMaxMs,
      });
    };

    const fetchIssueById = async (issueId: string): Promise<InboxIssueSummary | null> => {
      const endpoint = new URL(`/api/issues/${encodeURIComponent(issueId)}`, this.config.apiUrl);

      try {
        const raw = await fetchJson(endpoint, z.record(z.unknown()), {
          method: "GET",
          headers: {
            Authorization: `Bearer ${company.agentApiKey}`,
          },
          timeoutMs: this.config.requestTimeoutMs,
          retries: 1,
          retryBaseMs: this.config.deliveryRetryBaseMs,
          retryMaxMs: this.config.deliveryRetryMaxMs,
        });

        const parsed = inboxIssueSchema.safeParse({
          id: raw.id,
          identifier: raw.identifier ?? null,
          title: raw.title ?? "Untitled",
          status: raw.status ?? "backlog",
          priority: raw.priority ?? "medium",
          updatedAt: raw.updatedAt ?? new Date().toISOString(),
          lastActivityAt: raw.lastActivityAt ?? null,
        });

        return parsed.success ? parsed.data : null;
      } catch {
        companyLogger.warn({ issueId }, "fetchIssueById fallback failed");
        return null;
      }
    };

    const fetchLatestIssueComment = async (issueId: string) => {
      const endpoint = new URL(`/api/issues/${issueId}/comments`, this.config.apiUrl);
      endpoint.searchParams.set("order", "desc");
      endpoint.searchParams.set("limit", "1");

      const comments = await fetchJson(endpoint, issueCommentsResponseSchema, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${company.agentApiKey}`,
        },
        timeoutMs: this.config.requestTimeoutMs,
        retries: this.config.deliveryRetryCount,
        retryBaseMs: this.config.deliveryRetryBaseMs,
        retryMaxMs: this.config.deliveryRetryMaxMs,
      });

      return comments[0] ?? null;
    };

    const resolveReplySnippet = async (issue: InboxIssueSummary, context: RefreshContext) => {
      if (context.replySnippet) {
        return context.replySnippet;
      }

      if (context.action !== "issue.comment_added") {
        return null;
      }

      const latestComment = await fetchLatestIssueComment(issue.id);
      return latestComment ? latestComment.body : null;
    };

    const shouldRetryCreatedVisibility = (context: RefreshContext, additions: InboxIssueSummary[]) => {
      return context.action === "issue.created" && Boolean(context.issueId) && additions.length === 0;
    };

    const retryCreatedVisibility = async (
      userId: string,
      previousSnapshot: InboxSnapshot | null,
      context: RefreshContext,
    ) => {
      let nextIssues: InboxIssueSummary[] = [];
      let nextSnapshot: InboxSnapshot = new Map();
      let additions: InboxIssueSummary[] = [];

      for (let attempt = 1; attempt <= this.config.createdVisibilityRetryCount; attempt += 1) {
        const delay = Math.min(
          this.config.createdVisibilityRetryMaxMs,
          this.config.createdVisibilityRetryBaseMs * 2 ** (attempt - 1),
        );
        await sleep(delay);
        nextIssues = await fetchMineInbox(userId);
        nextSnapshot = createInboxSnapshot(nextIssues);
        additions = planIssueNotifications({
          action: context.action,
          previousSnapshot,
          nextIssues,
          targetIssueId: context.issueId,
        });

        companyLogger.info({
          action: context.action,
          issueId: context.issueId,
          attempt,
          delay,
          userId,
          inboxSize: nextIssues.length,
          visible: context.issueId ? nextSnapshot.has(context.issueId) : false,
        }, "retrying created issue visibility");

        if (additions.length > 0) {
          return { nextIssues, nextSnapshot, additions };
        }
      }

      return { nextIssues, nextSnapshot, additions };
    };

    const resolveNotificationContext = async (
      issue: InboxIssueSummary,
      previousSnapshot: InboxSnapshot | null,
      context: RefreshContext,
    ): Promise<RefreshContext> => {
      if (context.action !== "poll") {
        return {
          ...context,
          issueId: context.issueId ?? issue.id,
          replySnippet: await resolveReplySnippet(issue, context),
        };
      }

      const previousIssue = previousSnapshot?.get(issue.id) ?? null;
      if (!previousIssue) {
        return {
          action: "issue.created",
          issueId: issue.id,
          actorType: context.actorType,
          actorId: context.actorId,
          actorName: context.actorName,
        };
      }

      if (
        previousIssue.status !== issue.status ||
        previousIssue.priority !== issue.priority ||
        previousIssue.title !== issue.title
      ) {
        return {
          action: "issue.updated",
          issueId: issue.id,
          actorType: context.actorType,
          actorId: context.actorId,
          actorName: context.actorName,
          previousStatus: previousIssue.status !== issue.status ? previousIssue.status : null,
          previousPriority: previousIssue.priority !== issue.priority ? previousIssue.priority : null,
        };
      }

      return {
        action: "issue.comment_added",
        issueId: issue.id,
        actorType: context.actorType,
        actorId: context.actorId,
        actorName: context.actorName,
        replySnippet: await resolveReplySnippet(issue, {
          ...context,
          action: "issue.comment_added",
        }),
      };
    };

    const companyPaperclipBaseUrl = company.paperclipBaseUrl ?? this.config.paperclipBaseUrl;

    const refreshUserInbox = async (userId: string, context: RefreshContext) => {
      const previousSnapshot = snapshotsByUserId.get(userId) ?? null;
      let nextIssues = await fetchMineInbox(userId);
      let nextSnapshot = createInboxSnapshot(nextIssues);

      let additions = planIssueNotifications({
        action: context.action,
        previousSnapshot,
        nextIssues,
        targetIssueId: context.issueId,
      });

      if (shouldRetryCreatedVisibility(context, additions)) {
        ({ nextIssues, nextSnapshot, additions } = await retryCreatedVisibility(userId, previousSnapshot, context));
      }

      ({ additions, nextSnapshot } = await resolveDirectIssueFallback({
        additions,
        nextSnapshot,
        context,
        fetchIssueById,
        onResolved: (directIssue) => {
          companyLogger.info({
            action: context.action,
            issueId: context.issueId,
            identifier: directIssue.identifier,
          }, "resolved issue via direct fetch fallback");
        },
      }));

      snapshotsByUserId.set(userId, nextSnapshot);

      companyLogger.info({
        action: context.action,
        targetIssueId: context.issueId,
        userId,
        inboxSize: nextIssues.length,
        addedIssueIds: additions.map((issue) => issue.id),
      }, "refreshed user inbox snapshot");

      if (additions.length === 0) {
        return;
      }

      const destination = company.destinationsByUserId[userId];
      if (!destination) {
        companyLogger.warn({ userId }, "skipping delivery because no Lark destination is configured");
        return;
      }

      for (const issue of additions) {
        const notificationContext = await resolveNotificationContext(issue, previousSnapshot, context);
        await this.deliveryClient.sendIssueCard(userId, destination, issue, notificationContext, {
          paperclipBaseUrl: companyPaperclipBaseUrl,
          companyName: company.companyName,
        });
      }
    };

    const queueUserRefresh = (userId: string, context: RefreshContext) => {
      const existing = refreshChainsByUserId.get(userId) ?? Promise.resolve();
      const next = existing.catch(() => undefined).then(() => refreshUserInbox(userId, context));
      refreshChainsByUserId.set(userId, next);
      return next;
    };

    const refreshAllUsers = async (action: string) => {
      const userIds = Object.keys(company.destinationsByUserId);
      await Promise.all(userIds.map((userId) => queueUserRefresh(userId, { action })));
    };

    const handleSocketMessage = async (raw: string) => {
      let event: LiveEvent;

      try {
        event = liveEventSchema.parse(JSON.parse(raw));
      } catch (err) {
        companyLogger.warn({ err, raw }, "failed to parse websocket event");
        return;
      }

      if (!isRelevantActivityEvent(event)) {
        return;
      }

      const action = readPayloadAction(event);
      if (!action) return;

      const previous = readPayloadPrevious(event);
      const actorType = readEventActorType(event);
      const actorId = readEventActorId(event);

      const refreshContext: RefreshContext = {
        action,
        issueId: readPayloadEntityId(event),
        replySnippet: readPayloadBodySnippet(event),
        actorType,
        actorId,
        actorName: resolveActorName(actorType, actorId),
        previousStatus: previous ? readString(previous.status) : null,
        previousPriority: previous ? readString(previous.priority) : null,
      };

      const userIds = resolveRefreshUserIds(event, Object.keys(company.destinationsByUserId));
      companyLogger.debug({
        eventId: event.id,
        action,
        userIds,
      }, "received relevant live event");

      await Promise.all(userIds.map((userId) => queueUserRefresh(userId, refreshContext)));
    };

    const connectOnce = async (connectReason: string) => {
      const wsUrl = new URL(this.config.apiUrl);
      wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
      wsUrl.pathname = `/api/companies/${encodeURIComponent(company.companyId)}/events/ws`;
      wsUrl.search = "";

      await new Promise<void>((resolve, reject) => {
        let opened = false;
        let pingTimer: ReturnType<typeof setInterval> | undefined;
        let pongTimer: ReturnType<typeof setTimeout> | undefined;
        let pongReceived = true;

        const clearTimers = () => {
          if (pingTimer) { clearInterval(pingTimer); pingTimer = undefined; }
          if (pongTimer) { clearTimeout(pongTimer); pongTimer = undefined; }
        };

        const socket = new WebSocket(wsUrl, {
          headers: {
            Authorization: `Bearer ${company.agentApiKey}`,
          },
        });

        this.sockets.push(socket);

        socket.on("open", () => {
          opened = true;
          companyLogger.info({ connectReason, url: wsUrl.toString() }, "connected to live events websocket");
          void refreshAllUsers(connectReason);

          // Start ping/pong heartbeat
          pingTimer = setInterval(() => {
            if (!pongReceived) {
              companyLogger.warn("pong not received within interval, terminating websocket");
              clearTimers();
              socket.terminate();
              return;
            }
            pongReceived = false;
            socket.ping();
            pongTimer = setTimeout(() => {
              if (!pongReceived) {
                companyLogger.warn(
                  { timeoutMs: this.config.pingTimeoutMs },
                  "websocket ping timeout, terminating connection",
                );
                clearTimers();
                socket.terminate();
              }
            }, this.config.pingTimeoutMs);
          }, this.config.pingIntervalMs);
        });

        socket.on("pong", () => {
          pongReceived = true;
          if (pongTimer) { clearTimeout(pongTimer); pongTimer = undefined; }
        });

        socket.on("message", (raw) => {
          // Any message counts as proof of liveness
          pongReceived = true;
          void handleSocketMessage(raw.toString());
        });

        socket.on("error", (err) => {
          if (!opened) {
            clearTimers();
            reject(err);
            return;
          }
          companyLogger.warn({ err }, "websocket client error");
        });

        socket.on("close", (code, reason) => {
          clearTimers();
          const idx = this.sockets.indexOf(socket);
          if (idx >= 0) this.sockets.splice(idx, 1);
          const reasonText = typeof reason === "string" ? reason : reason.toString();
          companyLogger.warn({ code, reason: reasonText }, "websocket closed");
          if (!opened) {
            reject(new Error(`WebSocket closed before open: ${code} ${reasonText}`));
            return;
          }
          resolve();
        });
      });
    };

    const pollLoop = async () => {
      while (!this.stopped) {
        await sleep(this.config.pollIntervalMs);
        try {
          await refreshAllUsers("poll");
        } catch (err) {
          companyLogger.warn({ err }, "poll refresh failed");
        }
      }
    };

    const connectLoop = async () => {
      let attempt = 0;

      while (!this.stopped) {
        if (attempt > 0) {
          const delay = Math.min(this.config.reconnectMaxMs, this.config.reconnectBaseMs * 2 ** (attempt - 1));
          companyLogger.warn({ attempt, delay }, "waiting before websocket reconnect");
          await sleep(delay);
        }

        try {
          await connectOnce(attempt > 0 ? "reconnect" : "initial_connect");
          attempt = 0;
        } catch (err) {
          const wsStatus = readUnexpectedWebSocketStatus(err);
          if (wsStatus === 401 || wsStatus === 403) {
            companyLogger.warn({ wsStatus, err }, "websocket auth failed, switching to polling mode");
            await pollLoop();
            return;
          }

          attempt += 1;
          if (this.stopped) {
            return;
          }
          companyLogger.warn({ attempt, err }, "websocket connection ended");
        }
      }
    };

    // --- Company runner entry point ---
    await fetchAgentCache();
    await refreshAllUsers("bootstrap");
    await connectLoop();
  }
}
