// Adds an optional "dictate" microphone button next to any field marked
// data-dictation="true", using the browser's built-in speech-to-text (the
// Web Speech API's SpeechRecognition interface). This only works in Chrome
// and Edge today — Safari and Firefox don't implement it at all.
//
// IMPORTANT: this whole file is a no-op on unsupported browsers. It feature-
// detects once at the top and bails out immediately if the API isn't there,
// so it can never break typing (which must always work everywhere) and can
// never throw an error that affects the rest of the page.
(function () {
  var SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognitionCtor) {
    // No support (Safari, Firefox, older browsers) — don't render anything,
    // don't touch the page at all. Typing still works exactly as normal.
    return;
  }

  function onReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  function injectStyles() {
    if (document.getElementById('dictation-styles')) return;
    var style = document.createElement('style');
    style.id = 'dictation-styles';
    style.textContent =
      '.dictation-row { margin-top: 6px; display: flex; align-items: center; gap: 8px; }' +
      '.dictation-btn { width: 30px; height: 30px; border-radius: 50%; border: 1px solid var(--border, #dcdfe4);' +
      ' background: #fff; color: #555; display: inline-flex; align-items: center; justify-content: center;' +
      ' cursor: pointer; padding: 0; flex-shrink: 0; }' +
      '.dictation-btn:hover { background: var(--gray-bg, #f5f6f8); }' +
      '.dictation-btn.listening { background: var(--red, #d93025); border-color: var(--red, #d93025); color: #fff;' +
      ' animation: dictation-pulse 1.2s ease-in-out infinite; }' +
      '@keyframes dictation-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }' +
      '.dictation-status { font-size: 0.8rem; color: #666; }' +
      '.dictation-status.dictation-error { color: var(--red, #d93025); }';
    document.head.appendChild(style);
  }

  var MIC_ICON =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z" stroke="currentColor" stroke-width="2"/>' +
    '<path d="M19 11a7 7 0 0 1-14 0M12 18v3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
    '</svg>';

  // Only one microphone can realistically be listening at a time. Track the
  // active session's stop function so starting a new field's dictation
  // cleanly stops any other field still listening.
  var stopActive = null;

  function friendlyError(errorCode) {
    switch (errorCode) {
      case 'not-allowed':
      case 'permission-denied':
        return "Microphone access was blocked — check your browser's site permissions and try again.";
      case 'audio-capture':
        return 'No microphone was found on this device.';
      case 'network':
        return 'Dictation needs an internet connection right now.';
      case 'no-speech':
        return "Didn't catch any speech — try again.";
      default:
        return "Dictation had a problem — you can keep typing normally.";
    }
  }

  function setUpField(field) {
    var button = document.createElement('button');
    button.type = 'button'; // critical: fields live inside <form>s, must never submit
    button.className = 'dictation-btn';
    button.innerHTML = MIC_ICON;
    button.setAttribute('aria-label', 'Dictate into this field');

    var status = document.createElement('span');
    status.className = 'dictation-status';

    var row = document.createElement('div');
    row.className = 'dictation-row';
    row.appendChild(button);
    row.appendChild(status);

    field.insertAdjacentElement('afterend', row);

    var recognition = null;
    var listening = false;

    function separatorFor(text) {
      if (!text) return '';
      return /\s$/.test(text) ? '' : ' ';
    }

    function setListening(isListening) {
      listening = isListening;
      button.classList.toggle('listening', isListening);
      status.textContent = isListening ? 'Listening…' : '';
      status.classList.remove('dictation-error');
    }

    function stop() {
      if (recognition) {
        try {
          recognition.stop();
        } catch (e) {
          // ignore — recognition may already be stopped
        }
      }
    }

    function start() {
      if (stopActive) stopActive();

      recognition = new SpeechRecognitionCtor();
      recognition.lang = document.documentElement.lang || 'en-US';
      recognition.continuous = true;
      recognition.interimResults = true;

      var baseValue = field.value || '';
      var finalChunk = '';

      recognition.onresult = function (event) {
        var interim = '';
        for (var i = event.resultIndex; i < event.results.length; i++) {
          var transcript = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            finalChunk += separatorFor(baseValue + finalChunk) + transcript.trim();
          } else {
            interim += transcript;
          }
        }
        var combinedFinal = baseValue + finalChunk;
        field.value = combinedFinal + (interim ? separatorFor(combinedFinal) + interim : '');
        field.dispatchEvent(new Event('input', { bubbles: true }));
      };

      recognition.onerror = function (event) {
        // 'aborted' just means we (or the browser) stopped it on purpose —
        // not worth alarming Peter about.
        if (event.error === 'aborted') return;
        status.textContent = friendlyError(event.error);
        status.classList.add('dictation-error');
      };

      recognition.onend = function () {
        setListening(false);
        stopActive = null;
      };

      try {
        recognition.start();
        setListening(true);
        stopActive = stop;
      } catch (e) {
        status.textContent = "Couldn't start dictation — you can keep typing normally.";
        status.classList.add('dictation-error');
      }
    }

    button.addEventListener('click', function () {
      if (listening) {
        stop();
      } else {
        start();
      }
    });
  }

  onReady(function () {
    var fields = document.querySelectorAll('[data-dictation="true"]');
    if (!fields.length) return;
    injectStyles();
    fields.forEach(setUpField);
  });
})();
