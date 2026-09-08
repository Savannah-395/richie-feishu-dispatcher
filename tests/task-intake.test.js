import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildTaskIntakeCard,
  handleTaskIntakeCardAction,
  handleTaskIntakeResult,
  parseTaskIntakeProtocol,
  sendTaskIntakeError,
} from "../src/task-intake.js";

const fields = [
  { field_id: "desc", field_name: "任务描述", ui_type: "Text" },
  { field_id: "owner", field_name: "任务负责人", ui_type: "User" },
  {
    field_id: "group",
    field_name: "集团",
    ui_type: "SingleSelect",
    property: { options: [{ name: "医疗" }, { name: "再生" }, { name: "集团" }] },
  },
  {
    field_id: "base",
    field_name: "基地",
    ui_type: "MultiSelect",
    property: {
      options: [
        { name: "集团" },
        { name: "医疗" },
        { name: "再生" },
        { name: "青州" },
        { name: "镇江" },
      ],
    },
  },
  {
    field_id: "department",
    field_name: "部门",
    ui_type: "SingleSelect",
    property: { options: [{ name: "AIT部" }, { name: "生产部" }] },
  },
  {
    field_id: "reminder",
    field_name: "提醒频率",
    ui_type: "SingleSelect",
    property: { options: [{ name: "三天一次" }, { name: "一周一次" }] },
  },
  {
    field_id: "status",
    field_name: "任务状态",
    ui_type: "SingleSelect",
    property: { options: [{ name: "待开始" }, { name: "进行中" }, { name: "已完成" }] },
  },
  { field_id: "start", field_name: "开始日期", ui_type: "DateTime" },
];

const schema = {
  description: fields[0],
  owner: fields[1],
  group: fields[2],
  base: fields[3],
  department: fields[4],
  reminder: fields[5],
  status: fields[6],
  startDate: fields[7],
};

function asyncPages(...pages) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const page of pages) {
        yield page;
      }
    },
  };
}

function makeClient(calls) {
  return {
    request: async (payload) => {
      calls.baseWrites.push(payload);
      if (calls.baseError) {
        throw calls.baseError;
      }
      return {
        code: 0,
        data: {
          record_id_list: payload.data.create_records.map((_, index) => `rec_${index}`),
        },
      };
    },
    contact: {
      v3: {
        user: {
          findByDepartment: async () => ({ code: 0, data: { items: [] } }),
          get: async ({ path: { user_id: userId } }) => ({
            code: 0,
            data: {
              user: userId === "ou_second" || userId === "ou_yanyu"
                ? { open_id: userId, name: "颜宇", nickname: "Haze | 英科再生 镇江 生产部" }
                : { open_id: userId, name: "段星岚", nickname: "Savannah | 英科医疗 AIT部" },
            },
          }),
          listWithIterator: async () => asyncPages({
            items: [
              {
                open_id: "ou_owner",
                name: "段星岚",
                nickname: "Savannah | 英科医疗 AIT部",
                status: { is_activated: true },
              },
              {
                open_id: "ou_second",
                name: "童敏慧",
                nickname: "Haze | 英科再生 镇江 生产部",
                status: { is_activated: true },
              },
              { open_id: "ou_bot", name: "Richie", status: { is_activated: true } },
            ],
          }),
        },
      },
    },
    bitable: {
      v1: {
        appTableField: {
          listWithIterator: async () => asyncPages({ items: fields }),
        },
        appTableRecord: {
          listWithIterator: async () => asyncPages({ items: calls.records || [] }),
        },
      },
    },
    im: {
      v1: {
        message: {
          create: async (payload) => {
            if (calls.messageError) {
              throw calls.messageError;
            }
            if (payload.data.msg_type === "interactive") {
              calls.cards.push(payload);
              return { code: 0, data: { message_id: "om_card" } };
            }
            calls.textMessages.push(payload);
            return { code: 0, data: { message_id: `om_text_${calls.textMessages.length}` } };
          },
        },
      },
    },
  };
}

