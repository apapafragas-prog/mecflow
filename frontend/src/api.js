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
    throw new Error(err.error || "Request failed");
  }
  return r.json();
};

export const api = {
  // Auth
  login: (username, password) => req("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  changePassword: (current, nextPwd) => req("/auth/change-password", { method: "POST", body: JSON.stringify({ current, next: nextPwd }) }),
  me: () => req("/auth/me"),

  // Users (admin)
  listUsers: () => req("/users"),
  createUser: (u) => req("/users", { method: "POST", body: JSON.stringify(u) }),
  deleteUser: (id) => req(`/users/${id}`, { method: "DELETE" }),

  // Data
  getYearData: (year) => req(`/data/${year}`),
  getClientData: (year, client) => req(`/data/${year}/${encodeURIComponent(client)}`),
  saveClientData: (year, client, data) => req(`/data/${year}/${encodeURIComponent(client)}`, { method: "PUT", body: JSON.stringify(data) }),
  saveClientDataBeacon: (year, client, data) => {
    try {
      return fetch(`${API_BASE}/data/${year}/${encodeURIComponent(client)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(data),
        keepalive: true
      });
    } catch(e) { /* best-effort on unload */ }
  },

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
  fileUrl: (year, client, id) => `${API_BASE}/files/${year}/${encodeURIComponent(client)}/${id}/download?token=${encodeURIComponent(token||"")}`,
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

  // Audit
  audit: () => req("/audit"),
};
