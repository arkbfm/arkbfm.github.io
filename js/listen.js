// The listening feed: plays one question's answer at a time and moves on by itself, following the
// subject into other episodes (related spots) before falling back to an unheard question, within a
// theme when one is chosen. The audio is the show's own files (from its RSS feed, _data/audio_sources.json)
// in an <audio> element, so it can change speed, keep playing with the screen locked and take the lock
// screen's and earphones' controls (Media Session).
(function () {
  var root = document.getElementById('listen');
  if (!root || !window.fetch) return;

  var card = root.querySelector('[data-listen-card]');
  var nextPeek = root.querySelector('[data-listen-next]');
  var playButton = root.querySelector('[data-listen-play]');
  var rateButton = root.querySelector('[data-listen-rate]');
  var openLink = root.querySelector('[data-listen-open]');
  var statsElement = root.querySelector('[data-listen-stats]');
  var startScreen = root.querySelector('[data-listen-start]');
  var themeButton = root.querySelector('[data-listen-theme]');
  var themeSheet = root.querySelector('[data-listen-themes]');
  // Side panels, shown on wide screens only (CSS): the trail of this visit, the talk around the current
  // line, and what plays next.
  var pastList = root.querySelector('[data-listen-past]');
  var talkList = root.querySelector('[data-listen-talk]');
  var upcomingButton = root.querySelector('[data-listen-upcoming]');
  var toast = root.querySelector('[data-listen-toast]');
  var episodeBase = root.getAttribute('data-episode-base');
  var shareBase = root.getAttribute('data-share-base');
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var data = null;
  var clipsById = {};
  var theme = null;         // the chosen theme, or null for the whole archive
  var themeIds = null;      // its clip ids as a lookup
  var audio = new Audio();
  var pendingSeek = null;   // where to jump once a newly set file knows its length
  var started = false;      // the listener has tapped once, so playback may start on its own from now on
  var paused = true;
  var history = [];
  var position = -1;
  var current = null;
  var lastAt = null;        // the last playback position inside the current clip, for skip analytics
  var upcoming = null;
  var heard = {};
  var streak = 0;

  var RATES = [1, 1.25, 1.5, 2];
  var rate = 1;
  try { rate = Number(localStorage.getItem('arkbfm-listen-rate')) || 1; } catch (error) { /* storage can be unavailable */ }
  if (RATES.indexOf(rate) < 0) rate = 1;

  // How many seconds (at the chosen speed) before a clip ends the next one is announced.
  var PEEK_SECONDS = 12;
  // A small cheer every this many clips in a row.
  var STREAK_STEP = 5;
  // After this many finished clips the listener clearly likes it: offer following the show.
  var FOLLOW_AFTER = 3;
  // Share of picks (outside a theme) that leave the subject for an unrelated question.
  var DETOUR_CHANCE = 0.12;
  // Answers heard to the end in this visit, for the summary when a theme runs out.
  var session = { count: 0, seconds: 0, episodes: {} };
  var followLink = root.querySelector('[data-listen-follow]');
  followLink.href = root.getAttribute('data-follow');
  var finished = 0;

  function seconds(hms) {
    return hms.split(':').reduce(function (total, part) { return total * 60 + Number(part); }, 0);
  }

  function clock(total) {
    total = Math.max(0, Math.round(total));
    var pad = function (value) { return (value < 10 ? '0' : '') + value; };
    return (total >= 3600 ? Math.floor(total / 3600) + ':' + pad(Math.floor(total % 3600 / 60)) : Math.floor(total / 60)) + ':' + pad(total % 60);
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function fromItem(item) {
    return {
      id: item.i, slug: item.s, text: item.x, chapter: item.c || '', headline: !!item.h,
      start: seconds(item.t), end: seconds(item.e), part: (item.p || 1) - 1
    };
  }

  // A related spot either names another clip ("i") or, when its chapter has no question, carries its own span.
  function fromSpot(spot) {
    var clip = spot.i ? clipsById[spot.i] : {
      id: null, slug: spot.s, text: spot.c, chapter: spot.c, headline: false,
      start: seconds(spot.t), end: seconds(spot.e), part: (spot.p || 1) - 1
    };
    if (!clip) return null;
    var copy = {};
    Object.keys(clip).forEach(function (key) { copy[key] = clip[key]; });
    copy.reason = spot.r || '';
    return copy;
  }

  function keyOf(clip) { return clip.id || clip.slug + '@' + clip.start; }

  // A clip needs its audio file, and must start inside it (a few files are shorter than their transcript).
  function playable(clip) {
    var episode = clip && data.episodes[clip.slug];
    var file = episode && episode.u && episode.u[clip.part];
    return !!(file && (!file[1] || clip.start < file[1] - 10));
  }

  // Where other episodes talk about this clip's subject; a span without a question borrows the question
  // whose answer it falls in.
  function relatedOf(clip) {
    if (clip.id) return data.related[clip.id] || [];
    var inside = data.clips.filter(function (item) {
      return item.s === clip.slug && (item.p || 1) - 1 === clip.part && seconds(item.t) <= clip.start && clip.start < seconds(item.e);
    })[0];
    return inside ? data.related[inside.i] || [] : [];
  }

  function randomOf(list) { return list[Math.floor(Math.random() * list.length)]; }

  // GA4 events (see _includes/analytics.html); a no-op without a measurement ID.
  function track(name, params) {
    if (window.arkbfmTrack) window.arkbfmTrack(name, params);
  }

  function via(clip, how) {
    if (!clip) return clip;
    var copy = {};
    Object.keys(clip).forEach(function (key) { copy[key] = clip[key]; });
    copy.via = how;
    return copy;
  }

  // Follow the subject first (staying in the theme when there is one); when the chain runs dry,
  // pick an unheard clip from the theme or the whole archive. Null means everything has been heard.
  function chooseNext(clip) {
    var chained = relatedOf(clip).map(fromSpot).filter(function (next) {
      return next && playable(next) && !heard[keyOf(next)];
    });
    if (themeIds) {
      var inTheme = chained.filter(function (next) { return next.id && themeIds[next.id]; });
      if (inTheme.length) return via(inTheme[0], 'chain');
      var fresh = theme.clips.filter(function (id) { return clipsById[id] && !heard[id]; });
      if (fresh.length) return via(clipsById[randomOf(fresh)], 'theme');
      return null;
    }
    var unheard = data.clips.filter(function (item) { return !heard[item.i] && item.s !== clip.slug; });
    // Now and then a detour to somewhere unrelated, so the feed keeps a little surprise.
    if (chained.length && unheard.length && Math.random() < DETOUR_CHANCE) return via(fromItem(randomOf(unheard)), 'detour');
    if (chained.length) return via(chained[0], 'chain');
    return unheard.length ? via(fromItem(randomOf(unheard)), 'random') : null;
  }

  function episodeUrl(clip) {
    return episodeBase + clip.slug;
  }

  // A span without a question id is addressed by its episode and times.
  function spanQuery(clip) {
    return 'ep=' + encodeURIComponent(clip.slug) + '&t=' + clip.start + '&e=' + clip.end + (clip.part ? '&p=' + (clip.part + 1) : '') +
      (clip.chapter ? '&title=' + encodeURIComponent(clip.chapter) : '');
  }

  function shareUrl(clip) {
    if (!clip.id) return window.location.origin + window.location.pathname + '?' + spanQuery(clip);
    // Same rule as scripts/build_clip_pages.py (and Jekyll's slug): 118.5.2 -> 118-5-2.
    var page = clip.id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return window.location.origin + shareBase + page + '/';
  }

  function render(clip, direction) {
    var episode = data.episodes[clip.slug];
    // Two teal tones only: the white splat would vanish on the cream variant.
    var tone = (parseInt(String(episode.n), 10) || 0) % 2;
    var next = element('article', 'listen-card listen-tone-' + tone);
    next.setAttribute('data-listen-card', '');
    next.setAttribute('aria-live', 'polite');

    var progress = element('div', 'listen-progress');
    progress.appendChild(element('span'));
    next.appendChild(progress);

    var head = element('a', 'listen-episode');
    head.href = episodeUrl(clip);
    head.appendChild(element('span', 'listen-number', 'Ep.' + episode.n));
    head.appendChild(element('span', 'listen-episode-title', episode.t));
    var faces = element('span', 'listen-faces');
    episode.g.concat([['あらB', data.host]]).forEach(function (guest) {
      if (!guest[1]) return;
      var image = element('img');
      image.src = guest[1];
      image.alt = '';
      image.setAttribute('data-face', guest[1]);
      faces.appendChild(image);
    });
    head.appendChild(faces);
    next.appendChild(head);

    var trail = trailOf();
    if (trail) next.appendChild(element('p', 'listen-trail', '🧭 ' + trail));
    if (clip.via === 'detour') next.appendChild(element('p', 'listen-reason', '🎲 寄り道：ちょっと別の話へ'));
    else if (clip.reason) next.appendChild(element('p', 'listen-reason', '↪ つながり：' + clip.reason));
    next.appendChild(element('p', 'listen-kicker', clip.id ? 'Q' : clip.kicker || '関連する話題'));
    next.appendChild(element('h2', 'listen-question', clip.text));
    // Live captions with the speaker's face: filled in once the episode's captions arrive.
    var captions = element('div', 'listen-captions');
    captions.hidden = true;
    var face = element('img', 'listen-speaker-face');
    face.alt = '';
    captions.appendChild(face);
    var said = element('div', 'listen-said');
    said.appendChild(element('span', 'listen-speaker-name'));
    said.appendChild(element('p', 'listen-line'));
    captions.appendChild(said);
    next.appendChild(captions);
    var where = (episode.u.length > 1 ? 'パート' + (clip.part + 1) + ' ' : '') + clock(clip.start) + '〜 · 約' +
      Math.max(1, Math.round((clip.end - clip.start) / 60)) + '分' + (clip.chapter && clip.id ? ' · ' + clip.chapter : '');
    next.appendChild(element('p', 'listen-meta', where));
    var foot = element('div', 'listen-foot');
    foot.appendChild(element('span', 'listen-remaining', clock((clip.end - clip.start) / rate)));
    if (episode.a[clip.part]) {
      var spotify = element('a', 'listen-spotify', 'Spotifyで全編 ↗');
      spotify.href = 'https://open.spotify.com/episode/' + episode.a[clip.part];
      spotify.target = '_blank';
      spotify.rel = 'noopener';
      spotify.addEventListener('click', function () { track('listen_spotify_full_click', { clip_id: keyOf(clip), episode: clip.slug }); });
      foot.appendChild(spotify);
    }
    next.appendChild(foot);

    if (!reduceMotion && direction) next.classList.add(direction > 0 ? 'is-entering-up' : 'is-entering-down');
    card.replaceWith(next);
    card = next;
    openLink.href = episodeUrl(clip);
    document.title = clip.text + ' | つまみ聴き';
  }

  // "これまで": every clip of this visit, newest last; a click goes back (or forward) to it.
  var PAST_SHOWN = 15;
  function renderPast() {
    pastList.textContent = '';
    history.slice(-PAST_SHOWN).forEach(function (clip, offset) {
      var index = Math.max(0, history.length - PAST_SHOWN) + offset;
      var item = element('li', index === position ? 'is-current' : '');
      var button = element('button');
      button.type = 'button';
      button.appendChild(element('small', '', 'Ep.' + data.episodes[clip.slug].n));
      button.appendChild(element('span', '', clip.text));
      button.addEventListener('click', function () {
        if (index === position) return;
        var direction = index > position ? 1 : -1;
        position = index;
        streak = 0;
        show(history[index], direction, 'history');
      });
      item.appendChild(button);
      pastList.appendChild(item);
    });
    var shown = pastList.querySelector('.is-current');
    if (shown && shown.scrollIntoView && pastList.offsetParent) shown.scrollIntoView({ block: 'nearest' });
  }

  // "いまの会話": the current caption line with the few before it, each with its speaker's face.
  var TALK_SHOWN = 5;
  // Faces match the card's: each line shows whoever the card showed while it was on screen (the last
  // voice, if it changed mid-line), recorded in clip.lineSpeakers.
  function renderTalk(clip, index) {
    talkList.textContent = '';
    if (!clip.lines) return;
    var first = Math.max(0, index - TALK_SHOWN + 1);
    clip.lines.slice(first, index + 1).forEach(function (line, offset, shown) {
      var key = (clip.lineSpeakers || {})[first + offset];
      var speaker = (clip.speakers || {})[key === undefined ? line[2] : key] || null;
      var item = element('li', offset === shown.length - 1 ? 'is-current' : '');
      if (speaker && speaker[1]) {
        var face = element('img');
        face.src = speaker[1];
        face.alt = '';
        item.appendChild(face);
      }
      var words = element('div');
      if (speaker) words.appendChild(element('small', '', speaker[0]));
      words.appendChild(element('p', '', captionText(line[3], '​')));
      item.appendChild(words);
      talkList.appendChild(item);
    });
  }

  // "このあと": the clip lined up after this one.
  function renderUpcoming() {
    upcomingButton.textContent = '';
    upcomingButton.hidden = !upcoming;
    if (!upcoming) return;
    var episode = data.episodes[upcoming.slug];
    upcomingButton.appendChild(element('small', '', upcoming.via === 'detour' ? '🎲 寄り道' : upcoming.via === 'chain' ? '↪ つながる話題' : '次の問い'));
    upcomingButton.appendChild(element('strong', '', upcoming.text));
    upcomingButton.appendChild(element('span', '', 'Ep.' + episode.n + ' ' + episode.t + (upcoming.reason ? ' · ' + upcoming.reason : '')));
  }

  // The episodes this visit has passed through, up to the current clip: "Ep.37 → Ep.152 → Ep.88".
  function trailOf() {
    var numbers = [];
    history.slice(Math.max(0, position - 3), position + 1).forEach(function (item) {
      var number = 'Ep.' + data.episodes[item.slug].n;
      if (numbers[numbers.length - 1] !== number) numbers.push(number);
    });
    return numbers.length > 1 ? (position > 3 ? '… → ' : '') + numbers.join(' → ') : '';
  }

  function renderDone() {
    var done = element('article', 'listen-card listen-done');
    done.setAttribute('data-listen-card', '');
    done.appendChild(element('p', 'listen-kicker', theme ? theme.emoji + ' ' + theme.label : 'あらB.fm'));
    done.appendChild(element('h2', 'listen-question', theme ? 'このテーマは聴き終えました' : 'ぜんぶ聴き終えました'));
    if (session.count) {
      done.appendChild(element('p', 'listen-done-summary', '今回 ' + session.count + '本の答え・約' + Math.max(1, Math.round(session.seconds / 60)) +
        '分・' + Object.keys(session.episodes).length + '回分を聴きました'));
    }
    done.appendChild(element('p', 'listen-meta', 'ここでひと休み。別のテーマも、続きからどうぞ。'));
    var list = element('div', 'listen-done-themes');
    data.themes.filter(function (other) { return !theme || other.id !== theme.id; }).slice(0, 6).forEach(function (other) {
      var button = element('button', '', other.emoji + ' ' + other.label);
      button.type = 'button';
      button.addEventListener('click', function () { chooseTheme(other); });
      list.appendChild(button);
    });
    done.appendChild(list);
    var follow = element('a', 'listen-done-follow', 'Spotify で番組をフォロー →');
    follow.href = followLink.href;
    follow.target = '_blank';
    follow.rel = 'noopener';
    follow.addEventListener('click', function () { track('listen_follow_click', { place: 'done', finished: finished }); });
    done.appendChild(follow);
    card.replaceWith(done);
    card = done;
    nextPeek.hidden = true;
    upcoming = false;
    renderUpcoming();
    talkList.textContent = '';
    audio.pause();
  }

  function peek(clip) {
    nextPeek.textContent = '';
    nextPeek.appendChild(element('span', 'listen-next-label', clip.via === 'detour' ? '次はちょっと寄り道' : clip.reason ? '次は関連する話題' : '次はこちら'));
    nextPeek.appendChild(element('strong', '', clip.text));
    nextPeek.appendChild(element('small', '', 'Ep.' + data.episodes[clip.slug].n + ' ' + data.episodes[clip.slug].t));
    nextPeek.hidden = false;
  }

  function flash(message) {
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(flash.timer);
    flash.timer = setTimeout(function () { toast.hidden = true; }, 2600);
  }

  function stats(addSeconds) {
    var today = new Date().toISOString().slice(0, 10);
    var saved = { date: today, count: 0, seconds: 0 };
    try {
      var stored = JSON.parse(localStorage.getItem('arkbfm-listen') || 'null');
      if (stored && stored.date === today) saved = stored;
    } catch (error) { /* storage can be unavailable; the counter just starts over */ }
    if (addSeconds) {
      saved.count += 1;
      saved.seconds += addSeconds;
      try { localStorage.setItem('arkbfm-listen', JSON.stringify(saved)); } catch (error) { /* ignore */ }
    }
    statsElement.textContent = saved.count ? '今日 ' + saved.count + '本 · ' + Math.round(saved.seconds / 60) + '分' : '';
  }

  // Captions: one file per episode (scripts/build_captions.py), fetched once and shared by its clips.
  var captionBase = root.getAttribute('data-captions');
  var captionFiles = {};

  function captionsFor(slug) {
    if (!captionFiles[slug]) {
      captionFiles[slug] = fetch(captionBase + encodeURIComponent(slug) + '.json')
        .then(function (response) { return response.ok ? response.json() : null; })
        .catch(function () { return null; });
    }
    return captionFiles[slug];
  }

  // The clip's own lines (its audio part, from a little before its start to its end).
  function attachCaptions(clip) {
    return captionsFor(clip.slug).then(function (file) {
      if (!file) return clip;
      clip.speakers = file.speakers;
      var inClip = function (entry) { return entry[0] === clip.part && entry[1] >= clip.start - 5 && entry[1] < clip.end; };
      clip.lines = file.lines.filter(inClip);
      // Where the voice changes (scripts/build_captions.py): the speaking face follows these, mid-line too.
      var turns = file.turns || [];
      clip.turns = turns.filter(inClip);
      // The voice already talking when the clip starts.
      var before = turns.filter(function (turn) { return turn[0] === clip.part && turn[1] < clip.start - 5; }).pop();
      if (before) clip.turns.unshift(before);
      return clip;
    });
  }

  // The latest entry at or before `at` in a time-ordered list of [part, time, ...].
  function latestAt(list, at) {
    var index = -1;
    for (var i = 0; i < list.length && list[i][1] <= at; i += 1) index = i;
    return index;
  }

  function showCaption(clip, at) {
    if (clip !== current || !clip.lines || !clip.lines.length) return;
    var box = card.querySelector('.listen-captions');
    if (!box) return;
    var index = Math.max(0, latestAt(clip.lines, at));
    var lineChanged = index !== clip.shownLine;
    if (lineChanged) {
      clip.shownLine = index;
      box.hidden = false;
      var text = box.querySelector('.listen-line');
      text.textContent = captionText(clip.lines[index][3], '​');
      restart(text, 'is-new');
    }
    // Who is talking right now: the voice-change points when the file has them, else the line's speaker.
    var turn = clip.turns && clip.turns.length ? clip.turns[latestAt(clip.turns, at)] : null;
    var speakerChanged = showSpeaker(clip, turn ? turn[2] : clip.lines[index][2]);
    clip.lineSpeakers = clip.lineSpeakers || {};
    clip.lineSpeakers[index] = clip.shownSpeaker;
    if (lineChanged || speakerChanged) renderTalk(clip, index);
  }

  // Returns whether the speaker changed.
  function showSpeaker(clip, key) {
    if (key === clip.shownSpeaker) return false;
    clip.shownSpeaker = key;
    var speaker = (clip.speakers || {})[key] || null;
    var box = card.querySelector('.listen-captions');
    var face = box.querySelector('.listen-speaker-face');
    face.hidden = !(speaker && speaker[1]);
    if (speaker && speaker[1]) face.src = speaker[1];
    box.querySelector('.listen-speaker-name').textContent = speaker ? speaker[0] : '';
    // Light up whoever is talking among the faces in the card's header, and dim the others.
    var faces = card.querySelector('.listen-faces');
    if (faces) faces.classList.toggle('has-speaker', !!(speaker && speaker[1]));
    Array.prototype.forEach.call(card.querySelectorAll('[data-face]'), function (image) {
      var speaking = !!speaker && image.getAttribute('data-face') === speaker[1];
      image.classList.toggle('is-speaking', speaking);
      // A new voice makes its face hop, as in podclip's clips.
      if (speaking) restart(image, 'is-hop');
    });
    if (speaker) restart(face, 'is-hop');
    return true;
  }

  // Caption files mark where a line may wrap (between BudouX phrases) with "|": a zero-width space
  // on screen, nothing in quoted text.
  function captionText(text, gap) {
    return text.split('|').join(gap);
  }

  // Replays a one-shot animation class.
  function restart(node, className) {
    if (reduceMotion || !node) return;
    node.classList.remove(className);
    void node.offsetWidth;
    node.classList.add(className);
  }

  // "つづきから": remember the clip and position, so the next visit can pick up where this one stopped.
  var RESUME_KEY = 'arkbfm-listen-resume';
  var RESUME_DAYS = 14;
  var savedAt = 0;

  function saveResume(clip, at) {
    if (!clip || !clip.id || Date.now() - savedAt < 5000) return;
    savedAt = Date.now();
    try {
      localStorage.setItem(RESUME_KEY, JSON.stringify({ id: clip.id, at: Math.floor(at), theme: theme ? theme.id : '', t: Date.now() }));
    } catch (error) { /* storage can be unavailable */ }
  }

  function readResume() {
    try {
      var saved = JSON.parse(localStorage.getItem(RESUME_KEY) || 'null');
      if (saved && Date.now() - saved.t < RESUME_DAYS * 864e5) return saved;
    } catch (error) { /* storage can be unavailable */ }
    return null;
  }

  function applyRate() {
    audio.defaultPlaybackRate = rate;
    audio.playbackRate = rate;
    rateButton.textContent = rate + '×';
    rateButton.setAttribute('aria-label', '再生速度 ' + rate + '倍（押して変更）');
  }

  function playAudio() {
    var playing = audio.play();
    if (playing && playing.catch) {
      playing.catch(function (error) {
        // Refused without a tap (the page restored in the background, say): the start screen asks for one.
        if (error && error.name === 'NotAllowedError' && current) { started = false; showHook(current, 'つまみ聴き'); }
      });
    }
  }

  function load(clip) {
    var file = data.episodes[clip.slug].u[clip.part];
    clip.reached = false;
    // The file's end caps the clip (a few files are shorter than their transcript).
    if (file[1] && clip.end > file[1]) clip.end = file[1];
    // A resumed clip starts where the last visit stopped, once.
    var from = clip.resumeAt && clip.resumeAt > clip.start && clip.resumeAt < clip.end - 10 ? clip.resumeAt : clip.start;
    clip.resumeAt = null;
    clip.from = from;
    if (audio.getAttribute('src') !== file[0]) {
      pendingSeek = from;
      audio.src = file[0];
    } else if (audio.readyState < 1) {
      pendingSeek = from;
    } else {
      pendingSeek = null;
      audio.currentTime = from;
    }
    applyRate();
    updateSession(clip);
    if (started) playAudio();
  }

  // Lock screen, notification and earphone controls.
  function updateSession(clip) {
    if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
    var episode = data.episodes[clip.slug];
    var image = (episode.g[0] && episode.g[0][1]) || data.host;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: clip.text,
        artist: 'あらB.fm Ep.' + episode.n,
        album: episode.t,
        artwork: image ? [{ src: new URL(image, window.location.href).href }] : []
      });
    } catch (error) { /* an older browser */ }
  }

  // The lock screen's progress bar shows the answer, not the whole episode.
  var positionShownAt = 0;
  function sessionPosition(clip, at, force) {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    if (!force && Date.now() - positionShownAt < 5000) return;
    positionShownAt = Date.now();
    try {
      navigator.mediaSession.setPositionState({
        duration: Math.max(1, clip.end - clip.start),
        position: Math.min(clip.end - clip.start, Math.max(0, at - clip.start)),
        playbackRate: rate
      });
    } catch (error) { /* an invalid state while a file loads */ }
  }

  function seekBy(amount) {
    if (!current) return;
    audio.currentTime = Math.max(current.start, Math.min(current.end - 1, audio.currentTime + amount));
  }

  function sessionAction(name, handler) {
    try { navigator.mediaSession.setActionHandler(name, handler); } catch (error) { /* an unsupported action */ }
  }

  if ('mediaSession' in navigator) {
    sessionAction('play', function () { if (!started) begin(); else playAudio(); });
    sessionAction('pause', function () { audio.pause(); });
    sessionAction('nexttrack', function () { advance(false); });
    sessionAction('previoustrack', function () { back(); });
    sessionAction('seekbackward', function () { seekBy(-15); });
    sessionAction('seekforward', function () { seekBy(15); });
    sessionAction('seekto', function (details) {
      if (current && details && typeof details.seekTime === 'number') audio.currentTime = current.start + details.seekTime;
    });
  }

  function go(clip, direction) {
    // A new clip replaces whatever was ahead of the current one, like a browser's history.
    history = history.slice(0, position + 1);
    history.push(clip);
    position = history.length - 1;
    show(clip, direction);
  }

  function address() {
    var parts = [];
    if (theme) parts.push('theme=' + encodeURIComponent(theme.id));
    if (current && current.id) parts.push('c=' + encodeURIComponent(current.id));
    else if (current) parts.push(spanQuery(current));
    return '?' + parts.join('&');
  }

  function show(clip, direction, how) {
    var previous = current;
    current = clip;
    upcoming = null;
    lastAt = null;
    heard[keyOf(clip)] = true;
    nextPeek.hidden = true;
    render(clip, direction);
    // Following the subject into another episode is the feed's trick: make the jump felt.
    if (previous && direction > 0 && previous.slug !== clip.slug && (clip.via === 'chain' || clip.via === 'detour')) {
      if (!reduceMotion) card.classList.add('is-warp');
      if (toast.hidden) flash('🌀 Ep.' + data.episodes[previous.slug].n + ' → Ep.' + data.episodes[clip.slug].n + ' へワープ');
    }
    load(clip);
    clip.shownLine = null;
    clip.shownSpeaker = null;
    clip.lineSpeakers = {};
    talkList.textContent = '';
    attachCaptions(clip).then(function () { showCaption(clip, clip.from); });
    // Line up the next clip now, so the side panel can show it from the start: the one ahead in the
    // history after going back, or a fresh pick.
    upcoming = position < history.length - 1 ? history[position + 1] : chooseNext(clip) || false;
    renderUpcoming();
    renderPast();
    track('listen_clip_start', {
      clip_id: keyOf(clip), episode: clip.slug, via: how || clip.via || 'first', theme: theme ? theme.id : 'all', headline: clip.headline
    });
    try { window.history.replaceState(null, '', address()); } catch (error) { /* file:// or sandboxed */ }
  }

  function advance(complete) {
    if (!data || !current) return;
    track(complete ? 'listen_clip_complete' : 'listen_skip', {
      clip_id: keyOf(current), episode: current.slug, theme: theme ? theme.id : 'all',
      heard_seconds: Math.round(lastAt === null ? 0 : Math.max(0, lastAt - current.start))
    });
    if (complete) {
      stats(current.end - current.start);
      session.count += 1;
      session.seconds += current.end - current.start;
      session.episodes[current.slug] = true;
      streak += 1;
      finished += 1;
      if (streak % STREAK_STEP === 0) flash('🔥 ' + streak + '本連続');
      if (finished === FOLLOW_AFTER) {
        followLink.hidden = false;
        setTimeout(function () { followLink.hidden = true; }, 12000);
      }
    } else {
      streak = 0;
    }
    if (position < history.length - 1) {
      position += 1;
      show(history[position], 1, 'history');
      return;
    }
    var next = upcoming || chooseNext(current);
    if (next) go(next, 1);
    else {
      track('listen_done', { theme: theme ? theme.id : 'all', finished: finished });
      renderDone();
    }
  }

  function back() {
    if (position <= 0) return;
    position -= 1;
    streak = 0;
    show(history[position], -1, 'history');
  }

  function showPaused() {
    paused = audio.paused;
    // The speaking face only bobs while the audio actually plays.
    root.classList.toggle('is-paused', paused);
    playButton.textContent = paused ? '▶' : '❚❚';
    playButton.setAttribute('aria-label', paused ? '再生' : '一時停止');
  }

  function onTime() {
    if (!current || pendingSeek !== null) return;
    var at = audio.currentTime;
    var clip = current;
    if (!clip.reached) {
      // Until the jump lands, the element can still report the old position.
      if (at >= clip.start - 5 && at < clip.end) clip.reached = true;
      else return;
    }
    lastAt = at;
    showCaption(clip, at);
    if (!paused) saveResume(clip, at);
    sessionPosition(clip, at, false);
    var bar = card.querySelector('.listen-progress span');
    if (bar) bar.style.transform = 'scaleX(' + Math.min(1, Math.max(0, (at - clip.start) / (clip.end - clip.start))) + ')';
    var remaining = card.querySelector('.listen-remaining');
    // Time left at the chosen speed.
    if (remaining) remaining.textContent = clock((clip.end - at) / rate);
    if ((clip.end - at) / rate <= PEEK_SECONDS && !paused) {
      if (upcoming === null) {
        upcoming = chooseNext(clip) || false;
        // Fetch the next episode's captions now, so its first line shows the moment it starts.
        if (upcoming) captionsFor(upcoming.slug);
      }
      if (upcoming) peek(upcoming);
    }
    if (at >= clip.end) advance(true);
  }

  audio.preload = 'auto';
  audio.addEventListener('loadedmetadata', function () {
    if (pendingSeek === null) return;
    audio.currentTime = pendingSeek;
    pendingSeek = null;
    applyRate();
  });
  audio.addEventListener('timeupdate', onTime);
  audio.addEventListener('play', showPaused);
  audio.addEventListener('pause', showPaused);
  audio.addEventListener('waiting', function () { card.classList.add('is-buffering'); });
  audio.addEventListener('playing', function () {
    card.classList.remove('is-buffering');
    if (current) sessionPosition(current, audio.currentTime, true);
  });
  // A clip that runs to the very end of its file.
  audio.addEventListener('ended', function () { if (current && current.reached) advance(true); });
  audio.addEventListener('error', function () {
    if (!current || !audio.getAttribute('src')) return;
    card.classList.remove('is-buffering');
    flash('音声を読み込めませんでした。次へ進みます');
    setTimeout(function () { advance(false); }, 1500);
  });

  function begin() {
    started = true;
    startScreen.hidden = true;
    track('listen_begin', { theme: theme ? theme.id : 'all', from_link: /[?&](c|ep)=/.test(window.location.search) });
    // This tap is the gesture browsers want before audio; later clips start on their own, even with the screen locked.
    if (current) playAudio();
  }

  function togglePlay() {
    if (!started) { begin(); return; }
    if (audio.paused) playAudio(); else audio.pause();
  }

  // The start screen is a hook: the first question and the opening words of its answer, then one tap to hear it.
  function showHook(clip, kicker) {
    startScreen.querySelector('[data-listen-hook-kicker]').textContent = kicker;
    startScreen.querySelector('[data-listen-hook-question]').textContent = clip.text;
    var episode = data.episodes[clip.slug];
    startScreen.querySelector('[data-listen-hook-episode]').textContent = 'Ep.' + episode.n + ' ' + episode.t;
    var teaser = startScreen.querySelector('[data-listen-hook-teaser]');
    teaser.hidden = true;
    attachCaptions(clip).then(function () {
      var from = clip.from || clip.start;
      var line = (clip.lines || []).filter(function (item) { return item[1] >= from - 2; })[0];
      if (!line) return;
      var speaker = (clip.speakers || {})[line[2]];
      teaser.textContent = '「' + captionText(line[3], '') + '…」' + (speaker ? '　— ' + speaker[0] : '');
      teaser.hidden = false;
    });
    startScreen.hidden = false;
  }

  function firstOf(chosen) {
    var pool = chosen ? chosen.clips.map(function (id) { return clipsById[id]; }).filter(playable) :
      data.clips.map(fromItem).filter(function (clip) { return clip.headline && playable(clip); });
    // Themes list their hand-picked headline questions first; open with one of those.
    var headlines = pool.filter(function (clip) { return clip.headline; });
    return randomOf(headlines.length ? headlines.slice(0, 12) : pool);
  }

  function chooseTheme(chosen) {
    theme = chosen;
    themeIds = null;
    if (chosen) {
      themeIds = {};
      chosen.clips.forEach(function (id) { themeIds[id] = true; });
    }
    themeButton.textContent = chosen ? chosen.emoji + ' ' + chosen.label : 'テーマ';
    themeSheet.hidden = true;
    streak = 0;
    track('listen_theme_select', { theme: chosen ? chosen.id : 'all', label: chosen ? chosen.label : 'ぜんぶ' });
    go(via(firstOf(chosen), 'theme_pick'), 1);
  }

  function buildThemeSheet() {
    var list = themeSheet.querySelector('[data-listen-theme-list]');
    var all = element('button', 'listen-theme-all', '🎲 ぜんぶから');
    all.type = 'button';
    all.addEventListener('click', function () { chooseTheme(null); });
    list.appendChild(all);
    data.themes.forEach(function (item) {
      var button = element('button', '');
      button.type = 'button';
      button.appendChild(element('strong', '', item.emoji + ' ' + item.label));
      button.appendChild(element('small', '', item.clips.length + '本 · ' + item.lead));
      button.addEventListener('click', function () { chooseTheme(item); });
      list.appendChild(button);
    });
  }

  function share() {
    if (!current) return;
    var url = shareUrl(current);
    var text = 'Q. ' + current.text + '（あらB.fm Ep.' + data.episodes[current.slug].n + '）';
    track('listen_share', { clip_id: keyOf(current), method: navigator.share ? 'native' : 'x' });
    if (navigator.share) {
      navigator.share({ title: current.text, text: text, url: url }).catch(function () { /* dismissed */ });
      return;
    }
    window.open('https://twitter.com/intent/tweet?hashtags=arkbfm&text=' + encodeURIComponent(text) + '&url=' + encodeURIComponent(url), '_blank', 'noopener');
  }

  // Navigation: swipe up / wheel / keys, like a short-video feed.
  var touchY = null;
  root.addEventListener('touchstart', function (event) { touchY = event.touches[0].clientY; }, { passive: true });
  root.addEventListener('touchend', function (event) {
    if (touchY === null || !themeSheet.hidden) return;
    var moved = touchY - event.changedTouches[0].clientY;
    touchY = null;
    if (Math.abs(moved) < 60) return;
    if (moved > 0) advance(false); else back();
  });
  var wheelLock = 0;
  root.addEventListener('wheel', function (event) {
    if (!themeSheet.hidden || Math.abs(event.deltaY) < 40 || Date.now() < wheelLock) return;
    wheelLock = Date.now() + 700;
    if (event.deltaY > 0) advance(false); else back();
  }, { passive: true });
  document.addEventListener('keydown', function (event) {
    if (!themeSheet.hidden) { if (event.key === 'Escape') themeSheet.hidden = true; return; }
    if (event.key === 'ArrowDown' || event.key === 'j') { event.preventDefault(); advance(false); }
    else if (event.key === 'ArrowUp' || event.key === 'k') { event.preventDefault(); back(); }
    else if (event.key === 'ArrowLeft') seekBy(-15);
    else if (event.key === 'ArrowRight') seekBy(15);
    else if (event.key === ' ' && !event.target.closest('button, a')) { event.preventDefault(); togglePlay(); }
  });
  root.querySelector('[data-listen-next-button]').addEventListener('click', function () { advance(false); });
  root.querySelector('[data-listen-prev]').addEventListener('click', back);
  root.querySelector('[data-listen-replay]').addEventListener('click', function () { if (current) show(current, 0, 'replay'); });
  followLink.addEventListener('click', function () { track('listen_follow_click', { place: 'toast', finished: finished }); });
  root.querySelector('[data-listen-share]').addEventListener('click', share);
  playButton.addEventListener('click', togglePlay);
  rateButton.addEventListener('click', function () {
    rate = RATES[(RATES.indexOf(rate) + 1) % RATES.length];
    try { localStorage.setItem('arkbfm-listen-rate', String(rate)); } catch (error) { /* storage can be unavailable */ }
    applyRate();
    if (current) sessionPosition(current, audio.currentTime, true);
    track('listen_rate', { rate: rate });
  });
  root.querySelector('[data-listen-begin]').addEventListener('click', begin);
  nextPeek.addEventListener('click', function () { advance(false); });
  upcomingButton.addEventListener('click', function () { advance(false); });
  themeButton.addEventListener('click', function () { themeSheet.hidden = !themeSheet.hidden; });
  themeSheet.querySelector('[data-listen-theme-close]').addEventListener('click', function () { themeSheet.hidden = true; });

  function param(query, name) {
    var match = query.match(new RegExp('[?&]' + name + '=([^&]*)'));
    if (!match) return null;
    try { return decodeURIComponent(match[1].replace(/\+/g, ' ')); } catch (error) { return null; }
  }

  // ?ep=<slug>&t=<start>&e=<end>&p=<part>&title=<chapter>: any moment of an episode (chapters and quotes
  // on the episode page), played as it is; after it the feed follows the question it falls in.
  function spanFromQuery(query) {
    var slug = param(query, 'ep');
    var episode = slug && data.episodes[slug];
    if (!episode) return null;
    var time = function (value) { return value && /^\d+(:\d{1,2}){0,2}$/.test(value) ? seconds(value) : null; };
    var start = time(param(query, 't')) || 0;
    var part = (Number(param(query, 'p')) || 1) - 1;
    var file = episode.u && episode.u[part];
    var end = time(param(query, 'e'));
    // Without an end, ten minutes (or to the end of the file).
    if (end === null || end <= start) end = start + 600;
    if (file && file[1]) end = Math.min(end, file[1]);
    var title = param(query, 'title') || '';
    var clip = {
      id: null, slug: slug, text: title || 'Ep.' + episode.n + ' ' + clock(start) + '〜', chapter: title, headline: false,
      start: start, end: end, part: part, kicker: 'この回のこの場面'
    };
    return playable(clip) ? clip : null;
  }

  fetch(root.getAttribute('data-clips')).then(function (response) { return response.json(); }).then(function (loaded) {
    data = loaded;
    // The chain's links arrive separately (listen/related.json) so the first answer can start sooner;
    // until then a clip that ends picks from the theme or at random.
    data.related = {};
    fetch(root.getAttribute('data-related'))
      .then(function (response) { return response.ok ? response.json() : {}; })
      .then(function (related) {
        data.related = related || {};
        // The first clip was lined up before its links arrived: follow the subject after all.
        if (current && position === history.length - 1 && (!upcoming || upcoming.via === 'random')) {
          upcoming = chooseNext(current) || false;
          renderUpcoming();
        }
      })
      .catch(function () { /* the feed still works, without following subjects */ });
    data.themes = data.themes || [];
    data.clips = data.clips.filter(function (item) { return playable(fromItem(item)); });
    data.clips.forEach(function (item) { clipsById[item.i] = fromItem(item); });
    data.themes.forEach(function (item) { item.clips = item.clips.filter(function (id) { return clipsById[id]; }); });
    buildThemeSheet();
    stats(0);

    var query = window.location.search;
    var wantedTheme = param(query, 'theme') || '';
    var wantedClip = param(query, 'c') || '';
    var span = spanFromQuery(query);
    var kicker = /[?&]from=today/.test(query) ? '今日の1問' : '';
    // With no clip, moment or theme asked for, pick up where the last visit stopped.
    var resume = !wantedClip && !wantedTheme && !span || /[?&]resume=1/.test(query) ? readResume() : null;
    var first = clipsById[wantedClip] || span;
    if (!first && resume && clipsById[resume.id]) {
      first = clipsById[resume.id];
      first.resumeAt = resume.at;
      wantedTheme = wantedTheme || resume.theme;
      kicker = 'つづきから';
    }
    var chosen = data.themes.filter(function (item) { return item.id === wantedTheme; })[0] || null;
    theme = chosen;
    if (chosen) {
      themeIds = {};
      chosen.clips.forEach(function (id) { themeIds[id] = true; });
      themeButton.textContent = chosen.emoji + ' ' + chosen.label;
    }
    first = first || firstOf(chosen);
    applyRate();
    go(first, 0);
    playButton.disabled = false;
    showHook(first, kicker || (chosen ? chosen.emoji + ' ' + chosen.label : 'つまみ聴き'));
  }).catch(function () {
    card.textContent = '読み込めませんでした。時間をおいて開き直してください。';
  });
}());
