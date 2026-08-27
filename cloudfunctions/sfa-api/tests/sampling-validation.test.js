const assert = require("assert");
const { sanitizeSamplingValues, validateSamplingSubmission, preUploadSamplingImages, samplingFormModel, imageCacheKey, imageFromCache, validateSamplingEditAccess } = require("../sampling-validation");

function snapshot() {
  return {
    version: "v1",
    productRule: { ruleRecordId: "rule-v2", ruleName: "夏季产品规则" },
    groups: [
      { ruleRecordId: "must", name: "必上组合", required: true, minRequired: 2, products: [
        { productRecordId: "a", name: "产品A", code: "A", minPhotos: 1, maxPhotos: 2 },
        { productRecordId: "b", name: "产品B", code: "B", minPhotos: 2, maxPhotos: null },
      ] },
      { ruleRecordId: "choose", name: "三选一", required: true, minRequired: 1, products: [
        { productRecordId: "c", name: "产品C", code: "C", minPhotos: 1, maxPhotos: 3 },
        { productRecordId: "d", name: "产品D", code: "D", minPhotos: 1, maxPhotos: 3 },
        { productRecordId: "e", name: "产品E", code: "E", minPhotos: 1, maxPhotos: 3 },
      ] },
      { ruleRecordId: "optional", name: "选上", required: false, minRequired: 0, products: [
        { productRecordId: "f", name: "产品F", code: "F", minPhotos: 1, maxPhotos: 3 },
      ] },
    ],
  };
}

const file = (name) => `cloud://env/sampling/${name}.jpg`;

async function testValidAllRequiredAndNChooseM() {
  const result = validateSamplingSubmission(snapshot(), { a: [file("a")], b: [file("b1"), file("b2")], c: [file("c")] });
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.groups[0].completedProducts, 2);
  assert.strictEqual(result.groups[1].completedProducts, 1);
  assert.deepStrictEqual(result.values.d, []);
}

async function testZeroMinimumNeverBlocksSubmission() {
  const emptyOptional = validateSamplingSubmission(snapshot(), { a: [file("a")], b: [file("b1"), file("b2")], c: [file("c")] });
  assert.strictEqual(emptyOptional.groups[2].completedProducts, 0);
  assert.strictEqual(emptyOptional.groups[2].valid, true);

  const selectedOptional = validateSamplingSubmission(snapshot(), { a: [file("a")], b: [file("b1"), file("b2")], c: [file("c")], f: [file("f")] });
  assert.strictEqual(selectedOptional.groups[2].completedProducts, 1);

  const form = samplingFormModel(snapshot(), {});
  assert.strictEqual(form.groups[2].ruleLabel, "选上");
  assert.strictEqual(form.groups[2].requiredProducts, 0);
}

async function testValidationLocatesGroupAndProduct() {
  await assert.rejects(
    async () => validateSamplingSubmission(snapshot(), { a: [file("a")], b: [file("b1")], c: [] }),
    (error) => error.code === "SAMPLING_VALIDATION_FAILED" && error.details.errors.some((item) => item.productRecordId === "b") && error.details.errors.some((item) => item.ruleRecordId === "choose"),
  );
}

async function testUnknownProductAndUnsafeFileAreRejected() {
  assert.throws(() => sanitizeSamplingValues(snapshot(), { unknown: [file("x")] }), (error) => error.code === "SAMPLING_PRODUCT_UNKNOWN");
  assert.throws(() => sanitizeSamplingValues(snapshot(), { a: ["https://attacker.invalid/x.jpg"] }), (error) => error.code === "SAMPLING_FILE_ID_INVALID");
}

async function testMaximumAndPlatformLimit() {
  assert.throws(() => validateSamplingSubmission(snapshot(), { a: [file("1"), file("2"), file("3")], b: [file("b1"), file("b2")], c: [file("c")] }), (error) => error.code === "SAMPLING_VALIDATION_FAILED" && error.details.errors[0].code === "SAMPLING_PHOTOS_EXCEEDED");
  assert.throws(() => sanitizeSamplingValues(snapshot(), { b: Array.from({ length: 21 }, (_, index) => file(`b-${index}`)) }), (error) => error.code === "SAMPLING_PLATFORM_PHOTO_LIMIT");
}

async function testPreUploadReusesExistingCache() {
  const uploaded = [];
  const client = { uploadImage: async (buffer) => { uploaded.push(buffer.toString()); return { url: `https://doc.weixin.qq.com/${buffer.toString()}`, width: 1200, height: 900 }; } };
  const cloud = { downloadFile: async ({ fileID }) => ({ fileContent: Buffer.from(fileID.split("/").pop()) }) };
  const existing = { [file("a")]: { id: "cached-a", image_url: "https://doc.weixin.qq.com/cached-a" } };
  const values = { a: [file("a")], b: [file("b1"), file("b2")], c: [file("c")] };
  const caches = [];
  const result = await preUploadSamplingImages({ snapshot: snapshot(), values, client, cloud, existingCache: existing, onCache: async (cache) => caches.push(cache) });
  assert.strictEqual(uploaded.length, 3);
  assert.strictEqual(imageFromCache(result, file("a")).id, "cached-a");
  assert.strictEqual(result[imageCacheKey(file("a"))].fileId, file("a"));
  assert.ok(Object.keys(result).every((key) => !key.includes(".")), "缓存键不能包含点号");
  assert.strictEqual(caches.length, 1, "同一批成功图片只应保存一次缓存");
  assert.strictEqual(caches[0][imageCacheKey(file("c"))].fileId, file("c"));
}

