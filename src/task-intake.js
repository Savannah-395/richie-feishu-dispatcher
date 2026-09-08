import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { DurableStateStore } from "./durable-state.js";

const PROTOCOL = "richie.task-intake.v1";
const DEFAULT_MAX_CARD_BYTES = 28_000;
const DEFAULT_MAX_TASKS_PER_CARD = 6;
const DIRECTORY_TTL_MS = 10 * 60 * 1000;
let directoryCache;

export const TASK_INTAKE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["protocol", "status", "message", "tasks"],
  properties: {
    protocol: { type: "string", const: PROTOCOL },
    status: { type: "string", enum: ["candidates", "unrecognized", "error"] },
    message: { type: "string" },
    tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "description",
          "owner_open_id",
          "owner_name",
          "group",
          "bases",
          "department",
          "reminder_frequency",
          "duplicate_mode",
          "duplicate_note",
        ],
        properties: {
          description: { type: "string" },
          owner_open_id: { type: "string" },
          owner_name: { type: "string" },
          group: { type: "string" },
          bases: { type: "array", items: { type: "string" } },
          department: { type: "string" },
          reminder_frequency: { type: "string" },
          duplicate_mode: { type: "string", enum: ["none", "similar", "exact"] },
          duplicate_note: { type: "string" },
        },
      },
    },
  },
};

function asText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueStrings(value) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return [...new Set(values.map((item) => asText(`${item}`)).filter(Boolean))];
}

function normalizeDescription(value) {
  return asText(value).normalize("NFKC").replace(/\s+/g, " ");
}

function firstNonEmpty(value) {
  if (Array.isArray(value)) {
    return asText(value[0]?.name || value[0]?.text || value[0]);
  }
  return asText(value?.name || value?.text || value);
}

function normalizeDate(value, fallback = 0) {
  const direct = Number(value);
  if (Number.isFinite(direct) && direct > 0) {
    return direct;
  }
  const parsed = Date.parse(`${value || ""}`);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeApiError(response, operation) {
  if (response?.code && response.code !== 0) {
    throw new Error(`${operation}失败（${response.code}）：${response.msg || "未知错误"}`);
  }
  return response;
}

function hashToken(...parts) {
  return createHash("sha256").update(parts.join(":"), "utf8").digest("hex").slice(0, 32);
}

function optionItems(field) {
  return (field?.property?.options || [])
    .map((option) => ({ text: asText(option.name), value: asText(option.name) }))
    .filter((option) => option.text && option.value);
}

function isActiveEmployee(user, excludedOpenIds) {
  const status = user?.status || {};
  return Boolean(user?.open_id)
    && !excludedOpenIds.has(user.open_id)
    && !status.is_frozen
    && !status.is_resigned
    && !status.is_exited
    && !status.is_unjoin
    && status.is_activated !== false;
}

function getRawCardAction(event) {
  const raw = event?.raw || {};
  const payload = raw.event || raw;
  return {
    eventId: asText(raw.header?.event_id || payload.event_id),
    formValue: payload.action?.form_value ?? raw.action?.form_value,
  };
}

function parseFormValue(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function candidateValue(candidate, ...keys) {
  for (const key of keys) {
    if (candidate?.[key] != null) {
      return candidate[key];
    }
  }
  return undefined;
}

export function parseTaskIntakeProtocol(finalMessage) {
  const source = asText(finalMessage);
  if (!source) {
    return undefined;
  }

  const candidates = [source];
  for (const match of source.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.push(match[1].trim());
  }
  const firstBrace = source.indexOf("{");
  const lastBrace = source.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(source.slice(firstBrace, lastBrace + 1));
  }

  for (const candidateText of candidates) {
    try {
      const parsed = JSON.parse(candidateText);
      if (parsed?.protocol === PROTOCOL) {
        return parsed;
      }
    } catch {
      // Keep trying narrower JSON candidates.
    }
  }
  return undefined;
}

export function isTaskIntakeRoute(route) {
  return route?.workflow === "task-intake" || route?.skillName === "lark-workflow-task-intake";
}

async function loadWorkflowConfig(route) {
  const configuredPath = route?.workflowConfigPath;
  if (!configuredPath) {
    throw new Error("任务录入路由缺少 workflow_config 配置");
  }
  const configPath = path.resolve(
    path.isAbsolute(configuredPath) ? configuredPath : path.join(route.projectPath, configuredPath),
  );
  const config = JSON.parse(await readFile(configPath, "utf8"));
  if (!config.chat_id || !config.base_token || !config.table_id || !config.fields) {
    throw new Error(`任务录入配置不完整：${configPath}`);
  }
  return { ...config, configPath };
}

async function listBaseFields(client, config) {
  const fields = [];
  const iterator = await client.bitable.v1.appTableField.listWithIterator({
    params: { page_size: 100 },
    path: { app_token: config.base_token, table_id: config.table_id },
  });
  for await (const page of iterator) {
    fields.push(...(page?.items || []));
  }
  return fields;
}

function verifyBaseSchema(fields, config) {
  const byId = new Map(fields.map((field) => [field.field_id, field]));
  const result = {};
  for (const [key, expected] of Object.entries(config.fields)) {
    const field = byId.get(expected.id);
    if (!field || field.field_name !== expected.name) {
      throw new Error(`多维表格字段不匹配：${expected.name}（${expected.id}）`);
    }
    if (expected.ui_type && field.ui_type !== expected.ui_type) {
      throw new Error(`多维表格字段类型不匹配：${expected.name} 应为 ${expected.ui_type}，实际为 ${field.ui_type}`);
    }
    result[key] = field;
  }
  return result;
}

async function listBaseRecords(client, config) {
  const records = [];
  const names = Object.values(config.fields).map((field) => field.name);
  const iterator = await client.bitable.v1.appTableRecord.listWithIterator({
    params: {
      page_size: 500,
      user_id_type: "open_id",
      field_names: JSON.stringify(names),
    },
    path: { app_token: config.base_token, table_id: config.table_id },
  });
  for await (const page of iterator) {
    records.push(...(page?.items || []));
  }
  return records;
}

function ownerIds(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => asText(item?.id || item?.open_id || item))
    .filter(Boolean);
}

