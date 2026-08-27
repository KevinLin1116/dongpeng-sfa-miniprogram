const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const CELL_VALUE_KEY_TYPE_FIELD_TITLE = "CELL_VALUE_KEY_TYPE_FIELD_TITLE";
const CELL_VALUE_KEY_TYPE_FIELD_ID = "CELL_VALUE_KEY_TYPE_FIELD_ID";
const WRITE_BATCH_LIMIT = 500;
const READ_PAGE_LIMIT = 1000;
const SYSTEM_MANAGED_FIELD_TITLES = new Set(["创建人", "创建时间", "最后编辑人", "最后编辑时间"]);
const STRUCTURE_CACHE_TTL_MS = Math.max(30_000, Number(process.env.SFA_SMART_SHEET_STRUCTURE_CACHE_TTL_MS || 30_000));
const DIRECT_HTTPS_AGENT = new https.Agent({ keepAlive: true, keepAliveMsecs: 1_000, maxSockets: 16, maxFreeSockets: 8 });

function requestJson(url, body, options = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : "";
    const request = https.request(url, { method: options.method || (body ? "POST" : "GET"), ca: options.ca, agent: options.agent || DIRECT_HTTPS_AGENT, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...(options.headers || {}) } }, (response) => {
      let text = ""; response.setEncoding("utf8"); response.on("data", (chunk) => { text += chunk; }); response.on("end", () => { try { resolve(JSON.parse(text)); } catch (_) { reject(new Error("企业微信接口返回了无法解析的数据")); } });
    });
    request.setTimeout(options.timeoutMs || 30_000, () => request.destroy(new Error("企业微信接口请求超时")));
    request.on("error", reject); if (payload) request.write(payload); request.end();
  });
}

