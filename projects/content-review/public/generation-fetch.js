// Shared helper for every "Generating..." interstitial page in this app
// (Submit an Idea, Revise with AI, Generate Social Captions, Standalone
// Social Post). Wraps fetch() with a client-side timeout so the spinner
// can never spin forever with no explanation, no matter what goes wrong
// upstream (a slow Claude generation, a network hiccup, or anything else).
//
// Background: before this existed, a real generation call that ran long
// (a big brief, a long pasted inspiration piece, etc.) could get silently
// dropped by nginx's connection timeout with nothing logged anywhere and
// no error shown to the user — just an infinite "Generating..." spinner.
// nginx's own timeout has since been raised, but this client-side timeout
// is the real fix: it guarantees the user always sees a clear message
// within a bounded time, regardless of what caused the delay.
//
// If the timeout fires, the generation call on the server may still finish
// on its own (aborting the browser's fetch does not stop server-side work
// already in progress) — the error message says so honestly rather than
// implying the attempt failed outright.
function generationFetchWithTimeout(url, options, timeoutMs) {
  // ~110s: comfortably under nginx's 180s proxy_read_timeout, well above
  // the typical 6-30s a real generation call takes.
  timeoutMs = timeoutMs || 110000;

  var controller = new AbortController();
  var timedOut = false;
  var timer = setTimeout(function () {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  return fetch(url, Object.assign({}, options, { signal: controller.signal }))
    .then(function (res) {
      clearTimeout(timer);
      return res.json().then(function (data) {
        return { ok: res.ok, data: data };
      });
    })
    .catch(function (err) {
      clearTimeout(timer);
      if (timedOut) {
        var timeoutErr = new Error(
          'This is taking longer than expected. It may still be finishing in the background — check back in a minute, or go back and try again.'
        );
        timeoutErr.isTimeout = true;
        throw timeoutErr;
      }
      throw err;
    });
}