function latestOwnerDefaults(records, ownerOpenId, config) {
  if (!ownerOpenId) {
    return { group: "", bases: [] };
  }
  const names = Object.fromEntries(Object.entries(config.fields).map(([key, field]) => [key, field.name]));
  const relevant = records
    .filter((record) => ownerIds(record.fields?.[names.owner]).includes(ownerOpenId))
    .sort((left, right) => normalizeDate(
      right.fields?.[names.startDate],
      right.created_time || 0,
    ) - normalizeDate(left.fields?.[names.startDate], left.created_time || 0));

  let group = "";
  let bases = [];
  for (const record of relevant) {
    if (!group) {
      group = firstNonEmpty(record.fields?.[names.group]);
    }
    if (bases.length === 0) {
      bases = uniqueStrings(record.fields?.[names.base]);
    }
    if (group && bases.length > 0) {
      break;
    }
  }
  return { group, bases };
}

async function loadEmployeeDirectory(client, config, { force = false } = {}) {
  if (!force && directoryCache && Date.now() - directoryCache.loadedAt < DIRECTORY_TTL_MS) {
    return directoryCache.users;
  }

  const fullScopeProbe = normalizeApiError(await client.contact.v3.user.findByDepartment({
    params: {
      department_id: "0",
      department_id_type: "open_department_id",
      user_id_type: "open_id",
      page_size: 1,
    },
  }), "校验全员通讯录授权范围");
  if (!fullScopeProbe?.data) {
    throw new Error("Richie 当前没有全集团通讯录授权，无法生成可搜索的任务负责人字段");
  }

  const excludedOpenIds = new Set(uniqueStrings([config.bot_open_id, ...(config.excluded_owner_open_ids || [])]));
  const usersById = new Map();
  const iterator = await client.contact.v3.user.listWithIterator({
    params: {
      user_id_type: "open_id",
      department_id_type: "open_department_id",
      page_size: 50,
    },
  });
  for await (const page of iterator) {
    for (const user of page?.items || []) {
      if (isActiveEmployee(user, excludedOpenIds)) {
        usersById.set(user.open_id, { openId: user.open_id, name: asText(user.name) || user.open_id });
      }
    }
  }

  const users = [...usersById.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  if (users.length === 0) {
    throw new Error("全集团通讯录返回空结果，无法生成任务负责人字段");
  }
  directoryCache = { loadedAt: Date.now(), users };
  return users;
}

function stripAssignmentMentions(description, sourceMessage) {
  let result = asText(description);
  for (const mention of sourceMessage?.mentions || []) {
    for (const token of [mention.key, mention.name ? `@${mention.name}` : ""]) {
      if (token) {
        result = result.split(token).join(" ");
      }
    }
  }
  return result.replace(/\s+/g, " ").trim();
}

function normalizeTasks(protocol, message, config, records) {
  const rawTasks = Array.isArray(protocol.tasks) ? protocol.tasks : [];
  return rawTasks.map((candidate) => {
    const ownerOpenId = asText(candidateValue(candidate, "owner_open_id", "ownerOpenId"));
    const historical = latestOwnerDefaults(records, ownerOpenId, config);
    return {
      description: stripAssignmentMentions(asText(candidateValue(
        candidate,
        "description",
        "task_text_original",
        "task",
      )), message),
      ownerOpenId,
      ownerName: asText(candidateValue(candidate, "owner_name", "ownerName")),
      group: historical.group || asText(candidateValue(candidate, "group")),
      bases: historical.bases.length > 0
        ? historical.bases
        : uniqueStrings(candidateValue(candidate, "bases", "base")),
      department: asText(candidateValue(candidate, "department")),
      reminder: asText(candidateValue(candidate, "reminder_frequency", "reminder")) || "一周一次",
      duplicateMode: asText(candidateValue(candidate, "duplicate_mode", "duplicateMode")) || "none",
      duplicateNote: asText(candidateValue(candidate, "duplicate_note", "duplicateNote")),
    };
  }).filter((task) => task.description);
}

function findExactDuplicates(tasks, records, config) {
  const fieldName = config.fields.description.name;
  const existing = new Set(records.map((record) => normalizeDescription(record.fields?.[fieldName])).filter(Boolean));
  return tasks.map((task) => ({
    ...task,
    duplicateMode: existing.has(normalizeDescription(task.description)) ? "exact" : task.duplicateMode,
  }));
}

function cardText(content) {
  return { tag: "plain_text", content };
}

function markdown(content, extra = {}) {
  return { tag: "markdown", content, ...extra };
}

function staticSelect({ name, placeholder, options, initial, multi = false }) {
  const tag = multi ? "multi_select_static" : "select_static";
  const validValues = new Set(options.map((option) => option.value));
  const validInitial = multi
    ? uniqueStrings(initial).filter((value) => validValues.has(value))
    : validValues.has(initial) ? initial : "";
  return {
    tag,
    name,
    required: true,
    placeholder: cardText(placeholder),
    options: options.map((option) => ({ text: cardText(option.text), value: option.value })),
    ...(multi
      ? { initial_options: validInitial.length ? validInitial : undefined }
      : { initial_option: validInitial || undefined }),
  };
}

function column(elements) {
  return { tag: "column", width: "weighted", weight: 1, elements };
}

function twoColumns(left, right) {
  return {
    tag: "column_set",
    flex_mode: "stretch",
    horizontal_spacing: "12px",
    columns: [column(left), column(right)],
  };
}

function duplicateElements(task, index) {
  if (!["exact", "similar"].includes(task.duplicateMode)) {
    return [];
  }
  const exact = task.duplicateMode === "exact";
  return [
    markdown(exact ? "⚠️ 已存在相同任务" : `⚠️ 发现相似任务${task.duplicateNote ? `：${task.duplicateNote}` : ""}`),
    markdown("**处理方式**"),
    staticSelect({
      name: `t${index}_mode`,
      placeholder: "请选择处理方式",
      initial: exact ? "skip" : "add",
      options: exact
        ? [
            { text: "跳过已有任务", value: "skip" },
            { text: "仍要新增", value: "force_add" },
          ]
        : [
            { text: "新增", value: "add" },
            { text: "跳过相似任务", value: "skip" },
            { text: "仍要新增", value: "force_add" },
          ],
    }),
  ];
}

export function buildTaskIntakeCard({ tasks, directory, schema }) {
  const ownerOptions = directory.map((user) => ({ value: user.openId }));
  const groupOptions = optionItems(schema.group);
  const baseOptions = optionItems(schema.base);
  const departmentOptions = optionItems(schema.department);
  const reminderOptions = optionItems(schema.reminder);
  const elements = [markdown("<font color='grey'>确认后写入任务管理表</font>")];

  tasks.forEach((task, offset) => {
    const index = offset + 1;
    if (index > 1) {
      elements.push({ tag: "hr", margin: "12px 0" });
    }
    if (tasks.length > 1) {
      elements.push(markdown(`**任务 ${index}**`));
    }
    elements.push(
      markdown("**任务描述**"),
      {
        tag: "input",
        name: `t${index}_desc`,
        input_type: "multiline_text",
        required: true,
        rows: 2,
        auto_resize: true,
        max_rows: 4,
        default_value: task.description,
        placeholder: cardText("请输入任务描述"),
      },
      markdown("**任务负责人**"),
      {
        tag: "select_person",
        name: `t${index}_owner`,
        required: true,
        options: ownerOptions,
        initial_option: task.ownerOpenId || undefined,
        placeholder: cardText("搜索全集团在职员工"),
      },
      twoColumns(
        [markdown("**集团**"), staticSelect({
          name: `t${index}_group`,
          placeholder: "请选择集团",
          options: groupOptions,
          initial: task.group,
        })],
        [markdown("**基地**"), staticSelect({
          name: `t${index}_bases`,
          placeholder: "请选择基地",
          options: baseOptions,
          initial: task.bases,
          multi: true,
        })],
      ),
      twoColumns(
        [markdown("**部门**"), staticSelect({
          name: `t${index}_department`,
          placeholder: "请选择部门",
          options: departmentOptions,
          initial: task.department,
        })],
        [markdown("**提醒频率**"), staticSelect({
          name: `t${index}_reminder`,
          placeholder: "请选择提醒频率",
          options: reminderOptions,
          initial: task.reminder,
        })],
      ),
      ...duplicateElements(task, index),
    );
  });

  elements.push({
    tag: "button",
    name: "confirm_write",
    form_action_type: "submit",
    type: "primary",
    text: cardText("确认"),
  });

  return {
    schema: "2.0",
    config: { update_multi: true },
    header: {
      template: "blue",
      title: cardText("任务录入确认"),
    },
    body: {
      elements: [{ tag: "form", name: "task_intake", horizontal_align: "right", elements }],
    },
  };
}

function validateCardSize(card, config) {
  const bytes = Buffer.byteLength(JSON.stringify(card), "utf8");
  if (bytes > (config.max_card_bytes || DEFAULT_MAX_CARD_BYTES)) {
    throw new Error(`确认卡片数据量过大（${bytes} 字节），请拆分任务或联系管理员优化通讯录候选池`);
  }
}

function partitionTasks(tasks, directory, schema, config) {
  const limit = Math.max(1, Math.min(config.max_tasks_per_card || DEFAULT_MAX_TASKS_PER_CARD, 8));
  const groups = [];
  let current = [];
  for (const task of tasks) {
    const proposed = [...current, task];
    const proposedCard = buildTaskIntakeCard({ tasks: proposed, directory, schema });
    const proposedBytes = Buffer.byteLength(JSON.stringify(proposedCard), "utf8");
    const maxBytes = config.max_card_bytes || DEFAULT_MAX_CARD_BYTES;
    if (current.length > 0 && (proposed.length > limit || proposedBytes > maxBytes)) {
      const card = buildTaskIntakeCard({ tasks: current, directory, schema });
      validateCardSize(card, config);
      groups.push({ tasks: current, card });
      current = [task];
    } else {
      current = proposed;
    }
  }
  if (current.length > 0) {
    const card = buildTaskIntakeCard({ tasks: current, directory, schema });
    validateCardSize(card, config);
    groups.push({ tasks: current, card });
  }
  return groups;
}

async function sendPlainText(channel, chatId, text, uuid) {
  const response = normalizeApiError(await channel.rawClient.im.v1.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text }),
      uuid,
    },
  }), "发送飞书消息");
  if (!response.data?.message_id) {
    throw new Error("发送飞书消息成功但未返回 message_id");
  }
  return response.data.message_id;
}