class SmartSheetClient {
  constructor({ corpId, secret, docId, proxyUrl, proxySecret }) {
    this.corpId = corpId;
    this.secret = secret;
    this.docId = docId;
    this.proxyUrl = proxyUrl;
    this.proxySecret = proxySecret;
    this.directAgent = DIRECT_HTTPS_AGENT;
    this.pendingSheets = null;
    this.pendingFields = new Map();
    if (proxyUrl) {
      this.proxyCa = fs.readFileSync(path.join(__dirname, "proxy-ca.pem"));
      this.proxyAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 1_000, maxSockets: 16, maxFreeSockets: 8, ca: this.proxyCa });
    }
  }
  get configured() { return Boolean(this.corpId && this.secret && this.docId); }
  get proxyConfigured() { return Boolean(this.proxyUrl && this.proxySecret); }
  async proxyCall(route, input) {
    const rawBody = JSON.stringify(input);
    const timestamp = String(Date.now()); const nonce = crypto.randomBytes(18).toString("base64url");
    const signature = crypto.createHmac("sha256", this.proxySecret).update(`${timestamp}\n${nonce}\n${rawBody}`).digest("hex");
    return requestJson(`${this.proxyUrl.replace(/\/$/, "")}${route}`, input, { ca: this.proxyCa, agent: this.proxyAgent, method: "POST", headers: { "x-sfa-timestamp": timestamp, "x-sfa-nonce": nonce, "x-sfa-signature": signature } });
  }
  async request(url, body) {
    if (!this.proxyConfigured) return requestJson(url, body, { agent: this.directAgent });
    return this.proxyCall("/v1/wecom/request", { url, method: body ? "POST" : "GET", body });
  }
  async token() { if (this.cachedToken && Date.now() < this.tokenExpiresAt) return this.cachedToken; const payload = await this.request(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(this.corpId)}&corpsecret=${encodeURIComponent(this.secret)}`); if (payload.errcode !== 0) throw new Error(`获取企业微信凭证失败：${payload.errmsg || payload.errcode}`); this.cachedToken = payload.access_token; this.tokenExpiresAt = Date.now() + 6900 * 1000; return this.cachedToken; }
  async call(endpoint, body) { const accessToken = await this.token(); const payload = await this.request(`https://qyapi.weixin.qq.com/cgi-bin/wedoc/smartsheet/${endpoint}?access_token=${encodeURIComponent(accessToken)}`, body); if (payload.errcode !== 0) { const error = new Error(`智能表格接口失败：${payload.errmsg || payload.errcode}`); error.wecomCode = payload.errcode; error.wecomHint = payload.hint || ""; throw error; } return payload; }
  async getSheets(options = {}) {
    const cached = this.sheetCache;
    if (!options.forceRefresh && cached && Date.now() - cached.at < STRUCTURE_CACHE_TTL_MS) return cached.value;
    if (!options.forceRefresh && this.pendingSheets) return this.pendingSheets;
    const request = (async () => {
      const payload = await this.call("get_sheet", { docid: this.docId });
      const value = payload.properties || payload.sheets || payload.sheet_list || [];
      this.sheetCache = { at: Date.now(), value };
      return value;
    })();
    this.pendingSheets = request;
    try { return await request; }
    finally { if (this.pendingSheets === request) this.pendingSheets = null; }
  }
  async getFields(sheetId, options = {}) {
    const cacheKey = `${sheetId}:${(options.fieldIds || []).join(",")}:${(options.fieldTitles || []).join(",")}:${options.viewId || ""}:${options.limit || ""}`;
    const cached = this.fieldsCache && this.fieldsCache.get(cacheKey);
    if (!options.forceRefresh && cached && Date.now() - cached.at < STRUCTURE_CACHE_TTL_MS) return cached.value;
    if (!options.forceRefresh && this.pendingFields.has(cacheKey)) return this.pendingFields.get(cacheKey);
    const request = (async () => {
      const fields = [];
      const limit = normalizePageLimit(options.limit || 100);
      const base = compactObject({
        docid: this.docId,
        sheet_id: sheetId,
        view_id: options.viewId,
        field_ids: normalizeStringArray(options.fieldIds),
        field_titles: normalizeStringArray(options.fieldTitles),
      });
      for (let offset = Number(options.offset || 0); offset < 100_000; offset += limit) {
        const page = (await this.call("get_fields", { ...base, offset, limit })).fields || [];
        fields.push(...page);
        if (page.length < limit) break;
      }
      if (!this.fieldsCache) this.fieldsCache = new Map();
      this.fieldsCache.set(cacheKey, { at: Date.now(), value: fields });
      return fields;
    })();
    this.pendingFields.set(cacheKey, request);
    try { return await request; }
    finally { if (this.pendingFields.get(cacheKey) === request) this.pendingFields.delete(cacheKey); }
  }
  async getFieldContract(sheetId, options = {}) {
    const cacheKey = `${sheetId}:${(options.fieldIds || []).join(",")}:${(options.fieldTitles || []).join(",")}`;
    if (!options.forceRefresh && this.fieldContracts && this.fieldContracts.has(cacheKey)) return this.fieldContracts.get(cacheKey);
    const contract = buildFieldContract(await this.getFields(sheetId, options));
    if (!this.fieldContracts) this.fieldContracts = new Map();
    this.fieldContracts.set(cacheKey, contract);
    return contract;
  }
  invalidateFieldContract(sheetId) {
    if (this.fieldContracts) for (const cacheKey of this.fieldContracts.keys()) if (cacheKey === sheetId || cacheKey.startsWith(`${sheetId}:`)) this.fieldContracts.delete(cacheKey);
    if (this.fieldsCache) for (const cacheKey of this.fieldsCache.keys()) if (cacheKey === sheetId || cacheKey.startsWith(`${sheetId}:`)) this.fieldsCache.delete(cacheKey);
    if (this.pendingFields) for (const cacheKey of this.pendingFields.keys()) if (cacheKey === sheetId || cacheKey.startsWith(`${sheetId}:`)) this.pendingFields.delete(cacheKey);
  }
  async getRecords(sheetId, options = {}) {
    if (options.filterSpec && Array.isArray(options.sort) && options.sort.length) throw businessError("RECORD_QUERY_FILTER_SORT_CONFLICT", "智能表格记录查询不能同时使用筛选和排序");
    const records = [];
    const limit = normalizePageLimit(options.limit);
    const maximum = Number(options.maximum || 100_000);
    const keyType = normalizeKeyType(options.keyType, options.fieldIds);
    const base = compactObject({
      docid: this.docId,
      sheet_id: sheetId,
      view_id: options.viewId,
      record_ids: normalizeStringArray(options.recordIds),
      key_type: keyType,
      field_titles: keyType === CELL_VALUE_KEY_TYPE_FIELD_TITLE ? normalizeStringArray(options.fieldTitles) : undefined,
      field_ids: keyType === CELL_VALUE_KEY_TYPE_FIELD_ID ? normalizeStringArray(options.fieldIds) : undefined,
      sort: Array.isArray(options.sort) && options.sort.length ? options.sort : undefined,
      ver: options.ver,
      filter_spec: options.filterSpec,
    });
    for (let offset = Number(options.offset || 0); offset < maximum; offset += limit) {
      const payload = await this.call("get_records", { ...base, offset, limit });
      const page = payload.records || [];
      records.push(...page);
      if (page.length < limit || payload.has_more === false) break;
      if (offset + limit >= maximum) throw new Error(`智能表格记录超过${maximum}行，无法安全完成全量对账`);
    }
    return records;
  }
  async addRecords(sheetId, records, options = {}) {
    return this.writeRecordBatch("add_records", sheetId, records, options);
  }
  async updateRecords(sheetId, records, options = {}) {
    return this.writeRecordBatch("update_records", sheetId, records, options);
  }
  async addRecordsBatched(sheetId, records, options = {}) {
    return this.writeRecordsBatched("add_records", sheetId, records, options);
  }
  async updateRecordsBatched(sheetId, records, options = {}) {
    return this.writeRecordsBatched("update_records", sheetId, records, options);
  }
  async writeRecordBatch(endpoint, sheetId, records, options = {}) {
    validateWriteBatch(records, endpoint);
    const keyType = normalizeKeyType(options.keyType, options.fieldIds);
    assertWritableRecords(records, { keyType, systemFieldIds: options.systemFieldIds });
    return this.call(endpoint, { docid: this.docId, sheet_id: sheetId, key_type: keyType, records });
  }
  async writeRecordsBatched(endpoint, sheetId, records, options = {}) {
    if (!Array.isArray(records) || !records.length) throw new Error("智能表格写入记录不能为空");
    const batches = [];
    const mergedRecords = [];
    for (let index = 0; index < records.length; index += WRITE_BATCH_LIMIT) {
      const input = records.slice(index, index + WRITE_BATCH_LIMIT);
      const response = await this.writeRecordBatch(endpoint, sheetId, input, options);
      batches.push({ index: batches.length, offset: index, size: input.length, response });
      if (Array.isArray(response.records)) mergedRecords.push(...response.records);
    }
    return { errcode: 0, errmsg: "ok", records: mergedRecords, batches };
  }
  async findUniqueRecord(sheetId, { fieldTitle, value, recordIds, fieldTitles } = {}) {
    if (!fieldTitle) throw new Error("唯一键查询缺少中文字段名");
    const requestedTitles = Array.from(new Set([fieldTitle, ...(fieldTitles || [])]));
    const records = await this.getRecords(sheetId, { recordIds, fieldTitles: requestedTitles, keyType: CELL_VALUE_KEY_TYPE_FIELD_TITLE });
    const expected = String(value === undefined || value === null ? "" : value).trim();
    const matches = records.filter((record) => cellText(record, fieldTitle).trim() === expected);
    if (matches.length > 1) throw businessError("UNIQUE_KEY_CONFLICT", `字段“${fieldTitle}”的值“${expected}”存在${matches.length}条记录，请先在智能表格中处理重复数据`, { fieldTitle, value: expected, recordIds: matches.map((record) => record.record_id) });
    return matches[0] || undefined;
  }
  async uploadImage(buffer) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("上传文档图片缺少图片内容");
    const accessToken = await this.token();
    const payload = await this.request(`https://qyapi.weixin.qq.com/cgi-bin/wedoc/image_upload?access_token=${encodeURIComponent(accessToken)}`, { docid: this.docId, base64_content: buffer.toString("base64") });
    if (payload.errcode !== 0 || !payload.url) throw new Error(`上传文档图片失败：${payload.errmsg || payload.errcode}`);
    return payload;
  }
  async uploadImageOnce(buffer, { cacheKey, cache } = {}) {
    if (!cacheKey || !cache) return this.uploadImage(buffer);
    const cached = await cacheRead(cache, cacheKey);
    if (cached) return cached;
    const uploaded = await this.uploadImage(buffer);
    await cacheWrite(cache, cacheKey, uploaded);
    return uploaded;
  }
  async addSheet(title, index) { await this.call("add_sheet", { docid: this.docId, properties: { title, index } }); this.sheetCache = null; return (await this.getSheets({ forceRefresh: true })).find((sheet) => sheetTitle(sheet) === title); }
  async updateSheet(sheetId, title) { const response = await this.call("update_sheet", { docid: this.docId, properties: { sheet_id: sheetId, title } }); this.sheetCache = null; return response; }
  async addFields(sheetId, fields) { const response = await this.call("add_fields", { docid: this.docId, sheet_id: sheetId, fields }); this.invalidateFieldContract(sheetId); return response; }
  async updateFields(sheetId, fields) { const response = await this.call("update_fields", { docid: this.docId, sheet_id: sheetId, fields }); this.invalidateFieldContract(sheetId); return response; }
  async deleteFields(sheetId, fieldIds) {
    const normalized = normalizeStringArray(fieldIds);
    if (!normalized) throw new Error("智能表格删除字段不能为空");
    const response = await this.call("delete_fields", { docid: this.docId, sheet_id: sheetId, field_ids: normalized });
    this.invalidateFieldContract(sheetId);
    return response;
  }
  async enqueueRecords(endpoint, sheetId, records, jobId) {
    if (!this.proxyConfigured) throw new Error("异步写入需要配置服务器网关");
    await this.request(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(this.corpId)}&corpsecret=${encodeURIComponent(this.secret)}`);
    const accessToken = await this.token();
    return this.proxyCall("/v1/jobs/enqueue", { jobId, url: `https://qyapi.weixin.qq.com/cgi-bin/wedoc/smartsheet/${endpoint}?access_token=${encodeURIComponent(accessToken)}`, method: "POST", body: { docid: this.docId, sheet_id: sheetId, key_type: "CELL_VALUE_KEY_TYPE_FIELD_TITLE", records } });
  }
  async getQueueJobs(jobIds) { if (!this.proxyConfigured) return { ok: false, jobs: [] }; return this.proxyCall("/v1/jobs/status", { jobIds }); }
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && (!Array.isArray(item) || item.length)));
}

