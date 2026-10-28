// Talks to Halo's local engine. Every request carries the per-launch token from the window URL.

const token = new URLSearchParams(location.search).get("token") ?? "";

async function request(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { "x-halo-token": token, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error((await res.text()) || `Request failed (${res.status})`);
  if (res.status === 204) return null;
  const type = res.headers.get("content-type") ?? "";
  return type.includes("application/json") ? res.json() : res.blob();
}

/** For responses whose headers matter, like the thumbnail grid's layout. */
async function raw(path) {
  const res = await fetch(`/api${path}`, { headers: { "x-halo-token": token } });
  if (!res.ok) throw new Error((await res.text()) || `Request failed (${res.status})`);
  return res;
}

export const api = {
  raw,
  get: (path) => request("GET", path),
  post: (path, body = {}) => request("POST", path, body),
  put: (path, body) => request("PUT", path, body),
  del: (path) => request("DELETE", path),
  /** Sends a text file's contents as they are, like an imported LUT. */
  async postText(path, text) {
    const res = await fetch(`/api${path}`, { method: "POST", headers: { "x-halo-token": token, "content-type": "text/plain" }, body: text });
    if (!res.ok) throw new Error((await res.text()) || `Request failed (${res.status})`);
    return res.json();
  },
  /** A URL the <video> element can load directly; it can't send headers. */
  mediaUrl: (id) => `/api/media/${id}/file?token=${encodeURIComponent(token)}`,
  fontUrl: (id) => `/api/fonts/${id}/file?token=${encodeURIComponent(token)}`,
};
