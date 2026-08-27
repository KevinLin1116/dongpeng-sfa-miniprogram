const assert = require("assert");
const { CONFIRMATION, inspectSamplingProductReview, migrateSamplingProductReview } = require("../sampling-product-review-migration");

function client({ reasonType = "", records = [] } = {}) {
  const fields = [{ field_id: "item", field_title: "任务项执行", field_type: "FIELD_TYPE_REFERENCE" }, { field_id: "product", field_title: "上样产品", field_type: "FIELD_TYPE_REFERENCE" }];
  if (reasonType) fields.push({ field_id: "reason", field_title: "不合格原因", field_type: reasonType });
  let additions = 0;
  return {
    get additions() { return additions; },
    getSheets: async () => [{ title: "24_产品上样结果", sheet_id: "s24" }],
    getFields: async () => fields,
    getRecords: async () => records,
    addFields: async (_, added) => { additions += 1; fields.push({ ...added[0], field_id: "reason" }); },
  };
}

function cachedFieldClient() {
  const fields = [{ field_id: "item", field_title: "任务项执行", field_type: "FIELD_TYPE_REFERENCE" }];
  const cache = new Map();
  let additions = 0;
  return {
    get additions() { return additions; },
    getSheets: async () => [{ title: "24_产品上样结果", sheet_id: "s24" }],
    getFields: async (_, options = {}) => {
      const key = `${options.limit || 100}:${(options.fieldTitles || []).join(",")}`;
      if (!cache.has(key)) cache.set(key, fields.filter((field) => !options.fieldTitles?.length || options.fieldTitles.includes(field.field_title)).map((field) => ({ ...field })));
      return cache.get(key).map((field) => ({ ...field }));
    },
    getRecords: async () => [],
    addFields: async (_, added) => { additions += 1; fields.push({ ...added[0], field_id: "reason" }); },
  };
}

async function main() {
  const fresh = client();
  await assert.rejects(() => migrateSamplingProductReview(fresh, "wrong"), (error) => error.code === "SAMPLING_REVIEW_MIGRATION_CONFIRMATION_REQUIRED");
  const migrated = await migrateSamplingProductReview(fresh, CONFIRMATION);
  assert.strictEqual(migrated.changed, true);
  assert.strictEqual(fresh.additions, 1);
  const repeated = await migrateSamplingProductReview(fresh, CONFIRMATION);
  assert.strictEqual(repeated.changed, false);
  assert.strictEqual(fresh.additions, 1);
  const cached = cachedFieldClient();
  const cachedMigration = await migrateSamplingProductReview(cached, CONFIRMATION);
  assert.strictEqual(cachedMigration.changed, true);
  assert.strictEqual(cachedMigration.field.title, "不合格原因");
  assert.strictEqual(cached.additions, 1);
  const duplicate = client({ reasonType: "FIELD_TYPE_TEXT", records: [{ record_id: "r1", values: { "任务项执行": ["i1"], "上样产品": ["p1"] } }, { record_id: "r2", values: { "任务项执行": ["i1"], "上样产品": ["p1"] } }] });
  const inspected = await inspectSamplingProductReview(duplicate);
  assert.deepStrictEqual(inspected.duplicates[0].recordIds, ["r1", "r2"]);
  await assert.rejects(() => inspectSamplingProductReview(client({ reasonType: "FIELD_TYPE_NUMBER" })), (error) => error.code === "SAMPLING_REVIEW_FIELD_TYPE_INVALID");
  process.stdout.write("sampling product review migration tests passed\n");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
