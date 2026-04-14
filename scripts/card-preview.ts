/**
 * Send 3 card template previews to Feishu for visual review.
 * Usage: tsx scripts/card-preview.ts
 */

const FEISHU_APP_ID = process.env.FEISHU_APP_ID ?? "";
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET ?? "";
const RECEIVE_ID = "ou_dc2179573c637f78ee3a5538ce96e6c1";

async function getTenantToken(): Promise<string> {
  const res = await fetch(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: FEISHU_APP_ID,
        app_secret: FEISHU_APP_SECRET,
      }),
    },
  );
  const data = (await res.json()) as { tenant_access_token?: string };
  if (!data.tenant_access_token) throw new Error("Failed to get token");
  return data.tenant_access_token;
}

async function sendCard(token: string, card: object, label: string) {
  const endpoint = new URL("https://open.feishu.cn/open-apis/im/v1/messages");
  endpoint.searchParams.set("receive_id_type", "open_id");

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      receive_id: RECEIVE_ID,
      msg_type: "interactive",
      content: JSON.stringify(card),
    }),
  });
  const body = (await res.json()) as { code: number; msg?: string };
  if (body.code !== 0) {
    console.error(`[${label}] FAILED:`, JSON.stringify(body));
  } else {
    console.log(`[${label}] sent ✓`);
  }
}

// ─── Card templates ───

const issueUrl = "https://paperclip.yqbqnn.com/SOL/issues/SOL-42";

/** 1. issue.created */
function cardCreated() {
  return {
    schema: "2.0",
    config: { enable_forward: true, width_mode: "default" },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "🆕 新 Issue 提醒" },
      text_tag_list: [
        { tag: "text_tag", text: { tag: "plain_text", content: "待规划" }, color: "blue" },
        { tag: "text_tag", text: { tag: "plain_text", content: "高" }, color: "orange" },
      ],
    },
    body: {
      direction: "vertical",
      padding: "4px 12px 12px 12px",
      vertical_spacing: "8px",
      elements: [
        {
          tag: "markdown",
          content: "<font color='grey'>Solvely\\.ai · SOL\\-42</font>",
          text_size: "notation",
        },
        {
          tag: "markdown",
          content: `**[研究 Paperclip inbox 通知卡片的最佳实践](${issueUrl})**`,
          text_size: "heading",
        },
        {
          tag: "column_set",
          flex_mode: "flow",
          horizontal_spacing: "default",
          columns: [
            {
              tag: "column",
              width: "auto",
              elements: [
                {
                  tag: "markdown",
                  content: "<font color='grey'>操作人</font>\n**CEO**",
                  text_size: "notation",
                },
              ],
            },
          ],
        },
        { tag: "hr" },
        {
          tag: "button",
          text: { tag: "plain_text", content: "查看详情" },
          type: "primary",
          width: "default",
          multi_url: { url: issueUrl, pc_url: issueUrl, ios_url: issueUrl, android_url: issueUrl },
        },
      ],
    },
  };
}

/** 2. issue.updated — status change */
function cardUpdated() {
  return {
    schema: "2.0",
    config: { enable_forward: true, width_mode: "default" },
    header: {
      template: "green",
      title: { tag: "plain_text", content: "✏️ Issue 状态更新提醒" },
      text_tag_list: [
        { tag: "text_tag", text: { tag: "plain_text", content: "已完成" }, color: "green" },
        { tag: "text_tag", text: { tag: "plain_text", content: "高" }, color: "orange" },
      ],
    },
    body: {
      direction: "vertical",
      padding: "4px 12px 12px 12px",
      vertical_spacing: "8px",
      elements: [
        {
          tag: "markdown",
          content: "<font color='grey'>Solvely\\.ai · SOL\\-42</font>",
          text_size: "notation",
        },
        {
          tag: "markdown",
          content: `**[研究 Paperclip inbox 通知卡片的最佳实践](${issueUrl})**`,
          text_size: "heading",
        },
        {
          tag: "column_set",
          flex_mode: "flow",
          horizontal_spacing: "default",
          columns: [
            {
              tag: "column",
              width: "auto",
              elements: [
                {
                  tag: "markdown",
                  content: "<font color='grey'>操作人</font>\n**SeniorEngineer**",
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
                  content: "<font color='grey'>状态</font>\n待规划 → **已完成**",
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
                  content: "<font color='grey'>优先级</font>\n中 → **高**",
                  text_size: "notation",
                },
              ],
            },
          ],
        },
        { tag: "hr" },
        {
          tag: "button",
          text: { tag: "plain_text", content: "查看详情" },
          type: "primary",
          width: "default",
          multi_url: { url: issueUrl, pc_url: issueUrl, ios_url: issueUrl, android_url: issueUrl },
        },
      ],
    },
  };
}

