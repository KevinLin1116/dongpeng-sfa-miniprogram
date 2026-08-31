const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");

const TARGET_SHEETS = new Set([
  "04_任务发布",
  "06_任务执行",
  "13_考勤结果",
]);

const RECORD_SAMPLE_LIMIT = 20;
const MIGRATION_CONFIRMATION = "APPLY_ATTENDANCE_SCHEMA_V1";
const ATTENDANCE_PLACE_OPTIONS = [
  "零售门店", "经销商办公室", "项目工地/楼盘", "项目方办公室/门店", "装企门店",
  "建材市场/商圈/家居城", "客户仓库", "佛山总部", "生产基地（含外协厂）",
  "活动/培训/会议现场", "在路上", "异常:非工作场所",
];

function assertToken(received) {
  const expected = String(process.env.SFA_DIAGNOSTIC_TOKEN || "");
  const actual = String(received || "");
  if (!expected || expected.length !== actual.length) {
    throw new Error("诊断口令无效");
  }
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) {
    throw new Error("诊断口令无效");
  }
}

function requestJson(url, body, options = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const request = https.request(url, {
      method: options.method || (payload ? "POST" : "GET"),
      ca: options.ca,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
        ...(options.headers || {}),
      },
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => {
        try {
          resolve(JSON.parse(text));
        } catch (_) {
          reject(new Error("企业微信接口返回了无法解析的数据"));
        }
      });
    });
    request.setTimeout(30_000, () => request.destroy(new Error("企业微信接口请求超时")));
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

class ReadOnlySmartSheetClient {
  constructor() {
    this.corpId = process.env.SFA_WECOM_CORP_ID;
    this.secret = process.env.SFA_WECOM_SECRET;
    this.docId = process.env.SFA_SMART_SHEET_DOC_ID;
    this.proxyUrl = process.env.SFA_PROXY_URL;
    this.proxySecret = process.env.SFA_PROXY_SECRET;
  }

  assertConfigured() {
    const missing = [
      ["SFA_WECOM_CORP_ID", this.corpId],
      ["SFA_WECOM_SECRET", this.secret],
      ["SFA_SMART_SHEET_DOC_ID", this.docId],
      ["SFA_PROXY_URL", this.proxyUrl],
      ["SFA_PROXY_SECRET", this.proxySecret],
    ].filter(([, value]) => !value).map(([name]) => name);
    if (missing.length) throw new Error(`诊断函数缺少环境变量：${missing.join("、")}`);
  }

  async proxyCall(route, input) {
    const rawBody = JSON.stringify(input);
    const timestamp = String(Date.now());
    const nonce = crypto.randomBytes(18).toString("base64url");
    const signature = crypto.createHmac("sha256", this.proxySecret)
      .update(`${timestamp}\n${nonce}\n${rawBody}`)
      .digest("hex");
    const ca = fs.readFileSync(path.join(__dirname, "proxy-ca.pem"));
    return requestJson(`${this.proxyUrl.replace(/\/$/, "")}${route}`, input, {
      ca,
      method: "POST",
      headers: {
        "x-sfa-timestamp": timestamp,
        "x-sfa-nonce": nonce,
        "x-sfa-signature": signature,
      },
    });
  }

  async request(url, body) {
    return this.proxyCall("/v1/wecom/request", {
      url,
      method: body === undefined ? "GET" : "POST",
      body,
    });
  }

  async token() {
    const payload = await this.request(
      `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(this.corpId)}&corpsecret=${encodeURIComponent(this.secret)}`,
    );
    if (payload.errcode !== 0 || !payload.access_token) {
      throw new Error(`获取企业微信凭证失败：${payload.errmsg || payload.errcode}`);
    }
    return payload.access_token;
  }

  async call(endpoint, body) {
    const accessToken = await this.token();
    const payload = await this.request(
      `https://qyapi.weixin.qq.com/cgi-bin/wedoc/smartsheet/${endpoint}?access_token=${encodeURIComponent(accessToken)}`,
      body,
    );
    if (payload.errcode !== 0) {
      throw new Error(`智能表格接口失败：${payload.errmsg || payload.errcode}`);
    }
    return payload;
  }

  async getSheets() {
    const payload = await this.call("get_sheet", { docid: this.docId });
    return payload.properties || payload.sheets || payload.sheet_list || [];
  }