test("task-intake protocol parser accepts bare and fenced JSON", () => {
  const payload = { protocol: "richie.task-intake.v1", status: "unrecognized", message: "x", tasks: [] };
  assert.deepEqual(parseTaskIntakeProtocol(JSON.stringify(payload)), payload);
  assert.deepEqual(parseTaskIntakeProtocol(`\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``), payload);
  assert.equal(parseTaskIntakeProtocol("ordinary reply"), undefined);
});

test("Feishu HTTP errors keep the API code, message and log id", async () => {
  const messageError = new Error("Request failed with status code 400");
  messageError.response = {
    status: 400,
    data: {
      code: 230099,
      msg: "Failed to create card content",
      error: { log_id: "log_test" },
    },
  };
  const calls = {
    cards: [],
    baseWrites: [],
    textMessages: [],
    records: [],
    messageError,
  };

  await assert.rejects(
    sendTaskIntakeError({ rawClient: makeClient(calls) }, "oc_test", "boom"),
    /发送飞书消息失败（230099）：Failed to create card content；log_id=log_test/,
  );
});

test("compact card has exact Base labels, two-column short fields and strong task separators", () => {
  const card = buildTaskIntakeCard({
    tasks: [
      {
        description: "测试 Maxhub",
        ownerOpenId: "ou_owner",
        group: "医疗",
        bases: ["青州"],
        department: "AIT部",
        reminder: "一周一次",
        duplicateMode: "none",
      },
      {
        description: "测试 Youtube",
        ownerOpenId: "ou_second",
        group: "医疗",
        bases: ["镇江"],
        department: "AIT部",
        reminder: "三天一次",
        duplicateMode: "none",
      },
    ],
    directory: [
      { openId: "ou_owner", name: "段星岚" },
      { openId: "ou_second", name: "童敏慧" },
    ],
    schema,
  });
  const serialized = JSON.stringify(card);
  assert.match(serialized, /任务录入确认/);
  assert.equal(card.header.padding, undefined, "header padding must use the server default");
  for (const label of ["任务描述", "任务负责人", "集团", "基地", "部门", "提醒频率"]) {
    assert.match(serialized, new RegExp(label));
  }
  assert.doesNotMatch(serialized, /任务状态/, "ongoing status is system-written and must stay off the card");
  assert.equal((serialized.match(/column_set/g) || []).length, 7);
  assert.equal((serialized.match(/\"tag\":\"hr\"/g) || []).length, 1);
  assert.doesNotMatch(serialized, /识别结果|查重结果|处理方式|任务已完成/);
  assert.doesNotMatch(serialized, /确认后写入任务管理表/);
  assert.match(serialized, /\"rows\":1/);
  assert.match(serialized, /\"auto_resize\":true/);
  assert.doesNotMatch(serialized, /initial_options/);
  assert.doesNotMatch(serialized, /leftWeight|rightWeight/, "layout options must not leak into card JSON");
  assert.match(serialized, /\"form_action_type\":\"submit\"/);
  const firstTaskRow = card.body.elements[0].elements.find((element) => (
    element.tag === "column_set"
      && element.columns?.[0]?.elements?.some((item) => item.name === "t1_desc")
  ));
  assert.equal(firstTaskRow.flex_mode, "none");
  assert.deepEqual(firstTaskRow.columns.map((item) => item.weight), [3, 2]);
  assert.equal(firstTaskRow.columns[1].elements[1].name, "t1_owner");
  const firstOrganizationRow = card.body.elements[0].elements.find((element) => (
    element.tag === "column_set"
      && element.columns?.[1]?.elements?.some((item) => item.name === "t1_bases")
  ));
  assert.deepEqual(firstOrganizationRow.columns[1].elements[1].selected_values, ["青州"]);
});

test("resident callback writes confirmed Base fields with ongoing status once and sends one structured-mention text", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "richie-task-intake-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const deployDir = path.join(temporary, "deploy", "richie");
  await mkdir(deployDir, { recursive: true });
  const workflowConfigPath = path.join(deployDir, "task-intake.json");
  await writeFile(workflowConfigPath, JSON.stringify({
    chat_id: "oc_test",
    bot_open_id: "ou_bot",
    base_token: "base",
    table_id: "table",
    fields: {
      description: { id: "desc", name: "任务描述", ui_type: "Text" },
      owner: { id: "owner", name: "任务负责人", ui_type: "User" },
      group: { id: "group", name: "集团", ui_type: "SingleSelect" },
      base: { id: "base", name: "基地", ui_type: "MultiSelect" },
      department: { id: "department", name: "部门", ui_type: "SingleSelect" },
      reminder: { id: "reminder", name: "提醒频率", ui_type: "SingleSelect" },
      status: { id: "status", name: "任务状态", ui_type: "SingleSelect", value: "进行中" },
      startDate: { id: "start", name: "开始日期" },
    },
  }), "utf8");

  const calls = {
    cards: [],
    baseWrites: [],
    textMessages: [],
    records: [{
      created_time: 100,
      fields: {
        任务描述: "历史任务",
        任务负责人: [{ id: "ou_owner" }],
        集团: "再生",
        基地: ["镇江"],
        部门: ["生产部"],
        开始日期: 100,
      },
    }],
  };
  const channel = {
    rawClient: makeClient(calls),
  };
  const route = {
    workflow: "task-intake",
    skillName: "lark-workflow-task-intake",
    projectPath: temporary,
    workflowConfigPath,
  };
  const result = {
    finalMessage: JSON.stringify({
      protocol: "richie.task-intake.v1",
      status: "candidates",
      message: "",
      tasks: [{
        description: "完成 Maxhub 功能测试并反馈结果",
        owner_open_id: "ou_owner",
        owner_name: "段星岚",
        group: "医疗",
        bases: ["青州"],
        department: "AIT部",
        reminder_frequency: "一周一次",
        duplicate_mode: "none",
        duplicate_note: "",
      }],
    }),
  };
  const message = {
    chatId: "oc_test",
    messageId: "om_source",
    senderId: "ou_requester",
    mentions: [
      { key: "@_user_1", name: "段星岚", openId: "ou_owner" },
      { key: "@_user_2", name: "Richie", openId: "ou_bot", isBot: true },
    ],
  };

  assert.equal(await handleTaskIntakeResult({
    route,
    message,
    result,
    channel,
    stateDir: path.join(temporary, "state"),
  }), true);
  assert.equal(calls.cards.length, 1);
  assert.equal(calls.baseWrites.length, 0, "preview must never write Base");
  const cardJson = calls.cards[0].data.content;
  assert.match(cardJson, /\"initial_option\":\"再生\"/);
  assert.match(cardJson, /\"selected_values\":\[\"镇江\"\]/);
  assert.match(cardJson, /\"initial_option\":\"生产部\"/);

  const event = {
    messageId: "om_card",
    chatId: "oc_test",
    operator: { openId: "ou_confirmer" },
    action: { tag: "button", name: "confirm_write" },
    raw: {
      event_id: "evt_1",
      action: {
        form_value: JSON.stringify({
          t1_desc: "完成 Maxhub 功能测试并反馈结果",
          t1_owner: "ou_owner",
          t1_group: "医疗",
          t1_bases: ["青州"],
          t1_department: "AIT部",
          t1_reminder: "一周一次",
        }),
      },
    },
  };
  calls.baseError = new Error("connection reset after request");
  await assert.rejects(handleTaskIntakeCardAction({
    event,
    route,
    channel,
    stateDir: path.join(temporary, "state"),
  }), /connection reset after request/);
  assert.equal(calls.baseWrites.length, 1);
  assert.equal(calls.baseWrites[0].method, "POST");
  assert.equal(calls.baseWrites[0].url, "/open-apis/base/v3/bases/base/tables/table/records/batch_create");
  assert.deepEqual(Object.keys(calls.baseWrites[0].data.create_records[0]).sort(), [
    "任务负责人",
    "任务状态",
    "任务描述",
    "基地",
    "提醒频率",
    "部门",
    "集团",
  ].sort());
  assert.deepEqual(calls.baseWrites[0].data.create_records[0].集团, ["医疗"]);
  assert.deepEqual(calls.baseWrites[0].data.create_records[0].基地, ["青州"]);
  assert.deepEqual(calls.baseWrites[0].data.create_records[0].部门, ["AIT部"]);
  assert.deepEqual(calls.baseWrites[0].data.create_records[0].提醒频率, ["一周一次"]);
  assert.deepEqual(calls.baseWrites[0].data.create_records[0].任务状态, ["进行中"]);
  assert.equal(calls.textMessages.length, 0);

  calls.baseError = undefined;
  calls.records = [{
    record_id: "rec_recovered",
    created_time: Date.now(),
    fields: {
      任务描述: "完成 Maxhub 功能测试并反馈结果",
      任务负责人: [{ id: "ou_owner" }],
      集团: "医疗",
      基地: ["青州"],
      部门: "AIT部",
      提醒频率: "一周一次",
      任务状态: "进行中",
    },
  }];
  assert.equal(await handleTaskIntakeCardAction({
    event,
    route,
    channel,
    stateDir: path.join(temporary, "state"),
  }), true);
  assert.equal(calls.baseWrites.length, 1, "retry must recover the prior write instead of creating again");
  assert.equal(calls.textMessages.length, 1);
  const success = JSON.parse(calls.textMessages[0].data.content).text;
  assert.equal(
    success,
    "✅ 任务录入成功\n完成 Maxhub 功能测试并反馈结果 · <at user_id=\"ou_owner\">段星岚</at>",
  );

  await handleTaskIntakeCardAction({
    event,
    route,
    channel,
    stateDir: path.join(temporary, "state"),
  });
  assert.equal(calls.baseWrites.length, 1, "duplicate callback must not write twice");
  assert.equal(calls.textMessages.length, 1, "duplicate callback must not send twice");
});

test("resident workflow recovers missing owner IDs from source mentions", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "richie-task-intake-mention-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const deployDir = path.join(temporary, "deploy", "richie");
  await mkdir(deployDir, { recursive: true });
  const workflowConfigPath = path.join(deployDir, "task-intake.json");
  await writeFile(workflowConfigPath, JSON.stringify({
    chat_id: "oc_test",
    bot_open_id: "ou_bot",
    base_token: "base",
    table_id: "table",
    fields: {
      description: { id: "desc", name: "任务描述", ui_type: "Text" },
      owner: { id: "owner", name: "任务负责人", ui_type: "User" },
      group: { id: "group", name: "集团", ui_type: "SingleSelect" },
      base: { id: "base", name: "基地", ui_type: "MultiSelect" },
      department: { id: "department", name: "部门", ui_type: "SingleSelect" },
      reminder: { id: "reminder", name: "提醒频率", ui_type: "SingleSelect" },
      status: { id: "status", name: "任务状态", ui_type: "SingleSelect", value: "进行中" },
      startDate: { id: "start", name: "开始日期" },
    },
  }), "utf8");

  const calls = { cards: [], baseWrites: [], textMessages: [], records: [] };
  const route = {
    workflow: "task-intake",
    skillName: "lark-workflow-task-intake",
    projectPath: temporary,
    workflowConfigPath,
  };
  const message = {
    chatId: "oc_test",
    messageId: "om_source_missing_ids",
    senderId: "ou_requester",
    mentions: [
      { key: "@_user_1", name: "段星岚" },
      { key: "@_user_2", name: "颜宇" },
      { key: "@_user_3", name: "Richie", isBot: true },
    ],
    raw: {
      message: {
        mentions: [
          { key: "@_user_1", name: "段星岚", id: { open_id: "ou_owner" } },
          { key: "@_user_2", name: "颜宇", id: { open_id: "ou_yanyu" } },
          { key: "@_user_3", name: "Richie", id: { open_id: "ou_bot" } },
        ],
      },
    },
  };
  const result = {
    finalMessage: JSON.stringify({
      protocol: "richie.task-intake.v1",
      status: "candidates",
      message: "",
      tasks: [
        {
          description: "测试一下 maxhub",
          owner_open_id: "",
          owner_name: "段星岚",
          group: "",
          bases: [],
          department: "",
          reminder_frequency: "一周一次",
          duplicate_mode: "none",
          duplicate_note: "",
        },
        {
          description: "测试一下 youtube",
          owner_open_id: "",
          owner_name: "颜宇",
          group: "",
          bases: [],
          department: "",
          reminder_frequency: "一周一次",
          duplicate_mode: "none",
          duplicate_note: "",
        },
      ],
    }),
  };

  assert.equal(await handleTaskIntakeResult({
    route,
    message,
    result,
    channel: { rawClient: makeClient(calls) },
    stateDir: path.join(temporary, "state"),
  }), true);
  assert.equal(calls.cards.length, 1);
  const card = calls.cards[0].data.content;
  assert.match(card, /"initial_option":"ou_owner"/);
  assert.match(card, /"initial_option":"ou_yanyu"/);
  assert.match(card, /"value":"ou_yanyu"/);
  assert.match(card, /"initial_option":"医疗"/);
  assert.match(card, /"selected_values":\["医疗"\]/);
  assert.match(card, /"initial_option":"再生"/);
  assert.match(card, /"selected_values":\["镇江"\]/);
  assert.match(card, /"initial_option":"AIT部"/);
  assert.match(card, /"initial_option":"生产部"/);

  assert.equal(await handleTaskIntakeCardAction({
    event: {
      messageId: "om_card",
      chatId: "oc_test",
      operator: { openId: "ou_confirmer" },
      action: { tag: "button", name: "confirm_write" },
      raw: {
        event_id: "evt_missing_ids",
        action: {
          form_value: JSON.stringify({
            t1_desc: "测试一下 maxhub",
            t1_owner: "ou_owner",
            t1_group: "医疗",
            t1_bases: ["青州"],
            t1_department: "AIT部",
            t1_reminder: "一周一次",
            t2_desc: "测试一下 youtube",
            t2_owner: "ou_yanyu",
            t2_group: "医疗",
            t2_bases: ["青州"],
            t2_department: "AIT部",
            t2_reminder: "一周一次",
          }),
        },
      },
    },
    route,
    channel: { rawClient: makeClient(calls) },
    stateDir: path.join(temporary, "state"),
  }), true);
  assert.equal(calls.baseWrites.length, 1);
  assert.deepEqual(calls.baseWrites[0].data.create_records.map((record) => record.任务负责人), [
    [{ id: "ou_owner" }],
    [{ id: "ou_yanyu" }],
  ]);
  assert.deepEqual(calls.baseWrites[0].data.create_records.map((record) => record.任务状态), [
    ["进行中"],
    ["进行中"],
  ]);
  const successText = JSON.parse(calls.textMessages[0].data.content).text;
  assert.match(successText, /^✅ 任务录入成功\n1\. /);
  assert.match(successText, /\n2\. /);
  assert.match(successText, /<at user_id="ou_owner">段星岚<\/at>/);
  assert.match(successText, /<at user_id="ou_yanyu">颜宇<\/at>/);
});
