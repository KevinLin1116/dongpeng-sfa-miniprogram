function schemaConfigId(item = {}) {
  return item.configItemId || item.smartSheetItemId || item.sourceRecordId || "";
}

function schemaSnapshot(item = {}) {
  const snapshot = item.schemaSnapshot;
  if (!snapshot || !Array.isArray(snapshot.fields)) return null;
  return { ...snapshot, itemId: snapshot.itemId || schemaConfigId(item), itemName: snapshot.itemName || item.name, status: "ready" };
}

function findReadySchema(schemas, item) {
  const configItemId = schemaConfigId(item);
  if (!configItemId) return null;
  return (Array.isArray(schemas) ? schemas : []).find(
    (schema) => schema.itemId === configItemId && schema.status === "ready",
  ) || null;
}

function formFromSchema(item, schema) {
  return {
    id: item.id,
    configItemId: schema.itemId,
    name: item.name || schema.itemName,
    sectionName: item.sectionName || schema.itemName,
    renderer: schema.renderer || item.renderer || "通用表单",
    resultDirectoryRecordId: schema.resultDirectoryRecordId,
    resultSheetTitle: schema.resultSheetTitle,
    resultRelationField: schema.resultRelationField,
    writeMode: schema.writeMode,
    schemaHash: schema.schemaHash,
    fields: schema.fields,
    fieldCount: schema.fields.length,
    completedCount: 0,
    attendanceRole: schema.attendanceRole || item.attendanceRole || "",
    autoAdvance: schema.autoAdvance === true || item.autoAdvance === true,
    promptSubmitOnComplete: schema.promptSubmitOnComplete === true || item.promptSubmitOnComplete === true,
  };
}

function sanitizeValues(fields, values = {}) {
  return (Array.isArray(fields) ? fields : []).reduce((clean, field) => {
    if (Object.prototype.hasOwnProperty.call(values, field.key)) clean[field.key] = values[field.key];
    return clean;
  }, {});
}

module.exports = { schemaConfigId, schemaSnapshot, findReadySchema, formFromSchema, sanitizeValues };
