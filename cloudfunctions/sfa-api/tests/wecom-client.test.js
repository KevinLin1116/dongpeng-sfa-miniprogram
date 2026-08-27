const assert = require("assert");
const {
  SmartSheetClient,
  CELL_VALUE_KEY_TYPE_FIELD_ID,
  CELL_VALUE_KEY_TYPE_FIELD_TITLE,
  buildFieldContract,
  resolveFieldKey,
} = require("../wecom");

function createClient() {
  return new SmartSheetClient({ corpId: "corp", secret: "secret", docId: "doc" });
}

async function testTargetedRecordQueryUsesOfficialParameters() {
  const client = createClient();
  const calls = [];
  client.call = async (endpoint, body) => {
    calls.push({ endpoint, body });
    return { records: [{ record_id: "row-1", values: { fieldA: [{ type: "text", text: "值" }] } }], has_more: false };
  };
  const records = await client.getRecords("sheet-1", { recordIds: ["row-1"], fieldIds: ["fieldA"], limit: 50 });
  assert.strictEqual(records.length, 1);
  assert.strictEqual(calls[0].endpoint, "get_records");
  assert.deepStrictEqual(calls[0].body.record_ids, ["row-1"]);
  assert.deepStrictEqual(calls[0].body.field_ids, ["fieldA"]);
  assert.strictEqual(calls[0].body.key_type, CELL_VALUE_KEY_TYPE_FIELD_ID);
  assert.strictEqual(calls[0].body.limit, 50);
}

async function testFilterAndSortCannotBeCombined() {
  const client = createClient();
  await assert.rejects(
    () => client.getRecords("sheet-1", { filterSpec: { conjunction: "CONJUNCTION_AND" }, sort: [{ field_title: "任务名称" }] }),
    (error) => error.code === "RECORD_QUERY_FILTER_SORT_CONFLICT",
  );
}

async function testWritesAreSplitIntoOfficialBatchSize() {
  const client = createClient();
  const calls = [];
  client.call = async (endpoint, body) => {
    calls.push({ endpoint, body });
    return { errcode: 0, records: body.records.map((_, index) => ({ record_id: `${calls.length}-${index}` })) };
  };
  const input = Array.from({ length: 1001 }, (_, index) => ({ values: { "结果唯一键": [{ type: "text", text: `KEY-${index}` }] } }));
  const result = await client.addRecordsBatched("sheet-24", input);
  assert.deepStrictEqual(calls.map((item) => item.body.records.length), [500, 500, 1]);
  assert.strictEqual(result.batches.length, 3);
  assert.strictEqual(result.records.length, 1001);
  assert.strictEqual(calls[0].body.key_type, CELL_VALUE_KEY_TYPE_FIELD_TITLE);
}

async function testSingleWriteRejectsOversizedBatch() {
  const client = createClient();
  client.call = async () => { throw new Error("不应调用接口"); };
  const input = Array.from({ length: 501 }, () => ({ values: { "任务名称": [] } }));
  await assert.rejects(() => client.updateRecords("sheet-1", input), /1至500行/);
}

async function testUniqueLookupRejectsDuplicateBusinessKeys() {
  const client = createClient();
  client.getRecords = async () => [
    { record_id: "a", values: { "结果唯一键": [{ type: "text", text: "RESULT:1" }] } },
    { record_id: "b", values: { "结果唯一键": [{ type: "text", text: "RESULT:1" }] } },
  ];
  await assert.rejects(
    () => client.findUniqueRecord("sheet-24", { fieldTitle: "结果唯一键", value: "RESULT:1" }),
    (error) => error.code === "UNIQUE_KEY_CONFLICT" && error.details.recordIds.length === 2,
  );
}

async function testImageUploadCacheReusesFileId() {
  const client = createClient();
  const cache = new Map();
  let uploadCount = 0;
  client.uploadImage = async () => { uploadCount += 1; return { url: "https://doc.weixin.qq.com/image/1", width: 100, height: 100 }; };
  const first = await client.uploadImageOnce(Buffer.from("image"), { cacheKey: "cloud://file-1", cache });
  const second = await client.uploadImageOnce(Buffer.from("image"), { cacheKey: "cloud://file-1", cache });
  assert.strictEqual(uploadCount, 1);
  assert.deepStrictEqual(second, first);
}

