"use strict";
// A simulated Entra tenant behind Microsoft Graph, for tests of
// cx-entra-admin.js and the Directory screen. It answers the endpoints the
// portal calls, the way Microsoft's API reference documents them
// (api-reference/v1.0/api/group-post-members.md, group-delete-members.md,
// invitation-post.md, user-list.md, organization-get.md):
//
//   GET    /users?$select=…&$filter=mail eq '…' or userPrincipalName eq '…'
//   GET    /organization?$select=verifiedDomains
//   POST   /invitations                         → 201, invitedUser.id; an
//          address that already has an account returns that account
//   POST   /groups/{g}/members/$ref             → 204; 400 "already exist" when
//          already a member; 404 for an unknown or not-yet-replicated account;
//          403 unless the caller OWNS the group (the delegated rule)
//   DELETE /groups/{g}/members/{id}/$ref        → 204; 404 when not a member
//   DELETE /groups/{g}/members/{id} (no $ref)   → recorded as a disaster: it
//          would delete the account itself
//
// A request without the expected bearer token gets 401. Anything else is a
// 400, so a malformed request fails the test instead of passing by accident.
const crypto = require("crypto");

const GRAPH = "https://graph.microsoft.com/v1.0";
const err = (status, code, message) => ({ status, body: { error: { code, message } } });

