// supabase-lite.js — a tiny hand-written client for Supabase's Auth + REST (PostgREST) APIs,
// using nothing but fetch(). No build step, no npm dependency — works as a plain <script> tag,
// same "vanilla JS" style as the rest of this app.
//
// Why: the environment this app was built in cannot reach registry.npmjs.org, so the official
// @supabase/supabase-js package could not be installed. Everything it does for this app's needs
// (email/password auth, session storage, simple REST queries) is just a few HTTP calls, so this
// file talks to Supabase's own HTTP APIs directly instead.

const Dinero = (() => {
  let SUPABASE_URL = "";
  let SUPABASE_ANON_KEY = "";
  let session = null; // { access_token, refresh_token, user }

  const SESSION_KEY = "dinero_session";

  function configure(url, anonKey) {
    SUPABASE_URL = url.replace(/\/$/, "");
    SUPABASE_ANON_KEY = anonKey;
    const saved = localStorage.getItem(SESSION_KEY);
    if (saved) {
      try { session = JSON.parse(saved); } catch (e) { session = null; }
    }
  }

  function saveSession(s) {
    session = s;
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  }

  function currentUser() {
    return session ? session.user : null;
  }

  async function authFetch(path, opts = {}) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1${path}`, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        ...(opts.headers || {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error_description || data.msg || data.error || `Auth-feil (${res.status})`);
    return data;
  }

  // --- AUTH ---

  async function signUp(email, password, householdName) {
    const data = await authFetch("/signup", {
      method: "POST",
      body: JSON.stringify({
        email,
        password,
        data: { household_name: householdName }, // -> raw_user_meta_data, read by the DB trigger
      }),
    });
    if (data.access_token) {
      saveSession({ access_token: data.access_token, refresh_token: data.refresh_token, user: data.user });
    }
    return data;
  }

  async function signIn(email, password) {
    const data = await authFetch("/token?grant_type=password", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    saveSession({ access_token: data.access_token, refresh_token: data.refresh_token, user: data.user });
    return data;
  }

  async function signOut() {
    if (session) {
      await authFetch("/logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
      }).catch(() => {}); // best-effort; clear local session regardless
    }
    saveSession(null);
  }

  async function refreshSession() {
    if (!session || !session.refresh_token) return null;
    try {
      const data = await authFetch("/token?grant_type=refresh_token", {
        method: "POST",
        body: JSON.stringify({ refresh_token: session.refresh_token }),
      });
      saveSession({ access_token: data.access_token, refresh_token: data.refresh_token, user: data.user });
      return session;
    } catch (e) {
      saveSession(null);
      return null;
    }
  }

  // --- REST (PostgREST) ---
  // Thin wrapper: db("table").select(...) / .insert(...) / .update(...) / .upsert(...) / .delete()
  // Every call automatically sends the current session's access token, so Row Level Security
  // policies apply exactly as if this were the real supabase-js client.

  function db(table) {
    const base = `${SUPABASE_URL}/rest/v1/${table}`;
    function headers(extra = {}) {
      return {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${session ? session.access_token : SUPABASE_ANON_KEY}`,
        ...extra,
      };
    }
    async function run(url, opts) {
      const res = await fetch(url, { ...opts, headers: headers(opts.headers) });
      if (res.status === 204) return null;
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && (data.message || data.error)) || `Database-feil (${res.status})`);
      return data;
    }
    return {
      // select("*") or select("id,name") — filters as PostgREST query params, e.g. { household_id: "eq.xxx" }
      select(cols = "*", filters = {}) {
        const params = new URLSearchParams({ select: cols, ...filters });
        return run(`${base}?${params.toString()}`, { method: "GET" });
      },
      insert(rows) {
        return run(base, {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify(rows),
        });
      },
      upsert(rows, onConflict) {
        const q = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : "";
        return run(`${base}${q}`, {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=representation" },
          body: JSON.stringify(rows),
        });
      },
      update(patch, filters = {}) {
        const params = new URLSearchParams(filters);
        return run(`${base}?${params.toString()}`, {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify(patch),
        });
      },
      delete(filters = {}) {
        const params = new URLSearchParams(filters);
        return run(`${base}?${params.toString()}`, { method: "DELETE" });
      },
    };
  }

  return { configure, signUp, signIn, signOut, refreshSession, currentUser, db, get session() { return session; } };
})();