async function sendInteractiveCard(channel, chatId, card, uuid) {
  const response = normalizeApiError(await channel.rawClient.im.v1.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      msg_type: "interactive",
      content: JSON.stringify(card),
      uuid,
    },
  }), "发送任务确认卡片");
  if (!response.data?.message_id) {
    throw new Error("确认卡片发送成功但未返回 message_id");
  }
  return response.data.message_id;
}

function createTaskIntakeStore(stateDir) {
  return new DurableStateStore(path.join(stateDir, "task-intake"));
}

export async function handleTaskIntakeResult({ route, message, result, channel, stateDir }) {
  if (!isTaskIntakeRoute(route)) {
    return false;
  }

  const protocol = parseTaskIntakeProtocol(result?.finalMessage);
  if (!protocol) {
    throw new Error("任务录入 Skill 未返回 richie.task-intake.v1 结构化结果");
  }
  const config = await loadWorkflowConfig(route);
  if (message.chatId !== config.chat_id) {
    throw new Error("任务录入结果的群聊与工作流配置不一致");
  }

  if (protocol.status === "unrecognized" || !Array.isArray(protocol.tasks) || protocol.tasks.length === 0) {
    await sendPlainText(
      channel,
      config.chat_id,
      asText(protocol.message) || "未识别到明确待办，请发送具体任务内容并 @责任人。",
      `task-intake-unrecognized-${hashToken(message.messageId)}`,
    );
    return true;
  }
  if (protocol.status !== "candidates") {
    throw new Error(asText(protocol.message) || "任务录入识别失败");
  }

  const client = channel.rawClient;
  const [directory, fields, records] = await Promise.all([
    loadEmployeeDirectory(client, config),
    listBaseFields(client, config),
    listBaseRecords(client, config),
  ]);
  const schema = verifyBaseSchema(fields, config);
  const directoryIds = new Set(directory.map((user) => user.openId));
  let tasks = normalizeTasks(protocol, message, config, records);
  tasks = findExactDuplicates(tasks, records, config).map((task) => ({
    ...task,
    ownerOpenId: directoryIds.has(task.ownerOpenId) ? task.ownerOpenId : "",
  }));
  if (tasks.length === 0) {
    await sendPlainText(
      channel,
      config.chat_id,
      "未识别到明确待办，请发送具体任务内容并 @责任人。",
      `task-intake-empty-${hashToken(message.messageId)}`,
    );
    return true;
  }

  const store = createTaskIntakeStore(stateDir);
  const groups = partitionTasks(tasks, directory, schema, config);
  for (let offset = 0; offset < groups.length; offset += 1) {
    const group = groups[offset];
    const cardMessageId = await sendInteractiveCard(
      channel,
      config.chat_id,
      group.card,
      `task-intake-card-${hashToken(message.messageId, offset + 1)}`,
    );
    await store.write(`card:${cardMessageId}`, {
      version: 1,
      status: "pending",
      cardMessageId,
      chatId: config.chat_id,
      sourceMessageId: message.messageId,
      requesterOpenId: message.senderId || "",
      projectPath: route.projectPath,
      workflowConfigPath: route.workflowConfigPath,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + (config.pending_ttl_hours || 72) * 60 * 60 * 1000).toISOString(),
      tasks: group.tasks,
      part: offset + 1,
      partCount: groups.length,
    });
  }
  return true;
}

