import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { once } from "node:events";
import pino from "pino";
import { WebSocketServer } from "ws";
import { PaperclipInboxLarkNotifier, type InboxIssueSummary, type LiveEvent } from "../src/notifier.js";

const COMPANY_ID = "company-smoke";
const USER_ID = "user-smoke";
const AGENT_API_KEY = "pcak_smoke";

const issue: InboxIssueSummary = {
  id: "issue-smoke-1",
  identifier: "SOL-500",
  title: "Smoke test inbox issue",
  status: "todo",
  priority: "high",
  updatedAt: "2026-04-11T00:00:00.000Z",
  lastActivityAt: "2026-04-11T00:00:00.000Z",
  isUnreadForMe: true,
};

async function main() {
  const deliveries: unknown[] = [];
  const currentIssues: InboxIssueSummary[] = [];
  let createEventSent = false;
  let fetchesAfterCreate = 0;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === `/api/companies/${COMPANY_ID}/agents`) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([]));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/agents/me/inbox/mine") {
      if (req.headers.authorization !== `Bearer ${AGENT_API_KEY}`) {
        res.writeHead(401).end("unauthorized");
        return;
      }

      const userId = url.searchParams.get("userId");
      if (userId !== USER_ID) {
        res.writeHead(400).end("unexpected user");
        return;
      }

      if (createEventSent && currentIssues.length === 0) {
        fetchesAfterCreate += 1;
        if (fetchesAfterCreate >= 2) {
          currentIssues.push(issue);
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(currentIssues));
      return;
    }

    if (req.method === "POST" && url.pathname === "/open-apis/bot/v2/hook/test") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      deliveries.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 0 }));
      return;
    }

    res.writeHead(404).end("not found");
  });

  const wss = new WebSocketServer({ noServer: true });

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

  wss.on("connection", (ws) => {
    setTimeout(() => {
      createEventSent = true;
      const event: LiveEvent = {
        id: 1,
        companyId: COMPANY_ID,
        type: "activity.logged",
        createdAt: new Date().toISOString(),
        payload: {
          action: "issue.created",
          entityType: "issue",
          entityId: issue.id,
          details: { userId: USER_ID },
        },
      };
      ws.send(JSON.stringify(event));
    }, 100);
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
        [USER_ID]: {
          type: "webhook",
          webhookUrl: `${baseUrl}/open-apis/bot/v2/hook/test`,
        },
      },
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
    },
    pino({ level: "silent" }),
  );

  const runPromise = notifier.run();

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (deliveries.length > 0) {
      break;
    }
    await sleep(50);
  }

  notifier.stop();
  await runPromise;
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

  if (deliveries.length !== 1) {
    throw new Error(`Expected exactly one delivery, received ${deliveries.length}`);
  }

  const firstDelivery = deliveries[0] as {
    card?: {
      schema?: string;
      header?: { title?: { content?: string } };
      body?: { elements?: Array<{ element_id?: string }> };
    };
  };
  if (firstDelivery.card?.schema !== "2.0") {
    throw new Error("Expected a Card 2.0 payload in smoke delivery");
  }

  const headerTitle = firstDelivery.card?.header?.title?.content;
  if (!headerTitle || !headerTitle.includes("Issue")) {
    throw new Error(`Unexpected card header title in smoke delivery: ${headerTitle}`);
  }

  const elementIds = firstDelivery.card?.body?.elements?.map((element) => element.element_id) ?? [];
  if (!elementIds.includes("title") || !elementIds.includes("subtitle")) {
    throw new Error(`Unexpected card body layout in smoke delivery: ${elementIds.join(",")}`);
  }

  console.log(`Smoke passed with 1 delivery against ${baseUrl}`);
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
