import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { DurableStateStore } from "./durable-state.js";
import { buildStructuredMentions } from "./mention-utils.js";

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

function cellStrings(value) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return [...new Set(values.map((item) => {
    if (typeof item === "string" || typeof item === "number") {
      return asText(`${item}`);
    }
    return asText(item?.name || item?.text || item?.value);
  }).filter(Boolean))];
}

function normalizeDescription(value) {
  return asText(value).normalize("NFKC").replace(/\s+/g, " ");
}

function firstNonEmpty(value) {
  return cellStrings(value)[0] || "";
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

function thrownApiErrorMessage(error, operation) {
  const payload = error?.response?.data;
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const code = payload.code || error.response?.status;
  const message = asText(payload.msg || payload.message || error.message) || "未知错误";
  const logId = asText(payload.error?.log_id || payload.log_id);
  return `${operation}失败${code ? `（${code}）` : ""}：${message}${logId ? `；log_id=${logId}` : ""}`;
}

async function callApi(operation, request) {
  try {
    return normalizeApiError(await request(), operation);
  } catch (error) {
    const message = thrownApiErrorMessage(error, operation);
    if (message) {
      throw new Error(message, { cause: error });
    }
    throw error;
  }
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
    return { group: "", bases: [], department: "" };
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
  let department = "";
  for (const record of relevant) {
    if (!group) {
      group = firstNonEmpty(record.fields?.[names.group]);
    }
    if (bases.length === 0) {
      bases = cellStrings(record.fields?.[names.base]);
    }
    if (!department) {
      department = firstNonEmpty(record.fields?.[names.department]);
    }
    if (group && bases.length > 0 && department) {
      break;
    }
  }
  return { group, bases, department };
}

function organizationLabels(user) {
  const labels = [
    user?.nickname,
    user?.department,
    user?.work_station,
    user?.city,
    user?.geo,
    user?.job_title,
  ];
  for (const item of user?.department_path || []) {
    labels.push(
      item?.department_name?.name,
      item?.department_path?.department_path_name?.name,
    );
  }
  for (const item of user?.custom_attrs || []) {
    labels.push(
      item?.value?.text,
      item?.value?.name,
      item?.value?.option_value,
    );
  }
  return uniqueStrings(labels);
}

function directoryUser(user, fallback = {}) {
  const openId = asText(user?.open_id || user?.openId || fallback.open_id || fallback.openId);
  const labels = uniqueStrings([
    ...(user?.organizationLabels || user?.organization_labels || []),
    ...(fallback.organizationLabels || fallback.organization_labels || []),
    ...organizationLabels(user),
  ]);
  return {
    openId,
    name: asText(user?.name || fallback.name) || openId,
    organizationLabels: labels,
  };
}

function mergeDirectoryUser(current, incoming) {
  if (!current) {
    return directoryUser(incoming);
  }
  return {
    openId: current.openId,
    name: current.name || incoming.name || current.openId,
    organizationLabels: uniqueStrings([
      ...(current.organizationLabels || []),
      ...(incoming.organizationLabels || incoming.organization_labels || []),
    ]),
  };
}

async function loadMentionOwnerProfiles(client, owners) {
  if (typeof client?.contact?.v3?.user?.get !== "function") {
    return owners.map((owner) => directoryUser(owner));
  }
  return Promise.all(owners.map(async (owner) => {
    try {
      const response = await callApi(`读取${owner.name || "任务负责人"}的通讯录编制信息`, () => client.contact.v3.user.get({
        params: {
          user_id_type: "open_id",
          department_id_type: "open_department_id",
        },
        path: { user_id: owner.openId },
      }));
      return directoryUser(response.data?.user || {}, owner);
    } catch (error) {
      console.warn(`Unable to load organization profile for ${owner.openId}`, error);
      return directoryUser(owner);
    }
  }));
}

async function loadEmployeeDirectory(client, config, { force = false } = {}) {
  if (!force && directoryCache && Date.now() - directoryCache.loadedAt < DIRECTORY_TTL_MS) {
    return directoryCache.users;
  }

  let fullScopeProbe;
  try {
    fullScopeProbe = await callApi("校验全员通讯录授权范围", () => client.contact.v3.user.findByDepartment({
      params: {
        department_id: "0",
        department_id_type: "open_department_id",
        user_id_type: "open_id",
        page_size: 1,
      },
    }));
  } catch (error) {
    throw new Error(
      "Richie 的通讯录授权范围尚未覆盖全集团。请在飞书开放平台把该应用的通讯录可用范围设为全部员工，发布后再试。",
      { cause: error },
    );
  }
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
        usersById.set(user.open_id, directoryUser(user));
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
  for (const mention of buildStructuredMentions(sourceMessage)) {
    for (const token of [mention.key, mention.name ? `@${mention.name}` : ""]) {
      if (token) {
        result = result.split(token).join(" ");
      }
    }
  }
  return result.replace(/\s+/g, " ").trim();
}

function normalizedOrgText(value) {
  return asText(value).normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\s|｜/\\·()（）_-]+/g, "");
}

