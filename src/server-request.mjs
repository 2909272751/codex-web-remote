const MAX_TEXT = 8_000;
const MAX_ANSWERS = 16;

export function buildServerRequestResponse(request, payload = {}) {
  if (!request || typeof request !== "object") throw new Error("交互请求不存在");
  const params = request.params || {};

  switch (request.method) {
    case "item/commandExecution/requestApproval":
      return { decision: commandDecision(params, payload.decision) };
    case "item/fileChange/requestApproval":
      return { decision: simpleDecision(payload.decision) };
    case "item/permissions/requestApproval":
      return permissionResponse(params, payload);
    case "item/tool/requestUserInput":
      return userInputResponse(params, payload);
    case "mcpServer/elicitation/request":
      return elicitationResponse(params, payload);
    default:
      throw new Error(`Web 端尚不支持此交互请求：${request.method || "unknown"}`);
  }
}

function commandDecision(params, value) {
  const requested = String(value || "");
  if (requested === "always") {
    if (Array.isArray(params.proposedExecpolicyAmendment) && params.proposedExecpolicyAmendment.length) {
      return { acceptWithExecpolicyAmendment: { execpolicy_amendment: params.proposedExecpolicyAmendment.map(String) } };
    }
    if (Array.isArray(params.proposedNetworkPolicyAmendments) && params.proposedNetworkPolicyAmendments.length) {
      return { applyNetworkPolicyAmendment: { network_policy_amendment: cloneJson(params.proposedNetworkPolicyAmendments[0]) } };
    }
    throw new Error("此命令没有可永久保存的允许规则");
  }
  const decision = simpleDecision(requested);
  const available = Array.isArray(params.availableDecisions)
    ? params.availableDecisions.filter((item) => typeof item === "string")
    : null;
  if (available?.length && !available.includes(decision)) throw new Error("该审批选项当前不可用");
  return decision;
}

function simpleDecision(value) {
  const decision = String(value || "");
  if (!new Set(["accept", "acceptForSession", "decline", "cancel"]).has(decision)) throw new Error("无效审批选项");
  return decision;
}

function permissionResponse(params, payload) {
  const decision = String(payload.decision || "decline");
  if (decision === "decline" || decision === "cancel") return { permissions: {}, scope: "turn", strictAutoReview: null };
  if (!new Set(["accept", "acceptForSession"]).has(decision)) throw new Error("无效权限审批选项");
  return {
    permissions: cloneJson(params.permissions || {}),
    scope: decision === "acceptForSession" || payload.scope === "session" ? "session" : "turn",
    strictAutoReview: null,
  };
}

function userInputResponse(params, payload) {
  const rawAnswers = payload.answers && typeof payload.answers === "object" ? payload.answers : {};
  const answers = {};
  for (const question of Array.isArray(params.questions) ? params.questions : []) {
    const id = String(question.id || "");
    if (!id) continue;
    const raw = rawAnswers[id];
    const values = (Array.isArray(raw) ? raw : raw == null ? [] : [raw])
      .slice(0, MAX_ANSWERS)
      .map((value) => cleanText(value));
    if (!values.length || values.every((value) => !value)) throw new Error(`请回答：${question.header || question.question || id}`);
    answers[id] = { answers: values };
  }
  return { answers };
}

function elicitationResponse(params, payload) {
  const action = String(payload.action || "");
  if (!new Set(["accept", "decline", "cancel"]).has(action)) throw new Error("无效表单操作");
  if (action !== "accept") return { action, content: null };
  if (params.mode === "url") return { action, content: null };
  const source = payload.content && typeof payload.content === "object" ? payload.content : {};
  const content = params.mode === "form"
    ? sanitizeFormContent(params.requestedSchema, source)
    : sanitizeLooseObject(source);
  return { action, content };
}

function sanitizeFormContent(schema, source) {
  if (!schema || typeof schema !== "object") return sanitizeLooseObject(source);
  const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const result = {};
  for (const [key, definition] of Object.entries(properties)) {
    const value = source[key];
    if (value == null || value === "") {
      if (required.has(key)) throw new Error(`请填写：${definition?.title || key}`);
      continue;
    }
    result[key] = sanitizePrimitive(definition, value);
  }
  return result;
}

function sanitizePrimitive(definition = {}, value) {
  const types = schemaTypes(definition);
  const enumValues = collectEnumValues(definition);
  if (types.has("array") || Array.isArray(value)) {
    const values = (Array.isArray(value) ? value : [value]).slice(0, MAX_ANSWERS);
    return values.map((item) => enumValues.length ? validateEnum(enumValues, item) : cleanText(item));
  }
  if (types.has("boolean")) return value === true || value === "true" || value === "on" || value === 1;
  if (types.has("integer")) {
    const number = Number(value);
    if (!Number.isInteger(number)) throw new Error("请输入整数");
    return number;
  }
  if (types.has("number")) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error("请输入数字");
    return number;
  }
  if (enumValues.length) return validateEnum(enumValues, value);
  return cleanText(value);
}

function schemaTypes(definition) {
  const result = new Set();
  const add = (type) => { if (typeof type === "string") result.add(type); else if (Array.isArray(type)) type.forEach(add); };
  add(definition?.type);
  for (const item of definition?.oneOf || []) add(item?.type);
  return result;
}

function collectEnumValues(definition, result = []) {
  if (!definition || typeof definition !== "object") return result;
  if (Array.isArray(definition.enum)) result.push(...definition.enum);
  if (Object.hasOwn(definition, "const")) result.push(definition.const);
  for (const item of definition.oneOf || []) collectEnumValues(item, result);
  if (definition.items) collectEnumValues(definition.items, result);
  return [...new Set(result.map((value) => String(value)))];
}

function validateEnum(values, value) {
  const cleaned = cleanText(value);
  if (!values.includes(cleaned)) throw new Error("选择值不在允许范围内");
  return cleaned;
}

function sanitizeLooseObject(source, depth = 0) {
  if (depth > 4 || source == null) return null;
  if (Array.isArray(source)) return source.slice(0, MAX_ANSWERS).map((item) => sanitizeLooseObject(item, depth + 1));
  if (typeof source === "string") return cleanText(source);
  if (typeof source === "number" || typeof source === "boolean") return source;
  if (typeof source !== "object") return String(source).slice(0, MAX_TEXT);
  const result = {};
  for (const [key, value] of Object.entries(source).slice(0, 100)) result[String(key).slice(0, 160)] = sanitizeLooseObject(value, depth + 1);
  return result;
}

function cleanText(value) { return String(value ?? "").slice(0, MAX_TEXT); }
function cloneJson(value) { return JSON.parse(JSON.stringify(value ?? {})); }

