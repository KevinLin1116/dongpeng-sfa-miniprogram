const assert = require("assert");
const { generatedRegionCode, ensureRegionCodes } = require("../region-code-sync");

const text = (value) => [{ type: "text", text: value }];

function fixture(records) {
  const writes = [];
  return {
    writes,
    getSheets: async () => [{ title: "20_大区主档", sheet_id: "s20" }],
    getFields: async () => [
      { field_id: "f-name", field_title: "大区名称", field_type: "FIELD_TYPE_TEXT" },
      { field_id: "f-code", field_title: "大区编码（自动）", field_type: "FIELD_TYPE_TEXT" },
    ],
    getRecords: async () => records,
    updateRecordsBatched: async (_sheetId, updates) => { writes.push(...updates); return { errcode: 0 }; },
  };
}

async function testOnlyEmptyCodeIsGenerated() {
  const client = fixture([
    { record_id: "region-a", values: { "大区名称": text("华南运营中心"), "大区编码（自动）": text("hnyyzx") } },
    { record_id: "region-b", values: { "大区名称": text("华东运营中心"), "大区编码（自动）": [] } },
  ]);
  const result = await ensureRegionCodes(client, { recordIds: ["region-a", "region-b"] });
  assert.strictEqual(result.generated, 1);
  assert.strictEqual(client.writes[0].record_id, "region-b");
  assert.match(client.writes[0].values["大区编码（自动）"][0].text, /^DQ-[A-F0-9]{10}$/);
}

async function testCodeIsStableAndScopedToChangedRecords() {
  assert.strictEqual(generatedRegionCode("region-b", "华东运营中心"), generatedRegionCode("region-b", "华东运营中心"));
  const client = fixture([
    { record_id: "region-b", values: { "大区名称": text("华东运营中心"), "大区编码（自动）": [] } },
    { record_id: "region-c", values: { "大区名称": text("华北运营中心"), "大区编码（自动）": [] } },
  ]);
  const result = await ensureRegionCodes(client, { recordIds: ["region-c"] });
  assert.strictEqual(result.scanned, 1);
  assert.strictEqual(client.writes[0].record_id, "region-c");
}

async function main() {
  await testOnlyEmptyCodeIsGenerated();
  await testCodeIsStableAndScopedToChangedRecords();
  process.stdout.write("region code sync tests passed\n");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
