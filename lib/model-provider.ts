export const MODEL_PROVIDER_NAMES = ["llama.cpp", "remote-api"] as const;

export type ModelProviderName = (typeof MODEL_PROVIDER_NAMES)[number];

export const MODEL_PROVIDER_ERROR_CODES = [
  "model_unreachable",
  "model_timeout",
  "model_http_error",
  "model_invalid_json",
  "model_schema_invalid",
] as const;

export type ModelProviderErrorCode =
  (typeof MODEL_PROVIDER_ERROR_CODES)[number];

export interface SerializedModelProviderError {
  name: "ModelProviderError";
  provider: ModelProviderName;
  code: ModelProviderErrorCode;
  status?: number;
  message: string;
}

export interface ModelProviderErrorOptions {
  provider: ModelProviderName;
  code: ModelProviderErrorCode;
  status?: number;
  detail?: unknown;
}

const SAFE_ERROR_MESSAGE = "Model provider request failed.";

export function isModelProviderName(
  value: unknown,
): value is ModelProviderName {
  return (
    typeof value === "string" &&
    (MODEL_PROVIDER_NAMES as readonly string[]).includes(value)
  );
}

export function isModelProviderErrorCode(
  value: unknown,
): value is ModelProviderErrorCode {
  return (
    typeof value === "string" &&
    (MODEL_PROVIDER_ERROR_CODES as readonly string[]).includes(value)
  );
}

export class ModelProviderError extends Error {
  readonly provider: ModelProviderName;
  readonly code: ModelProviderErrorCode;
  readonly status?: number;

  constructor(options: ModelProviderErrorOptions) {
    if (!isModelProviderName(options.provider)) {
      throw new TypeError("Invalid model provider.");
    }
    if (!isModelProviderErrorCode(options.code)) {
      throw new TypeError("Invalid model provider error code.");
    }
    if (
      options.status !== undefined &&
      (!Number.isInteger(options.status) ||
        options.status < 100 ||
        options.status > 599)
    ) {
      throw new TypeError("Invalid model provider HTTP status.");
    }

    super(SAFE_ERROR_MESSAGE);
    this.name = "ModelProviderError";
    this.provider = options.provider;
    this.code = options.code;
    this.status = options.status;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): SerializedModelProviderError {
    return serializeModelProviderError(this);
  }
}

export function serializeModelProviderError(
  error: ModelProviderError,
): SerializedModelProviderError {
  const serialized: SerializedModelProviderError = {
    name: "ModelProviderError",
    provider: error.provider,
    code: error.code,
    message: SAFE_ERROR_MESSAGE,
  };

  if (error.status !== undefined) {
    serialized.status = error.status;
  }

  return serialized;
}
