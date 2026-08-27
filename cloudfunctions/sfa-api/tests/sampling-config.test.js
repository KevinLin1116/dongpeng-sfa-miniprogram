const assert = require("assert");
const { buildSamplingConfiguration, resolveProductRule } = require("../sampling-config");
const { createSamplingSnapshot, snapshotHash } = require("../sampling-snapshot");

const titles = {
  products: { productCode: "产品编码", productName: "产品名称", productSeries: "系列", productSpecification: "规格", productThumbnail: "产品图片", productOrder: "展示顺序", productStatus: "产品状态" },
  rules: { ruleCode: "产品规则编号", ruleName: "规则名称" },
  groups: { groupCode: "规则分组编号", groupRule: "产品规则", groupLevel1: "一级分组名称", groupLevel2: "二级分组名称", groupProducts: "关联产品", groupMinimum: "必上样数量" },
};

function record(recordId, values, updateTime = "1786550400000") { return { record_id: recordId, update_time: updateTime, values }; }
function text(value) { return [{ type: "text", text: value }]; }
function option(value) { return [{ text: value }]; }

function validInput() {
  return {
    titles,
    productRecords: [
      record("product-a", { "产品编码": text("DP-A"), "产品名称": text("产品A"), "系列": text("岩板"), "规格": text("600×1200mm"), "产品图片": [{ id: "img-a", image_url: "https://img/a.jpg" }], "展示顺序": 1, "产品状态": option("在售") }),
      record("product-b", { "产品编码": text("DP-B"), "产品名称": text("产品B"), "规格": text("750×1500mm"), "展示顺序": 2, "产品状态": option("在售") }),
      record("product-c", { "产品编码": text("DP-C"), "产品名称": text("产品C"), "规格": text("900×1800mm"), "展示顺序": 3, "产品状态": option("待上市") }),
      record("product-disabled", { "产品编码": text("DP-X"), "产品名称": text("停售产品"), "规格": text("600×600mm"), "产品状态": option("停售") }),
    ],
    ruleRecords: [
      record("rule-summer", { "产品规则编号": text("RULE-001"), "规则名称": text("盛夏焕新上样规则") }),
      record("rule-other", { "产品规则编号": text("RULE-002"), "规则名称": text("其他规则") }),
    ],
    groupRecords: [
      record("group-must", { "规则分组编号": text("GROUP-001"), "产品规则": ["rule-summer"], "一级分组名称": text("必上"), "二级分组名称": text("系列一"), "关联产品": ["product-a", "product-b"], "必上样数量": 2 }),
      record("group-choose", { "规则分组编号": text("GROUP-002"), "产品规则": ["rule-summer"], "一级分组名称": text("三选一"), "二级分组名称": text("重点花色"), "关联产品": ["product-c"], "必上样数量": 1 }),
      record("group-other", { "规则分组编号": text("GROUP-003"), "产品规则": ["rule-other"], "一级分组名称": text("其他"), "二级分组名称": text("可选"), "关联产品": ["product-a"], "必上样数量": 1 }),
    ],
  };
}

async function testSelectedRuleAndSnapshotFreeze() {
  const config = buildSamplingConfiguration(validInput());
  const snapshot = createSamplingSnapshot({ store: { recordId: "store-a", name: "门店A", regionRecordIds: ["region-south"] }, configuration: config, productRuleRecordId: "rule-summer", createdAt: "2026-08-12T00:00:00.000Z" });
  assert.strictEqual(snapshot.schemaVersion, 2);
  assert.strictEqual(snapshot.productRule.ruleRecordId, "rule-summer");
  assert.deepStrictEqual(snapshot.groups.map((group) => group.groupCode), ["GROUP-001", "GROUP-002"]);
  assert.strictEqual(snapshot.groups[0].products[0].minPhotos, 1);
  assert.strictEqual(snapshot.groups[0].products[0].maxPhotos, null);
  assert.strictEqual(snapshot.groups[0].products[0].thumbnail.imageUrl, "https://img/a.jpg");
  assert.strictEqual(snapshot.businessRegionSnapshot.regionRecordId, "region-south");
  assert.strictEqual(snapshot.version.length, 64);
  const copy = JSON.parse(JSON.stringify(snapshot));
  delete copy.version;
  delete copy.createdAt;
  assert.strictEqual(snapshot.version, snapshotHash(copy));
}

