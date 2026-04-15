import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { InboxIssueSummary, LiveEvent, NotifierConfig } from "../src/notifier.js";
import {
  buildIssueCard,
  createInboxSnapshot,
  diffAddedIssues,
  diffChangedIssues,
  isRelevantActivityEvent,
  loadNotifierConfig,
  planIssueNotifications,
  resolveDirectIssueFallback,
  resolveCompanies,
  resolveRefreshUserIds,
  shouldNotifyForAction,
} from "../src/notifier.js";

function makeIssue(overrides: Partial<InboxIssueSummary> = {}): InboxIssueSummary {
  return {
    id: "issue-1",
    identifier: "SOL-99",
    title: "Example issue",
    status: "todo",
    priority: "medium",
    updatedAt: "2026-04-11T00:00:00.000Z",
    lastActivityAt: "2026-04-11T00:00:00.000Z",
    isUnreadForMe: true,
    ...overrides,
  };
}

function makeActivityEvent(action: string, userId?: string): LiveEvent {
  return {
    id: 1,
    companyId: "company-1",
    type: "activity.logged",
    createdAt: "2026-04-11T00:00:00.000Z",
    payload: {
      action,
      entityType: "issue",
      entityId: "issue-1",
      details: userId ? { userId } : {},
    },
  };
}