function organizationOption(user, field, configuredMappings = {}) {
  const options = optionItems(field).map((option) => option.value);
  const allowed = new Set(options);
  const labels = (user?.organizationLabels || []).map(normalizedOrgText).filter(Boolean);
  for (const [value, aliases] of Object.entries(configuredMappings || {})) {
    if (!allowed.has(value)) {
      continue;
    }
    const candidates = uniqueStrings([value, ...(Array.isArray(aliases) ? aliases : [aliases])]);
    if (candidates.some((candidate) => {
      const normalized = normalizedOrgText(candidate);
      return normalized && labels.some((label) => label.includes(normalized));
    })) {
      return value;
    }
  }
  return [...options]
    .sort((left, right) => right.length - left.length)
    .find((option) => {
      const normalized = normalizedOrgText(option);
      return normalized && labels.some((label) => label.includes(normalized));
    }) || "";
}

function organizationDefaults(user, schema, config) {
  const mappings = config.organization_defaults || {};
  const genericBaseValues = new Set([
    ...optionItems(schema.group).map((option) => option.value),
    ...Object.keys(mappings.base || {}),
  ]);
  const specificBaseField = {
    ...schema.base,
    property: {
      ...schema.base?.property,
      options: (schema.base?.property?.options || [])
        .filter((option) => !genericBaseValues.has(asText(option?.name))),
    },
  };
  const base = organizationOption(user, specificBaseField)
    || organizationOption(user, schema.base, mappings.base);
  return {
    group: organizationOption(user, schema.group, mappings.group),
    bases: base ? [base] : [],
    department: organizationOption(user, schema.department, mappings.department),
  };
}

function normalizeTasks(protocol, message, config, records, directory, schema) {
  const sourceMentions = buildStructuredMentions(message, config.bot_open_id);
  const directoryById = new Map(directory.map((user) => [user.openId, user]));
  const rawTasks = Array.isArray(protocol.tasks) ? protocol.tasks : [];
  return rawTasks.map((candidate) => {
    const ownerName = asText(candidateValue(candidate, "owner_name", "ownerName"));
    const suppliedOwnerOpenId = asText(candidateValue(candidate, "owner_open_id", "ownerOpenId"));
    const ownerIdsByName = uniqueStrings(sourceMentions
      .filter((mention) => !mention.is_bot && mention.open_id && mention.name === ownerName)
      .map((mention) => mention.open_id));
    const ownerOpenId = suppliedOwnerOpenId || (ownerIdsByName.length === 1 ? ownerIdsByName[0] : "");
    const historical = latestOwnerDefaults(records, ownerOpenId, config);
    const organization = organizationDefaults(directoryById.get(ownerOpenId), schema, config);
    return {
      description: stripAssignmentMentions(asText(candidateValue(
        candidate,
        "description",
        "task_text_original",
        "task",
      )), message),
      ownerOpenId,
      ownerName,
      group: historical.group || organization.group || asText(candidateValue(candidate, "group")),
      bases: historical.bases.length > 0
        ? historical.bases
        : organization.bases.length > 0
          ? organization.bases
          : uniqueStrings(candidateValue(candidate, "bases", "base")),
      department: historical.department
        || organization.department
        || asText(candidateValue(candidate, "department")),
      reminder: asText(candidateValue(candidate, "reminder_frequency", "reminder")) || "一周一次",
      duplicateMode: asText(candidateValue(candidate, "duplicate_mode", "duplicateMode")) || "none",
      duplicateNote: asText(candidateValue(candidate, "duplicate_note", "duplicateNote")),
    };
  }).filter((task) => task.description);
}

function sourceMentionOwners(message, config) {
  return buildStructuredMentions(message, config.bot_open_id)
    .filter((mention) => !mention.is_bot && mention.open_id)
    .map((mention) => ({ openId: mention.open_id, name: mention.name || mention.open_id }));
}

