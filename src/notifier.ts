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

const notifierConfigBaseSchema = z.object({
  apiUrl: z.string().url(),
  companyId: z.string().min(1),
  agentApiKey: z.string().min(1),
  paperclipBaseUrl: z.string().url(),
  dryRun: z.boolean().default(false),
  logLevel: z.enum(LOG_LEVELS).default("info"),
  destinationsByUserId: z.record(z.string().min(1), larkDestinationSchema),
  larkAppId: z.string().min(1).optional(),
  larkAppSecret: z.string().min(1).optional(),
  requestTimeoutMs: z.number().int().positive().default(10_000),
  reconnectBaseMs: z.number().int().positive().default(1_000),
  reconnectMaxMs: z.number().int().positive().default(30_000),
  deliveryRetryCount: z.number().int().min(0).default(3),
  deliveryRetryBaseMs: z.number().int().positive().default(1_000),
  deliveryRetryMaxMs: z.number().int().positive().default(8_000),
  pollIntervalMs: z.number().int().positive().default(30_000),
  createdVisibilityRetryCount: z.number().int().min(0).default(6),
  createdVisibilityRetryBaseMs: z.number().int().positive().default(500),
  createdVisibilityRetryMaxMs: z.number().int().positive().default(4_000),
});

const notifierConfigSchema = notifierConfigBaseSchema.superRefine((value, ctx) => {
  if (Object.keys(value.destinationsByUserId).length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["destinationsByUserId"],
      message: "At least one Paperclip user -> Lark destination mapping is required.",
    });
  }

  const needsBotCredentials = Object.values(value.destinationsByUserId).some(
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
export type InboxSnapshot = Map<string, InboxIssueSummary>;
export type LiveEvent = z.infer<typeof liveEventSchema>;

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
}

interface RefreshContext {
  action: string;
  issueId?: string | null;
  replySnippet?: string | null;
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
  const configFromFile = configFilePath
    ? partialNotifierConfigSchema.parse(readJsonFile(configFilePath, "PAPERCLIP_INBOX_LARK_CONFIG_FILE"))
    : {};
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

