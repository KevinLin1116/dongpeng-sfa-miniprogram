const assert = require("assert");
const {
  TARGET_SCHEMA_VERSION,
  SAFE_ADDITIONS,
  RELATION_ADDITIONS,
  fieldSummary,
  planStructureMigration,
  applySafeStructureMigration,
} = require("../structure-migration");

async function run() {
  assert.strictEqual(TARGET_SCHEMA_VERSION, "SMART_SHEET_SCHEMA_V3");
  assert(SAFE_ADDITIONS["09_门店主档"].some((item) => item.field_type === "FIELD_TYPE_LOCATION"));
  assert(RELATION_ADDITIONS.some((item) => item.sheet === "04_任务发布" && item.title === "任务项" && item.multiple));
  assert.deepStrictEqual(fieldSummary({
    field_id: "field-1",
    field_title: "任务项",
    field_type: "FIELD_TYPE_LINK",
    property_link: { target_sheet_id: "sheet-5" },
    ignored: true,
  }), {
    id: "field-1",
    title: "任务项",
    type: "FIELD_TYPE_LINK",
    property: { property_link: { target_sheet_id: "sheet-5" } },
  });

  const state = {
    sheets: [
      { title: "05_任务项设置", sheet_id: "sheet-5" },
      { title: "09_门店主档", sheet_id: "sheet-9" },
    ],
    fields: {
      "sheet-5": [{ field_id: "existing", field_title: "需要审批", field_type: "FIELD_TYPE_CHECKBOX" }],
      "sheet-9": [],
    },
  };
  const calls = [];
  const client = {
    getSheets: async () => state.sheets,
    getFields: async (id) => state.fields[id] || [],
    addSheet: async (title) => {
      const sheet = { title, sheet_id: `new-sheet-${state.sheets.length + 1}` };
      state.sheets.push(sheet);
      state.fields[sheet.sheet_id] = [];
      calls.push({ action: "addSheet", title });
      return sheet;
    },
    addFields: async (id, fields) => {
      calls.push({ action: "addFields", id, fields });
      state.fields[id].push(...fields.map((item, index) => ({ ...item, field_id: `${id}-${index}` })));
    },
  };

  const plan = await planStructureMigration(client);
  const storeOperation = plan.safe.find((item) => item.sheet === "09_门店主档");
  assert.deepStrictEqual(storeOperation.fields.map((item) => item.field_title), ["门店位置"]);
  const itemOperation = plan.safe.find((item) => item.sheet === "05_任务项设置");
  assert.strictEqual(itemOperation, undefined, "已存在字段不应重复创建");
  assert(plan.safe.some((item) => item.sheet === "16_审批规则" && item.action === "add_sheet"));

  await assert.rejects(
    () => applySafeStructureMigration(client),
    /quarantined/,
  );
  assert(!state.sheets.some((item) => item.title === "16_审批规则"));
  assert(!state.fields["sheet-9"].some((item) => item.field_title === "门店位置"));
  assert.deepStrictEqual(calls, [], "隔离状态不得产生任何结构写入");
  console.log("structure migration tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