function normalizeStringArray(value) {
  if (!Array.isArray(value) || !value.length) return undefined;
  const normalized = Array.from(new Set(value.map((item) => String(item || "").trim()).filter(Boolean)));
  return normalized.length ? normalized : undefined;
}

function normalizePageLimit(value) {
  const limit = Number(value || READ_PAGE_LIMIT);
  if (!Number.isInteger(limit) || limit < 1 || limit > READ_PAGE_LIMIT) throw new Error(`智能表格分页大小必须为1至${READ_PAGE_LIMIT}`);
  return limit;
}

function normalizeKeyType(keyType, fieldIds) {
  const normalized = keyType || (Array.isArray(fieldIds) && fieldIds.length ? CELL_VALUE_KEY_TYPE_FIELD_ID : CELL_VALUE_KEY_TYPE_FIELD_TITLE);
  if (![CELL_VALUE_KEY_TYPE_FIELD_TITLE, CELL_VALUE_KEY_TYPE_FIELD_ID].includes(normalized)) throw new Error("智能表格记录键类型无效");
  return normalized;
}

function validateWriteBatch(records, endpoint) {
  if (!Array.isArray(records) || !records.length || records.length > WRITE_BATCH_LIMIT) {
    const action = endpoint === "update_records" ? "更新" : "添加";
    throw new Error(`单次${action}智能表格记录必须为1至${WRITE_BATCH_LIMIT}行`);
  }
}