  async getFields(sheetId) {
    const fields = [];
    const limit = 100;
    for (let offset = 0; offset < 2_000; offset += limit) {
      const payload = await this.call("get_fields", {
        docid: this.docId,
        sheet_id: sheetId,
        offset,
        limit,
      });
      const page = payload.fields || [];
      fields.push(...page);
      if (page.length < limit) break;
    }
    return fields;
  }

  async getRecords(sheetId, maximum = RECORD_SAMPLE_LIMIT) {
    const records = [];
    const limit = Math.min(100, maximum);
    for (let offset = 0; offset < maximum; offset += limit) {
      const payload = await this.call("get_records", {
        docid: this.docId,
        sheet_id: sheetId,
        offset,
        limit,
      });
      const page = payload.records || [];
      records.push(...page);
      if (page.length < limit || payload.has_more === false) break;
    }
    return records.slice(0, maximum);
  }

  async addFields(sheetId, fields) {
    return this.call("add_fields", { docid: this.docId, sheet_id: sheetId, fields });
  }

  async updateFields(sheetId, fields) {
    return this.call("update_fields", { docid: this.docId, sheet_id: sheetId, fields });
  }
}

function sheetTitle(sheet) {
  return sheet.title || sheet.properties?.title || "";
}

function sheetId(sheet) {
  return sheet.sheet_id || sheet.properties?.sheet_id || "";
}

function fieldSnapshot(field) {
  const properties = Object.fromEntries(
    Object.entries(field).filter(([key]) => key.startsWith("property_")),
  );
  return {
    fieldId: field.field_id || "",
    title: field.field_title || "",
    type: field.field_type,
    properties,
  };
}

function sheetSnapshot(sheet) {
  const properties = sheet?.properties && typeof sheet.properties === "object" ? sheet.properties : {};
  return {
    sheetId: sheetId(sheet),
    title: sheetTitle(sheet),
    propertyKeys: Object.keys(properties).sort(),
    properties,
  };
}

function workbookSnapshot(client, sheets) {
  return {
    docIdFingerprint: crypto.createHash("sha256").update(String(client.docId || "")).digest("hex").slice(0, 16),
    sheetCount: sheets.length,
    sheets: sheets.map((sheet) => ({ title: sheetTitle(sheet), sheetId: sheetId(sheet) })),
  };
}

function field(title, type, properties = {}) {
  return { field_title: title, field_type: type, ...properties };
}

function singleSelect(title, options) {
  return field(title, "FIELD_TYPE_SINGLE_SELECT", {
    property_single_select: { is_multiple: false, is_quick_add: false, options: options.map((text) => ({ text })) },
  });
}

function fieldsByTitle(fields) {
  return new Map(fields.map((item) => [item.field_title, item]));
}

function attendanceDefinitions(sheetIds) {
  return {
    "04_任务发布": [
      field("提醒提前量（分钟）", "FIELD_TYPE_NUMBER", { property_number: { decimal_places: 0, use_separate: false } }),
      field("自动任务唯一键", "FIELD_TYPE_TEXT"),
      field("自动来源任务", "FIELD_TYPE_REFERENCE", { property_reference: { sub_id: sheetIds["04_任务发布"], field_id: "", is_multiple: false } }),
    ],
    "06_任务执行": [
      field("延期原因", "FIELD_TYPE_TEXT"),
      field("延期操作人", "FIELD_TYPE_USER", { property_user: { is_multiple: false, is_notified: false } }),
    ],
    "13_考勤结果": [
      field("工作内容", "FIELD_TYPE_TEXT"),
      field("当前客户名称", "FIELD_TYPE_TEXT"),
      singleSelect("当前所在地", ATTENDANCE_PLACE_OPTIONS),
      field("签到地址", "FIELD_TYPE_TEXT"),
      field("签到经度", "FIELD_TYPE_TEXT"),
      field("签到纬度", "FIELD_TYPE_TEXT"),
      field("定位精度", "FIELD_TYPE_TEXT"),
      field("签到时间", "FIELD_TYPE_DATE_TIME", { property_date_time: { format: "yyyy-mm-dd hh:mm", auto_fill: false } }),
      field("原图文件ID（审计）", "FIELD_TYPE_TEXT"),
      singleSelect("异常标记", ["是", "否"]),
      field("自动来源任务", "FIELD_TYPE_TEXT"),
    ],
  };
}

