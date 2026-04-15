import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import pino from "pino";
import { WebSocketServer } from "ws";
import {
  PaperclipInboxLarkNotifier,
  type InboxIssueSummary,
  type LiveEvent,
} from "../src/notifier.js";

const COMPANY_ID = "company-acceptance";
const AGENT_API_KEY = "pcak_acceptance";
const USER_WEBHOOK = "user-webhook";
const USER_IM = "user-im";
const ACTOR_AGENT_ID = "agent-acceptance-1";
const ACTOR_NAME = "Alex";
const LARK_APP_ID = "cli_acceptance";
const LARK_APP_SECRET = "secret_acceptance";
const RECEIVE_ID = "ou_acceptance";
const LARK_TOKEN = "tenant-token-acceptance";

type Scenario = "created" | "updated" | "commented";

interface CapturedWebhookDelivery {
  msg_type: string;
  card: Record<string, unknown>;
}

interface CapturedImDelivery {
  authorization: string | null;
  receiveIdType: string | null;
  body: {
    receive_id: string;
    msg_type: string;
    content: string;
  };
}

function makeIssue(overrides: Partial<InboxIssueSummary> = {}): InboxIssueSummary {
  return {
    id: "issue-acceptance-1",
    identifier: "SOL-36",
    title: "实施卡片模板系统验收测试",
    status: "todo",
    priority: "medium",
    updatedAt: "2026-04-14T10:40:05.888Z",
    lastActivityAt: "2026-04-14T10:40:05.888Z",
    isUnreadForMe: true,
    ...overrides,
  };
}

function collectElementIds(value: unknown, ids = new Set<string>()) {
  if (!value || typeof value !== "object") {
    return ids;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectElementIds(item, ids);
    }
    return ids;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.element_id === "string") {
    ids.add(record.element_id);
  }

  for (const child of Object.values(record)) {
    collectElementIds(child, ids);
  }

  return ids;
}

function findElementById(value: unknown, elementId: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findElementById(item, elementId);
      if (found) return found;
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  if (record.element_id === elementId) {
    return record;
  }

  for (const child of Object.values(record)) {
    const found = findElementById(child, elementId);
    if (found) return found;
  }

  return null;
}

function collectMarkdownContent(value: unknown, contents: string[] = []) {
  if (!value || typeof value !== "object") {
    return contents;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectMarkdownContent(item, contents);
    }
    return contents;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.content === "string") {
    contents.push(record.content);
  }

  for (const child of Object.values(record)) {
    collectMarkdownContent(child, contents);
  }

  return contents;
}

async function waitFor(label: string, check: () => boolean, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await sleep(25);
  }
}

function assertCard(
  card: Record<string, unknown>,
  expected: {
    template: string;
    titleIncludes: string;
    tags?: readonly string[];
    requiredElementIds: readonly string[];
    replyIncludes?: string;
    metaIncludes?: readonly string[];
  },
) {
  const header = card.header as {
    template?: string;
    title?: { content?: string };
    text_tag_list?: Array<{ text?: { content?: string } }>;
  };

  if (card.schema !== "2.0") {
    throw new Error(`Expected Card 2.0 payload, got ${String(card.schema ?? "missing")}`);
  }
  if (header.template !== expected.template) {
    throw new Error(`Expected template ${expected.template}, got ${header.template ?? "missing"}`);
  }
  if (!header.title?.content?.includes(expected.titleIncludes)) {
    throw new Error(`Expected header title to include ${expected.titleIncludes}, got ${header.title?.content ?? "missing"}`);
  }
  if (expected.tags) {
    const actualTags = header.text_tag_list?.map((tag) => tag.text?.content ?? "") ?? [];
    if (JSON.stringify(actualTags) !== JSON.stringify(expected.tags)) {
      throw new Error(`Expected tags ${expected.tags.join(", ")}, got ${actualTags.join(", ")}`);
    }
  }

  const elementIds = [...collectElementIds(card)];
  for (const elementId of expected.requiredElementIds) {
    if (!elementIds.includes(elementId)) {
      throw new Error(`Expected body element ${elementId}, got ${elementIds.join(", ")}`);
    }
  }

  if (expected.replyIncludes) {
    const replyBlock = findElementById(card, "reply");
    const reply = String(replyBlock?.content ?? "");
    if (!reply.includes(expected.replyIncludes)) {
      throw new Error(`Expected reply block to include ${expected.replyIncludes}, got ${reply || "missing"}`);
    }
  }

  if (expected.metaIncludes) {
    const metaRow = findElementById(card, "meta_row");
    const metaText = collectMarkdownContent(metaRow).join(" ");
    for (const expectedText of expected.metaIncludes) {
      if (!metaText.includes(expectedText)) {
        throw new Error(`Expected meta row to include ${expectedText}, got ${metaText || "missing"}`);
      }
    }
  }
}