async function testSystemManagedFieldsAreReadOnly() {
  const client = createClient();
  client.call = async () => { throw new Error("不应调用接口"); };
  await assert.rejects(
    () => client.addRecords("sheet-1", [{ values: { "创建时间": String(Date.now()) } }]),
    (error) => error.code === "SYSTEM_FIELD_READ_ONLY" && /创建时间/.test(error.message),
  );
  await assert.rejects(
    () => client.addRecords("sheet-1", [{ values: { systemCreatedAt: String(Date.now()) } }], { keyType: CELL_VALUE_KEY_TYPE_FIELD_ID, systemFieldIds: ["systemCreatedAt"] }),
    (error) => error.code === "SYSTEM_FIELD_READ_ONLY",
  );
}

async function testFieldContractUsesChineseErrorsAndInternalIds() {
  const contract = buildFieldContract([{ field_id: "f-result-key", field_title: "结果唯一键", field_type: "FIELD_TYPE_TEXT" }]);
  assert.strictEqual(resolveFieldKey(contract, "结果唯一键"), "f-result-key");
  await assert.rejects(
    async () => resolveFieldKey(contract, "提交轮次"),
    (error) => error.code === "SMART_SHEET_FIELD_MISSING" && /提交轮次/.test(error.message),
  );
}

async function testDeleteFieldsUsesOfficialPayload() {
  const client = createClient();
  const calls = [];
  client.call = async (endpoint, body) => { calls.push({ endpoint, body }); return { errcode: 0 }; };
  await client.deleteFields("sheet-22", ["field-a", "field-a", "field-b"]);
  assert.strictEqual(calls[0].endpoint, "delete_fields");
  assert.deepStrictEqual(calls[0].body, { docid: "doc", sheet_id: "sheet-22", field_ids: ["field-a", "field-b"] });
  await assert.rejects(() => client.deleteFields("sheet-22", []), /不能为空/);
}

async function testShortLivedStructureCacheAvoidsRepeatedNetworkCalls() {
  const client = createClient();
  const calls = [];
  client.call = async (endpoint) => {
    calls.push(endpoint);
    if (endpoint === "get_sheet") return { properties: [{ title: "06_任务执行", sheet_id: "s06" }] };
    if (endpoint === "get_fields") return { fields: [{ field_id: "f1", field_title: "当前状态" }] };
    return { errcode: 0 };
  };
  await client.getSheets();
  await client.getSheets();
  await client.getFields("s06");
  await client.getFields("s06");
  assert.deepStrictEqual(calls, ["get_sheet", "get_fields"]);
  client.invalidateFieldContract("s06");
  await client.getFields("s06");
  assert.deepStrictEqual(calls, ["get_sheet", "get_fields", "get_fields"]);
}

async function testConcurrentStructureReadsShareOneRequestAndKeepConnectionsAlive() {
  const client = createClient();
  let calls = 0;
  let release;
  client.call = async () => {
    calls += 1;
    await new Promise((resolve) => { release = resolve; });
    return { fields: [{ field_id: "f1", field_title: "当前状态" }] };
  };
  const first = client.getFields("s06");
  const second = client.getFields("s06");
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(calls, 1);
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.deepStrictEqual(left, right);
  assert.strictEqual(client.directAgent.keepAlive, true);
}

async function main() {
  await testTargetedRecordQueryUsesOfficialParameters();
  await testFilterAndSortCannotBeCombined();
  await testWritesAreSplitIntoOfficialBatchSize();
  await testSingleWriteRejectsOversizedBatch();
  await testUniqueLookupRejectsDuplicateBusinessKeys();
  await testImageUploadCacheReusesFileId();
  await testSystemManagedFieldsAreReadOnly();
  await testFieldContractUsesChineseErrorsAndInternalIds();
  await testDeleteFieldsUsesOfficialPayload();
  await testShortLivedStructureCacheAvoidsRepeatedNetworkCalls();
  await testConcurrentStructureReadsShareOneRequestAndKeepConnectionsAlive();
  process.stdout.write("wecom client tests passed\n");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