function mergeDirectoryUsers(directory, additionalUsers) {
  const usersById = new Map(directory.map((user) => [user.openId, user]));
  for (const user of additionalUsers || []) {
    const openId = asText(user?.openId || user?.open_id);
    if (openId) {
      usersById.set(openId, mergeDirectoryUser(usersById.get(openId), directoryUser(user)));
    }
  }
  return [...usersById.values()].sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
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
    width: "fill",
    placeholder: cardText(placeholder),
    options: options.map((option) => ({ text: cardText(option.text), value: option.value })),
    ...(multi
      ? { selected_values: validInitial.length ? validInitial : undefined }
      : { initial_option: validInitial || undefined }),
  };
}

function column(elements, weight = 1) {
  return { tag: "column", width: "weighted", weight, vertical_spacing: "4px", elements };
}

function twoColumns(left, right, { leftWeight = 1, rightWeight = 1 } = {}) {
  return {
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "12px",
    columns: [column(left, leftWeight), column(right, rightWeight)],
  };
}

function confirmButtonRow() {
  return {
    tag: "column_set",
    flex_mode: "none",
    horizontal_align: "right",
    columns: [{
      tag: "column",
      width: "120px",
      elements: [{
        tag: "button",
        name: "confirm_write",
        form_action_type: "submit",
        type: "primary_filled",
        width: "fill",
        text: cardText("确认写入"),
      }],
    }],
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
  const elements = [];

  tasks.forEach((task, offset) => {
    const index = offset + 1;
    if (index > 1) {
      elements.push({ tag: "hr", margin: "16px 0 12px 0" });
    }
    if (tasks.length > 1) {
      elements.push(markdown(`**<font color='blue'>任务 ${index}</font>**`));
    }
    elements.push(
      twoColumns(
        [markdown("**任务描述**"), {
          tag: "input",
          name: `t${index}_desc`,
          input_type: "multiline_text",
          required: true,
          width: "fill",
          rows: 1,
          auto_resize: true,
          max_rows: 3,
          default_value: task.description,
          placeholder: cardText("请输入任务描述"),
        }],
        [markdown("**任务负责人**"), {
          tag: "select_person",
          name: `t${index}_owner`,
          required: true,
          width: "fill",
          options: ownerOptions,
          initial_option: task.ownerOpenId || undefined,
          placeholder: cardText("搜索全集团在职员工"),
        }],
        { leftWeight: 3, rightWeight: 2 },
      ),
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

  elements.push(confirmButtonRow());

  return {
    schema: "2.0",
    config: { update_multi: true, width_mode: "default" },
    header: {
      template: "blue",
      title: cardText("任务录入确认"),
      icon: { tag: "standard_icon", token: "todo_colorful" },
    },
    body: {
      padding: "12px 12px 16px 12px",
      elements: [{
        tag: "form",
        name: "task_intake",
        vertical_spacing: "12px",
        elements,
      }],
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
  const response = await callApi("发送飞书消息", () => channel.rawClient.im.v1.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text }),
      uuid,
    },
  }));
  if (!response.data?.message_id) {
    throw new Error("发送飞书消息成功但未返回 message_id");
  }
  return response.data.message_id;
}

async function sendInteractiveCard(channel, chatId, card, uuid) {
  const response = await callApi("发送任务确认卡片", () => channel.rawClient.im.v1.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      msg_type: "interactive",
      content: JSON.stringify(card),
      uuid,
    },
  }));
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
  const trustedMentionOwners = sourceMentionOwners(message, config);
  const [loadedDirectory, fields, records, mentionProfiles] = await Promise.all([
    loadEmployeeDirectory(client, config),
    listBaseFields(client, config),
    listBaseRecords(client, config),
    loadMentionOwnerProfiles(client, trustedMentionOwners),
  ]);
  const directory = mergeDirectoryUsers(loadedDirectory, mentionProfiles);
  const schema = verifyBaseSchema(fields, config);
  const directoryIds = new Set(directory.map((user) => user.openId));
  let tasks = normalizeTasks(protocol, message, config, records, directory, schema);
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
      sourceMentionOwners: mentionProfiles,
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

function baseV3Record(task, config) {
  return {
    [config.fields.description.name]: task.description,
    [config.fields.owner.name]: [{ id: task.ownerOpenId }],
    [config.fields.group.name]: [task.group],
    [config.fields.base.name]: task.bases,
    [config.fields.department.name]: [task.department],
    [config.fields.reminder.name]: [task.reminder],
  };
}

