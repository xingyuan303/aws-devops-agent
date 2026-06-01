# CloudWatch Alarm Auto RCA

> English: [README.en.md](README.en.md)

基于 AWS DevOps Agent 的 CloudWatch 告警自动根因分析系统。当 CloudWatch 告警触发时，系统自动调用 DevOps Agent 进行根因调查，生成结构化 RCA 报告，并通过飞书 Webhook 推送给团队。同时提供飞书 Bot 对话助手，支持直接在飞书中与 DevOps Agent 交互对话以及运行和查看改进建议。


---

## 系统架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                        告警自动处理链路                                │
│                                                                     │
│  CloudWatch Alarm ──→ EventBridge ──→ Step Functions ──→ Lambda     │
│       (ALARM)           (规则匹配)       (工作流编排)      (处理逻辑)   │
│                                                                     │
│  Lambda 链路:                                                        │
│  AlarmRouter → AlarmGrouper → RCAAnalyzer → FeishuNotifier          │
│  (解析过滤)     (告警聚合)     (调用Agent)    (飞书通知)               │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                      飞书 Bot 对话助手 (Lambda + API Gateway)         │
│                                                                     │
│  用户 @Bot ──→ 飞书云端 ──→ POST API Gateway ──→ Lambda ──→ DevOps Agent
│                                        ↓                            │
│                              飞书交互式卡片 ←── Agent 响应             │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 功能特性

- **自动告警捕获**：EventBridge 规则自动捕获 CloudWatch 告警状态变化
- **智能过滤**：支持 all/custom 告警选择模式，namespace/name_pattern/tag 过滤
- **告警聚合**：同一资源 2 分钟内的多个告警自动聚合为一次调查
- **自动根因分析**：调用 AWS DevOps Agent 进行 RCA，生成结构化报告
- **飞书通知**：RCA 结果以交互式卡片推送到飞书群，支持多 Webhook 路由
- **飞书 Bot 对话**：直接在飞书中 @机器人 与 DevOps Agent 对话
- **一键部署**：全部基础设施通过 CDK 定义，`cdk deploy` 即可完成
- **配置热加载**：SSM Parameter Store 管理配置，5 分钟自动刷新

---

## 前置条件

- Node.js >= 20
- AWS CLI 已配置（`aws configure`）
- AWS CDK CLI（`npm install -g aws-cdk`）

---

## 一键部署

### 步骤一：配置飞书（部署前准备）

部署前先在飞书侧完成配置，获取需要的凭证。

> **两个机器人的区别说明**：本系统使用了两种不同的飞书机器人，它们互相独立、互不关联：
>
> | | 自定义机器人（Webhook） | 企业自建应用机器人 |
> |---|---|---|
> | **用途** | 告警自动推送（系统→飞书，单向通知） | 对话式交互（用户↔系统，双向问答） |
> | **创建位置** | 在飞书群聊设置中直接添加 | 在飞书开放平台（开发者后台）创建 |
> | **工作方式** | 系统通过 HTTP POST 往群里发消息 | 用户 @机器人，机器人调用 Agent 后回复 |
> | **凭证** | 一个 Webhook URL | App ID + App Secret + Verification Token |
> | **是否必须** | ✅ 必须（否则收不到告警通知） | ❌ 可选（不需要对话功能可以不配） |
>
> 简单说：「自定义机器人」只是一个接收消息的入口（URL），没有交互能力。「企业自建应用」是一个完整的应用，添加「机器人能力」后它本身就变成一个机器人，可以接收消息并回复。

#### A. 告警自动推送（自定义机器人 Webhook）

1. 打开要接收告警的飞书**群聊**
2. 群设置（右上角 ···）→ **群机器人** → **添加机器人** → 选择 **「自定义机器人」**
3. 填写名称（如"告警通知"），点击「添加」
4. **立即复制 Webhook URL** → 记为 `feishuWebhookUrl`

> ⚠️ Webhook URL 创建时只显示一次，关掉就看不到了。

#### B. 对话式交互（企业自建应用机器人，可选）

如果需要在飞书中 @机器人 与 DevOps Agent 对话：

