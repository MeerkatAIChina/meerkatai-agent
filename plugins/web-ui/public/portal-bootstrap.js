(function () {
  var KEY = "meerkat.portal_token";
  var params = new URLSearchParams(location.search);
  var token = params.get("portal_token");
  if (token) {
    localStorage.setItem(KEY, token);
    params.delete("portal_token");
    var q = params.toString();
    history.replaceState(null, "", location.pathname + (q ? "?" + q : "") + location.hash);
  }
  var saved = token || localStorage.getItem(KEY);
  if (!saved) return;
  window.__MEERKAT_PORTAL_TOKEN__ = saved;
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : input && input.url;
    if (url && url.charAt(0) === "/") {
      init = init || {};
      var headers = new Headers(init.headers || (typeof input !== "string" && input ? input.headers : undefined));
      if (!headers.has("x-portal-identity")) headers.set("x-portal-identity", saved);
      init.headers = headers;
    }
    return origFetch.call(this, input, init);
  };
})();