function baseV3BatchCreatePath(config) {
  const baseToken = encodeURIComponent(config.base_token);
  const tableId = encodeURIComponent(config.table_id);
  return `/open-apis/base/v3/bases/${baseToken}/tables/${tableId}/records/batch_create`;
}

function recordMatchesTask(record, task, config) {
  const fields = record?.fields || {};
  const ownerIds = new Set((Array.isArray(fields[config.fields.owner.name])
    ? fields[config.fields.owner.name]
    : [fields[config.fields.owner.name]])
    .map((owner) => asText(owner?.id || owner?.open_id))
    .filter(Boolean));
  const recordBases = cellStrings(fields[config.fields.base.name]).sort();
  const taskBases = [...task.bases].sort();
  return normalizeDescription(fields[config.fields.description.name]) === normalizeDescription(task.description)
    && ownerIds.has(task.ownerOpenId)
    && firstNonEmpty(fields[config.fields.group.name]) === task.group
    && recordBases.length === taskBases.length
    && recordBases.every((base, index) => base === taskBases[index])
    && firstNonEmpty(fields[config.fields.department.name]) === task.department
    && firstNonEmpty(fields[config.fields.reminder.name]) === task.reminder;
}

function recoveryCutoff(pending) {
  const startedAt = Date.parse(pending.processingAt || pending.lastErrorAt || "");
  return Number.isFinite(startedAt) ? startedAt - 30_000 : 0;
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
      const [loadedDirectory, fields, records] = await Promise.all([
        loadEmployeeDirectory(client, config, { force: true }),
        listBaseFields(client, config),
        listBaseRecords(client, config),
      ]);
      const directory = mergeDirectoryUsers(loadedDirectory, pending.sourceMentionOwners);
      const schema = verifyBaseSchema(fields, config);
      const submitted = readSubmittedTasks(form, pending, directory, schema);
      const existingDescriptions = new Set(records
        .map((record) => normalizeDescription(record.fields?.[config.fields.description.name]))
        .filter(Boolean));
      const canRecoverPriorWrite = pending.status === "processing" || Boolean(pending.lastErrorAt);
      const createdAfter = recoveryCutoff(pending);
      const recovered = [];
      const recoveredRecordIds = new Set();
      const toCreate = [];
      for (const task of submitted) {
        if (task.mode === "skip") {
          continue;
        }
        const recoveredRecord = canRecoverPriorWrite
          ? records.find((record) => (
            normalizeDate(record.created_time) >= createdAfter
              && !recoveredRecordIds.has(record.record_id)
              && recordMatchesTask(record, task, config)
          ))
          : undefined;
        if (recoveredRecord?.record_id) {
          recovered.push({ task, recordId: recoveredRecord.record_id });
          recoveredRecordIds.add(recoveredRecord.record_id);
          continue;
        }
        const isExactDuplicateNow = existingDescriptions.has(normalizeDescription(task.description));
        if (isExactDuplicateNow && task.mode !== "force_add") {
          throw new Error(`“${task.description}”在等待确认期间已出现相同任务；如仍需新增，请重新发起并选择“仍要新增”`);
        }
        toCreate.push(task);
      }

      if (toCreate.length === 0 && recovered.length === 0) {
        throw new Error("确认时所有任务均为已存在任务或被选择跳过，本次没有写入新记录");
      }
      if (toCreate.length > 500) {
        throw new Error("单次确认最多写入 500 条任务");
      }

      let createdRecordIds = [];
      if (toCreate.length > 0) {
        const response = await callApi("写入任务管理表", () => client.request({
          method: "POST",
          url: baseV3BatchCreatePath(config),
          data: { create_records: toCreate.map((task) => baseV3Record(task, config)) },
        }));
        createdRecordIds = response.data?.record_id_list || [];
        if (createdRecordIds.length !== toCreate.length || createdRecordIds.some((recordId) => !recordId)) {
          throw new Error(`任务管理表仅返回 ${createdRecordIds.length}/${toCreate.length} 条成功记录`);
        }
      }

      const completedTasks = [...recovered.map((item) => item.task), ...toCreate];
      await sendPlainText(
        channel,
        config.chat_id,
        successText(completedTasks),
        `task-intake-success-${hashToken(event.messageId)}`,
      );
      await store.write(key, {
        ...pending,
        status: "completed",
        operatorOpenId: event.operator?.openId || "",
        eventId: raw.eventId,
        completedAt: new Date().toISOString(),
        recordIds: [...recovered.map((item) => item.recordId), ...createdRecordIds],
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