function allowedValues(field) {
  return new Set(optionItems(field).map((option) => option.value));
}

function normalizeSingleFormValue(value) {
  if (Array.isArray(value)) {
    return asText(value[0]?.value || value[0]?.id || value[0]?.open_id || value[0]);
  }
  return asText(value?.value || value?.id || value?.open_id || value);
}

function normalizeMultiFormValue(value) {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return uniqueStrings(parsed.map((item) => item?.value || item?.id || item?.open_id || item));
      }
    } catch {
      return uniqueStrings(value.split(","));
    }
  }
  return uniqueStrings((Array.isArray(value) ? value : [value])
    .map((item) => item?.value || item?.id || item?.open_id || item));
}

function readSubmittedTasks(form, pending, directory, schema) {
  const directoryById = new Map(directory.map((user) => [user.openId, user]));
  const validGroups = allowedValues(schema.group);
  const validBases = allowedValues(schema.base);
  const validDepartments = allowedValues(schema.department);
  const validReminders = allowedValues(schema.reminder);

  return pending.tasks.map((original, offset) => {
    const index = offset + 1;
    const description = asText(form[`t${index}_desc`]);
    const ownerOpenId = normalizeSingleFormValue(form[`t${index}_owner`]);
    const group = normalizeSingleFormValue(form[`t${index}_group`]);
    const bases = normalizeMultiFormValue(form[`t${index}_bases`]);
    const department = normalizeSingleFormValue(form[`t${index}_department`]);
    const reminder = normalizeSingleFormValue(form[`t${index}_reminder`]);
    const mode = original.duplicateMode === "exact"
      ? normalizeSingleFormValue(form[`t${index}_mode`]) || "skip"
      : normalizeSingleFormValue(form[`t${index}_mode`]) || "add";

    if (!description || !ownerOpenId || !group || bases.length === 0 || !department || !reminder) {
      throw new Error(`任务 ${index} 有必填字段未完成`);
    }
    if (!directoryById.has(ownerOpenId)) {
      throw new Error(`任务 ${index} 的任务负责人不属于当前全集团在职员工目录`);
    }
    if (!validGroups.has(group) || !bases.every((base) => validBases.has(base))
      || !validDepartments.has(department) || !validReminders.has(reminder)) {
      throw new Error(`任务 ${index} 包含不属于目标多维表格当前字段选项的值`);
    }
    if (!["add", "skip", "force_add"].includes(mode)) {
      throw new Error(`任务 ${index} 的重复任务处理方式无效`);
    }
    return {
      description,
      ownerOpenId,
      ownerName: directoryById.get(ownerOpenId).name,
      group,
      bases,
      department,
      reminder,
      mode,
      duplicateMode: original.duplicateMode,
    };
  });
}