/** 3. issue.comment_added */
function cardComment() {
  return {
    schema: "2.0",
    config: { enable_forward: true, width_mode: "default" },
    header: {
      template: "wathet",
      title: { tag: "plain_text", content: "💬 Issue 评论提醒" },
      text_tag_list: [
        { tag: "text_tag", text: { tag: "plain_text", content: "进行中" }, color: "turquoise" },
        { tag: "text_tag", text: { tag: "plain_text", content: "高" }, color: "orange" },
      ],
    },
    body: {
      direction: "vertical",
      padding: "4px 12px 12px 12px",
      vertical_spacing: "8px",
      elements: [
        {
          tag: "markdown",
          content: `<font color='grey'>Solvely\\.ai · SOL\\-42</font>  **新增评论**`,
          text_size: "notation",
        },
        {
          tag: "markdown",
          content: `**[研究 Paperclip inbox 通知卡片的最佳实践](${issueUrl})**`,
          text_size: "heading",
        },
        {
          tag: "column_set",
          flex_mode: "flow",
          horizontal_spacing: "default",
          columns: [
            {
              tag: "column",
              width: "auto",
              elements: [
                {
                  tag: "markdown",
                  content: "<font color='grey'>操作人</font>\n**CTO**",
                  text_size: "notation",
                },
              ],
            },
          ],
        },
        {
          tag: "markdown",
          content:
            "<font color='grey'>评论内容</font>\n已经完成了初步方案评审，建议增加 webhook 回调以支持第三方集成场景。具体方案详见 plan 文档。",
          text_size: "normal",
        },
        { tag: "hr" },
        {
          tag: "column_set",
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
                  text: { tag: "plain_text", content: "查看详情" },
                  type: "default",
                  width: "fill",
                  multi_url: {
                    url: issueUrl,
                    pc_url: issueUrl,
                    ios_url: issueUrl,
                    android_url: issueUrl,
                  },
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
                  text: { tag: "plain_text", content: "回复评论" },
                  type: "primary",
                  width: "fill",
                  multi_url: {
                    url: issueUrl,
                    pc_url: issueUrl,
                    ios_url: issueUrl,
                    android_url: issueUrl,
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

async function main() {
  if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
    // Try reading from the notifier run script
    const { execSync } = await import("node:child_process");
    const script = execSync(
      "cat /Users/scorpion/.config/paperclip-inbox-lark-notifier/run.sh",
      { encoding: "utf8" },
    );
    const idMatch = script.match(/FEISHU_APP_ID="([^"]+)"/);
    const secretMatch = script.match(/FEISHU_APP_SECRET=.*\n/);
    if (!idMatch) throw new Error("Cannot find FEISHU_APP_ID");
    // Fallback: read from lark secrets
    throw new Error(
      "Set FEISHU_APP_ID and FEISHU_APP_SECRET env vars, or source the run script first",
    );
  }

  const token = await getTenantToken();
  console.log("Got tenant token ✓\n");

  await sendCard(token, cardCreated(), "1. 新建");
  await new Promise((r) => setTimeout(r, 500));
  await sendCard(token, cardUpdated(), "2. 更新");
  await new Promise((r) => setTimeout(r, 500));
  await sendCard(token, cardComment(), "3. 评论");

  console.log("\nDone — check Feishu for 3 preview cards");
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
