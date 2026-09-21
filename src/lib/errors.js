// src/lib/errors.js - errors that describe themselves over HTTP
//
// The class name is the identifier on the wire, and code is the HTTP status:
// serialize-error-cjs carries both, where a property of our own would be lost.
// Statics rather than fields, since a subclass field would clobber an override.

export class ApiError extends Error {
  static code = 500;
  static defaultMessage = 'The request could not be completed';

  constructor(message, { code, details } = {}) {
    super(message ?? new.target.defaultMessage);
    this.name = new.target.name;
    this.code = code ?? new.target.code;
    if (details !== undefined) this.details = details;
  }
}

// Carries details.request_id, tying a report of "it broke" to the log line.
export class InternalError extends ApiError {
  static code = 500;
}

// For a 4xx nobody threw deliberately, such as a body Fastify itself refused.
export class BadRequest extends ApiError {
  static code = 400;
  static defaultMessage = 'The request could not be understood';
}

// --- not there, or not yours: both answer 404, so neither can be probed ---

export class UnknownProject extends ApiError {
  static code = 404;
  static defaultMessage = 'No such project';
}

export class UnknownJob extends ApiError {
  static code = 404;
  static defaultMessage = 'No such job';
}

export class UnknownTask extends ApiError {
  static code = 404;
  static defaultMessage = 'No such task';
}

export class UnknownArtifact extends ApiError {
  static code = 404;
  static defaultMessage = 'No such artifact';
}

export class ArtifactNotStored extends ApiError {
  static code = 404;
  static defaultMessage = 'That artifact is no longer stored';
}

export class NotFound extends ApiError {
  static code = 404;
  static defaultMessage = 'No such endpoint';
}

// --- refused ---

export class InvalidSignature extends ApiError {
  static code = 401;
  static defaultMessage = 'The request signature is missing or wrong';
}

export class InvalidWorkerToken extends ApiError {
  static code = 401;
  static defaultMessage = 'The worker token is missing or wrong';
}

// 403 reaching for a task it never held, 409 losing one mid-report.
export class TaskNotHeld extends ApiError {
  static code = 403;
  static defaultMessage = 'That task is not held by this worker';
}

// --- not actionable as it stands ---

export class ProjectDisabled extends ApiError {
  static code = 409;
  static defaultMessage = 'That project is disabled';
}

export class TaskNotRunning extends ApiError {
  static code = 409;
  static defaultMessage = 'That task is not running';
}

// Carries details.expected_offset, which is what makes a resume safe.
export class LogOffsetConflict extends ApiError {
  static code = 409;
  static defaultMessage = 'The log chunk does not continue from the end of the log';
}

// --- malformed ---

export class MalformedJson extends ApiError {
  static code = 400;
  static defaultMessage = 'The request body is not valid JSON';
}

export class NoCommitInPayload extends ApiError {
  static code = 400;
  static defaultMessage =
    'Could not read a commit from the payload; expected sha, or a GitHub, Gitea or GitLab push event';
}

export class InvalidSha extends ApiError {
  static code = 400;
  static defaultMessage = 'That is not a full commit id';
}

export class ShaRequired extends ApiError {
  static code = 400;
  static defaultMessage = 'sha is required';
}

export class InvalidLogOffset extends ApiError {
  static code = 400;
  static defaultMessage = 'x-log-offset must be an integer';
}

export class InvalidArtifactPath extends ApiError {
  static code = 400;
  static defaultMessage = 'x-artifact-path is missing or unusable';
}

export class ArtifactSizeMismatch extends ApiError {
  static code = 400;
  static defaultMessage = 'The artifact body does not match its declared length';
}

export class ContentLengthRequired extends ApiError {
  static code = 411;
  static defaultMessage = 'content-length is required for artifact uploads';
}

export class LogChunkTooLarge extends ApiError {
  static code = 413;
  static defaultMessage = 'That log chunk is too large';
}
