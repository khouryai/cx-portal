// ==========================================
// HITACHI Rail T&C Portal — people in Microsoft Entra (cx-entra-admin.js)
//
// Under Microsoft sign-in, a person can use the portal only if they are in the
// CX Portal Users group in Entra (the app registration requires assignment).
// This module lets a portal administrator manage that from the Directory
// screen, so adding or removing someone is one step in the portal, not a
// ticket to IT:
//
//   findUser(email)        is there a Microsoft account with this address?
//   invite(email, name)    no: invite them as a B2B guest (Microsoft emails them)
//   addToGroup(id)         put them in CX Portal Users (they can sign in)
//   removeFromGroup(id)    take them out (they can no longer sign in)
//
// It talks to Microsoft Graph from the browser with the administrator's OWN
// delegated token. That token can never do more than the administrator could
// do in Microsoft's own admin pages: adding or removing members works because
// IT makes portal administrators OWNERS of the CX Portal Users group, and
// inviting guests works if Hitachi's external-collaboration settings let them
// (docs/AZURE_HOSTING.md, section 2). A portal user who is not an owner gets
// 403 from Microsoft whatever this file does. There is no secret here and no
// server.
//
// Enabled when IDENTITY is 'entra' and config.js sets ENTRA_USERS_GROUP_ID
// (the object id of CX Portal Users). Without it the portal falls back to
// "add the profile, IT adds them to the group" (team-invite.js).
//
// The orchestration (and its rollback when the portal's own save fails) lives
// in team-invite.js; this file only speaks Graph, and turns Graph's errors into
// sentences an administrator can act on (explain()).
// Pinned by tools/test_entra_admin.js against a simulated Entra tenant.
// ==========================================
(function () {
  'use strict';

  var GRAPH = 'https://graph.microsoft.com/v1.0';
  // Delegated permissions IT grants (admin consent) on the app registration.
  // Each call asks only for the one it needs, so a permission IT chose not to
  // grant (say guest invitations) stops only that one action.
  var SCOPE = {
    org:    'https://graph.microsoft.com/User.Read',                 // the organisation's own domains
    find:   'https://graph.microsoft.com/User.ReadBasic.All',        // find a person by email
    add:    'https://graph.microsoft.com/GroupMember.ReadWrite.All', // add to CX Portal Users
    remove: 'https://graph.microsoft.com/GroupMember.ReadWrite.All', // remove from CX Portal Users
    invite: 'https://graph.microsoft.com/User.Invite.All',           // invite a BART guest
  };
  var SCOPES = [SCOPE.org, SCOPE.find, SCOPE.add, SCOPE.invite];
  var GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // A newly invited guest takes a few seconds to reach every directory
  // replica; until then adding them to a group answers 404 or 400 "doesn't
  // exist" (Microsoft: retry after a brief delay). Up to ~25 s in total.
  var api = { _delays: [1000, 2000, 4000, 8000, 10000] };

  function win() { return typeof window !== 'undefined' ? window : {}; }
  function cfg() { return win().CX_CONFIG || {}; }
  function groupId() { return String(cfg().ENTRA_USERS_GROUP_ID || '').trim(); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /** A Graph failure, with what the caller was doing. */
  function failure(status, code, message, op) {
    var e = new Error(message || ('Microsoft Graph error ' + status));
    e.status = status; e.code = code || ''; e.op = op || '';
    e.graph = true;
    return e;
  }

  function enabled() {
    var id = win().CXIdentity;
    return !!(id && id.kind === 'entra' && typeof id.tokenFor === 'function' && groupId());
  }

  function token(op) {
    return win().CXIdentity.tokenFor([SCOPE[op]], { interactive: 'popup' }).catch(function (err) {
      var code = String((err && (err.errorCode || err.name)) || '');
      var text = code + ' ' + ((err && err.message) || '');
      throw failure(0, /user_cancel/i.test(text) ? 'cancelled' : /popup|empty_window/i.test(text) ? 'popup_blocked' : 'token',
        (err && err.message) || 'no Microsoft Graph token', 'token:' + op);
    });
  }

  function call(method, path, body, op) {
    return token(op).then(function (t) {
      var headers = { Authorization: 'Bearer ' + t, Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      return fetch(GRAPH + path, {
        method: method, headers: headers, cache: 'no-store',
        body: body === undefined ? undefined : JSON.stringify(body),
      }).then(function (res) {
        if (res.status === 204) return null;
        return res.text().then(function (text) {
          var json = null;
          try { json = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
          if (!res.ok) {
            var err = (json && json.error) || {};
            throw failure(res.status, err.code, err.message || text || res.statusText, op);
          }
          return json;
        });
      }, function (e) {
        throw failure(0, 'network', 'Could not reach Microsoft: ' + ((e && e.message) || e), op);
      });
    });
  }

  function cleanEmail(email) { return String(email || '').trim().toLowerCase(); }

  /**
   * The Microsoft account with this address in the organisation's directory —
   * staff by their mail or sign-in name, guests by the address they were
   * invited with — or null.
   * @returns {Promise<{id:string, displayName:string, mail:string, userPrincipalName:string, guest:boolean}|null>}
   */
  function findUser(email) {
    var e = cleanEmail(email);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return Promise.reject(failure(400, 'bad_email', 'That does not look like an email address', 'find'));
    var q = e.replace(/'/g, "''");    // OData string literal
    var filter = "mail eq '" + q + "' or userPrincipalName eq '" + q + "'";
    return call('GET', '/users?$select=id,displayName,mail,userPrincipalName&$filter=' + encodeURIComponent(filter), undefined, 'find')
      .then(function (r) {
        var list = (r && r.value) || [];
        if (list.length > 1) {
          throw failure(409, 'ambiguous', 'More than one Microsoft account uses ' + e + ' — ask IT which one is theirs', 'find');
        }
        var u = list[0];
        if (!u) return null;
        return { id: u.id, displayName: u.displayName || '', mail: u.mail || '', userPrincipalName: u.userPrincipalName || '',
                 guest: /#EXT#/i.test(u.userPrincipalName || '') };
      });
  }

  var domains = null;
  /** The organisation's own email domains, lower-case. Cached per page load. */
  function homeDomains() {
    if (domains) return Promise.resolve(domains);
    return call('GET', '/organization?$select=verifiedDomains', undefined, 'org').then(function (r) {
      var org = (r && r.value && r.value[0]) || {};
      domains = (org.verifiedDomains || []).map(function (d) { return String(d.name || '').toLowerCase(); }).filter(Boolean);
      return domains;
    });
  }

  /** True when the address is on one of the organisation's own domains (staff, not a guest). */
  function isHomeAddress(email) {
    var domain = cleanEmail(email).split('@')[1] || '';
    return homeDomains().then(function (list) { return list.indexOf(domain) !== -1; });
  }

  /**
   * Invite an outside person as a B2B guest; Microsoft emails them the
   * invitation, which brings them back to the portal once accepted.
   * @returns {Promise<{id:string, status:string}>}
   */
  function invite(email, displayName) {
    var w = win();
    var redirect = cfg().ENTRA_REDIRECT_URI ||
      (w.location ? w.location.origin + w.location.pathname : '');
    return call('POST', '/invitations', {
      invitedUserEmailAddress: String(email || '').trim(),
      invitedUserDisplayName: displayName || undefined,
      inviteRedirectUrl: redirect,
      sendInvitationMessage: true,
    }, 'invite').then(function (r) {
      var id = r && r.invitedUser && r.invitedUser.id;
      if (!id) throw failure(500, 'no_id', 'Microsoft accepted the invitation but returned no account id', 'invite');
      return { id: id, status: (r && r.status) || '' };
    });
  }

  /**
   * The account for this address: an existing one, or a guest invited now.
   * An address on the organisation's own domain that has no account is a
   * typo or a missing staff account — never invited as a guest.
   * @param {function(string): Promise<boolean>} [confirmInvite] asked before inviting
   * @returns {Promise<{id:string, invited:boolean, guest:boolean}|null>} null = the admin declined the invitation
   */
  function resolveAccount(email, displayName, confirmInvite) {
    return findUser(email).then(function (u) {
      if (u) return { id: u.id, invited: false, guest: u.guest };
      return isHomeAddress(email).then(function (home) {
        if (home) {
          throw failure(404, 'no_account', 'No Microsoft account in your organisation has the address ' + cleanEmail(email) +
            '. Check the spelling: staff accounts are created by IT.', 'find');
        }
        return Promise.resolve(confirmInvite ? confirmInvite(cleanEmail(email)) : true).then(function (yes) {
          if (!yes) return null;
          return invite(email, displayName).then(function (inv) { return { id: inv.id, invited: true, guest: true }; });
        });
      });
    });
  }

  function checkId(id) {
    if (!GUID.test(String(id || ''))) throw failure(400, 'bad_id', 'Not a Microsoft account id: ' + id, 'id');
    if (!GUID.test(groupId())) throw failure(400, 'bad_group', 'CX_CONFIG.ENTRA_USERS_GROUP_ID is not a group object id', 'id');
  }

  /**
   * Add to CX Portal Users. Already a member is not an error.
   * @returns {Promise<{added:boolean}>} added=false when they were already in it
   */
  function addToGroup(id) {
    try { checkId(id); } catch (e) { return Promise.reject(e); }
    var attempt = 0;
    function tryOnce() {
      return call('POST', '/groups/' + groupId() + '/members/$ref',
        { '@odata.id': GRAPH + '/directoryObjects/' + id }, 'add')
        .then(function () { return { added: true }; }, function (err) {
          if (err.status === 400 && /already exist/i.test(err.message)) return { added: false };
          var notYet = err.status === 404 ||
            (err.status === 400 && /(don'?t|do not|does not|doesn'?t) exist/i.test(err.message));
          if (notYet && attempt < api._delays.length) {
            return sleep(api._delays[attempt++]).then(tryOnce);
          }
          throw err;
        });
    }
    return tryOnce();
  }

  /**
   * Take out of CX Portal Users. Not a member is not an error. Always the
   * `/$ref` form: without it Graph would DELETE THE ACCOUNT ITSELF if the
   * token were ever allowed to.
   * @returns {Promise<{removed:boolean}>}
   */
  function removeFromGroup(id) {
    try { checkId(id); } catch (e) { return Promise.reject(e); }
    return call('DELETE', '/groups/' + groupId() + '/members/' + id + '/$ref', undefined, 'remove')
      .then(function () { return { removed: true }; }, function (err) {
        if (err.status === 404) return { removed: false };
        throw err;
      });
  }

  /** A sentence an administrator can act on, for any failure above. */
  function explain(err) {
    if (!err) return 'Something went wrong talking to Microsoft.';
    if (!err.graph) return String(err.message || err);
    if (err.code === 'cancelled') return 'You closed the Microsoft window, so nothing was changed.';
    if (err.code === 'popup_blocked') {
      return 'Microsoft needs you to confirm in a pop-up window, and the browser blocked it. Allow pop-ups for this site and try again.';
    }
    if (/^token/.test(err.op)) {
      return 'Microsoft did not let the portal ' + (err.op === 'token:invite' ? 'invite guests' : 'manage people') +
        ' for you (' + err.message + '). IT must grant admin consent for the portal’s Microsoft Graph permissions' +
        (err.op === 'token:invite' ? ' (User.Invite.All), or invite the guest in Entra and add them here again.' : '.');
    }
    if (err.status === 403) {
      if (err.op === 'add' || err.op === 'remove') {
        return 'Your Microsoft account cannot change the CX Portal Users group. IT makes portal administrators owners of that group.';
      }
      if (err.op === 'invite') {
        return 'Your Microsoft account is not allowed to invite guests. IT can allow it (the Guest Inviter role, or the external-collaboration settings).';
      }
      return 'Microsoft refused to look up accounts. IT must grant admin consent for the portal’s Microsoft Graph permissions.';
    }
    if (err.status === 401) return 'Microsoft rejected the sign-in token. Sign out, sign in again, and retry.';
    if (err.status === 429 || err.status >= 500) return 'Microsoft is busy or unavailable. Try again in a minute.';
    if ((err.op === 'add') && (err.status === 404 || err.status === 400) && !/already/i.test(err.message)) {
      return 'Microsoft has not finished creating this account yet. Wait a minute and add them again; nothing is duplicated.';
    }
    return err.message;
  }

  api.SCOPES = SCOPES;
  api.enabled = enabled;
  api.groupId = groupId;
  api.findUser = findUser;
  api.homeDomains = homeDomains;
  api.isHomeAddress = isHomeAddress;
  api.invite = invite;
  api.resolveAccount = resolveAccount;
  api.addToGroup = addToGroup;
  api.removeFromGroup = removeFromGroup;
  api.explain = explain;
  api._reset = function () { domains = null; };

  if (typeof window !== 'undefined') window.CXEntraAdmin = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