describe("paperclip inbox Lark notifier helpers", () => {
  it("filters for relevant issue activity events only", () => {
    expect(isRelevantActivityEvent(makeActivityEvent("issue.created"))).toBe(true);
    expect(isRelevantActivityEvent(makeActivityEvent("issue.comment_added"))).toBe(true);
    expect(isRelevantActivityEvent(makeActivityEvent("issue.deleted"))).toBe(false);
    expect(
      isRelevantActivityEvent({
        ...makeActivityEvent("issue.created"),
        payload: {
          action: "issue.created",
          entityType: "project",
          entityId: "project-1",
        },
      }),
    ).toBe(false);
  });

  it("targets only the affected user for local inbox actions", () => {
    const event = makeActivityEvent("issue.inbox_archived", "user-2");
    expect(resolveRefreshUserIds(event, ["user-1", "user-2", "user-3"])).toEqual(["user-2"]);
  });

  it("targets all configured users for shared issue activity", () => {
    const event = makeActivityEvent("issue.comment_added", "user-2");
    expect(resolveRefreshUserIds(event, ["user-1", "user-2"])).toEqual(["user-1", "user-2"]);
  });

  it("diffs newly visible inbox issues", () => {
    const previous = createInboxSnapshot([makeIssue({ id: "issue-1", identifier: "SOL-1" })]);
    const nextIssues = [
      makeIssue({ id: "issue-2", identifier: "SOL-2" }),
      makeIssue({ id: "issue-1", identifier: "SOL-1" }),
    ];

    expect(diffAddedIssues(previous, nextIssues).map((issue) => issue.id)).toEqual(["issue-2"]);
  });

  it("diffs visible inbox issues whose summary fields changed", () => {
    const previous = createInboxSnapshot([makeIssue({ id: "issue-1", status: "todo", updatedAt: "2026-04-11T00:00:00.000Z" })]);
    const nextIssues = [makeIssue({ id: "issue-1", status: "done", updatedAt: "2026-04-11T01:00:00.000Z" })];

    expect(diffChangedIssues(previous, nextIssues).map((issue) => issue.id)).toEqual(["issue-1"]);
  });

  it("suppresses notifications for local read/archive actions", () => {
    const previous = createInboxSnapshot([]);
    const nextIssues = [makeIssue({ id: "issue-2", identifier: "SOL-2" })];

    expect(shouldNotifyForAction("issue.read_marked")).toBe(false);
    expect(
      planIssueNotifications({
        action: "issue.inbox_unarchived",
        previousSnapshot: previous,
        nextIssues,
      }),
    ).toEqual([]);
  });

  it("notifies when a new inbox-visible issue appears after shared activity", () => {
    const previous = createInboxSnapshot([makeIssue({ id: "issue-1", identifier: "SOL-1" })]);
    const nextIssues = [
      makeIssue({ id: "issue-2", identifier: "SOL-2" }),
      makeIssue({ id: "issue-1", identifier: "SOL-1" }),
    ];

    expect(
      planIssueNotifications({
        action: "issue.created",
        previousSnapshot: previous,
        nextIssues,
      }).map((issue) => issue.id),
    ).toEqual(["issue-2"]);
  });

  it("notifies the targeted visible issue for shared updates even when it already exists in the inbox", () => {
    const previous = createInboxSnapshot([makeIssue({ id: "issue-1", identifier: "SOL-1", status: "todo" })]);
    const nextIssues = [makeIssue({ id: "issue-1", identifier: "SOL-1", status: "done" })];

    expect(
      planIssueNotifications({
        action: "issue.updated",
        previousSnapshot: previous,
        nextIssues,
        targetIssueId: "issue-1",
      }).map((issue) => issue.id),
    ).toEqual(["issue-1"]);
  });

  it("skips shared updates when the targeted issue is not visible in the inbox", () => {
    const previous = createInboxSnapshot([makeIssue({ id: "issue-1", identifier: "SOL-1" })]);
    const nextIssues = [makeIssue({ id: "issue-1", identifier: "SOL-1" })];

    expect(
      planIssueNotifications({
        action: "issue.updated",
        previousSnapshot: previous,
        nextIssues,
        targetIssueId: "issue-2",
      }),
    ).toEqual([]);
  });

  it("poll mode notifies both new issues and visible status changes", () => {
    const previous = createInboxSnapshot([makeIssue({ id: "issue-1", identifier: "SOL-1", status: "todo" })]);
    const nextIssues = [
      makeIssue({ id: "issue-1", identifier: "SOL-1", status: "done", updatedAt: "2026-04-11T01:00:00.000Z" }),
      makeIssue({ id: "issue-2", identifier: "SOL-2", status: "todo" }),
    ];

    expect(
      planIssueNotifications({
        action: "poll",
        previousSnapshot: previous,
        nextIssues,
      }).map((issue) => issue.id),
    ).toEqual(["issue-2", "issue-1"]);
  });

  it("falls back to direct issue fetch and injects the issue into the snapshot", async () => {
    const nextSnapshot = createInboxSnapshot([]);
    let requestedIssueId: string | null = null;
    const fetchIssueById = async (issueId: string) => {
      requestedIssueId = issueId;
      return makeIssue({ id: issueId, identifier: "SOL-404" });
    };

    const result = await resolveDirectIssueFallback({
      additions: [],
      nextSnapshot,
      context: {
        action: "issue.updated",
        issueId: "issue-404",
      },
      fetchIssueById,
    });

    expect(requestedIssueId).toBe("issue-404");
    expect(result.additions.map((issue) => issue.id)).toEqual(["issue-404"]);
    expect(result.nextSnapshot.get("issue-404")?.identifier).toBe("SOL-404");
  });

  it("does not use the direct fetch fallback for local inbox actions", async () => {
    const fetchIssueById = async () => {
      throw new Error("should not be called");
    };

    const result = await resolveDirectIssueFallback({
      additions: [],
      nextSnapshot: createInboxSnapshot([]),
      context: {
        action: "issue.read_marked",
        issueId: "issue-404",
      },
      fetchIssueById,
    });

    expect(result.additions).toEqual([]);
    expect(result.nextSnapshot.size).toBe(0);
  });

  it("gracefully skips notification when the direct fetch fallback returns null", async () => {
    const result = await resolveDirectIssueFallback({
      additions: [],
      nextSnapshot: createInboxSnapshot([]),
      context: {
        action: "issue.created",
        issueId: "issue-404",
      },
      fetchIssueById: async () => null,
    });

    expect(result.additions).toEqual([]);
    expect(result.nextSnapshot.size).toBe(0);
  });

  it("builds a Feishu Card 2.0 payload with title, metadata row, and action button", () => {
    const card = buildIssueCard(
      makeIssue({
        identifier: "SOL-2",
        status: "done",
        priority: "high",
      }),
      {
        action: "issue.updated",
        paperclipBaseUrl: "https://paperclip.example.com",
        userId: "user-1",
        previousStatus: "backlog",
        actorName: "TestAgent",
      },
    );

    expect(card.schema).toBe("2.0");
    // issue.updated falls through to status-driven: done → green
    expect(card.header.template).toBe("green");
    // header tags: status + priority
    expect(card.header.text_tag_list.map((tag: { text: { content: string } }) => tag.text.content)).toEqual(["已完成", "高"]);
    // header title is action-based
    expect(card.header.title.content).toContain("状态更新");
    expect(card.config.summary.content).toContain("SOL-2");
    // body elements: subtitle, title, meta_row (with actor + status change), divider, open_btn
    const elementIds = card.body.elements.map((element: { element_id?: string }) => element.element_id);
    expect(elementIds).toContain("subtitle");
    expect(elementIds).toContain("title");
    expect(elementIds).toContain("meta_row");
    expect(elementIds).toContain("open_btn");
    // status tag color for "done" → green
    expect(card.header.text_tag_list[0]!.color).toBe("green");
  });

  it("surfaces reply details for comment-triggered notifications without unread markers", () => {
    const card = buildIssueCard(
      makeIssue({
        identifier: "SOL-3",
        status: "blocked",
        priority: "critical",
      }),
      {
        action: "issue.comment_added",
        paperclipBaseUrl: "https://paperclip.example.com",
        replySnippet: "已经复现，根因是 token 配错了。",
        userId: "user-2",
        actorName: "Agent007",
      },
    );

    // comment_added → wathet (action-driven)
    expect(card.header.template).toBe("wathet");
    expect(card.header.text_tag_list.map((tag: { text: { content: string } }) => tag.text.content)).toEqual(["已阻塞", "紧急"]);
    const elementIds = card.body.elements.map((element: { element_id?: string }) => element.element_id);
    // reply element is present for comment_added
    expect(elementIds).toContain("subtitle");
    expect(elementIds).toContain("title");
    expect(elementIds).toContain("reply");
    expect(elementIds).toContain("meta_row");
    // comment template has reply button
    expect(elementIds).toContain("action_row");

    const replyBlock = card.body.elements.find((element: { element_id?: string }) => element.element_id === "reply");
    expect((replyBlock as { content?: string })?.content).toContain("已经复现");

    // status tag color for "blocked" → red
    expect(card.header.text_tag_list[0]!.color).toBe("red");
  });

  it("loads notifier config from a config file", () => {
    const dir = mkdtempSync(join(tmpdir(), "paperclip-inbox-lark-config-"));
    const configPath = join(dir, "config.json");

    writeFileSync(
      configPath,
      JSON.stringify({
        apiUrl: "https://paperclip.example.com",
        companyId: "company-1",
        agentApiKey: "pcak_test",
        paperclipBaseUrl: "https://paperclip.example.com",
        destinationsByUserId: {
          "user-1": {
            type: "webhook",
            webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/test",
          },
        },
      }),
    );

    try {
      const config = loadNotifierConfig({
        PAPERCLIP_INBOX_LARK_CONFIG_FILE: configPath,
      });

      expect(config.apiUrl).toBe("https://paperclip.example.com");
      expect(config.destinationsByUserId["user-1"]).toEqual({
        type: "webhook",
        webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/test",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lets env values override the config file", () => {
    const dir = mkdtempSync(join(tmpdir(), "paperclip-inbox-lark-config-"));
    const configPath = join(dir, "config.json");

    writeFileSync(
      configPath,
      JSON.stringify({
        apiUrl: "https://paperclip.example.com",
        companyId: "company-1",
        agentApiKey: "pcak_test",
        paperclipBaseUrl: "https://paperclip.example.com",
        destinationsByUserId: {
          "user-1": {
            type: "webhook",
            webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/test",
          },
        },
      }),
    );

    try {
      const config = loadNotifierConfig({
        PAPERCLIP_INBOX_LARK_CONFIG_FILE: configPath,
        PAPERCLIP_INBOX_NOTIFIER_API_URL: "https://override.example.com",
        PAPERCLIP_INBOX_LARK_DRY_RUN: "true",
      });

      expect(config.apiUrl).toBe("https://override.example.com");
      expect(config.dryRun).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads destinations from a separate JSON file", () => {
    const dir = mkdtempSync(join(tmpdir(), "paperclip-inbox-lark-config-"));
    const configPath = join(dir, "config.json");
    const destinationsPath = join(dir, "destinations.json");

    writeFileSync(
      configPath,
      JSON.stringify({
        apiUrl: "https://paperclip.example.com",
        companyId: "company-1",
        agentApiKey: "pcak_test",
        paperclipBaseUrl: "https://paperclip.example.com",
      }),
    );
    writeFileSync(
      destinationsPath,
      JSON.stringify({
        "user-2": {
          type: "webhook",
          webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/test-2",
        },
      }),
    );

    try {
      const config = loadNotifierConfig({
        PAPERCLIP_INBOX_LARK_CONFIG_FILE: configPath,
        PAPERCLIP_INBOX_LARK_DESTINATIONS_FILE: destinationsPath,
      });

      expect(config.destinationsByUserId["user-2"]).toEqual({
        type: "webhook",
        webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/test-2",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts FEISHU/LARK env aliases for direct IM credentials", () => {
    const config = loadNotifierConfig({
      PAPERCLIP_INBOX_NOTIFIER_API_URL: "https://paperclip.example.com",
      PAPERCLIP_INBOX_NOTIFIER_COMPANY_ID: "company-1",
      PAPERCLIP_INBOX_NOTIFIER_AGENT_API_KEY: "pcak_test",
      PAPERCLIP_INBOX_NOTIFIER_BASE_URL: "https://paperclip.example.com",
      PAPERCLIP_INBOX_LARK_DESTINATIONS_JSON: JSON.stringify({
        "user-1": {
          type: "open_id",
          receiveId: "ou_test",
        },
      }),
      FEISHU_APP_ID: "cli_feishu",
      FEISHU_APP_SECRET: "secret_feishu",
    });

    expect(config.larkAppId).toBe("cli_feishu");
    expect(config.larkAppSecret).toBe("secret_feishu");
  });

  it("does not include card_link in built cards", () => {
    const card = buildIssueCard(
      makeIssue({ identifier: "SOL-10", status: "todo", priority: "medium" }),
      {
        action: "issue.created",
        paperclipBaseUrl: "https://paperclip.example.com",
        userId: "user-1",
      },
    );

    expect(card).not.toHaveProperty("card_link");
  });

  it("resolveCompanies returns single company from legacy config", () => {
    const config: NotifierConfig = {
      apiUrl: "https://paperclip.example.com",
      companyId: "company-1",
      companyName: "TestCo",
      agentApiKey: "pcak_test",
      paperclipBaseUrl: "https://paperclip.example.com",
      dryRun: false,
      logLevel: "info",
      destinationsByUserId: {
        "user-1": { type: "webhook", webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/test" },
      },
      requestTimeoutMs: 10_000,
      reconnectBaseMs: 1_000,
      reconnectMaxMs: 30_000,
      deliveryRetryCount: 3,
      deliveryRetryBaseMs: 1_000,
      deliveryRetryMaxMs: 8_000,
      pollIntervalMs: 30_000,
      createdVisibilityRetryCount: 6,
      createdVisibilityRetryBaseMs: 500,
      createdVisibilityRetryMaxMs: 4_000,
      pingIntervalMs: 30_000,
      pingTimeoutMs: 10_000,
    };

    const companies = resolveCompanies(config);
    expect(companies).toHaveLength(1);
    expect(companies[0]!.companyId).toBe("company-1");
    expect(companies[0]!.companyName).toBe("TestCo");
    expect(companies[0]!.agentApiKey).toBe("pcak_test");
    expect(companies[0]!.paperclipBaseUrl).toBe("https://paperclip.example.com");
    expect(companies[0]!.destinationsByUserId).toEqual(config.destinationsByUserId);
  });

  it("resolveCompanies returns multiple companies from multi-company config", () => {
    const config: NotifierConfig = {
      apiUrl: "https://paperclip.example.com",
      companyId: "",
      agentApiKey: "",
      paperclipBaseUrl: "https://paperclip.example.com",
      dryRun: false,
      logLevel: "info",
      destinationsByUserId: {},
      companies: [
        {
          companyId: "company-a",
          companyName: "Company A",
          agentApiKey: "pcak_a",
          destinationsByUserId: {
            "user-1": { type: "webhook", webhookUrl: "https://hook.example.com/a" },
          },
        },
        {
          companyId: "company-b",
          companyName: "Company B",
          agentApiKey: "pcak_b",
          paperclipBaseUrl: "https://other.example.com",
          destinationsByUserId: {
            "user-2": { type: "webhook", webhookUrl: "https://hook.example.com/b" },
          },
        },
      ],
      requestTimeoutMs: 10_000,
      reconnectBaseMs: 1_000,
      reconnectMaxMs: 30_000,
      deliveryRetryCount: 3,
      deliveryRetryBaseMs: 1_000,
      deliveryRetryMaxMs: 8_000,
      pollIntervalMs: 30_000,
      createdVisibilityRetryCount: 6,
      createdVisibilityRetryBaseMs: 500,
      createdVisibilityRetryMaxMs: 4_000,
      pingIntervalMs: 30_000,
      pingTimeoutMs: 10_000,
    };

    const companies = resolveCompanies(config);
    expect(companies).toHaveLength(2);
    expect(companies[0]!.companyId).toBe("company-a");
    expect(companies[0]!.paperclipBaseUrl).toBe("https://paperclip.example.com"); // falls back to top-level
    expect(companies[1]!.companyId).toBe("company-b");
    expect(companies[1]!.paperclipBaseUrl).toBe("https://other.example.com"); // company-level override
  });

  it("loads multi-company config from a config file", () => {
    const dir = mkdtempSync(join(tmpdir(), "paperclip-inbox-lark-config-"));
    const configPath = join(dir, "config.json");

    writeFileSync(
      configPath,
      JSON.stringify({
        apiUrl: "https://paperclip.example.com",
        paperclipBaseUrl: "https://paperclip.example.com",
        companies: [
          {
            companyId: "company-a",
            companyName: "Company A",
            agentApiKey: "pcak_a",
            destinationsByUserId: {
              "user-1": {
                type: "webhook",
                webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/test-a",
              },
            },
          },
          {
            companyId: "company-b",
            agentApiKey: "pcak_b",
            destinationsByUserId: {
              "user-2": {
                type: "webhook",
                webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/test-b",
              },
            },
          },
        ],
      }),
    );

    try {
      const config = loadNotifierConfig({
        PAPERCLIP_INBOX_LARK_CONFIG_FILE: configPath,
      });

      expect(config.companies).toHaveLength(2);
      expect(config.companies![0]!.companyId).toBe("company-a");
      expect(config.companies![1]!.companyId).toBe("company-b");

      const companies = resolveCompanies(config);
      expect(companies).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
