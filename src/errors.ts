// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Typed mesh errors with code + status + didYouMean.
export type MeshErrorCode =
  | "PEER_NOT_FOUND"
  | "PAYLOAD_TOO_LARGE"
  | "UNAUTHORIZED"
  | "PEER_BUSY_RETRY"
  | "SERVER_UNAVAILABLE"
  | "STORAGE_FULL"
  | "STORAGE_CORRUPT"
  | "STORAGE_UNAVAILABLE"
  | "INVALID_DIRECTORY"
  | "BROADCAST_DISABLED";

const STATUS_MAP: Record<MeshErrorCode, number> = {
  PEER_NOT_FOUND: 404,
  PAYLOAD_TOO_LARGE: 413,
  UNAUTHORIZED: 401,
  PEER_BUSY_RETRY: 429,
  SERVER_UNAVAILABLE: 503,
  STORAGE_FULL: 507,
  STORAGE_CORRUPT: 500,
  STORAGE_UNAVAILABLE: 503,
  INVALID_DIRECTORY: 400,
  BROADCAST_DISABLED: 403,
};

/**
 * Typed failure with stable code plus status; call sites match code, never message text.
 */
export class MeshError extends Error {
  code: MeshErrorCode;
  status: number;
  didYouMean?: string[];

  constructor(code: MeshErrorCode, message: string, opts?: { didYouMean?: string[]; status?: number }) {
    super(message);
    this.name = "MeshError";
    this.code = code;
    this.status = opts?.status ?? STATUS_MAP[code];
    if (opts?.didYouMean) this.didYouMean = opts.didYouMean;
  }
}