1. 登录 [飞书开放平台](https://open.feishu.cn/app) → **创建企业自建应用**
2. 填写应用名称（如 `DevOps Agent 助手`）
3. **添加应用能力** → 点击「机器人」的「添加」
4. **权限管理** → 开通以下权限：

| 权限标识 | 说明 |
|---------|------|
| `im:message` | 获取与发送单聊、群组消息 |
| `im:message:send_as_bot` | 以应用的身份发送消息 |
| `im:message.group_at_msg:readonly` | 接收群聊中 @机器人消息 |
| `im:message.p2p_msg:readonly` | 接收用户发给机器人的单聊消息 |
| `im:chat:readonly` | 获取群组信息 |
| `im:resource` | 获取消息中的资源文件（图片/文件） |

5. **凭证与基础信息** → 记录 **App ID** 和 **App Secret**
6. **事件与回调** → **加密策略** → 记录 **Verification Token**
7. 事件订阅方式先选择「将事件发送至请求地址」，请求地址**先留空**（部署后回来填）

> 💡 部署完订阅 `im.message.receive_v1` 事件后（步骤六），打开该事件的详情面板，**确保三个复选框都勾上**（群聊 / 单聊 / 话题）—— 默认只勾了群聊，单聊那个不勾的话私聊消息根本不会推过来。

### 步骤二：获取 AWS DevOps Agent 信息

#### 获取 Agent Space ID

从 DevOps Agent 控制台 URL 中获取：
```
https://4XXXXXXXXXXXXXXXXXXXXc.aidevops.global.app.aws/home
        └── Agent Space ID ──┘
```

或通过 CLI 查询：
```bash
aws devops-agent list-agent-spaces --region us-east-1 --query 'agentSpaces[].{ID:agentSpaceId,Name:name}' --output table
```

#### 获取 DevOps Agent Webhook URL 和 HMAC Secret

在 Agent Space → Settings → Integrations → **Webhooks** → 点 **Add** 创建一个新的 webhook。

> ⚠️ Webhook URL 和 HMAC Secret 都**只在创建时显示一次**，关掉对话框就找不回来，必须当场复制好。

把这两个值组装成 JSON 写进 AWS Secrets Manager（默认 secret 名 `cloudwatch-alarm-auto-rca/devops-agent-webhook`，Lambda 启动时会读它）：

```bash
aws secretsmanager create-secret \
  --region us-east-1 \
  --name cloudwatch-alarm-auto-rca/devops-agent-webhook \
  --secret-string '{"url":"https://event-ai.us-east-1.api.aws/webhook/generic/<webhook-id>","secret":"<HMAC-secret>"}'
```

如果之后要轮换密钥，用 `update-secret` 改值即可，无需重新部署：

```bash
aws secretsmanager update-secret \
  --region us-east-1 \
  --secret-id cloudwatch-alarm-auto-rca/devops-agent-webhook \
  --secret-string '{"url":"...","secret":"..."}'
```

### 步骤三：克隆代码并安装依赖

```bash
git clone https://github.com/xitingy1123/aws-devops-agent.git
cd aws-devops-agent
npm install
```

### 步骤四：CDK Bootstrap（首次部署必须）

```bash
npx cdk bootstrap aws://<account-ID>/us-east-1
```

> 如果之前已 bootstrap 过可跳过。

### 步骤五：部署

所有飞书配置通过 CDK 参数一次性传入，**无需再手动执行 `aws ssm put-parameter`**。DevOps Agent 的 webhook URL + HMAC Secret 走 Secrets Manager（步骤二已创建），不在这里传。

```bash
# 完整部署（告警推送 + 对话 Bot）
npx cdk deploy \
  -c agentSpaceId="你的agentspaceID" \
  -c feishuWebhookUrl="https://open.feishu.cn/open-apis/bot/v2/hook/你的token" \
  -c feishuAppId="cli_a5xxxxxxxx" \
  -c feishuAppSecret="你的App Secret" \
  -c feishuVerificationToken="你的Verification Token"

# 仅部署告警推送（不含对话 Bot）
npx cdk deploy \
  -c agentSpaceId="你的agentspaceID" \
  -c feishuWebhookUrl="https://open.feishu.cn/open-apis/bot/v2/hook/你的token" \
  -c deployFeishuBot=false
```

### 步骤六：配置飞书事件回调地址（仅对话 Bot）

部署完成后 CDK 会输出：
```
FeishuBotWebhookUrl = https://xxxxxxxx.execute-api.us-east-1.amazonaws.com/prod/webhook
```

回到飞书开放平台 → **事件与回调**，**事件配置**和**回调配置**两个 Tab 都要配（用同一个 URL）：

**A. 事件配置**（接收用户发来的消息）

1. 订阅方式 → 编辑 → 选择「将事件发送至请求地址」→ 填上面那个 URL
2. 飞书会自动发验证请求（Lambda 自动响应 challenge）
3. 添加事件 `im.message.receive_v1`


**B. 回调配置**（接收卡片按钮的点击事件）

1. 订阅方式 → 编辑 → 选择「将回调发送至请求地址」→ 填**同一个** URL
2. 添加回调 `card.action.trigger`

> ⚠️ **回调配置必须配**——「立即运行改善计划」「发起调查」「查看改进建议」这些卡片按钮都通过这个事件触发。不配的话按钮按下去没任何反应。

**C. 发布**

4. 版本管理 → 创建版本 → 提交审核 → 发布
5. 在目标群聊中：群设置 → 群机器人 → 添加你创建的应用

### 步骤七：验证

```bash
# 验证告警推送
aws cloudwatch set-alarm-state \
  --alarm-name "任意已存在的告警名" \
  --state-value ALARM \
  --state-reason "Testing RCA pipeline" \
  --region us-east-1

# 验证对话 Bot：在飞书群中 @你的机器人 发送消息
```
---

## CDK 部署的资源清单

| 资源 | 类型 | 说明 |
|------|------|------|
| WorkflowExecutionTable | DynamoDB | 工作流执行记录 |
| AlarmGroupTable | DynamoDB | 告警聚合组 |
| DeadLetterNotificationTable | DynamoDB | 未发送通知死信 |
| AlarmRouterFunction | Lambda | 告警解析与过滤 |
| AlarmGrouperFunction | Lambda | 告警聚合 |
| RCAAnalyzerFunction | Lambda | 调用 DevOps Agent |
| FeishuNotifierFunction | Lambda | 飞书通知 |
| FeishuBotFunction | Lambda | 飞书 Bot 对话（可选） |
| FeishuBotApi | API Gateway | 飞书事件回调端点（可选） |
| AlarmRCAWorkflow | Step Functions | 工作流编排 |
| CloudWatchAlarmRule | EventBridge | 告警事件捕获 |
| SystemConfig | SSM Parameter | 系统配置 |
| WorkflowFailureAlarm | CloudWatch Alarm | 系统健康监控 |
| NotificationFailureAlarm | CloudWatch Alarm | 通知失败监控 |

---

## 配置说明

### SSM 配置参数

路径：`/cloudwatch-alarm-auto-rca/config`

```json
{
  "version": "1.0.0",
  "alarmSelectionMode": "all",          // "all" 或 "custom"
  "selectedAlarmNames": [],             // custom 模式下的白名单
  "alarmFilters": [                     // 过滤规则
    {"type": "namespace", "value": "AWS/EC2", "action": "include"},
    {"type": "name_pattern", "value": "^prod-.*", "action": "include"},
    {"type": "name_pattern", "value": ".*test.*", "action": "exclude"}
  ],
  "feishuWebhooks": [                   // 飞书 Webhook 及路由
    {
      "url": "https://open.feishu.cn/open-apis/bot/v2/hook/xxx",
      "name": "基础设施团队",
      "routingRules": [
        {"field": "namespace", "pattern": "AWS/EC2", "match": "equals"}
      ]
    }
  ],
  "rcaTimeout": 300,                    // RCA 超时（秒）
  "retryPolicy": {"maxRetries": 3, "initialDelay": 5, "backoffMultiplier": 2},
  "groupingWindow": 120,                // 告警聚合窗口（秒）
  "enabledNamespaces": ["AWS/EC2", "AWS/RDS", "AWS/Lambda", "AWS/ECS"],
  "retentionDays": 90                   // 记录保留天数
}
```

> **过滤规则优先级**：exclude 规则优先于 include 规则。告警选择模式优先于过滤规则。

---

## 使用方式
共有以下三个功能：
- Cloudwatch告警自动触发DevopsAgent生成RCA并推送至飞书；
- 在飞书里直接和Devops Agent 对话
- 在飞书里运行改善计划（Improvement Plan）

### 自动告警 RCA

无需操作。任何 CloudWatch 告警触发 ALARM 状态时，系统自动：
1. 解析告警事件
2. 应用过滤规则
3. 聚合同资源告警
4. 调用 DevOps Agent 分析根因
5. 将 RCA 报告以飞书卡片推送到群聊



默认 `alarmSelectionMode = "all"`，即**所有进入 ALARM 状态的告警都会触发 RCA**。如果只想 RCA 一部分告警，改 SSM Parameter `/cloudwatch-alarm-auto-rca/config` 即可，**Lambda 5 分钟内自动加载新配置**，无需 `cdk deploy`。

> 设计原因：筛选规则属于"运行时配置"，会随业务变；CDK 只创建默认空配置，规则放在 SSM 里支持热加载。

#### 三种筛选方式

**1. 白名单模式（最严格）—— 只 RCA 指定名字的告警**

```bash
aws ssm put-parameter --region us-east-1 \
  --name /cloudwatch-alarm-auto-rca/config \
  --overwrite --type String \
  --value '{
    "version":"1.0.0",
    "alarmSelectionMode":"custom",
    "selectedAlarmNames":["EC2-HighCPU-Test","RDS-Conn-Limit"],
    "alarmFilters":[],
    "feishuWebhooks":[{"url":"https://open.feishu.cn/open-apis/bot/v2/hook/<your-token>","name":"默认告警群","routingRules":[]}],
    "rcaTimeout":600,
    "retryPolicy":{"maxRetries":1,"initialDelay":5,"backoffMultiplier":2},
    "groupingWindow":120,
    "enabledNamespaces":["AWS/EC2","AWS/RDS","AWS/Lambda","AWS/ECS"],
    "retentionDays":90
  }'
```

**2. 按 namespace 筛 —— 只 RCA 某些 AWS 服务的告警**

把 `alarmSelectionMode` 留为 `"all"`，用 `alarmFilters` 表达：

```json
{
  "alarmSelectionMode": "all",
  "alarmFilters": [
    {"type": "namespace", "value": "AWS/EC2", "action": "include"},
    {"type": "namespace", "value": "AWS/RDS", "action": "include"}
  ]
}
```

**3. 按名称正则筛 —— 例如只看生产环境告警**

```json
{
  "alarmSelectionMode": "all",
  "alarmFilters": [
    {"type": "name_pattern", "value": "^prod-",  "action": "include"},
    {"type": "name_pattern", "value": ".*test.*","action": "exclude"}
  ]
}
```

#### 筛选规则速查

`alarmFilters[]` 每条规则有三个字段：`type` / `value` / `action`。

| type | 含义 | value 形态举例 |
|---|---|---|
| `namespace` | 告警的指标 namespace **完全相等** | `"AWS/EC2"` |
| `name_pattern` | 告警名按 **正则** 匹配 | `"^prod-.*"` |
| `tag` | 告警资源的 tag(⚠️ 当前未实装：CloudWatch 告警事件 payload 不带资源 tag,需要在 alarm-router 里额外调 `cloudwatch:ListTagsForResource` 才能用——有需要告诉我加上) | `"env=production"` |

| action | 行为 |
|---|---|
| `include` | 命中此规则 → 通过 |
| `exclude` | 命中此规则 → 拒绝 |

**优先级**：`exclude` 优先于 `include`（命中任何 exclude 立即拒绝，不再检查 include）。`alarmSelectionMode='custom'` 优先于 `alarmFilters`（不在白名单的告警直接拒绝，不进 filter 阶段）。

#### Webhook 路由分群（namespace / tag / 告警名）

`feishuWebhooks[]` 里每个群可带 `routingRules[]`，决定该群收哪些告警的卡片。一条告警会发给**所有命中的群**；`routingRules: []` 表示 catch-all（收全部）；若没有任何群命中，则广播给所有群（兜底，避免丢卡片）。

每条规则三个字段 `field` / `pattern` / `match`：

| field | 匹配对象 | pattern 形态举例 |
|---|---|---|
| `namespace` | 告警指标 namespace | `"AWS/RDS"` |
| `alarmName` | 告警名 | `"^teamA-"`（配 `regex`）|
| `tag` | **资源的 AWS tag**（`key=value`）| `"project=abc"` |

`match` 可选 `equals` / `contains` / `regex`。

**tag 路由**：发卡片前，用告警资源的 ARN 调 `tag:GetResources` 拉取资源 tag 来匹配。支持 alarm-router 能拼出 ARN 的服务（EC2、RDS、Lambda、ELB、SQS、DynamoDB、S3、ECS、SNS）；拿不到 tag 时回退到 namespace 规则 / catch-all。需要 FeishuNotifier 具备 `tag:GetResources` 权限（CDK 已自动授予）。

示例 —— 把打了 `project=abc` 的资源告警发到 abc 群，按命名规范把 `teamA-*` 发到 A 组群，其余进默认群：

```json
"feishuWebhooks": [
  { "url": "https://open.feishu.cn/open-apis/bot/v2/hook/<abc>", "name": "abc项目",
    "routingRules": [ { "field": "tag", "pattern": "project=abc", "match": "equals" } ] },
  { "url": "https://open.feishu.cn/open-apis/bot/v2/hook/<teamA>", "name": "A组",
    "routingRules": [ { "field": "alarmName", "pattern": "^teamA-", "match": "regex" } ] },
  { "url": "https://open.feishu.cn/open-apis/bot/v2/hook/<default>", "name": "默认群", "routingRules": [] }
]
```

> tag 键不写死在代码里，只出现在规则 `pattern` 中，将来换成 `team` / `cost-center` 只需改配置。

> ⚠️ **路由 tag ≠ 过滤 tag**：这里是"按资源 tag 决定卡片发哪个群"（已实现）。而 `alarmFilters` 里的 `tag` 类型是"按 dimension 决定告警要不要处理"，按**真资源 tag 过滤**仍未实装（见上一节）。

#### 验证当前生效的配置

```bash
aws ssm get-parameter --region us-east-1 \
  --name /cloudwatch-alarm-auto-rca/config \
  --query 'Parameter.Value' --output text | python3 -m json.tool
```

#### 调试某条告警是否被过滤掉

看 alarm-router Lambda 日志，过滤决策会以结构化 JSON 写日志：

```bash
aws logs tail /aws/lambda/<AlarmRouterFunction-name> \
  --region us-east-1 --since 10m \
  --filter-pattern '{ $.filterReason = * }'
```

或者在 CloudWatch 看自定义指标 `CloudWatchAlarmAutoRCA / AlarmsFiltered`。

### 飞书 Bot 对话

在群聊中 @机器人 + 问题：

```
@DevOps Agent 查看 us-east-1 的 EC2 实例健康状态
@DevOps Agent 最近一周有哪些告警事件？
@DevOps Agent 分析一下 prod-db 的性能瓶颈
@DevOps Agent 生成本周运维健康报告
```

支持多轮对话，Bot 会保持上下文。

#### 在飞书里运行改善计划（Improvement Plan）

机器人在群里能主动跑一次「改善计划」——基于 Agent Space 中已完成的 INVESTIGATION 任务，分析这段时间的运维事件并产出新的改进建议。**触发流程：发关键词唤起菜单卡 → 点「🚀 立即运行改善计划」按钮**。

**第 1 步：唤起菜单卡**

群里 @ 机器人发以下任一关键词（**整条消息就是这个词**，前后空格忽略，大小写无关）：

| 中文 | 英文 |
|---|---|
| `改善计划` | `menu` |
| `改进建议` | `help` |
| `帮助` | `improvements` / `improvement` |

例如：

```
@DevOps Agent 改善计划
@DevOps Agent improvements
```

机器人会回一张菜单卡，里面有两个按钮：

- 🚀 **立即运行改善计划** — 后台调 `CreateBacklogTask({ taskType: 'EVALUATION' })` 用 Agent Space 里第一个 ACTIVE 的 goal 跑一次 evaluation，轮询完成后把新生成的建议作为文本消息发回当前群。约 30 秒 - 2 分钟。
- 🔍 **查看改进建议** — 直接列出 Agent Space 中已存在的所有改进建议（不创建新任务）。

**第 2 步：点按钮就行**

> ⚠️ 改善计划任务**依赖窗口内有已完成的 INVESTIGATION**——如果近期没人触发过事件调查，会收到「改善计划无法启动，必须先有一个已完成的 INVESTIGATION 任务」的提示。等告警自动触发一次 RCA、或在 chat 里让 Agent 跑一次调查后再点。

**注意事项**

- 关键词必须**整条消息严格匹配**，写「我想看看改善计划」不会触发菜单（会被当成普通问答转给 Agent）
- 真要在长句子里触发，把关键词单独发一句即可





---

## 开发

```bash
npm install          # 安装依赖
npm run build        # 编译 TypeScript
npm test             # 运行全部 292 个测试
npm run test:unit    # 仅单元测试
npm run test:property # 仅属性测试
npm run synth        # 生成 CloudFormation 模板
npm run lint         # 类型检查
```

---

## 清理

```bash
npx cdk destroy
```

---

## 许可证

ISC

---

## 进一步阅读

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — 代码内部架构、数据流、关键决策