  return notifierConfigSchema.parse({
    apiUrl,
    companyId,
    agentApiKey,
    paperclipBaseUrl,
    dryRun: readEnvBoolean(env.PAPERCLIP_INBOX_LARK_DRY_RUN, configFromFile.dryRun ?? false),
    logLevel: (env.PAPERCLIP_INBOX_LARK_LOG_LEVEL?.trim() || configFromFile.logLevel || "info").toLowerCase(),
    destinationsByUserId,
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

  if (["done", "completed", "complete", "pass", "passed", "approved", "success"].includes(normalized)) {
    return "green";
  }

  if (["blocked", "failed", "failure", "error", "rejected"].includes(normalized)) {
    return "red";
  }

  if (["in_progress"].includes(normalized)) {
    return "turquoise";
  }

  if (["warning", "warn"].includes(normalized)) {
    return "orange";
  }

  if (["cancelled", "canceled"].includes(normalized)) {
    return "grey";
  }

  if (["in_review", "review"].includes(normalized)) {
    return "indigo";
  }

  return "blue";
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
  if (["done", "completed", "complete"].includes(normalized)) return "green";
  if (["in_progress"].includes(normalized)) return "turquoise";
  if (["in_review", "review"].includes(normalized)) return "purple";
  if (["blocked", "failed"].includes(normalized)) return "red";
  if (["cancelled", "canceled"].includes(normalized)) return "neutral";
  if (["todo"].includes(normalized)) return "blue";
  return "neutral";
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

export function buildIssueCard(issue: InboxIssueSummary, context: LarkCardContext) {
  const issueUrl = buildIssueUrl(context.paperclipBaseUrl, issue);
  const issueTitle = normalizeCardText(issue.title) || "Untitled issue";
  const recentActivity = formatTimestamp(issue.lastActivityAt ?? issue.updatedAt);
  const statusLabel = humanizeStatus(issue.status);
  const priorityLabel = humanizePriority(issue.priority);
  const actionLabel = humanizeAction(context.action);
  const replySnippet = truncateCardText(context.replySnippet);
  const identifierText = issue.identifier ? normalizeCardText(issue.identifier) : null;

  // --- Header ---
  const emoji = resolveActionEmoji(context.action);
  const headerTitle = identifierText
    ? `${emoji} ${identifierText} · ${actionLabel}`
    : `${emoji} ${actionLabel}`;

  const header = {
    template: resolveHeaderTemplate(context.action, issue.status),
    title: {
      tag: "plain_text",
      content: headerTitle,
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

  // 1. Issue title as main content
  elements.push({
    tag: "markdown",
    element_id: "title",
    content: `**${escapeMarkdownText(issueTitle)}**`,
    text_size: "heading",
  });

  // 2. Reply snippet for comment_added (quote-style)
  if (replySnippet) {
    elements.push({
      tag: "markdown",
      element_id: "reply",
      content: `💬 ${escapeMarkdownText(replySnippet)}`,
      text_size: "normal",
    });
  }

  // 3. Metadata row — column_set with status/priority/time
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
            content: `<font color='grey'>状态</font>\n${inlineCode(statusLabel)}`,
            text_size: "notation",
          },
        ],
      },
      {
        tag: "column",
        width: "auto",
        elements: [
          {
            tag: "markdown",
            content: `<font color='grey'>优先级</font>\n${inlineCode(priorityLabel)}`,
            text_size: "notation",
          },
        ],
      },
      {
        tag: "column",
        width: "auto",
        elements: [
          {
            tag: "markdown",
            content: `<font color='grey'>最近活动</font>\n${inlineCode(recentActivity)}`,
            text_size: "notation",
          },
        ],
      },
    ],
  });

  // 4. Divider + link button
  if (issueUrl) {
    elements.push({ tag: "hr", element_id: "divider" });
    elements.push({
      tag: "button",
      element_id: "open_btn",
      text: { tag: "plain_text", content: "在 Paperclip 中打开 →" },
      type: "primary",
      width: "default",
      multi_url: {
        url: issueUrl,
        pc_url: issueUrl,
        ios_url: issueUrl,
        android_url: issueUrl,
      },
    });
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
    ...(issueUrl
      ? {
          card_link: {
            url: issueUrl,
          },
        }
      : {}),
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
  ) {
    const card = buildIssueCard(issue, {
      action: context.action,
      paperclipBaseUrl: this.config.paperclipBaseUrl,
      replySnippet: context.replySnippet,
      userId,
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
  private readonly snapshotsByUserId = new Map<string, InboxSnapshot>();
  private readonly refreshChainsByUserId = new Map<string, Promise<void>>();
  private readonly deliveryClient: LarkDeliveryClient;

  private stopped = false;
  private socket: WebSocket | null = null;
  private signalHandlersInstalled = false;

  constructor(config: NotifierConfig, logger = pino({ level: config.logLevel })) {
    this.config = config;
    this.logger = logger;
    this.deliveryClient = new LarkDeliveryClient(config, logger);
  }

  async run() {
    this.installSignalHandlers();
    await this.refreshAllUsers("bootstrap");
    await this.connectLoop();
  }

  stop() {
    this.stopped = true;
    if (this.socket) {
      this.socket.close();
    }
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

  private async connectLoop() {
    let attempt = 0;

    while (!this.stopped) {
      if (attempt > 0) {
        const delay = Math.min(this.config.reconnectMaxMs, this.config.reconnectBaseMs * 2 ** (attempt - 1));
        this.logger.warn({ attempt, delay }, "waiting before websocket reconnect");
        await sleep(delay);
      }

      try {
        await this.connectOnce(attempt > 0 ? "reconnect" : "initial_connect");
        attempt = 0;
      } catch (err) {
        const wsStatus = readUnexpectedWebSocketStatus(err);
        if (wsStatus === 401 || wsStatus === 403) {
          this.logger.warn({ wsStatus, err }, "websocket auth failed, switching to polling mode");
          await this.pollLoop();
          return;
        }

        attempt += 1;
        if (this.stopped) {
          return;
        }
        this.logger.warn({ attempt, err }, "websocket connection ended");
      }
    }
  }

  private async connectOnce(connectReason: string) {
    const wsUrl = new URL(this.config.apiUrl);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    wsUrl.pathname = `/api/companies/${encodeURIComponent(this.config.companyId)}/events/ws`;
    wsUrl.search = "";

    await new Promise<void>((resolve, reject) => {
      let opened = false;
      const socket = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Bearer ${this.config.agentApiKey}`,
        },
      });

      this.socket = socket;

      socket.on("open", () => {
        opened = true;
        this.logger.info({ connectReason, url: wsUrl.toString() }, "connected to live events websocket");
        void this.refreshAllUsers(connectReason);
      });

      socket.on("message", (raw) => {
        void this.handleSocketMessage(raw.toString());
      });

      socket.on("error", (err) => {
        if (!opened) {
          reject(err);
          return;
        }
        this.logger.warn({ err }, "websocket client error");
      });

      socket.on("close", (code, reason) => {
        this.socket = null;
        const reasonText = typeof reason === "string" ? reason : reason.toString();
        this.logger.warn({ code, reason: reasonText }, "websocket closed");
        if (!opened) {
          reject(new Error(`WebSocket closed before open: ${code} ${reasonText}`));
          return;
        }
        resolve();
      });
    });
  }

  private async handleSocketMessage(raw: string) {
    let event: LiveEvent;

    try {
      event = liveEventSchema.parse(JSON.parse(raw));
    } catch (err) {
      this.logger.warn({ err, raw }, "failed to parse websocket event");
      return;
    }

    if (!isRelevantActivityEvent(event)) {
      return;
    }

    const action = readPayloadAction(event);
    if (!action) return;
    const refreshContext: RefreshContext = {
      action,
      issueId: readPayloadEntityId(event),
      replySnippet: readPayloadBodySnippet(event),
    };

    const userIds = resolveRefreshUserIds(event, Object.keys(this.config.destinationsByUserId));
    this.logger.debug({
      eventId: event.id,
      action,
      userIds,
    }, "received relevant live event");

    await Promise.all(userIds.map((userId) => this.queueUserRefresh(userId, refreshContext)));
  }

  private async refreshAllUsers(action: string) {
    const userIds = Object.keys(this.config.destinationsByUserId);
    await Promise.all(userIds.map((userId) => this.queueUserRefresh(userId, { action })));
  }

  private queueUserRefresh(userId: string, context: RefreshContext) {
    const existing = this.refreshChainsByUserId.get(userId) ?? Promise.resolve();
    const next = existing.catch(() => undefined).then(() => this.refreshUserInbox(userId, context));
    this.refreshChainsByUserId.set(userId, next);
    return next;
  }

  private async pollLoop() {
    while (!this.stopped) {
      await sleep(this.config.pollIntervalMs);
      try {
        await this.refreshAllUsers("poll");
      } catch (err) {
        this.logger.warn({ err }, "poll refresh failed");
      }
    }
  }

  private async refreshUserInbox(userId: string, context: RefreshContext) {
    const previousSnapshot = this.snapshotsByUserId.get(userId) ?? null;
    let nextIssues = await this.fetchMineInbox(userId);
    let nextSnapshot = createInboxSnapshot(nextIssues);

    let additions = planIssueNotifications({
      action: context.action,
      previousSnapshot,
      nextIssues,
      targetIssueId: context.issueId,
    });

    if (this.shouldRetryCreatedVisibility(context, additions)) {
      ({ nextIssues, nextSnapshot, additions } = await this.retryCreatedVisibility(userId, previousSnapshot, context));
    }

    this.snapshotsByUserId.set(userId, nextSnapshot);

    this.logger.info({
      action: context.action,
      targetIssueId: context.issueId,
      userId,
      inboxSize: nextIssues.length,
      addedIssueIds: additions.map((issue) => issue.id),
    }, "refreshed user inbox snapshot");

    if (additions.length === 0) {
      return;
    }

    const destination = this.config.destinationsByUserId[userId];
    if (!destination) {
      this.logger.warn({ userId }, "skipping delivery because no Lark destination is configured");
      return;
    }

    for (const issue of additions) {
      const notificationContext = await this.resolveNotificationContext(issue, previousSnapshot, context);
      await this.deliveryClient.sendIssueCard(userId, destination, issue, notificationContext);
    }
  }

  private async fetchMineInbox(userId: string) {
    const endpoint = new URL("/api/agents/me/inbox/mine", this.config.apiUrl);
    endpoint.searchParams.set("userId", userId);

    return fetchJson(endpoint, inboxIssuesResponseSchema, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.config.agentApiKey}`,
      },
      timeoutMs: this.config.requestTimeoutMs,
      retries: this.config.deliveryRetryCount,
      retryBaseMs: this.config.deliveryRetryBaseMs,
      retryMaxMs: this.config.deliveryRetryMaxMs,
    });
  }

  private async fetchLatestIssueComment(issueId: string) {
    const endpoint = new URL(`/api/issues/${issueId}/comments`, this.config.apiUrl);
    endpoint.searchParams.set("order", "desc");
    endpoint.searchParams.set("limit", "1");

    const comments = await fetchJson(endpoint, issueCommentsResponseSchema, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.config.agentApiKey}`,
      },
      timeoutMs: this.config.requestTimeoutMs,
      retries: this.config.deliveryRetryCount,
      retryBaseMs: this.config.deliveryRetryBaseMs,
      retryMaxMs: this.config.deliveryRetryMaxMs,
    });

    return comments[0] ?? null;
  }

  private async resolveReplySnippet(issue: InboxIssueSummary, context: RefreshContext) {
    if (context.replySnippet) {
      return context.replySnippet;
    }

    if (context.action !== "issue.comment_added") {
      return null;
    }

    const latestComment = await this.fetchLatestIssueComment(issue.id);
    return latestComment ? latestComment.body : null;
  }

  private shouldRetryCreatedVisibility(context: RefreshContext, additions: InboxIssueSummary[]) {
    return context.action === "issue.created" && Boolean(context.issueId) && additions.length === 0;
  }

  private async retryCreatedVisibility(
    userId: string,
    previousSnapshot: InboxSnapshot | null,
    context: RefreshContext,
  ) {
    let nextIssues: InboxIssueSummary[] = [];
    let nextSnapshot: InboxSnapshot = new Map();
    let additions: InboxIssueSummary[] = [];

    for (let attempt = 1; attempt <= this.config.createdVisibilityRetryCount; attempt += 1) {
      const delay = Math.min(
        this.config.createdVisibilityRetryMaxMs,
        this.config.createdVisibilityRetryBaseMs * 2 ** (attempt - 1),
      );
      await sleep(delay);
      nextIssues = await this.fetchMineInbox(userId);
      nextSnapshot = createInboxSnapshot(nextIssues);
      additions = planIssueNotifications({
        action: context.action,
        previousSnapshot,
        nextIssues,
        targetIssueId: context.issueId,
      });

      this.logger.info({
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
  }

  private async resolveNotificationContext(
    issue: InboxIssueSummary,
    previousSnapshot: InboxSnapshot | null,
    context: RefreshContext,
  ): Promise<RefreshContext> {
    if (context.action !== "poll") {
      return {
        ...context,
        issueId: context.issueId ?? issue.id,
        replySnippet: await this.resolveReplySnippet(issue, context),
      };
    }

    const previousIssue = previousSnapshot?.get(issue.id) ?? null;
    if (!previousIssue) {
      return {
        action: "issue.created",
        issueId: issue.id,
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
      };
    }

    return {
      action: "issue.comment_added",
      issueId: issue.id,
      replySnippet: await this.resolveReplySnippet(issue, {
        ...context,
        action: "issue.comment_added",
      }),
    };
  }
}
