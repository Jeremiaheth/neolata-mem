/**
 * Shared validation utilities for neolata-mem.
 */

const PRIVATE_IP_RE = /^https?:\/\/(10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0|\[fd[0-9a-f]{0,2}:)/i;
const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?/i;

/**
 * Validate a base URL for API calls.
 * Blocks private/internal IPs unless allowPrivate is true.
 * Allows localhost (needed for OpenClaw gateway, Ollama, etc).
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {boolean} [opts.allowPrivate=false] - Allow private IP ranges
 * @param {boolean} [opts.requireHttps=false] - Require HTTPS (blocks HTTP except localhost)
 * @param {string} [opts.label='baseUrl'] - Label for error messages
 */
export function validateBaseUrl(url, { allowPrivate = false, requireHttps = false, label = 'baseUrl' } = {}) {
  if (typeof url !== 'string' || !url.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }

  // Must start with http:// or https://
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`${label} must start with http:// or https://`);
  }

  // Cloud metadata endpoint — always blocked (even with allowPrivate)
  if (/169\.254\.169\.254/.test(url) || /metadata\.google\.internal/i.test(url)) {
    throw new Error(`${label} points to a cloud metadata endpoint — blocked for security`);
  }

  // Block private IPs (unless explicitly allowed)
  if (!allowPrivate && PRIVATE_IP_RE.test(url)) {
    throw new Error(`${label} points to a private IP range — set allowPrivate:true to override`);
  }

  // requireHttps: block non-localhost HTTP
  if (requireHttps && /^http:\/\//i.test(url) && !LOCALHOST_RE.test(url)) {
    throw new Error(`${label} must use HTTPS for non-localhost URLs`);
  }

  return url;
}
