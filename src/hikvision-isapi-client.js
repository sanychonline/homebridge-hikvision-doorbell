"use strict";

const crypto = require("crypto");
const http = require("http");
const https = require("https");

class HikvisionIsapiClient {
  constructor(config) {
    this.config = config;
  }

  async get(path) {
    return this.requestWithDigest("GET", path);
  }

  async getBuffer(path, headers = {}, options = {}) {
    return this.requestWithDigest("GET", path, undefined, headers, { ...options, binary: true });
  }

  async put(path, body, headers = {}) {
    return this.requestWithDigest("PUT", path, body, {
      "Content-Type": "application/xml",
      ...headers,
    });
  }

  async requestWithDigest(method, path, body, headers = {}, options = {}) {
    const deadlineAt = Date.now() + Number(options.timeoutMs || this.config.isapiRequestTimeoutMs || 5000);
    const firstHeaders = { ...headers };
    if (options.preemptiveBasicAuth === true && !firstHeaders.Authorization) {
      firstHeaders.Authorization = this.basicAuthorizationHeader();
    }
    const first = await this.request(method, path, body, firstHeaders, {
      ...options,
      timeoutMs: remainingTimeoutMs(deadlineAt),
    });
    if (first.statusCode !== 401) {
      return this.requireSuccess(first);
    }

    if (options.retryDigest === false) {
      return this.requireSuccess(first);
    }

    const challenge = first.response.headers["www-authenticate"];
    first.response.resume();
    if (!challenge) {
      throw new Error(`ISAPI ${method} ${path} returned HTTP 401 without authentication challenge`);
    }

    const authorization = this.authorizationHeader(method, path, challenge, body);
    const authenticated = await this.request(method, path, body, {
      ...headers,
      Authorization: authorization,
    }, {
      ...options,
      timeoutMs: remainingTimeoutMs(deadlineAt),
    });
    return this.requireSuccess(authenticated);
  }

  requireSuccess(result) {
    const { response, statusCode, body } = result;
    if (statusCode >= 200 && statusCode < 300) {
      return body;
    }
    response.destroy();
    throw new Error(`ISAPI returned HTTP ${statusCode}`);
  }

  request(method, path, body, headers = {}, options = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.url(path));
      const transport = url.protocol === "https:" ? https : http;
      const payload = body === undefined || body === null ? null : Buffer.from(String(body));
      const requestHeaders = {
        Accept: options.binary ? "image/jpeg,*/*" : "application/xml",
        ...headers,
      };
      if (payload) {
        requestHeaders["Content-Length"] = String(payload.length);
      }

      const request = transport.request(url, {
        method,
        headers: requestHeaders,
        rejectUnauthorized: false,
        timeout: Number(options.timeoutMs || this.config.isapiRequestTimeoutMs || 5000),
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({
          response,
          statusCode: response.statusCode || 0,
          body: options.binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString("utf8"),
        }));
      });
      request.once("error", reject);
      request.once("timeout", () => request.destroy(new Error(`ISAPI ${method} ${path} timeout`)));
      if (payload) {
        request.write(payload);
      }
      request.end();
    });
  }

  authorizationHeader(method, path, challenge, body) {
    const values = parseAuthenticateChallenge(challenge);
    if (!values.nonce) {
      return this.basicAuthorizationHeader();
    }

    const username = String(this.config.username || "");
    const password = String(this.config.password || "");
    const nc = "00000001";
    const cnonce = crypto.randomBytes(8).toString("hex");
    const qop = normalizeDigestQop(values.qop);
    const algorithm = normalizeDigestAlgorithm(values.algorithm);
    const baseHa1 = digestHash(algorithm.hash, `${username}:${values.realm || ""}:${password}`);
    const ha1 = algorithm.session ? digestHash(algorithm.hash, `${baseHa1}:${values.nonce}:${cnonce}`) : baseHa1;
    const ha2 = qop === "auth-int"
      ? digestHash(algorithm.hash, `${method}:${path}:${digestHash(algorithm.hash, normalizeDigestBody(body))}`)
      : digestHash(algorithm.hash, `${method}:${path}`);
    const response = qop
      ? digestHash(algorithm.hash, `${ha1}:${values.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
      : digestHash(algorithm.hash, `${ha1}:${values.nonce}:${ha2}`);
    const parts = [`username="${username}"`, `realm="${values.realm || ""}"`, `nonce="${values.nonce}"`, `uri="${path}"`, `response="${response}"`];
    if (values.algorithm) parts.push(`algorithm=${values.algorithm}`);
    if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
    if (values.opaque) parts.push(`opaque="${values.opaque}"`);
    return `Digest ${parts.join(", ")}`;
  }

  basicAuthorizationHeader() {
    return `Basic ${Buffer.from(`${this.config.username || ""}:${this.config.password || ""}`).toString("base64")}`;
  }

  url(path) {
    const host = this.config.ip || this.config.host || this.config.ipAddress || this.config.address;
    if (!host) {
      throw new Error("ISAPI host is unavailable.");
    }
    const protocol = String(this.config.httpProtocol || (this.config.https ? "https" : "http")).replace(/:$/, "");
    const port = Number(this.config.httpPort || (protocol === "https" ? 443 : 80));
    return `${protocol}://${host}:${port}${path.startsWith("/") ? path : `/${path}`}`;
  }
}

function remainingTimeoutMs(deadlineAt) {
  return Math.max(250, deadlineAt - Date.now());
}

function normalizeDigestAlgorithm(value) {
  const normalized = String(value || "MD5").toUpperCase();
  return {
    hash: normalized.includes("SHA-512-256") ? "sha512-256" : normalized.includes("SHA-256") ? "sha256" : "md5",
    session: normalized.includes("-SESS"),
  };
}

function digestHash(algorithm, value) {
  return crypto.createHash(algorithm).update(value).digest("hex");
}

function parseAuthenticateChallenge(challenge) {
  const header = String(challenge || "");
  const digest = header.match(/(?:^|,\s*)Digest\s+(.+?)(?=,\s*(?:Basic|Bearer|Negotiate)\s+|$)/i)?.[1] || header;
  const values = {};
  for (const match of digest.matchAll(/([a-z][a-z0-9_-]*)\s*=\s*(?:"([^"]*)"|([^,\s]+))/gi)) {
    values[match[1].toLowerCase()] = match[2] ?? match[3] ?? "";
  }
  return values;
}

function normalizeDigestQop(value) {
  const modes = String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (!modes.length) {
    return "";
  }
  return modes.includes("auth") ? "auth" : modes[0];
}

function normalizeDigestBody(body) {
  if (body === undefined || body === null) {
    return "";
  }
  return String(body);
}

module.exports = { HikvisionIsapiClient };