function assertWritableRecords(records, { keyType, systemFieldIds } = {}) {
  const protectedIds = new Set((systemFieldIds || []).map(String));
  for (const record of records) {
    const values = record && record.values;
    if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("智能表格写入记录缺少values对象");
    for (const key of Object.keys(values)) {
      const protectedField = keyType === CELL_VALUE_KEY_TYPE_FIELD_ID ? protectedIds.has(key) : SYSTEM_MANAGED_FIELD_TITLES.has(key);
      if (protectedField) throw businessError("SYSTEM_FIELD_READ_ONLY", `系统预设字段“${key}”由企业微信自动维护，不能通过接口写入`, { field: key });
    }
  }
}

function buildFieldContract(fields) {
  const byTitle = {};
  const byId = {};
  for (const field of fields || []) {
    const title = String(field.field_title || "").trim();
    const id = String(field.field_id || "").trim();
    if (title) byTitle[title] = field;
    if (id) byId[id] = field;
  }
  return { fields: fields || [], byTitle, byId };
}

function resolveFieldKey(contract, chineseTitle, keyType = CELL_VALUE_KEY_TYPE_FIELD_ID) {
  const field = contract && contract.byTitle && contract.byTitle[chineseTitle];
  if (!field) throw businessError("SMART_SHEET_FIELD_MISSING", `智能表格缺少字段“${chineseTitle}”`, { fieldTitle: chineseTitle });
  return keyType === CELL_VALUE_KEY_TYPE_FIELD_ID ? field.field_id : field.field_title;
}

