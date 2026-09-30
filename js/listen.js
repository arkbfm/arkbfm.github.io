// The listening feed: plays one question's answer at a time and moves on by itself, following the
// subject into other episodes (related spots) before falling back to an unheard question, within a
// theme when one is chosen.
(function () {
  var root = document.getElementById('listen');
  if (!root || !window.fetch) return;

  var card = root.querySelector('[data-listen-card]');
  var nextPeek = root.querySelector('[data-listen-next]');
  var playButton = root.querySelector('[data-listen-play]');
  var openLink = root.querySelector('[data-listen-open]');
  var statsElement = root.querySelector('[data-listen-stats]');
  var startScreen = root.querySelector('[data-listen-start]');
  var themeButton = root.querySelector('[data-listen-theme]');
  var themeSheet = root.querySelector('[data-listen-themes]');
  var toast = root.querySelector('[data-listen-toast]');
  var episodeBase = root.getAttribute('data-episode-base');
  var shareBase = root.getAttribute('data-share-base');
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var data = null;
  var clipsById = {};
  var theme = null;         // the chosen theme, or null for the whole archive
  var themeIds = null;      // its clip ids as a lookup
  var controller = null;
  var loadedUri = null;
  var started = false;      // the listener has tapped once, so playback may start on its own from now on
  var paused = true;
  var history = [];
  var position = -1;
  var current = null;
  var lastAt = null;        // the last playback position inside the current clip, for skip analytics
  var upcoming = null;
  var heard = {};
  var streak = 0;
  var wakeLock = null;

  // How many seconds before a clip ends the next one is announced.
  var PEEK_SECONDS = 12;
  // A small cheer every this many clips in a row.
  var STREAK_STEP = 5;
  // After this many finished clips the listener clearly likes it: offer following the show.
  var FOLLOW_AFTER = 3;
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

  function playable(clip) {
    var episode = clip && data.episodes[clip.slug];
    return !!(episode && episode.a[clip.part]);
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
    var chained = ((clip.id && data.related[clip.id]) || []).map(fromSpot).filter(function (next) {
      return next && playable(next) && !heard[keyOf(next)];
    });
    if (themeIds) {
      var inTheme = chained.filter(function (next) { return next.id && themeIds[next.id]; });
      if (inTheme.length) return via(inTheme[0], 'chain');
      var fresh = theme.clips.filter(function (id) { return clipsById[id] && !heard[id]; });
      if (fresh.length) return via(clipsById[randomOf(fresh)], 'theme');
      return null;
    }
    if (chained.length) return via(chained[0], 'chain');
    var unheard = data.clips.filter(function (item) { return !heard[item.i] && item.s !== clip.slug; });
    return unheard.length ? via(fromItem(randomOf(unheard)), 'random') : null;
  }

  function episodeUrl(clip) {
    // The episode page reads the same span, so it too stops where this topic ends.
    var question = clip.headline ? '&q=' + clip.id.split('.').pop() : '';
    return episodeBase + clip.slug + '?t=' + clip.start + '&e=' + clip.end + (clip.part ? '&p=' + (clip.part + 1) : '') + question;
  }

  function shareUrl(clip) {
    if (!clip.id) return window.location.origin + episodeUrl(clip);
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
      faces.appendChild(image);
    });
    head.appendChild(faces);
    next.appendChild(head);

    if (clip.reason) next.appendChild(element('p', 'listen-reason', '↪ つながり：' + clip.reason));
    next.appendChild(element('p', 'listen-kicker', clip.id ? 'Q' : '関連する話題'));
    next.appendChild(element('h2', 'listen-question', clip.text));
    var where = (episode.a.length > 1 ? 'パート' + (clip.part + 1) + ' ' : '') + clock(clip.start) + '〜 · 約' +
      Math.max(1, Math.round((clip.end - clip.start) / 60)) + '分' + (clip.chapter && clip.id ? ' · ' + clip.chapter : '');
    next.appendChild(element('p', 'listen-meta', where));
    var foot = element('div', 'listen-foot');
    foot.appendChild(element('span', 'listen-remaining', clock(clip.end - clip.start)));
    var spotify = element('a', 'listen-spotify', 'Spotifyで全編 ↗');
    spotify.href = 'https://open.spotify.com/episode/' + episode.a[clip.part];
    spotify.target = '_blank';
    spotify.rel = 'noopener';
    spotify.addEventListener('click', function () { track('listen_spotify_full_click', { clip_id: keyOf(clip), episode: clip.slug }); });
    foot.appendChild(spotify);
    next.appendChild(foot);

    if (!reduceMotion && direction) next.classList.add(direction > 0 ? 'is-entering-up' : 'is-entering-down');
    card.replaceWith(next);
    card = next;
    openLink.href = episodeUrl(clip);
    document.title = clip.text + ' | つまみ聴き';
  }

  function renderDone() {
    var done = element('article', 'listen-card listen-done');
    done.setAttribute('data-listen-card', '');
    done.appendChild(element('p', 'listen-kicker', theme ? theme.emoji + ' ' + theme.label : 'あらB.fm'));
    done.appendChild(element('h2', 'listen-question', theme ? 'このテーマは聴き終えました' : 'ぜんぶ聴き終えました'));
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
    if (controller) controller.pause();
  }

  function peek(clip) {
    nextPeek.textContent = '';
    nextPeek.appendChild(element('span', 'listen-next-label', clip.reason ? '次は関連する話題' : '次はこちら'));
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

  // Keep the screen on while a clip plays: on phones the embedded player stops when the screen locks.
  function holdScreen(on) {
    if (!('wakeLock' in navigator)) return;
    if (on && !wakeLock && document.visibilityState === 'visible') {
      navigator.wakeLock.request('screen').then(function (lock) {
        wakeLock = lock;
        lock.addEventListener('release', function () { wakeLock = null; });
      }).catch(function () { /* not allowed right now; nothing to do */ });
    } else if (!on && wakeLock) {
      wakeLock.release();
    }
  }

  function load(clip) {
    if (!controller) return;
    var uri = 'spotify:episode:' + data.episodes[clip.slug].a[clip.part];
    clip.reached = false;
    // Loading with startAt keeps the position once playback starts; a seek before the first play is ignored.
    controller.loadEntity(uri, false, clip.start);
    loadedUri = uri;
    if (started) controller.play();
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
    return '?' + parts.join('&');
  }

  function show(clip, direction, how) {
    current = clip;
    upcoming = null;
    lastAt = null;
    heard[keyOf(clip)] = true;
    nextPeek.hidden = true;
    render(clip, direction);
    load(clip);
    track('listen_clip_start', {
      clip_id: keyOf(clip), episode: clip.slug, via: how || clip.via || 'first', theme: theme ? theme.id : 'all', headline: clip.headline
    });
    try { window.history.replaceState(null, '', address()); } catch (error) { /* file:// or sandboxed */ }
  }

  function advance(finished) {
    if (!data || !current) return;
    track(finished ? 'listen_clip_complete' : 'listen_skip', {
      clip_id: keyOf(current), episode: current.slug, theme: theme ? theme.id : 'all',
      heard_seconds: Math.round(lastAt === null ? 0 : Math.max(0, lastAt - current.start))
    });
    if (finished) {
      stats(current.end - current.start);
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

  function onPlayback(state) {
    if (!current || !state) return;
    paused = state.isPaused;
    playButton.textContent = paused ? '▶' : '❚❚';
    playButton.setAttribute('aria-label', paused ? '再生' : '一時停止');
    holdScreen(!paused);
    var at = state.position / 1000;
    var clip = current;
    if (!clip.reached) {
      // Updates from before the jump still report the old position; wait until playback reaches the clip.
      if (at >= clip.start - 5 && at < clip.end) clip.reached = true;
      else return;
    }
    lastAt = at;
    var bar = card.querySelector('.listen-progress span');
    if (bar) bar.style.transform = 'scaleX(' + Math.min(1, Math.max(0, (at - clip.start) / (clip.end - clip.start))) + ')';
    var remaining = card.querySelector('.listen-remaining');
    if (remaining) remaining.textContent = clock(clip.end - at);
    if (clip.end - at <= PEEK_SECONDS && !paused) {
      if (upcoming === null) upcoming = chooseNext(clip) || false;
      if (upcoming) peek(upcoming);
    }
    if (at >= clip.end) advance(true);
  }

  function begin() {
    started = true;
    startScreen.hidden = true;
    track('listen_begin', { theme: theme ? theme.id : 'all', from_link: /[?&]c=/.test(window.location.search) });
    if (controller && current) {
      // This tap is the gesture browsers want before audio; later clips start on their own.
      if (loadedUri) controller.play();
      else load(current);
    }
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
    else if (event.key === ' ' && !event.target.closest('button, a')) { event.preventDefault(); if (controller) controller.togglePlay(); }
  });
  document.addEventListener('visibilitychange', function () {
    // The browser drops the wake lock when the tab is hidden; take it again on return if still playing.
    if (document.visibilityState === 'visible') holdScreen(!paused);
  });
  root.querySelector('[data-listen-next-button]').addEventListener('click', function () { advance(false); });
  root.querySelector('[data-listen-prev]').addEventListener('click', back);
  root.querySelector('[data-listen-replay]').addEventListener('click', function () { if (current) show(current, 0, 'replay'); });
  followLink.addEventListener('click', function () { track('listen_follow_click', { place: 'toast', finished: finished }); });
  root.querySelector('[data-listen-share]').addEventListener('click', share);
  playButton.addEventListener('click', function () {
    if (!started) { begin(); return; }
    if (controller) controller.togglePlay();
  });
  root.querySelector('[data-listen-begin]').addEventListener('click', begin);
  nextPeek.addEventListener('click', function () { advance(false); });
  themeButton.addEventListener('click', function () { themeSheet.hidden = !themeSheet.hidden; });
  themeSheet.querySelector('[data-listen-theme-close]').addEventListener('click', function () { themeSheet.hidden = true; });

  var apiReady = null;
  window.onSpotifyIframeApiReady = function (api) {
    apiReady = api;
    if (data && current) createPlayer();
  };

  function createPlayer() {
    apiReady.createController(root.querySelector('[data-listen-player]'), {
      uri: 'spotify:episode:' + data.episodes[current.slug].a[current.part],
      width: '100%',
      height: 80
    }, function (embed) {
      controller = embed;
      embed.addListener('playback_update', function (event) { onPlayback(event.data); });
      embed.addListener('ready', function () {
        playButton.disabled = false;
        if (!loadedUri) load(current);
      });
    });
  }

  fetch(root.getAttribute('data-clips')).then(function (response) { return response.json(); }).then(function (loaded) {
    data = loaded;
    data.related = data.related || {};
    data.themes = data.themes || [];
    data.clips = data.clips.filter(function (item) { return playable(fromItem(item)); });
    data.clips.forEach(function (item) { clipsById[item.i] = fromItem(item); });
    data.themes.forEach(function (item) { item.clips = item.clips.filter(function (id) { return clipsById[id]; }); });
    buildThemeSheet();
    stats(0);

    var query = window.location.search;
    var wantedTheme = decodeURIComponent((query.match(/[?&]theme=([^&]+)/) || [])[1] || '');
    var wantedClip = decodeURIComponent((query.match(/[?&]c=([^&]+)/) || [])[1] || '');
    var chosen = data.themes.filter(function (item) { return item.id === wantedTheme; })[0] || null;
    theme = chosen;
    if (chosen) {
      themeIds = {};
      chosen.clips.forEach(function (id) { themeIds[id] = true; });
      themeButton.textContent = chosen.emoji + ' ' + chosen.label;
    }
    go(clipsById[wantedClip] || firstOf(chosen), 0);
    startScreen.hidden = false;
    if (apiReady) createPlayer();
  }).catch(function () {
    card.textContent = '読み込めませんでした。時間をおいて開き直してください。';
  });
}());
