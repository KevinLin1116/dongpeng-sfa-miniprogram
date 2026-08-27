const crypto = require("crypto");
const { resolveProductRule } = require("./sampling-config");

function snapshotError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((result, key) => {
      if (value[key] !== undefined) result[key] = canonicalize(value[key]);
      return result;
    }, {});
  }
  return value;
}

function snapshotHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function createSamplingSnapshot({ store, configuration, productRuleRecordId, createdAt = new Date().toISOString() }) {
  const regionRecordIds = Array.isArray(store.regionRecordIds) ? store.regionRecordIds.filter(Boolean) : [];
  const rule = resolveProductRule(configuration, productRuleRecordId);
  const content = {
    schemaVersion: 2,
    productRule: {
      ruleRecordId: rule.ruleRecordId,
      ruleCode: rule.ruleCode,
      ruleName: rule.ruleName,
      sourceUpdatedAt: rule.sourceUpdatedAt,
    },
    businessRegionSnapshot: { regionRecordId: regionRecordIds[0] || "" },
    groups: rule.groups.map((group, groupIndex) => ({
      groupRecordId: group.groupRecordId,
      groupCode: group.groupCode,
      level1Name: group.level1Name,
      level2Name: group.level2Name,
      displayName: group.displayName,
      productCount: group.products.length,
      sourceUpdatedAt: group.sourceUpdatedAt,
      // Compatibility aliases keep already released clients and historical
      // submission code able to consume V2 snapshots during rollout.
      ruleRecordId: group.groupRecordId,
      ruleCode: group.groupCode,
      name: group.displayName,
      description: "",
      order: groupIndex + 1,
      required: group.minRequired > 0,
      minRequired: group.minRequired,
      products: group.products.map((product, productIndex) => ({
        productRecordId: product.recordId,
        code: product.code,
        name: product.name,
        series: product.series,
        finish: product.finish,
        specification: product.specification,
        thumbnail: product.thumbnail,
        minPhotos: 1,
        maxPhotos: null,
        instructions: "",
        order: product.order || productIndex + 1,
        sourceUpdatedAt: product.sourceUpdatedAt,
      })),
    })),
  };
  return { version: snapshotHash(content), createdAt, ...content };
}

module.exports = { canonicalize, snapshotHash, createSamplingSnapshot, snapshotError };