function businessError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

async function cacheRead(cache, key) {
  if (typeof cache.get === "function") return cache.get(key);
  return cache[key];
}

async function cacheWrite(cache, key, value) {
  if (typeof cache.set === "function") { await cache.set(key, value); return; }
  cache[key] = value;
}

function sheetId(sheet) { return sheet.sheet_id || sheet.properties?.sheet_id; }
function sheetTitle(sheet) { return sheet.title || sheet.properties?.title; }
function cellRaw(record, title) { return record.values?.[title]; }
function cellList(record, title) { const value = cellRaw(record, title); if (value === undefined || value === null) return []; return Array.isArray(value) ? value : [value]; }
function cellText(record, title) {
  const value = cellList(record, title)[0];
  if (value === undefined || value === null) return "";
  if (["string", "number", "boolean"].includes(typeof value)) return String(value);
  return String(value.text ?? value.name ?? value.option?.text ?? value.value?.text ?? value.value?.name ?? value.value ?? "");
}
function cellBoolean(record, title) {
  const value = cellRaw(record, title);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first === "boolean") return first;
  return Boolean(first?.checked ?? first?.value ?? false);
}
function cellNumber(record, title) {
  const value = cellRaw(record, title);
  if (typeof value === "number") return value;
  const first = Array.isArray(value) ? value[0] : value;
  return Number(first?.number ?? first?.value ?? first ?? 0);
}
function cellReferences(record, title) { return cellList(record, title).map((value) => typeof value === "string" ? value : value?.record_id || value?.recordId || value?.value?.record_id || value?.value?.recordId || value?.value).filter((value) => typeof value === "string" && value); }
function cellUsers(record, title) {
  return cellList(record, title).map((item) => {
    const value = item?.value && typeof item.value === "object" ? item.value : item;
    return {
      userId: String(value?.user_id || value?.userid || value?.userId || ""),
      name: String(value?.name || value?.display_name || value?.text || ""),
    };
  }).filter((item) => item.userId);
}
function cellLocation(record, title) {
  const item = cellList(record, title)[0];
  const value = item?.value && typeof item.value === "object" ? item.value : item;
  if (!value || typeof value !== "object") return undefined;
  const latitude = Number(value.latitude ?? value.lat);
  const longitude = Number(value.longitude ?? value.lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;
  return {
    id: String(value.id || ""),
    title: String(value.title || value.address || value.name || ""),
    latitude,
    longitude,
    sourceType: Number(value.source_type ?? value.sourceType ?? 0),
  };
}
function textCell(value) { return [{ type: "text", text: String(value ?? "") }]; }
function checkboxCell(value) { return Boolean(value); }

module.exports = {
  SmartSheetClient,
  CELL_VALUE_KEY_TYPE_FIELD_TITLE,
  CELL_VALUE_KEY_TYPE_FIELD_ID,
  WRITE_BATCH_LIMIT,
  SYSTEM_MANAGED_FIELD_TITLES,
  buildFieldContract,
  resolveFieldKey,
  assertWritableRecords,
  sheetId,
  sheetTitle,
  cellText,
  cellBoolean,
  cellNumber,
  cellReferences,
  cellUsers,
  cellLocation,
  textCell,
  checkboxCell,
};
