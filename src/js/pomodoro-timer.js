(function (root) {
  'use strict';

  // Which phase comes after `phase`, given how many focus sessions are done.
  function nextPhase(phase, focusDone, every) {
    if (phase !== 'focus') return 'focus';
    return focusDone > 0 && focusDone % every === 0 ? 'long' : 'short';
  }

  function clock(ms) {
    var total = Math.max(0, Math.ceil(ms / 1000));
    var m = Math.floor(total / 60), s = total % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  var api = { nextPhase: nextPhase, clock: clock };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }

  var TK = root.TK;
  var LABEL = { focus: 'Focus', short: 'Short break', long: 'Long break' };
  var inputs = { focus: TK.$('#pt-focus'), short: TK.$('#pt-short'), long: TK.$('#pt-long'), every: TK.$('#pt-every') };
  var face = TK.$('#pt-face'), phaseEl = TK.$('#pt-phase'), startBtn = TK.$('#pt-start'), doneEl = TK.$('#pt-done');
  var baseTitle = document.title;

  var state = { phase: 'focus', remaining: 0, endAt: 0, running: false, focusDone: 0, tick: null };

  function minutes(key) {
    var v = TK.num(inputs[key].value);
    return v > 0 ? v : Number(inputs[key].defaultValue);
  }

  function render() {
    var ms = state.running ? state.endAt - Date.now() : state.remaining;
    face.textContent = clock(ms);
    phaseEl.textContent = LABEL[state.phase];
    doneEl.textContent = state.focusDone;
    startBtn.textContent = state.running ? 'Pause' : (state.remaining < minutes(state.phase) * 60000 ? 'Resume' : 'Start');
    document.title = state.running ? clock(ms) + ' · ' + LABEL[state.phase] : baseTitle;
  }

  function beep() {
    try {
      var Ctx = root.AudioContext || root.webkitAudioContext;
      var ctx = new Ctx();
      [0, 0.35, 0.7].forEach(function (t) {
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = 880;
        g.gain.setValueAtTime(0.0001, ctx.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.25);
        o.connect(g); g.connect(ctx.destination);
        o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.3);
      });
    } catch (e) { /* audio unavailable */ }
  }

  function setPhase(p) {
    state.phase = p;
    state.remaining = minutes(p) * 60000;
  }

  function stop() {
    if (state.running) state.remaining = Math.max(0, state.endAt - Date.now());
    state.running = false;
    clearInterval(state.tick);
  }

  function finish() {
    stop();
    if (state.phase === 'focus') state.focusDone += 1;
    beep();
    setPhase(nextPhase(state.phase, state.focusDone, Math.max(1, Math.round(minutes('every')))));
    render();
  }

  function start() {
    state.running = true;
    state.endAt = Date.now() + state.remaining;
    state.tick = setInterval(function () {
      if (Date.now() >= state.endAt) finish(); else render();
    }, 250);
    render();
  }

  startBtn.addEventListener('click', function () { if (state.running) { stop(); render(); } else start(); });
  TK.$('#pt-reset').addEventListener('click', function () { stop(); setPhase(state.phase); render(); });
  TK.$('#pt-skip').addEventListener('click', function () {
    stop();
    setPhase(nextPhase(state.phase, state.focusDone + (state.phase === 'focus' ? 1 : 0), Math.max(1, Math.round(minutes('every')))));
    render();
  });
  Object.keys(inputs).forEach(function (k) {
    inputs[k].addEventListener('change', function () {
      TK.save('pt', { focus: inputs.focus.value, short: inputs.short.value, long: inputs.long.value, every: inputs.every.value });
      if (!state.running) { setPhase(state.phase); render(); }
    });
  });

  var saved = TK.load('pt', null);
  if (saved) Object.keys(inputs).forEach(function (k) { if (saved[k]) inputs[k].value = saved[k]; });
  setPhase('focus');
  render();
})(this);
