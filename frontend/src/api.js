// API client with JWT auth
const API_BASE = import.meta.env.VITE_API_URL || "/api";

let token = localStorage.getItem("cbre_token") || null;

export const setToken = (t) => {
  token = t;
  if (t) localStorage.setItem("cbre_token", t);
  else localStorage.removeItem("cbre_token");
};

export const getToken = () => token;

const req = async (path, opts = {}) => {
  const headers = { ...(opts.headers || {}) };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (opts.body && !(opts.body instanceof FormData)) headers["Content-Type"] = "application/json";
  const r = await fetch(API_BASE + path, { ...opts, headers });
  if (r.status === 401) {
    setToken(null);
    window.location.reload();
    return;
  }
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: "Request failed" }));
    const e = new Error(err.error || "Request failed");
    e.status = r.status;           // e.g. 409 = concurrent-edit conflict
    e.serverVersion = err.version; // fresh version on 409
    throw e;
  }
  return r.json();
};

export const api = {
  // Auth
  login: (username, password) => req("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  changePassword: (current, nextPwd) => req("/auth/change-password", { method: "POST", body: JSON.stringify({ current, next: nextPwd }) }),
  me: () => req("/auth/me"),
  // Forgot/reset password (email self-service via Resend)
  forgotPassword: (username) => req("/auth/forgot", { method: "POST", body: JSON.stringify({ username }) }),
  resetPassword: (token, password) => req("/auth/reset", { method: "POST", body: JSON.stringify({ token, password }) }),

  // Users (admin)
  listUsers: () => req("/users"),
  createUser: (u) => req("/users", { method: "POST", body: JSON.stringify(u) }),
  deleteUser: (id) => req(`/users/${id}`, { method: "DELETE" }),
  resetUserPassword: (id, password) => req(`/users/${id}/reset-password`, { method: "POST", body: JSON.stringify(password ? { password } : {}) }),
  updateUser: (id, patch) => req(`/users/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  // Data
  getYearData: (year) => req(`/data/${year}`),
  getClientData: (year, client) => req(`/data/${year}/${encodeURIComponent(client)}`),
  // baseVersion enables optimistic locking: server rejects with 409 instead of silently
  // overwriting a colleague's changes. Omit baseVersion for legacy force-save.
  saveClientData: (year, client, data, baseVersion) => req(`/data/${year}/${encodeURIComponent(client)}`, {
    method: "PUT",
    body: JSON.stringify(baseVersion === undefined ? data : { data, baseVersion })
  }),
  saveClientDataBeacon: (year, client, data, baseVersion) => {
    try {
      return fetch(`${API_BASE}/data/${year}/${encodeURIComponent(client)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(baseVersion === undefined ? data : { data, baseVersion }),
        keepalive: true
      });
    } catch(e) { /* best-effort on unload */ }
  },

  // Company-wide OPEX/CAPEX (finance/admin)
  getFinanceData: (year) => req(`/finance/${year}`),
  saveFinanceData: (year, data, baseVersion) => req(`/finance/${year}`, {
    method: "PUT",
    body: JSON.stringify(baseVersion === undefined ? data : { data, baseVersion })
  }),

  // Files
  listFiles: (year, client) => req(`/files/${year}/${encodeURIComponent(client)}`),
  uploadFile: (year, client, file, type, contractRef) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("type", type || "Other");
    fd.append("contract_ref", contractRef || "");
    return req(`/files/${year}/${encodeURIComponent(client)}`, { method: "POST", body: fd });
  },
  updateFileRef: (year, client, id, contractRef) => req(`/files/${year}/${encodeURIComponent(client)}/${id}`, { method: "PATCH", body: JSON.stringify({ contract_ref: contractRef }) }),
  // Short-lived signed link (2') — no JWT ever appears in a URL
  getFileLink: async (year, client, id, dl) => {
    const r = await req(`/files/${year}/${encodeURIComponent(client)}/${id}/link`, { method: "POST", body: JSON.stringify({ dl: dl ? 1 : 0 }) });
    return r.url;
  },
  deleteFile: (year, client, id) => req(`/files/${year}/${encodeURIComponent(client)}/${id}`, { method: "DELETE" }),

  // AI Extraction (proxied to Anthropic via backend)
  extractInvoice: (file, mode) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("mode", mode || "AP");
    return req("/extract/invoice", { method: "POST", body: fd });
  },
  extractContract: (file) => {
    const fd = new FormData();
    fd.append("file", file);
    return req("/extract/contract", { method: "POST", body: fd });
  },
  // AI narrative insights over aggregated numbers (scope: "client" | "portfolio")
  getInsights: (scope, context) => req("/insights", { method: "POST", body: JSON.stringify({ scope, context }) }),

  // Audit
  audit: () => req("/audit"),

  // Full DB backup (admin) — returns a Blob to download
  backupDb: async () => {
    const r = await fetch(`${API_BASE}/backup`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!r.ok) throw new Error("Backup failed");
    return r.blob();
  },
};
