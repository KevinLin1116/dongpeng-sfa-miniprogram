const crypto = require("crypto");
const { normalizeSamplingReview, uniqueIds } = require("./product-review");

const PLATFORM_MAX_PHOTOS_PER_PRODUCT = 20;

function samplingError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function productsFromSnapshot(snapshot) {
  return (snapshot.groups || []).flatMap((group) => (group.products || []).map((product) => ({ group, product })));
}

function groupRecordId(group) {
  return group.groupRecordId || group.ruleRecordId || "";
}

function groupName(group) {
  return group.displayName || group.name || group.level2Name || group.level1Name || "未命名分组";
}

function sanitizeSamplingValues(snapshot, input, { platformMaxPhotos = PLATFORM_MAX_PHOTOS_PER_PRODUCT } = {}) {
  if (!snapshot || !Array.isArray(snapshot.groups)) throw samplingError("SAMPLING_SNAPSHOT_MISSING", "产品上样任务缺少发布快照，请联系任务发布者重新发布任务");
  const knownProducts = new Set(productsFromSnapshot(snapshot).map(({ product }) => product.productRecordId));
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const unknown = Object.keys(source).filter((key) => !knownProducts.has(key));
  if (unknown.length) throw samplingError("SAMPLING_PRODUCT_UNKNOWN", "提交内容包含任务快照之外的产品，请刷新任务后重试", { productRecordIds: unknown });
  const normalized = {};
  for (const productRecordId of knownProducts) {
    const values = Array.isArray(source[productRecordId]) ? source[productRecordId] : [];
    const fileIds = Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
    if (fileIds.length > platformMaxPhotos) throw samplingError("SAMPLING_PLATFORM_PHOTO_LIMIT", `单个产品一次最多上传${platformMaxPhotos}张照片`, { productRecordId, photoCount: fileIds.length, maximum: platformMaxPhotos });
    const invalid = fileIds.filter((fileId) => !/^cloud:\/\//.test(fileId));
    if (invalid.length) throw samplingError("SAMPLING_FILE_ID_INVALID", "产品上样照片必须来自当前小程序云存储，请重新上传", { productRecordId, invalidCount: invalid.length });
    normalized[productRecordId] = fileIds;
  }
  return normalized;
}

function sameFileIds(left, right) {
  const a = uniqueIds(left).sort();
  const b = uniqueIds(right).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function validateSamplingEditAccess(snapshot, previousInput, nextInput, samplingReview) {
  const previous = sanitizeSamplingValues(snapshot, previousInput || {});
  const next = sanitizeSamplingValues(snapshot, nextInput || {});
  const review = normalizeSamplingReview(samplingReview);
  for (const productRecordId of review.qualifiedProductIds) {
    if (!sameFileIds(previous[productRecordId], next[productRecordId])) {
      throw samplingError("SAMPLING_QUALIFIED_PRODUCT_LOCKED", "已审核合格的产品不能修改或删除照片", { productRecordId });
    }
  }
  return next;
}

function validateSamplingSubmission(snapshot, input, options = {}) {
  const values = sanitizeSamplingValues(snapshot, input, options);
  const review = normalizeSamplingReview(options.samplingReview);
  const errors = [];
  const groups = (snapshot.groups || []).map((group) => {
    let completedProducts = 0;
    let errorCount = 0;
    const products = (group.products || []).map((product) => {
      const photos = values[product.productRecordId] || [];
      const selected = photos.length > 0;
      const minimum = Number(product.minPhotos || 1);
      const maximum = product.maxPhotos === null || product.maxPhotos === undefined || product.maxPhotos === "" ? null : Number(product.maxPhotos);
      let error;
      if (selected && photos.length < minimum) error = { code: "SAMPLING_PHOTOS_MISSING", message: `产品“${product.name}”还缺少${minimum - photos.length}张照片`, missing: minimum - photos.length };
      if (!error && maximum !== null && photos.length > maximum) error = { code: "SAMPLING_PHOTOS_EXCEEDED", message: `产品“${product.name}”最多上传${maximum}张照片`, exceeded: photos.length - maximum };
      const rejected = review.rejectedProducts[product.productRecordId];
      if (!error && rejected) {
        const previousFileIds = uniqueIds(rejected.previousFileIds);
        if (!photos.length || sameFileIds(previousFileIds, photos)) {
          error = { code: "SAMPLING_RECTIFICATION_PHOTO_REQUIRED", message: `产品“${product.name}”需要删除原照片并重新上传`, previousPhotoCount: previousFileIds.length };
        }
      }
      if (!error && selected) completedProducts += 1;
      if (error) {
        errorCount += 1;
        errors.push({ ...error, ruleRecordId: groupRecordId(group), groupRecordId: groupRecordId(group), productRecordId: product.productRecordId, groupName: groupName(group), productName: product.name });
      }
      return { ...product, photos, selected, valid: !error, error };
    });
    const minimumRequired = Number(group.minRequired || 0);
    if (group.required !== false && completedProducts < minimumRequired) {
      const error = { code: "SAMPLING_GROUP_INCOMPLETE", message: `规则分组“${groupName(group)}”至少完成${minimumRequired}款，目前完成${completedProducts}款`, missingProducts: minimumRequired - completedProducts, ruleRecordId: groupRecordId(group), groupRecordId: groupRecordId(group), groupName: groupName(group) };
      errors.push(error);
      errorCount += 1;
    }
    return { ...group, products, completedProducts, requiredProducts: minimumRequired, errorCount, valid: errorCount === 0 };
  });
  if (errors.length) throw samplingError("SAMPLING_VALIDATION_FAILED", errors[0].message, { errors, groups: groups.map((group) => ({ ruleRecordId: groupRecordId(group), groupRecordId: groupRecordId(group), completedProducts: group.completedProducts, requiredProducts: group.requiredProducts, errorCount: group.errorCount })) });
  return { values, groups, valid: true };
}

function imageObject(fileId, uploaded) {
  return {
    id: String(uploaded.id || crypto.createHash("sha256").update(fileId).digest("hex").slice(0, 24)),
    title: String(uploaded.title || "现场上样照片"),
    image_url: String(uploaded.image_url || uploaded.url || ""),
    width: Number(uploaded.width || 0),
    height: Number(uploaded.height || 0),
  };
}

function imageCacheKey(fileId) {
  return `file_${crypto.createHash("sha256").update(String(fileId || "")).digest("hex")}`;
}

function imageFromCache(cache, fileId) {
  if (!cache || typeof cache !== "object" || Array.isArray(cache)) return null;
  const direct = cache[fileId];
  if (direct?.image_url) return direct;
  if (direct?.fileId === fileId && direct?.image?.image_url) return direct.image;

  const safeEntry = cache[imageCacheKey(fileId)];
  if (safeEntry?.image_url) return safeEntry;
  if (safeEntry?.fileId === fileId && safeEntry?.image?.image_url) return safeEntry.image;

  // Older drafts used the full cloud file ID as an object key. CloudBase treats
  // dots in object keys as path separators, so those entries were persisted as
  // nested objects. Walk the split path to recover them without re-uploading.
  let legacyEntry = cache;
  for (const segment of String(fileId || "").split(".")) {
    legacyEntry = legacyEntry && typeof legacyEntry === "object" ? legacyEntry[segment] : null;
    if (!legacyEntry) break;
  }
  if (legacyEntry?.image_url) return legacyEntry;
  if (legacyEntry?.image?.image_url) return legacyEntry.image;
  return null;
}

function putImageInCache(cache, fileId, image) {
  cache[imageCacheKey(fileId)] = { fileId, image };
  return cache;
}

async function preUploadSamplingImages({ snapshot, values, client, cloud, existingCache = {}, onCache, concurrency = 3 }) {
  const cache = {};
  const normalized = sanitizeSamplingValues(snapshot, values);
  const pending = [];
  for (const { product } of productsFromSnapshot(snapshot)) {
    for (const fileId of normalized[product.productRecordId] || []) {
      const cachedImage = imageFromCache(existingCache, fileId);
      if (cachedImage) {
        putImageInCache(cache, fileId, cachedImage);
        continue;
      }
      pending.push({ product, fileId });
    }
  }
  const batchSize = Math.max(1, Math.min(5, Number(concurrency) || 3));
  for (let offset = 0; offset < pending.length; offset += batchSize) {
    const batch = pending.slice(offset, offset + batchSize);
    const settled = await Promise.allSettled(batch.map(async ({ product, fileId }) => {
      let downloaded;
      try { downloaded = await cloud.downloadFile({ fileID: fileId }); }
      catch (error) { throw samplingError("SAMPLING_IMAGE_DOWNLOAD_FAILED", `产品“${product.name}”的照片读取失败，请重新上传`, { productRecordId: product.productRecordId, fileId }); }
      let uploaded;
      try { uploaded = await client.uploadImage(downloaded.fileContent); }
      catch (error) { throw samplingError("SAMPLING_IMAGE_UPLOAD_FAILED", `产品“${product.name}”的照片同步失败，请稍后重试`, { productRecordId: product.productRecordId, fileId }); }
      const image = imageObject(fileId, uploaded);
      if (!image.image_url) throw samplingError("SAMPLING_IMAGE_UPLOAD_FAILED", `产品“${product.name}”的照片同步后缺少图片地址`, { productRecordId: product.productRecordId, fileId });
      return { fileId, image };
    }));
    const successful = settled.filter((entry) => entry.status === "fulfilled").map((entry) => entry.value);
    for (const { fileId, image } of successful) putImageInCache(cache, fileId, image);
    // 每批只落一次缓存；即使同批某张失败，已成功的照片也会被记住，重试时不会重复上传。
    if (successful.length && onCache) await onCache({ ...cache }, successful.map((entry) => entry.fileId), successful.map((entry) => entry.image));
    const failed = settled.find((entry) => entry.status === "rejected");
    if (failed) throw failed.reason;
  }
  return cache;
}

function samplingFormModel(snapshot, values, { readOnly = false, currentRound = 0, rejectionReason = "", approvalStatus = "", samplingReview } = {}) {
  const normalized = sanitizeSamplingValues(snapshot, values || {});
  const review = normalizeSamplingReview(samplingReview);
  const qualified = new Set(review.qualifiedProductIds);
  const groups = (snapshot.groups || []).map((group) => {
    const products = (group.products || []).map((product, originalIndex) => {
      const productRecordId = product.productRecordId;
      const photos = normalized[productRecordId] || [];
      const rejected = review.rejectedProducts[productRecordId];
      const isQualified = qualified.has(productRecordId);
      const reviewState = isQualified ? "qualified" : rejected ? "rectify" : photos.length ? "new" : "candidate";
      const priority = { rectify: 0, new: 1, qualified: 2, candidate: 3 }[reviewState];
      return {
        ...product,
        id: productRecordId,
        thumbnail: product.thumbnail && (product.thumbnail.imageUrl || product.thumbnail.image_url || ""),
        photos,
        reviewState,
        editable: !readOnly && !isQualified,
        rejectionReason: rejected && rejected.reason || "",
        priority,
        originalIndex,
      };
    }).sort((left, right) => left.priority - right.priority || left.originalIndex - right.originalIndex);
    const completedProducts = products.filter((product) => qualified.has(product.productRecordId) || product.photos.length >= Number(product.minPhotos || 1)).length;
    const minimumRequired = Number(group.minRequired || 0);
    const ruleLabel = minimumRequired === 0 ? "选上" : minimumRequired >= products.length ? "必上" : `${products.length}选${minimumRequired}`;
    return { ...group, id: groupRecordId(group), name: groupName(group), ruleLabel, products, completedProducts, requiredProducts: minimumRequired, errorCount: 0 };
  });
  return { snapshotVersion: snapshot.version, productRule: snapshot.productRule || null, groups, values: normalized, readOnly, currentRound, rejectionReason, approvalStatus, samplingReview: review, rectificationMode: Object.keys(review.rejectedProducts).length > 0 };
}

module.exports = {
  PLATFORM_MAX_PHOTOS_PER_PRODUCT,
  sanitizeSamplingValues,
  validateSamplingSubmission,
  preUploadSamplingImages,
  samplingFormModel,
  sameFileIds,
  validateSamplingEditAccess,
  productsFromSnapshot,
  groupRecordId,
  groupName,
  imageObject,
  imageCacheKey,
  imageFromCache,
  putImageInCache,
  samplingError,
};