async function main() {
  const issueCreated = makeIssue({ priority: "high" });
  const issueUpdated = makeIssue({
    status: "done",
    priority: "high",
    updatedAt: "2026-04-14T10:45:00.000Z",
    lastActivityAt: "2026-04-14T10:45:00.000Z",
  });
  const issueCommented = makeIssue({
    status: "blocked",
    priority: "critical",
    updatedAt: "2026-04-14T10:46:00.000Z",
    lastActivityAt: "2026-04-14T10:46:00.000Z",
  });

  let scenario: Scenario = "created";
  let currentIssues: InboxIssueSummary[] = [];
  const createdFetchCounts = new Map<string, number>();
  let tokenRequests = 0;
  const webhookDeliveries: CapturedWebhookDelivery[] = [];
  const imDeliveries: CapturedImDelivery[] = [];

  const originalFetch = globalThis.fetch.bind(globalThis);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === `/api/companies/${COMPANY_ID}/agents`) {
      if (req.headers.authorization !== `Bearer ${AGENT_API_KEY}`) {
        res.writeHead(401).end("unauthorized");
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([{ id: ACTOR_AGENT_ID, name: ACTOR_NAME }]));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/agents/me/inbox/mine") {
      if (req.headers.authorization !== `Bearer ${AGENT_API_KEY}`) {
        res.writeHead(401).end("unauthorized");
        return;
      }

      const userId = url.searchParams.get("userId");
      if (!userId) {
        res.writeHead(400).end("missing userId");
        return;
      }

      if (scenario === "created") {
        const nextCount = (createdFetchCounts.get(userId) ?? 0) + 1;
        createdFetchCounts.set(userId, nextCount);
        if (nextCount >= 3) {
          currentIssues = [issueCreated];
        }
      } else if (scenario === "updated") {
        currentIssues = [issueUpdated];
      } else {
        currentIssues = [issueCommented];
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(currentIssues));
      return;
    }

    if (req.method === "POST" && url.pathname === "/open-apis/bot/v2/hook/acceptance") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }

      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as CapturedWebhookDelivery;
      webhookDeliveries.push(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 0 }));
      return;
    }

    res.writeHead(404).end("not found");
  });

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const rawUrl = input instanceof Request ? input.url : input instanceof URL ? input.toString() : input;

    if (rawUrl === "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal") {
      tokenRequests += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as { app_id?: string; app_secret?: string };
      if (body.app_id !== LARK_APP_ID || body.app_secret !== LARK_APP_SECRET) {
        return new Response(JSON.stringify({ code: 1, msg: "bad credentials" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ code: 0, tenant_access_token: LARK_TOKEN, expire: 7200 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (rawUrl === "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id") {
      const body = JSON.parse(String(init?.body ?? "{}")) as CapturedImDelivery["body"];
      imDeliveries.push({
        authorization: init?.headers ? String((init.headers as Record<string, string>).Authorization ?? (init.headers as Record<string, string>).authorization ?? "") : null,
        receiveIdType: "open_id",
        body,
      });

      return new Response(JSON.stringify({ code: 0, data: { message_id: "message-acceptance", chat_id: "chat-acceptance" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return originalFetch(input, init);
  }) as typeof globalThis.fetch;

  const wss = new WebSocketServer({ noServer: true });
  let activeSocket: import("ws").WebSocket | null = null;

  wss.on("connection", (ws) => {
    activeSocket = ws;
    ws.on("close", () => {
      if (activeSocket === ws) {
        activeSocket = null;
      }
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== `/api/companies/${COMPANY_ID}/events/ws`) {
      socket.destroy();
      return;
    }

    if (req.headers.authorization !== `Bearer ${AGENT_API_KEY}`) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const notifier = new PaperclipInboxLarkNotifier(
    {
      apiUrl: baseUrl,
      companyId: COMPANY_ID,
      agentApiKey: AGENT_API_KEY,
      paperclipBaseUrl: "https://paperclip.example.com",
      dryRun: false,
      logLevel: "error",
      destinationsByUserId: {
        [USER_WEBHOOK]: {
          type: "webhook",
          webhookUrl: `${baseUrl}/open-apis/bot/v2/hook/acceptance`,
        },
        [USER_IM]: {
          type: "open_id",
          receiveId: RECEIVE_ID,
        },
      },
      larkAppId: LARK_APP_ID,
      larkAppSecret: LARK_APP_SECRET,
      requestTimeoutMs: 5_000,
      reconnectBaseMs: 100,
      reconnectMaxMs: 500,
      deliveryRetryCount: 1,
      deliveryRetryBaseMs: 50,
      deliveryRetryMaxMs: 200,
      pollIntervalMs: 250,
      createdVisibilityRetryCount: 3,
      createdVisibilityRetryBaseMs: 20,
      createdVisibilityRetryMaxMs: 50,
      pingIntervalMs: 30_000,
      pingTimeoutMs: 10_000,
    },
    pino({ level: "silent" }),
  );

  const runPromise = notifier.run();

  try {
    await waitFor("websocket connection", () => activeSocket !== null);

    const emitEvent = (event: LiveEvent) => {
      activeSocket?.send(JSON.stringify(event));
    };

    await sleep(100);
    emitEvent({
      id: 1,
      companyId: COMPANY_ID,
      type: "activity.logged",
      createdAt: "2026-04-14T10:40:10.000Z",
      actorType: "agent",
      actorId: ACTOR_AGENT_ID,
      payload: {
        action: "issue.created",
        entityType: "issue",
        entityId: issueCreated.id,
        details: {
          userId: USER_WEBHOOK,
        },
      },
    });

    await waitFor("created deliveries", () => webhookDeliveries.length === 1 && imDeliveries.length === 1);

    scenario = "updated";
    await sleep(100);
    emitEvent({
      id: 2,
      companyId: COMPANY_ID,
      type: "activity.logged",
      createdAt: "2026-04-14T10:45:10.000Z",
      actorType: "agent",
      actorId: ACTOR_AGENT_ID,
      payload: {
        action: "issue.updated",
        entityType: "issue",
        entityId: issueUpdated.id,
        details: {
          _previous: {
            status: "todo",
            priority: "medium",
          },
        },
      },
    });

    await waitFor("updated deliveries", () => webhookDeliveries.length === 2 && imDeliveries.length === 2);

    scenario = "commented";
    await sleep(100);
    emitEvent({
      id: 3,
      companyId: COMPANY_ID,
      type: "activity.logged",
      createdAt: "2026-04-14T10:46:10.000Z",
      actorType: "agent",
      actorId: ACTOR_AGENT_ID,
      payload: {
        action: "issue.comment_added",
        entityType: "issue",
        entityId: issueCommented.id,
        details: {
          bodySnippet: "已经完成了初步方案评审，建议增加 webhook 回调以支持第三方集成场景。",
        },
      },
    });

    await waitFor("comment deliveries", () => webhookDeliveries.length === 3 && imDeliveries.length === 3);
  } finally {
    notifier.stop();
    await runPromise;
    globalThis.fetch = originalFetch;

    await Promise.all([
      new Promise<void>((resolve, reject) => {
        wss.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
    ]);
  }

  if (tokenRequests !== 1) {
    throw new Error(`Expected exactly 1 Lark token request, got ${tokenRequests}`);
  }
  if (webhookDeliveries.length !== 3) {
    throw new Error(`Expected 3 webhook deliveries, got ${webhookDeliveries.length}`);
  }
  if (imDeliveries.length !== 3) {
    throw new Error(`Expected 3 IM deliveries, got ${imDeliveries.length}`);
  }
  for (const delivery of imDeliveries) {
    if (delivery.authorization !== `Bearer ${LARK_TOKEN}`) {
      throw new Error(`Expected IM authorization Bearer ${LARK_TOKEN}, got ${delivery.authorization ?? "missing"}`);
    }
    if (delivery.receiveIdType !== "open_id") {
      throw new Error(`Expected receive_id_type=open_id, got ${delivery.receiveIdType ?? "missing"}`);
    }
    if (delivery.body.receive_id !== RECEIVE_ID) {
      throw new Error(`Expected receive_id=${RECEIVE_ID}, got ${delivery.body.receive_id}`);
    }
    if (delivery.body.msg_type !== "interactive") {
      throw new Error(`Expected IM msg_type=interactive, got ${delivery.body.msg_type}`);
    }
  }
  if ((createdFetchCounts.get(USER_WEBHOOK) ?? 0) < 2 || (createdFetchCounts.get(USER_IM) ?? 0) < 2) {
    throw new Error(`Expected created visibility retries for both users, got ${JSON.stringify(Object.fromEntries(createdFetchCounts))}`);
  }

  const expectedCards = [
    {
      template: "blue",
      titleIncludes: "新 Issue",
      tags: ["待处理", "高"],
      requiredElementIds: ["subtitle", "title", "meta_row", "divider", "open_btn"],
      metaIncludes: [ACTOR_NAME],
    },
    {
      template: "green",
      titleIncludes: "状态更新",
      tags: ["已完成", "高"],
      requiredElementIds: ["subtitle", "title", "meta_row", "divider", "open_btn"],
      metaIncludes: [ACTOR_NAME, "状态: 待处理 → **已完成**", "优先级: 中 → **高**"],
    },
    {
      template: "wathet",
      titleIncludes: "评论提醒",
      tags: ["已阻塞", "紧急"],
      requiredElementIds: ["subtitle", "title", "meta_row", "reply", "divider", "action_row", "open_btn", "reply_btn"],
      replyIncludes: "建议增加 webhook 回调",
      metaIncludes: [ACTOR_NAME],
    },
  ] as const;

  for (let index = 0; index < expectedCards.length; index += 1) {
    assertCard(webhookDeliveries[index]!.card, expectedCards[index]!);
    assertCard(JSON.parse(imDeliveries[index]!.body.content) as Record<string, unknown>, expectedCards[index]!);
  }

  console.log(
    "Acceptance passed: 3 templates validated across webhook and direct IM delivery with created visibility retry, status/priority diff rendering, and comment reply fallback",
  );
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