async function testPreUploadRunsIndependentImagesConcurrently() {
  const customSnapshot = { groups: [{ minRequired: 1, products: [
    { productRecordId: "a", name: "产品A", minPhotos: 1 },
    { productRecordId: "b", name: "产品B", minPhotos: 1 },
    { productRecordId: "c", name: "产品C", minPhotos: 1 },
  ] }] };
  let active = 0;
  let maximumActive = 0;
  const cloud = { downloadFile: async ({ fileID }) => ({ fileContent: Buffer.from(fileID) }) };
  const client = { uploadImage: async (buffer) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active -= 1;
    return { url: `https://doc.weixin.qq.com/${encodeURIComponent(buffer.toString())}` };
  } };
  await preUploadSamplingImages({ snapshot: customSnapshot, values: { a: [file("a")], b: [file("b")], c: [file("c")] }, client, cloud, concurrency: 3 });
  assert.strictEqual(maximumActive, 3, "独立照片应并行同步，而不是逐张串行等待");
}

async function testLegacyNestedCacheIsRecoveredWithoutUpload() {
  const fileId = "cloud://cloudbase-env.bucket/sampling/task/product/photo.jpg";
  const legacy = {
    "cloud://cloudbase-env": {
      "bucket/sampling/task/product/photo": {
        jpg: { id: "legacy-image", image_url: "https://doc.weixin.qq.com/legacy" },
      },
    },
  };
  assert.strictEqual(imageFromCache(legacy, fileId).id, "legacy-image");
  const customSnapshot = { groups: [{ minRequired: 1, products: [{ productRecordId: "a", name: "产品A", minPhotos: 1 }] }] };
  let downloadCount = 0;
  const result = await preUploadSamplingImages({
    snapshot: customSnapshot,
    values: { a: [fileId] },
    client: { uploadImage: async () => { throw new Error("不应重新上传"); } },
    cloud: { downloadFile: async () => { downloadCount += 1; throw new Error("不应重新下载"); } },
    existingCache: legacy,
  });
  assert.strictEqual(downloadCount, 0);
  assert.strictEqual(imageFromCache(result, fileId).id, "legacy-image");
  assert.strictEqual(result[imageCacheKey(fileId)].fileId, fileId);
}

async function testFormUsesDynamicLimitsAndReadOnlyState() {
  const model = samplingFormModel(snapshot(), { a: [file("a")] }, { readOnly: true, currentRound: 2, rejectionReason: "照片模糊" });
  assert.strictEqual(model.readOnly, true);
  assert.strictEqual(model.productRule.ruleName, "夏季产品规则");
  assert.strictEqual(model.currentRound, 2);
  assert.strictEqual(model.groups[0].products[1].maxPhotos, null);
  assert.strictEqual(model.groups[1].ruleLabel, "3选1");
}

async function testQualifiedProductsAreLocked() {
  const before = { a: [file("a")], b: [file("b1"), file("b2")], c: [file("c")] };
  assert.throws(
    () => validateSamplingEditAccess(snapshot(), before, { ...before, a: [file("a-new")] }, { qualifiedProductIds: ["a"] }),
    (error) => error.code === "SAMPLING_QUALIFIED_PRODUCT_LOCKED" && error.details.productRecordId === "a",
  );
  assert.strictEqual(validateSamplingEditAccess(snapshot(), before, { ...before, c: [file("c-new")] }, { qualifiedProductIds: ["a"] }).c[0], file("c-new"));
}

async function testRejectedProductRequiresReplacementPhoto() {
  const review = { rejectedProducts: { c: { reason: "照片模糊", previousFileIds: [file("c-old")] } } };
  assert.throws(
    () => validateSamplingSubmission(snapshot(), { a: [file("a")], b: [file("b1"), file("b2")], c: [file("c-old")] }, { samplingReview: review }),
    (error) => error.code === "SAMPLING_VALIDATION_FAILED" && error.details.errors.some((item) => item.code === "SAMPLING_RECTIFICATION_PHOTO_REQUIRED"),
  );
  const result = validateSamplingSubmission(snapshot(), { a: [file("a")], b: [file("b1"), file("b2")], c: [file("c-new")] }, { samplingReview: review });
  assert.strictEqual(result.valid, true);
}

async function testRectificationFormSortsAndLocksProducts() {
  const model = samplingFormModel(snapshot(), { a: [file("a")], c: [file("c-new")] }, {
    samplingReview: { qualifiedProductIds: ["a"], rejectedProducts: { c: { reason: "重拍", previousFileIds: [file("c-old")] } } },
  });
  assert.strictEqual(model.rectificationMode, true);
  assert.strictEqual(model.groups[0].products.find((item) => item.id === "a").editable, false);
  assert.strictEqual(model.groups[1].products[0].id, "c");
  assert.strictEqual(model.groups[1].products[0].reviewState, "rectify");
  assert.strictEqual(model.groups[1].products[0].rejectionReason, "重拍");
}

async function main() {
  await testValidAllRequiredAndNChooseM();
  await testZeroMinimumNeverBlocksSubmission();
  await testValidationLocatesGroupAndProduct();
  await testUnknownProductAndUnsafeFileAreRejected();
  await testMaximumAndPlatformLimit();
  await testPreUploadReusesExistingCache();
  await testPreUploadRunsIndependentImagesConcurrently();
  await testLegacyNestedCacheIsRecoveredWithoutUpload();
  await testFormUsesDynamicLimitsAndReadOnlyState();
  await testQualifiedProductsAreLocked();
  await testRejectedProductRequiresReplacementPhoto();
  await testRectificationFormSortsAndLocksProducts();
  process.stdout.write("sampling validation tests passed\n");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