function selectionTexts(item) {
  return (item?.property_single_select?.options || []).map((option) => String(option.text || "")).filter(Boolean);
}

function buildAttendanceMigration(selected) {
  const ids = Object.fromEntries(selected.map((sheet) => [sheetTitle(sheet), sheetId(sheet)]));
  const definitions = attendanceDefinitions(ids);
  const plan = { additions: [], statusUpdate: null };
  for (const [title, fields] of Object.entries(definitions)) {
    const existing = fieldsByTitle(selected.find((sheet) => sheetTitle(sheet) === title).fields);
    const missing = fields.filter((definition) => !existing.has(definition.field_title));
    if (missing.length) plan.additions.push({ title, sheetId: ids[title], fields: missing });
  }
  const execution = selected.find((sheet) => sheetTitle(sheet) === "06_任务执行");
  const status = fieldsByTitle(execution.fields).get("当前状态");
  if (!status || status.field_type !== "FIELD_TYPE_SINGLE_SELECT") throw new Error("06_任务执行的“当前状态”必须是单选字段");
  const existingOptions = selectionTexts(status);
  const appended = ["待开始", "未完成"].filter((text) => !existingOptions.includes(text));
  if (appended.length) {
    plan.statusUpdate = {
      sheetId: sheetId(execution),
      field: {
        field_id: status.field_id,
        field_title: status.field_title,
        field_type: status.field_type,
        property_single_select: {
          ...(status.property_single_select || {}),
          options: [...(status.property_single_select?.options || []), ...appended.map((text) => ({ text }))],
        },
      },
      appended,
    };
  }
  return plan;
}

function batches(values, size = 1) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

async function inspectTargetSheets(client) {
  const sheets = await client.getSheets();
  const selected = sheets.filter((sheet) => TARGET_SHEETS.has(sheetTitle(sheet)));
  const result = [];
  for (const sheet of selected) {
    const id = sheetId(sheet);
    result.push({ ...sheet, fields: await client.getFields(id) });
  }
  if (result.length !== TARGET_SHEETS.size) throw new Error("目标智能表格不完整，已停止迁移");
  return result;
}

exports.main = async (event = {}) => {
  try {
    assertToken(event.token);
    if (!["inspectRelations", "applyAttendanceSchemaMigration"].includes(event.action)) throw new Error("不支持的诊断操作");

    const client = new ReadOnlySmartSheetClient();
    client.assertConfigured();
    const selected = await inspectTargetSheets(client);
    const allSheets = await client.getSheets();
    const plan = buildAttendanceMigration(selected);
    if (event.action === "applyAttendanceSchemaMigration") {
      if (event.confirmation !== MIGRATION_CONFIRMATION) throw new Error("迁移确认标记无效");
      for (const operation of plan.additions) {
        for (const fields of batches(operation.fields)) await client.addFields(operation.sheetId, fields);
      }
      if (plan.statusUpdate) await client.updateFields(plan.statusUpdate.sheetId, [plan.statusUpdate.field]);
      const verified = await inspectTargetSheets(client);
      const verifiedPlan = buildAttendanceMigration(verified);
      if (verifiedPlan.additions.length || verifiedPlan.statusUpdate) throw new Error("考勤抽查字段迁移回读校验失败");
      return { ok: true, migrated: true, applied: { additions: plan.additions.map((item) => ({ title: item.title, fields: item.fields.map((entry) => entry.field_title) })), appendedExecutionStatuses: plan.statusUpdate?.appended || [] } };
    }
    const result = {};

    for (const sheet of selected) {
      const title = sheetTitle(sheet);
      const id = sheetId(sheet);
      result[title] = {
        sheetId: id,
        sheet: sheetSnapshot(sheet),
        fields: (await client.getFields(id)).map(fieldSnapshot),
        records: await client.getRecords(id),
      };
    }

    return {
      ok: true,
      readOnly: true,
      docIdMatchedConfiguredValue: Boolean(client.docId),
      requestedSheets: [...TARGET_SHEETS],
      foundSheets: Object.keys(result),
      workbook: workbookSnapshot(client, allSheets),
      sheets: result,
      migrationPlan: { additions: plan.additions.map((item) => ({ title: item.title, fields: item.fields.map((entry) => entry.field_title) })), appendedExecutionStatuses: plan.statusUpdate?.appended || [] },
    };
  } catch (error) {
    return { ok: false, error: error.message || "诊断失败" };
  }
};