function createTenant(opts = {}) {
  const state = {
    token: opts.token || "graph-token",
    caller: opts.caller,                       // the signed-in administrator's object id
    domains: opts.domains || ["hitachirail.com", "hitachirail.onmicrosoft.com"],
    users: new Map(),
    groups: new Map(),
    invitesAllowed: true,
    replicationLag: opts.replicationLag == null ? 2 : opts.replicationLag,
    lagging: new Map(),                        // id -> add attempts that still 404
    invitations: [],
    requests: [],
    disasters: [],
    failNext: null,                            // { method, path: RegExp, status, code, message }
  };

  function addUser(u) {
    const user = { id: u.id || crypto.randomUUID(), displayName: u.displayName || "", mail: u.mail || null,
                   userPrincipalName: u.userPrincipalName || u.mail };
    state.users.set(user.id, user);
    return user;
  }
  function addGroup(id, owners = []) {
    state.groups.set(id, { owners: new Set(owners), members: new Set() });
    return state.groups.get(id);
  }
  const lower = (s) => String(s || "").toLowerCase();

  function handle(method, rawUrl, headers = {}, bodyText) {
    const url = new URL(rawUrl);
    const auth = headers.Authorization || headers.authorization || "";
    const req = { method, path: url.pathname.replace(/^\/v1\.0/, ""), search: url.search, url: rawUrl,
                  body: bodyText ? JSON.parse(bodyText) : undefined, auth };
    state.requests.push(req);
    if (url.origin + "/v1.0" !== GRAPH) return err(400, "BadRequest", "not Graph v1.0: " + rawUrl);
    if (auth !== "Bearer " + state.token) return err(401, "InvalidAuthenticationToken", "Access token is empty or invalid.");
    const f = state.failNext;
    if (f && f.method === method && f.path.test(req.path)) {
      state.failNext = null;
      return err(f.status, f.code || "Injected", f.message || "injected failure");
    }

    // GET /users
    if (method === "GET" && req.path === "/users") {
      const filter = url.searchParams.get("$filter") || "";
      const m = /^mail eq '((?:[^']|'')*)' or userPrincipalName eq '((?:[^']|'')*)'$/.exec(filter);
      if (!m || m[1] !== m[2]) return err(400, "BadRequest", "Invalid filter clause: " + filter);
      const want = lower(m[1].replace(/''/g, "'"));
      const value = [...state.users.values()]
        .filter((u) => lower(u.mail) === want || lower(u.userPrincipalName) === want)
        .map((u) => ({ id: u.id, displayName: u.displayName, mail: u.mail, userPrincipalName: u.userPrincipalName }));
      return { status: 200, body: { value } };
    }
    // GET /organization
    if (method === "GET" && req.path === "/organization") {
      return { status: 200, body: { value: [{ verifiedDomains: state.domains.map((name) => ({ name })) }] } };
    }
    // POST /invitations
    if (method === "POST" && req.path === "/invitations") {
      const b = req.body || {};
      if (!b.invitedUserEmailAddress || !b.inviteRedirectUrl) return err(400, "BadRequest", "invitedUserEmailAddress and inviteRedirectUrl are required");
      if (!state.invitesAllowed) return err(403, "Authorization_RequestDenied", "Insufficient privileges to perform requested operation by the application '00000003-0000-0000-c000-000000000000'. ControllerName=MSGraphInviteAPI");
      state.invitations.push(b);
      let user = [...state.users.values()].find((u) => lower(u.mail) === lower(b.invitedUserEmailAddress));
      if (!user) {
        user = addUser({ mail: b.invitedUserEmailAddress, displayName: b.invitedUserDisplayName || "",
          userPrincipalName: b.invitedUserEmailAddress.replace("@", "_") + "#EXT#@hitachirail.onmicrosoft.com" });
        if (state.replicationLag) state.lagging.set(user.id, state.replicationLag);
      }
      return { status: 201, body: { id: crypto.randomUUID(), invitedUserEmailAddress: b.invitedUserEmailAddress,
        status: "PendingAcceptance", invitedUser: { id: user.id, userPrincipalName: user.userPrincipalName } } };
    }
    // /groups/{g}/members…
    const gm = /^\/groups\/([^/]+)\/members(?:\/(?!\$ref$)([^/]+))?(\/\$ref)?$/.exec(req.path);
    if (gm) {
      const [, gid, memberId, ref] = gm;
      const group = state.groups.get(gid);
      if (!group) return err(404, "Request_ResourceNotFound", `Resource '${gid}' does not exist or one of its queried reference-property objects are not present.`);
      if (!group.owners.has(state.caller)) return err(403, "Authorization_RequestDenied", "Insufficient privileges to complete the operation.");
      if (method === "POST" && !memberId && ref) {
        const odata = (req.body || {})["@odata.id"] || "";
        const om = new RegExp("^" + GRAPH.replace(/[.]/g, "\\.") + "/directoryObjects/([0-9a-f-]{36})$").exec(odata);
        if (!om) return err(400, "Request_BadRequest", "Invalid object identifier '" + odata + "'.");
        const id = om[1];
        const lag = state.lagging.get(id) || 0;
        if (lag > 0 || !state.users.has(id)) {
          if (lag > 0) state.lagging.set(id, lag - 1);
          return err(404, "Request_ResourceNotFound", `Resource '${id}' does not exist or one of its queried reference-property objects are not present.`);
        }
        if (group.members.has(id)) return err(400, "Request_BadRequest", "One or more added object references already exist for the following modified properties: 'members'.");
        group.members.add(id);
        return { status: 204 };
      }
      if (method === "DELETE" && memberId) {
        if (!ref) { state.disasters.push(req); return err(403, "Authorization_RequestDenied", "would have deleted the account"); }
        if (!group.members.has(memberId)) return err(404, "Request_ResourceNotFound", `Resource '${memberId}' does not exist or one of its queried reference-property objects are not present.`);
        group.members.delete(memberId);
        return { status: 204 };
      }
    }
    return err(400, "BadRequest", `Unsupported request ${method} ${req.path}`);
  }

  /** A fetch() for Node (vm sandboxes, unit tests). */
  async function fetchImpl(url, init = {}) {
    if (!String(url).startsWith("https://graph.microsoft.com/")) throw new TypeError("fake Graph only: " + url);
    const r = handle(init.method || "GET", String(url), init.headers || {}, init.body);
    return new Response(r.status === 204 || r.body === undefined ? null : JSON.stringify(r.body),
      { status: r.status, headers: { "content-type": "application/json" } });
  }

  return { state, addUser, addGroup, handle, fetch: fetchImpl };
}

module.exports = { createTenant, GRAPH };
