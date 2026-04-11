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
  userId: string;
}

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
    larkAppId: env.PAPERCLIP_INBOX_LARK_APP_ID?.trim() || configFromFile.larkAppId || undefined,
    larkAppSecret: env.PAPERCLIP_INBOX_LARK_APP_SECRET?.trim() || configFromFile.larkAppSecret || undefined,
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
  });
}

function readPayloadAction(event: LiveEvent) {
  return readString(event.payload.action);
}

function readPayloadEntityType(event: LiveEvent) {
  return readString(event.payload.entityType);
}

function readPayloadUserId(event: LiveEvent) {
  const details = isRecord(event.payload.details) ? event.payload.details : null;
  return details ? readString(details.userId) : null;
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

export function shouldNotifyForAction(action: string) {
  return !LOCAL_INBOX_ACTION_SET.has(action) && action !== "bootstrap";
}

export function planIssueNotifications(input: {
  action: string;
  previousSnapshot: InboxSnapshot | null;
  nextIssues: InboxIssueSummary[];
}) {
  if (!shouldNotifyForAction(input.action)) {
    return [];
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
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function buildIssueCard(issue: InboxIssueSummary, context: LarkCardContext) {
  const issueUrl = buildIssueUrl(context.paperclipBaseUrl, issue);
  const lines = [
    issue.identifier ? `**${issue.identifier}**` : "**Inbox item**",
    issue.title.replace(/\n+/g, " ").trim(),
    `Status: ${issue.status}`,
    `Priority: ${issue.priority}`,
    issue.isUnreadForMe ? "Unread: yes" : "Unread: no",
    `Activity: ${formatTimestamp(issue.lastActivityAt ?? issue.updatedAt)}`,
    `Triggered by: ${context.action}`,
  ];

  return {
    config: {
      wide_screen_mode: true,
      enable_forward: true,
    },
    header: {
      template: issue.isUnreadForMe ? "red" : "blue",
      title: {
        tag: "plain_text",
        content: issue.identifier ? `Paperclip Inbox: ${issue.identifier}` : "Paperclip Inbox",
      },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: lines.join("\n"),
        },
      },
      ...(issueUrl
        ? [
            {
              tag: "action",
              actions: [
                {
                  tag: "button",
                  type: "primary",
                  text: {
                    tag: "plain_text",
                    content: "Open in Paperclip",
                  },
                  url: issueUrl,
                },
              ],
            },
          ]
        : []),
      {
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content: `Paperclip user: ${context.userId}`,
          },
        ],
      },
    ],
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

  async sendIssueCard(userId: string, destination: LarkDestination, issue: InboxIssueSummary, action: string) {
    const card = buildIssueCard(issue, {
      action,
      paperclipBaseUrl: this.config.paperclipBaseUrl,
      userId,
    });

    if (this.config.dryRun) {
      this.logger.info({
        action,
        dryRun: true,
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        userId,
        destinationType: destination.type,
        card,
      }, "dry-run Lark delivery");
      return;
    }

    await withRetry(async () => {
      if (destination.type === "webhook") {
        const textPrefix = destination.mentionOpenId ? `<at id=${destination.mentionOpenId}></at>\n` : "";
        const webhookCard = {
          ...card,
          elements: card.elements.map((element, index) => {
            if (index !== 0 || !isRecord(element) || element.tag !== "div" || !isRecord(element.text)) {
              return element;
            }

            return {
              ...element,
              text: {
                ...element.text,
                content: `${textPrefix}${String(element.text.content ?? "")}`.trim(),
              },
            };
          }),
        };

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
      action,
      dryRun: false,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      userId,
      destinationType: destination.type,
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

    const userIds = resolveRefreshUserIds(event, Object.keys(this.config.destinationsByUserId));
    this.logger.debug({
      eventId: event.id,
      action,
      userIds,
    }, "received relevant live event");

    await Promise.all(userIds.map((userId) => this.queueUserRefresh(userId, action)));
  }

  private async refreshAllUsers(action: string) {
    const userIds = Object.keys(this.config.destinationsByUserId);
    await Promise.all(userIds.map((userId) => this.queueUserRefresh(userId, action)));
  }

  private queueUserRefresh(userId: string, action: string) {
    const existing = this.refreshChainsByUserId.get(userId) ?? Promise.resolve();
    const next = existing.catch(() => undefined).then(() => this.refreshUserInbox(userId, action));
    this.refreshChainsByUserId.set(userId, next);
    return next;
  }

  private async refreshUserInbox(userId: string, action: string) {
    const previousSnapshot = this.snapshotsByUserId.get(userId) ?? null;
    const nextIssues = await this.fetchMineInbox(userId);
    const nextSnapshot = createInboxSnapshot(nextIssues);
    this.snapshotsByUserId.set(userId, nextSnapshot);

    const additions = planIssueNotifications({
      action,
      previousSnapshot,
      nextIssues,
    });

    this.logger.info({
      action,
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
      await this.deliveryClient.sendIssueCard(userId, destination, issue, action);
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
}
