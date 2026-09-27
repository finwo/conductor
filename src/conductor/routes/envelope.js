// src/conductor/routes/envelope.js - the shape every API response takes
//
//   { "ok": true,  "data": ..., "pagination": { ... } }
//   { "ok": false, "error": { "name": ..., "message": ..., "details": ... } }
//
// Optional keys are left out rather than sent as null, so an absent key
// cannot be mistaken for a meaningful one.

import { serializeError } from 'serialize-error-cjs';
import { ApiError, BadRequest, InternalError, NotFound } from '../../lib/errors.js';

export function ok(reply, data, pagination = null) {
  const body = { ok: true, data };
  if (pagination) body.pagination = pagination;
  return reply.send(body);
}

// API plugin only; page urls must not be answered in JSON.
export function envelopeFailures(fastify) {
  fastify.setNotFoundHandler((req, reply) => fail(req, reply, new NotFound()));
  fastify.setErrorHandler((e, req, reply) => fail(req, reply, e));
}

function fail(req, reply, e) {
  const known = asApiError(e);

  // A fault is the server's to explain. The error goes to the log under the
  // request id and the response carries only that id: a stack would hand out
  // paths and versions, and CORS here is open to any origin.
  if (known.code >= 500) {
    req.log.error({ err: serializeError(e), request_id: req.id }, 'request failed');
    return send(reply, new InternalError(undefined, { details: { request_id: req.id } }));
  }

  return send(reply, known);
}

function send(reply, e) {
  const error = { name: e.name, message: e.message };
  if (e.details !== undefined) error.details = e.details;
  return reply.code(e.code).send({ ok: false, error });
}

// Fastify's own failures carry a numeric statusCode; their code is a string
// like FST_ERR_CTP_EMPTY_JSON_BODY and is not what we mean by one.
function asApiError(e) {
  if (e instanceof ApiError) return e;

  const status = Number.isInteger(e?.statusCode) ? e.statusCode : 500;
  if (status >= 400 && status < 500) return new BadRequest(e.message, { code: status });

  return new InternalError();
}
