/** 类型化错误层级：业务错误一律继承 AppError，全局处理器据此返回结构化响应 */
export class AppError extends Error {
  constructor(message, code, status = 500, details) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class BadRequestError extends AppError {
  constructor(message, details) { super(message, 'BAD_REQUEST', 400, details); }
}

export class NotFoundError extends AppError {
  constructor(resource, id) { super(`${resource} 不存在：${id}`, 'NOT_FOUND', 404); }
}

export class ConflictError extends AppError {
  constructor(message, details) { super(message, 'CONFLICT', 409, details); }
}

/** 业务校验错误：details.errors = [{code, element_seq?, message}]，details.warnings 为不拦截的提示 */
export class ValidationError extends AppError {
  constructor(message, errors, warnings) {
    super(message, 'VALIDATION_ERROR', 422, { errors, ...(warnings?.length ? { warnings } : {}) });
  }
}

export class RuleError extends AppError {
  constructor(message, details) { super(message, 'RULE_ERROR', 500, details); }
}

export function toErrorPayload(err, requestId) {
  if (err instanceof AppError) {
    return {
      title: err.code,
      status: err.status,
      detail: err.message,
      ...(err.details ? { details: err.details } : {}),
      request_id: requestId,
    };
  }
  return { title: 'INTERNAL_ERROR', status: 500, detail: '服务器内部错误', request_id: requestId };
}
