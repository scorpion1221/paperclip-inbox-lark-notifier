#!/usr/bin/env python3
"""Send card template previews to Feishu — one per status color."""
import json, subprocess, time
from pathlib import Path

APP_ID = "cli_a9461ec19db8dbde"
secrets = json.loads((Path.home() / ".openclaw" / "credentials" / "lark.secrets.json").read_text())
APP_SECRET = secrets["lark"]["appSecret"]
RECEIVE_ID = "ou_dc2179573c637f78ee3a5538ce96e6c1"
URL = "https://paperclip.yqbqnn.com/SOL/issues/SOL-42"
MU = {"url": URL, "pc_url": URL, "ios_url": URL, "android_url": URL}

def curl_post(url, headers, data):
    cmd = ["curl", "-s", "-X", "POST", url]
    for k, v in headers.items():
        cmd += ["-H", f"{k}: {v}"]
    cmd += ["-d", json.dumps(data)]
    return json.loads(subprocess.check_output(cmd))

token_resp = curl_post(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {"Content-Type": "application/json"},
    {"app_id": APP_ID, "app_secret": APP_SECRET},
)
TOKEN = token_resp["tenant_access_token"]
print(f"Token: {TOKEN[:10]}...")

def send_card(card, label):
    resp = curl_post(
        "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id",
        {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        {"receive_id": RECEIVE_ID, "msg_type": "interactive", "content": json.dumps(card)},
    )
    code = resp.get("code", -1)
    if code != 0:
        print(f"  [{label}] FAILED: code={code} msg={resp.get('msg','')}")
    else:
        print(f"  [{label}] ✓")

# ── Status → color mapping (matching Paperclip UI) ──
# Header template colors and tag colors for each status
STATUS_MAP = {
    "backlog":     {"zh": "待规划",  "header": "grey",      "tag": "neutral"},
    "todo":        {"zh": "待处理",  "header": "blue",      "tag": "blue"},
    "in_progress": {"zh": "进行中",  "header": "orange",    "tag": "orange"},
    "in_review":   {"zh": "评审中",  "header": "purple",    "tag": "purple"},
    "done":        {"zh": "已完成",  "header": "green",     "tag": "green"},
    "cancelled":   {"zh": "已取消",  "header": "grey",      "tag": "neutral"},
    "blocked":     {"zh": "已阻塞",  "header": "red",       "tag": "red"},
}

def make_update_card(status_key, prev_status_key):
    s = STATUS_MAP[status_key]
    ps = STATUS_MAP[prev_status_key]
    return {
        "schema": "2.0",
        "config": {"enable_forward": True, "width_mode": "default"},
        "header": {
            "template": s["header"],
            "title": {"tag": "plain_text", "content": "✏️ Issue 状态更新提醒"},
            "text_tag_list": [
                {"tag": "text_tag", "text": {"tag": "plain_text", "content": s["zh"]}, "color": s["tag"]},
                {"tag": "text_tag", "text": {"tag": "plain_text", "content": "高"}, "color": "orange"},
            ],
        },
        "card_link": {"url": URL},
        "body": {
            "direction": "vertical",
            "padding": "4px 12px 12px 12px",
            "vertical_spacing": "8px",
            "elements": [
                {"tag": "markdown", "content": "<font color='grey'>Solvely\\.ai · SOL\\-42</font>  **状态变更**", "text_size": "notation"},
                {"tag": "markdown", "content": f"**[研究 Paperclip inbox 通知卡片的最佳实践]({URL})**", "text_size": "heading"},
                {
                    "tag": "column_set", "flex_mode": "flow", "horizontal_spacing": "default",
                    "columns": [
                        {"tag": "column", "width": "auto", "elements": [
                            {"tag": "markdown", "content": "<font color='grey'>操作人</font>\n**SeniorEngineer**", "text_size": "notation"}
                        ]},
                        {"tag": "column", "width": "auto", "elements": [
                            {"tag": "markdown", "content": f"<font color='grey'>状态</font>\n{ps['zh']} → **{s['zh']}**", "text_size": "notation"}
                        ]},
                    ],
                },
                {"tag": "hr"},
                {"tag": "button", "text": {"tag": "plain_text", "content": "查看详情"}, "type": "primary", "width": "default", "multi_url": MU},
            ],
        },
    }

# ── Send all 7 status cards ──
transitions = [
    ("backlog",     "todo",        "Backlog → 灰色"),
    ("todo",        "backlog",     "Todo → 蓝色"),
    ("in_progress", "todo",        "In Progress → 橙色"),
    ("in_review",   "in_progress", "In Review → 紫色"),
    ("done",        "in_review",   "Done → 绿色"),
    ("cancelled",   "in_progress", "Cancelled → 灰色"),
    ("blocked",     "in_progress", "Blocked → 红色"),
]

print("\nSending 7 status color previews...")
for status, prev, label in transitions:
    card = make_update_card(status, prev)
    send_card(card, label)
    time.sleep(0.3)

# ── Also send 1 created + 1 comment for completeness ──
print("\nSending created + comment...")

card_created = {
    "schema": "2.0",
    "config": {"enable_forward": True, "width_mode": "default"},
    "header": {
        "template": "blue",
        "title": {"tag": "plain_text", "content": "🆕 新 Issue 提醒"},
        "text_tag_list": [
            {"tag": "text_tag", "text": {"tag": "plain_text", "content": "待规划"}, "color": "neutral"},
            {"tag": "text_tag", "text": {"tag": "plain_text", "content": "高"}, "color": "orange"},
        ],
    },
    "card_link": {"url": URL},
    "body": {
        "direction": "vertical",
        "padding": "4px 12px 12px 12px",
        "vertical_spacing": "8px",
        "elements": [
            {"tag": "markdown", "content": "<font color='grey'>Solvely\\.ai · SOL\\-42</font>", "text_size": "notation"},
            {"tag": "markdown", "content": f"**[研究 Paperclip inbox 通知卡片的最佳实践]({URL})**", "text_size": "heading"},
            {
                "tag": "column_set", "flex_mode": "flow", "horizontal_spacing": "default",
                "columns": [
                    {"tag": "column", "width": "auto", "elements": [
                        {"tag": "markdown", "content": "<font color='grey'>操作人</font>\n**CEO**", "text_size": "notation"}
                    ]},
                ],
            },
            {"tag": "hr"},
            {"tag": "button", "text": {"tag": "plain_text", "content": "查看详情"}, "type": "primary", "width": "default", "multi_url": MU},
        ],
    },
}
send_card(card_created, "新建 (blue)")
time.sleep(0.3)

card_comment = {
    "schema": "2.0",
    "config": {"enable_forward": True, "width_mode": "default"},
    "header": {
        "template": "wathet",
        "title": {"tag": "plain_text", "content": "💬 Issue 评论提醒"},
        "text_tag_list": [
            {"tag": "text_tag", "text": {"tag": "plain_text", "content": "进行中"}, "color": "orange"},
            {"tag": "text_tag", "text": {"tag": "plain_text", "content": "高"}, "color": "orange"},
        ],
    },
    "card_link": {"url": URL},
    "body": {
        "direction": "vertical",
        "padding": "4px 12px 12px 12px",
        "vertical_spacing": "8px",
        "elements": [
            {"tag": "markdown", "content": f"<font color='grey'>Solvely\\.ai · SOL\\-42</font>  **新增评论**", "text_size": "notation"},
            {"tag": "markdown", "content": f"**[研究 Paperclip inbox 通知卡片的最佳实践]({URL})**", "text_size": "heading"},
            {
                "tag": "column_set", "flex_mode": "flow", "horizontal_spacing": "default",
                "columns": [
                    {"tag": "column", "width": "auto", "elements": [
                        {"tag": "markdown", "content": "<font color='grey'>操作人</font>\n**CTO**", "text_size": "notation"}
                    ]},
                ],
            },
            {"tag": "markdown", "content": "<font color='grey'>评论内容</font>\n已经完成了初步方案评审，建议增加 webhook 回调以支持第三方集成场景。具体方案详见 plan 文档。", "text_size": "normal"},
            {"tag": "hr"},
            {
                "tag": "column_set", "flex_mode": "none", "horizontal_spacing": "default",
                "columns": [
                    {"tag": "column", "width": "weighted", "weight": 1, "elements": [
                        {"tag": "button", "text": {"tag": "plain_text", "content": "查看详情"}, "type": "default", "width": "fill", "multi_url": MU}
                    ]},
                    {"tag": "column", "width": "weighted", "weight": 1, "elements": [
                        {"tag": "button", "text": {"tag": "plain_text", "content": "回复评论"}, "type": "primary", "width": "fill", "multi_url": MU}
                    ]},
                ],
            },
        ],
    },
}
send_card(card_comment, "评论 (wathet)")

print("\nDone — 9 cards total sent to Feishu")