function baseRecord(task, config) {
  return {
    fields: {
      [config.fields.description.name]: task.description,
      [config.fields.owner.name]: [{ id: task.ownerOpenId }],
      [config.fields.group.name]: task.group,
      [config.fields.base.name]: task.bases,
      [config.fields.department.name]: task.department,
      [config.fields.reminder.name]: task.reminder,
    },
  };
}

function safeMessageText(value) {
  return asText(value).replace(/[<>]/g, (character) => character === "<" ? "＜" : "＞");
}

function successText(tasks) {
  const items = tasks.map((task) => (
    `${safeMessageText(task.description)} <at user_id="${task.ownerOpenId}">${safeMessageText(task.ownerName)}</at>`
  ));
  return `${items.join("、")}，写入成功了。`;
}

export async function handleTaskIntakeCardAction({ event, route, channel, stateDir }) {
  if (!isTaskIntakeRoute(route) || event?.action?.name !== "confirm_write" || event?.action?.tag !== "button") {
    return false;
  }
  const config = await loadWorkflowConfig(route);
  if (event.chatId !== config.chat_id || !event.messageId) {
    return false;
  }
  const raw = getRawCardAction(event);
  const form = parseFormValue(raw.formValue);
  if (!form) {
    throw new Error("确认回调缺少有效的 form_value；请确认已启用 card.action.trigger 并使用最新版 dispatcher");
  }

  const store = createTaskIntakeStore(stateDir);
  const key = `card:${event.messageId}`;
  return store.withLock(key, async () => {
    const pending = await store.read(key);
    if (!pending) {
      throw new Error("找不到这张确认卡片的待处理状态，请重新发送任务内容");
    }
    if (pending.status === "completed" || pending.status === "expired") {
      return true;
    }
    if (pending.status === "processing") {
      const processingAt = Date.parse(pending.processingAt || "");
      if (Number.isFinite(processingAt) && Date.now() - processingAt < 10 * 60 * 1000) {
        return true;
      }
    } else if (pending.status !== "pending") {
      throw new Error("这张确认卡片当前状态异常，请重新发送任务内容");
    }
    if (pending.chatId !== event.chatId || Date.parse(pending.expiresAt || "") < Date.now()) {
      await store.write(key, { ...pending, status: "expired", expiredAt: new Date().toISOString() });
      throw new Error("这张确认卡片已失效，请重新发送任务内容");
    }

    await store.write(key, {
      ...pending,
      status: "processing",
      operatorOpenId: event.operator?.openId || "",
      eventId: raw.eventId,
      processingAt: new Date().toISOString(),
    });

    try {
      const client = channel.rawClient;
      const [directory, fields, records] = await Promise.all([
        loadEmployeeDirectory(client, config, { force: true }),
        listBaseFields(client, config),
        listBaseRecords(client, config),
      ]);
      const schema = verifyBaseSchema(fields, config);
      const submitted = readSubmittedTasks(form, pending, directory, schema);
      const existingDescriptions = new Set(records
        .map((record) => normalizeDescription(record.fields?.[config.fields.description.name]))
        .filter(Boolean));
      const toCreate = [];
      for (const task of submitted) {
        if (task.mode === "skip") {
          continue;
        }
        const isExactDuplicateNow = existingDescriptions.has(normalizeDescription(task.description));
        if (isExactDuplicateNow && task.mode !== "force_add") {
          throw new Error(`“${task.description}”在等待确认期间已出现相同任务；如仍需新增，请重新发起并选择“仍要新增”`);
        }
        toCreate.push(task);
      }

      if (toCreate.length === 0) {
        throw new Error("确认时所有任务均为已存在任务或被选择跳过，本次没有写入新记录");
      }
      if (toCreate.length > 500) {
        throw new Error("单次确认最多写入 500 条任务");
      }

      const response = normalizeApiError(await client.bitable.v1.appTableRecord.batchCreate({
        params: {
          user_id_type: "open_id",
          client_token: hashToken("task-intake", event.messageId),
        },
        path: { app_token: config.base_token, table_id: config.table_id },
        data: { records: toCreate.map((task) => baseRecord(task, config)) },
      }), "写入任务管理表");
      const created = response.data?.records || [];
      if (created.length !== toCreate.length || created.some((record) => !record.record_id)) {
        throw new Error(`任务管理表仅返回 ${created.length}/${toCreate.length} 条成功记录`);
      }

      await sendPlainText(
        channel,
        config.chat_id,
        successText(toCreate),
        `task-intake-success-${hashToken(event.messageId)}`,
      );
      await store.write(key, {
        ...pending,
        status: "completed",
        operatorOpenId: event.operator?.openId || "",
        eventId: raw.eventId,
        completedAt: new Date().toISOString(),
        recordIds: created.map((record) => record.record_id),
      });
      return true;
    } catch (error) {
      await store.write(key, {
        ...pending,
        status: "pending",
        lastErrorAt: new Date().toISOString(),
        lastError: `${error?.message || error}`.slice(0, 1000),
      });
      throw error;
    }
  });
}

export async function sendTaskIntakeError(channel, chatId, message, key = "") {
  return sendPlainText(
    channel,
    chatId,
    `任务录入失败：${asText(message) || "未知错误"}`,
    `task-intake-error-${hashToken(key || chatId, message)}`,
  );
}