async function testNChooseMAndSystemNumbers() {
  const config = buildSamplingConfiguration(validInput());
  const rule = resolveProductRule(config, "rule-summer");
  assert.strictEqual(rule.ruleCode, "RULE-001");
  assert.strictEqual(rule.groups[0].groupCode, "GROUP-001");
  assert.strictEqual(rule.groups[0].minRequired, 2);
  assert.strictEqual(rule.groups[0].products.length, 2);
}

async function testRuleConflictValidation() {
  const input = validInput();
  input.ruleRecords[1].values["产品规则编号"] = text("RULE-001");
  assert.throws(() => buildSamplingConfiguration(input), (error) => error.code === "SAMPLING_RULE_CODE_DUPLICATE");
}

async function testInactiveProductCannotBeUsed() {
  const input = validInput();
  input.groupRecords[1].values["关联产品"] = ["product-c", "product-disabled"];
  const config = buildSamplingConfiguration(input);
  assert.throws(() => resolveProductRule(config, "rule-summer"), (error) => error.code === "SAMPLING_GROUP_PRODUCT_INACTIVE");
}

async function testInvalidMinimumAndDuplicateAcrossGroups() {
  const minimumInput = validInput();
  minimumInput.groupRecords[1].values["必上样数量"] = 2;
  assert.throws(() => resolveProductRule(buildSamplingConfiguration(minimumInput), "rule-summer"), (error) => error.code === "SAMPLING_GROUP_MINIMUM_EXCEEDS_PRODUCTS");

  const duplicateInput = validInput();
  duplicateInput.groupRecords[1].values["关联产品"] = ["product-a", "product-c"];
  assert.throws(() => resolveProductRule(buildSamplingConfiguration(duplicateInput), "rule-summer"), (error) => error.code === "SAMPLING_PRODUCT_DUPLICATE_ACROSS_GROUPS");
}

async function testZeroMinimumMeansOptionalSelection() {
  const input = validInput();
  input.groupRecords[1].values["必上样数量"] = 0;
  const rule = resolveProductRule(buildSamplingConfiguration(input), "rule-summer");
  assert.strictEqual(rule.groups[1].minRequired, 0);

  const emptyInput = validInput();
  emptyInput.groupRecords[1].values["必上样数量"] = [];
  assert.throws(() => resolveProductRule(buildSamplingConfiguration(emptyInput), "rule-summer"), (error) => error.code === "SAMPLING_NUMBER_INVALID");

  const negativeInput = validInput();
  negativeInput.groupRecords[1].values["必上样数量"] = -1;
  assert.throws(() => resolveProductRule(buildSamplingConfiguration(negativeInput), "rule-summer"), (error) => error.code === "SAMPLING_NUMBER_INVALID");
}

async function testOnlySelectedRuleMustBeComplete() {
  const input = validInput();
  input.ruleRecords.push(record("rule-draft", { "规则名称": text("尚未维护完成的草稿规则") }));
  const config = buildSamplingConfiguration(input);
  assert.strictEqual(resolveProductRule(config, "rule-summer").ruleName, "盛夏焕新上样规则");
  assert.throws(() => resolveProductRule(config, "rule-draft"), (error) => error.code === "SAMPLING_PRODUCT_RULE_INCOMPLETE");
}

async function testEmptyGroupIsRejectedWhenSelected() {
  const input = validInput();
  input.groupRecords[0].values["关联产品"] = [];
  assert.throws(() => resolveProductRule(buildSamplingConfiguration(input), "rule-summer"), (error) => error.code === "SAMPLING_GROUP_PRODUCTS_MISSING");
}

async function testGroupMustLinkExactlyOneRule() {
  const input = validInput();
  input.groupRecords[0].values["产品规则"] = ["rule-summer", "rule-other"];
  const config = buildSamplingConfiguration(input);
  assert.throws(() => resolveProductRule(config, "rule-summer"), (error) => error.code === "SAMPLING_GROUP_RULE_INVALID");
}

async function main() {
  await testSelectedRuleAndSnapshotFreeze();
  await testNChooseMAndSystemNumbers();
  await testRuleConflictValidation();
  await testInactiveProductCannotBeUsed();
  await testInvalidMinimumAndDuplicateAcrossGroups();
  await testZeroMinimumMeansOptionalSelection();
  await testOnlySelectedRuleMustBeComplete();
  await testEmptyGroupIsRejectedWhenSelected();
  await testGroupMustLinkExactlyOneRule();
  process.stdout.write("sampling config tests passed\n");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
