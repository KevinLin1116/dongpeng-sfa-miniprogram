const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");

const TARGET_SHEETS = new Set([
  "05_任务项设置",
  "06_任务执行",
  "16_任务项执行",
]);

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

exports.main = async (event = {}) => {
  try {
    assertToken(event.token);
    if (event.action !== "inspectRelations") throw new Error("不支持的诊断操作");

    const client = new ReadOnlySmartSheetClient();
    client.assertConfigured();
    const sheets = await client.getSheets();
    const selected = sheets.filter((sheet) => TARGET_SHEETS.has(sheetTitle(sheet)));
    const result = {};

    for (const sheet of selected) {
      const title = sheetTitle(sheet);
      const id = sheetId(sheet);
      result[title] = {
        sheetId: id,
        fields: (await client.getFields(id)).map(fieldSnapshot),
      };
    }

    return {
      ok: true,
      readOnly: true,
      docIdMatchedConfiguredValue: Boolean(client.docId),
      requestedSheets: [...TARGET_SHEETS],
      foundSheets: Object.keys(result),
      sheets: result,
    };
  } catch (error) {
    return { ok: false, error: error.message || "诊断失败" };
  }
};
