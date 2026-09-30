(function () {
  var article = document.querySelector('.article .markdown');
  if (!article) return;

  var player = document.getElementById('episode-player');
  // One player per audio file; episodes published in several files restart their clock in each part.
  var parts = Array.prototype.map.call(document.querySelectorAll('.episode-player-part'), function (element) {
    return {
      element: element,
      api: element.querySelector('.episode-spotify-api'),
      fallback: element.querySelector('.episode-spotify-fallback'),
      controller: null
    };
  });
  var playButtons = [];
  var chapters = [];
  var headings = Array.prototype.filter.call(article.querySelectorAll('h2'), function (heading) {
    return /^\d{1,2}:\d{2}:\d{2}\s/.test(heading.textContent.trim());
  });

  function formatTime(seconds) {
    var pad = function (value) { return (value < 10 ? '0' : '') + value; };
    return pad(Math.floor(seconds / 3600)) + ':' + pad(Math.floor(seconds % 3600 / 60)) + ':' + pad(seconds % 60);
  }

  function partLabel(part) {
    return parts.length > 1 ? 'パート' + (part + 1) + ' ' : '';
  }

  // Where other episodes talk about each question's subject (one list per question).
  var relatedElement = document.getElementById('question-related');
  var relatedSpots = relatedElement ? JSON.parse(relatedElement.textContent) : [];
  var episodeBase = relatedElement ? relatedElement.getAttribute('data-episode-base') : '';

  // A clip is playback that should stop where its topic ends: { part, start, end, related }.
  var activeClip = null;
  var clipPanel = null;

  // GA4 events (see _includes/analytics.html); a no-op without a measurement ID.
  function track(name, params) {
    if (window.arkbfmTrack) window.arkbfmTrack(name, params);
  }

  var episodeSlug = decodeURIComponent(window.location.pathname.split('/').pop());

  // "Now playing" above the player: Spotify's embed only shows the episode, so this shows which question's
  // answer is playing, how far into it, and captions with the speaker's face (listen/captions/<slug>.json).
  var captionBase = player ? player.getAttribute('data-captions') : null;
  var captionFile = null;
  var nowPanel = null;
  var nowPlaying = null;

  function loadCaptions() {
    if (!captionFile) {
      captionFile = captionBase ? fetch(captionBase + encodeURIComponent(episodeSlug) + '.json')
        .then(function (response) { return response.ok ? response.json() : null; })
        .catch(function () { return null; }) : Promise.resolve(null);
    }
    return captionFile;
  }

  function nowElement(tag, className) {
    var node = document.createElement(tag);
    node.className = className;
    return node;
  }

  // info: { text, start, end (or null), part, waiting (true until playback starts) }
  function showNow(info) {
    if (!player) return;
    if (!nowPanel) {
      nowPanel = nowElement('div', 'ep-now');
      nowPanel.setAttribute('aria-live', 'polite');
      nowPanel.appendChild(nowElement('p', 'ep-now-label'));
      nowPanel.appendChild(nowElement('p', 'ep-now-text'));
      var bar = nowElement('div', 'ep-now-progress');
      bar.appendChild(nowElement('span', ''));
      nowPanel.appendChild(bar);
      var said = nowElement('div', 'ep-now-caption');
      said.appendChild(nowElement('img', 'ep-now-face'));
      var words = nowElement('div', 'ep-now-words');
      words.appendChild(nowElement('span', 'ep-now-speaker'));
      words.appendChild(nowElement('p', 'ep-now-line'));
      said.appendChild(words);
      nowPanel.appendChild(said);
      player.insertAdjacentElement('afterbegin', nowPanel);
    }
    nowPlaying = info;
    info.shown = null;
    var range = partLabel(info.part) + formatTime(info.start) + (info.end ? '〜' + formatTime(info.end) : '〜');
    nowPanel.querySelector('.ep-now-label').textContent = (info.waiting ? '▶ を押すと、この答えから再生 · ' : '再生中 · ') + range;
    nowPanel.querySelector('.ep-now-text').textContent = info.text || '';
    nowPanel.querySelector('.ep-now-progress span').style.transform = 'scaleX(0)';
    nowPanel.querySelector('.ep-now-caption').hidden = true;
    nowPanel.hidden = false;
    loadCaptions().then(function (file) {
      if (!file || nowPlaying !== info) return;
      info.speakers = file.speakers;
      info.lines = file.lines.filter(function (line) {
        return line[0] === info.part && line[1] >= info.start - 5 && (!info.end || line[1] < info.end);
      });
      followNow(info.part, info.start);
    });
  }

  function followNow(part, at) {
    var info = nowPlaying;
    if (!info || !nowPanel || info.part !== part) return;
    if (info.end) {
      nowPanel.querySelector('.ep-now-progress span').style.transform =
        'scaleX(' + Math.min(1, Math.max(0, (at - info.start) / (info.end - info.start))) + ')';
    }
    if (!info.lines || !info.lines.length) return;
    var index = 0;
    for (var i = 0; i < info.lines.length && info.lines[i][1] <= at; i += 1) index = i;
    if (index === info.shown) return;
    info.shown = index;
    var line = info.lines[index];
    var speaker = (info.speakers || {})[line[2]];
    var caption = nowPanel.querySelector('.ep-now-caption');
    var face = caption.querySelector('.ep-now-face');
    face.hidden = !(speaker && speaker[1]);
    if (speaker && speaker[1]) face.src = speaker[1];
    face.alt = '';
    caption.querySelector('.ep-now-speaker').textContent = speaker ? speaker[0] : '';
    var text = caption.querySelector('.ep-now-line');
    // Before playback the first line is a teaser for what the answer opens with.
    text.textContent = info.waiting ? '「' + line[3] + '…」' : line[3];
    caption.hidden = false;
  }

  function playFrom(seconds, part, clip) {
    var target = parts[part];
    if (!target || !target.controller) return;
    track('episode_play', { episode: episodeSlug, kind: clip ? (clip.index ? 'question' : 'topic') : 'chapter', question: clip && clip.index || 0 });
    var chapter = chapterAt(seconds, part);
    var following = chapter ? chapters[chapters.indexOf(chapter) + 1] : null;
    showNow({
      text: clip && clip.text || (chapter ? chapter.title : ''),
      start: seconds,
      end: clip && clip.end || (following && following.part === part ? following.seconds : null),
      part: part,
      waiting: false
    });
    parts.forEach(function (other) {
      if (other !== target && other.controller) other.controller.pause();
    });
    if (clipPanel) clipPanel.remove();
    activeClip = clip && clip.end !== null ? { part: part, start: seconds, end: clip.end, related: clip.related || [], q: clip.index || null, started: false } : null;
    // Loading with startAt preserves the chapter position when playback starts.
    // Calling seek before the first play is ignored by Spotify's Embed.
    target.controller.loadEntity('spotify:episode:' + target.spotifyId, false, seconds);
    target.controller.play();
    target.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // Returns null when the part has no player, so callers simply skip the button.
  function playButton(seconds, part, text, label, clip) {
    if (!parts[part]) return null;
    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.setAttribute('aria-label', label);
    button.disabled = true;
    button.addEventListener('click', function () { playFrom(seconds, part, clip); });
    playButtons.push({ button: button, part: part });
    return button;
  }

  function spotUrl(spot) {
    return episodeBase + spot.slug + '?t=' + spot.time + (spot.part ? '&p=' + spot.part : '') +
      (spot.end ? '&e=' + spot.end : '') + (spot.q ? '&q=' + spot.q : '');
  }

  // Shown when a clip reaches its end: carry on here, or hear the same subject in another episode.
  function showClipEnd(clip) {
    if (clipPanel) clipPanel.remove();
    track('episode_clip_end', { episode: episodeSlug, question: clip.q || 0, related: clip.related.length });
    clipPanel = document.createElement('div');
    clipPanel.className = 'ep-clip-end';
    clipPanel.setAttribute('role', 'status');
    var head = document.createElement('p');
    var title = document.createElement('strong');
    title.textContent = 'この話題はここまで';
    head.appendChild(title);
    var resume = document.createElement('button');
    resume.type = 'button';
    resume.textContent = '▶ 続きを聴く';
    resume.addEventListener('click', function () {
      clipPanel.remove();
      parts[clip.part].controller.resume();
    });
    head.appendChild(resume);
    if (clip.q && episodeBase) {
      // The feed picks up from this question and keeps following the subject on its own.
      var feed = document.createElement('a');
      feed.className = 'ep-clip-end-feed';
      feed.href = episodeBase.replace(/episode\/$/, 'listen/') + '?c=' + encodeURIComponent(episodeSlug + '.' + clip.q);
      feed.textContent = 'つまみ聴きで続ける →';
      feed.addEventListener('click', function () { track('episode_to_feed', { episode: episodeSlug, question: clip.q }); });
      head.appendChild(feed);
    }
    clipPanel.appendChild(head);
    if (clip.related.length) {
      var lead = document.createElement('p');
      lead.className = 'ep-clip-end-lead';
      lead.textContent = '関連するテーマを話している箇所';
      clipPanel.appendChild(lead);
      var list = document.createElement('ul');
      clip.related.forEach(function (spot) {
        var item = document.createElement('li');
        var link = document.createElement('a');
        link.href = spotUrl(spot);
        link.addEventListener('click', function () {
          track('episode_related_click', { episode: episodeSlug, to_episode: spot.slug, to_clip: spot.id || '' });
        });
        var episode = document.createElement('span');
        episode.textContent = spot.episode + (spot.question ? ' ／ ' + spot.chapter : '');
        var chapter = document.createElement('strong');
        chapter.textContent = spot.question || spot.chapter;
        var time = document.createElement('time');
        time.textContent = (spot.part ? 'パート' + spot.part + ' ' : '') + spot.time + '〜';
        link.appendChild(chapter);
        link.appendChild(episode);
        link.appendChild(time);
        if (spot.reason) {
          var reason = document.createElement('small');
          reason.textContent = spot.reason;
          link.appendChild(reason);
        }
        item.appendChild(link);
        list.appendChild(item);
      });
      clipPanel.appendChild(list);
    }
    parts[clip.part].element.insertAdjacentElement('afterend', clipPanel);
  }

  function watchClip(index, data) {
    var clip = activeClip;
    if (!clip || clip.part !== index || !data || data.isPaused) return;
    var position = data.position / 1000;
    if (!clip.started) {
      // Updates from before the jump still report the old position; wait until playback reaches the clip.
      if (position >= clip.start - 5 && position < clip.end) clip.started = true;
      return;
    }
    if (position < clip.start - 5 || position > clip.end + 30) {
      // The listener sought elsewhere, so they are no longer following this topic.
      activeClip = null;
      return;
    }
    if (position >= clip.end) {
      activeClip = null;
      parts[index].controller.pause();
      showClipEnd(clip);
    }
  }

  if (headings.length) {
    var nav = document.createElement('nav');
    nav.className = 'episode-toc';
    nav.setAttribute('aria-label', 'この回の目次');
    var title = document.createElement('h2');
    title.textContent = 'この回の目次';
    nav.appendChild(title);
    var previewList = document.createElement('ol');
    previewList.className = 'episode-toc-preview';
    var details = document.createElement('details');
    var summary = document.createElement('summary');
    summary.textContent = '残り' + (headings.length - 3) + '章を見る';
    details.appendChild(summary);
    var remainingList = document.createElement('ol');
    var part = 0;

    headings.forEach(function (heading, index) {
      var label = heading.textContent.trim();
      var match = label.match(/^(\d{1,2}):(\d{2}):(\d{2})\s+(.+)$/);
      if (!match) return;
      if (!heading.id) heading.id = 'chapter-' + (index + 1);
      var seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
      // Multi-part episodes restart their timestamps with each audio file.
      if (chapters.length && seconds < chapters[chapters.length - 1].seconds) part += 1;
      chapters.push({ heading: heading, seconds: seconds, part: part, title: match[4] });
      var item = document.createElement('li');
      var link = document.createElement('a');
      link.href = '#' + heading.id;
      var time = document.createElement('time');
      time.textContent = match[1] + ':' + match[2] + ':' + match[3];
      link.appendChild(time);
      link.appendChild(document.createTextNode(match[4]));
      item.appendChild(link);

      var chapterButton = playButton(seconds, part, 'ここから聴く', partLabel(part) + time.textContent + ' ' + match[4] + ' から聴く');
      if (chapterButton) item.appendChild(chapterButton);
      if (index < 3) previewList.appendChild(item);
      else remainingList.appendChild(item);
    });

    nav.appendChild(previewList);
    if (headings.length > 3) {
      details.appendChild(remainingList);
      nav.appendChild(details);
    }
    if (player) player.insertAdjacentElement('afterend', nav);
    else headings[0].parentNode.insertBefore(nav, headings[0]);
  }

  function chapterAt(seconds, part) {
    var found = null;
    chapters.forEach(function (chapter) {
      if (chapter.part === part && chapter.seconds <= seconds) found = chapter;
    });
    return found;
  }

  // Quotes are listed together without JavaScript; with it, each moves under its chapter.
  var quotesSection = article.querySelector('.ep-quotes');
  if (quotesSection) {
    Array.prototype.forEach.call(quotesSection.querySelectorAll('.ep-quote'), function (quote) {
      var seconds = Number(quote.getAttribute('data-seconds'));
      var quoteButton = playButton(seconds, 0, '▶ この発言から聴く', formatTime(seconds) + ' の発言から聴く');
      if (quoteButton) quote.querySelector('figcaption').appendChild(quoteButton);
      var chapter = chapterAt(seconds, 0);
      if (!chapter) return;
      var anchor = chapter.heading.nextElementSibling;
      while (anchor && anchor.tagName !== 'UL' && anchor.tagName !== 'H2') anchor = anchor.nextElementSibling;
      var target = anchor && anchor.tagName === 'UL' ? anchor : chapter.heading;
      var last = target;
      while (last.nextElementSibling && last.nextElementSibling.classList.contains('ep-quote')) last = last.nextElementSibling;
      last.insertAdjacentElement('afterend', quote);
    });
    if (!quotesSection.querySelector('.ep-quote')) quotesSection.remove();
  }

  // Accepts plain seconds (random scene) or HH:MM:SS (question times).
  function parseTime(value) {
    if (!value || !/^\d+(:\d{1,2}){0,2}$/.test(value)) return null;
    return value.split(':').reduce(function (total, part) { return total * 60 + Number(part); }, 0);
  }

  // Each question plays the part of the talk that answers it, then offers related talk elsewhere.
  var questions = Array.prototype.map.call(article.querySelectorAll('.ep-questions li'), function (item, index) {
    var question = {
      item: item,
      text: item.textContent.trim(),
      seconds: parseTime(item.getAttribute('data-time')),
      end: parseTime(item.getAttribute('data-end')),
      part: (Number(item.getAttribute('data-part')) || 1) - 1,
      related: relatedSpots[index] || [],
      index: index + 1
    };
    var button = question.seconds !== null && playButton(question.seconds, question.part, '▶ ここから聴く', question.text + ' の答えから聴く', question);
    if (button) item.appendChild(button);
    return question;
  });

  // The full question list (headline and chapter questions) plays each answer's span as well, and reads
  // in the order of the talk: the template lists the headline questions first.
  var allQuestions = article.querySelector('.ep-all-questions ol');
  if (allQuestions) {
    Array.prototype.slice.call(allQuestions.children).map(function (item) {
      return { item: item, order: (Number(item.getAttribute('data-part')) || 1) * 1e6 + (parseTime(item.getAttribute('data-time')) || 0) };
    }).sort(function (a, b) { return a.order - b.order; }).forEach(function (entry) { allQuestions.appendChild(entry.item); });
  }
  Array.prototype.forEach.call(article.querySelectorAll('.ep-all-questions li'), function (item) {
    var seconds = parseTime(item.getAttribute('data-time'));
    var part = (Number(item.getAttribute('data-part')) || 1) - 1;
    var text = item.querySelector('a').textContent;
    var button = seconds !== null && playButton(seconds, part, '▶', text + ' の答えを聴く', { end: parseTime(item.getAttribute('data-end')), related: [], text: text });
    if (button) item.insertBefore(button, item.firstChild);
  });

  // ?t= comes from the random scene button, question links and related spots
  // (?p= is the 1-based audio part, ?q= the question's 1-based position, ?e= where the topic ends).
  var requested = parseTime((window.location.search.match(/[?&]t=([\d:]+)/) || [])[1]);
  var requestedEnd = parseTime((window.location.search.match(/[?&]e=([\d:]+)/) || [])[1]);
  var requestedPart = (Number((window.location.search.match(/[?&]p=(\d+)/) || [])[1]) || 1) - 1;
  var requestedQuestion = questions[Number((window.location.search.match(/[?&]q=(\d+)/) || [])[1]) - 1] || null;
  var requestedChapter = requested !== null ? chapterAt(requested, requestedPart) : null;
  if (requested !== null && player && (requestedQuestion || requestedChapter || requestedEnd !== null)) {
    var banner = document.createElement('div');
    banner.className = 'ep-scene-banner';
    var text = document.createElement('p');
    var label = document.createElement('span');
    var strong = document.createElement('strong');
    var where = partLabel(requestedPart) + formatTime(requested) + (requestedChapter ? '（' + requestedChapter.title + '）' : '');
    var bannerClip = null;
    if (requestedQuestion) {
      label.textContent = 'Q この問いの答えから ' + where;
      strong.textContent = requestedQuestion.text;
      requestedQuestion.item.classList.add('is-requested');
      bannerClip = { end: requestedEnd !== null ? requestedEnd : requestedQuestion.end, related: requestedQuestion.related, index: requestedQuestion.index, text: requestedQuestion.text };
    } else if (requestedEnd !== null) {
      label.textContent = '関連する話題から ' + partLabel(requestedPart) + formatTime(requested) + '〜' + formatTime(requestedEnd);
      strong.textContent = requestedChapter ? requestedChapter.title : 'この場面';
      bannerClip = { end: requestedEnd, related: [], text: requestedChapter ? requestedChapter.title : '' };
    } else {
      label.textContent = '🎲 ランダムに選んだ場面';
      strong.textContent = formatTime(requestedChapter.seconds) + ' ' + requestedChapter.title;
    }
    text.appendChild(label);
    text.appendChild(strong);
    banner.appendChild(text);
    var bannerButton = playButton(requested, requestedPart, '▶ ここから聴く', partLabel(requestedPart) + formatTime(requested) + ' から聴く', bannerClip);
    if (bannerButton) banner.appendChild(bannerButton);
    if (requestedChapter) {
      var jump = document.createElement('a');
      jump.href = '#' + requestedChapter.heading.id;
      jump.textContent = 'ショーノートで見る';
      banner.appendChild(jump);
      requestedChapter.heading.classList.add('is-requested');
    }
    player.insertAdjacentElement('beforebegin', banner);
    // Show what will play, with the answer's opening words, before the listener presses play.
    showNow({
      text: bannerClip ? bannerClip.text : (requestedChapter ? requestedChapter.title : ''),
      start: requested,
      end: bannerClip ? bannerClip.end : null,
      part: requestedPart,
      waiting: true
    });
  }

  var copyButton = document.querySelector('[data-copy-url]');
  if (copyButton && navigator.clipboard) {
    copyButton.addEventListener('click', function () {
      navigator.clipboard.writeText(copyButton.getAttribute('data-copy-url')).then(function () {
        copyButton.textContent = 'コピーしました';
        setTimeout(function () { copyButton.textContent = 'リンクをコピー'; }, 2000);
      });
    });
  } else if (copyButton) {
    copyButton.remove();
  }

  if (!parts.length) return;

  window.onSpotifyIframeApiReady = function (IFrameAPI) {
    parts.forEach(function (part, index) {
      // The API replaces the inner element with its iframe; the wrapper keeps the ready state.
      var target = part.api.firstElementChild;
      part.spotifyId = target.dataset.spotifyId;
      IFrameAPI.createController(target, {
        uri: 'spotify:episode:' + part.spotifyId,
        width: '100%',
        height: 204
      }, function (embedController) {
        part.controller = embedController;
        embedController.addListener('playback_update', function (event) {
          watchClip(index, event.data);
          if (event.data && !event.data.isPaused) followNow(index, event.data.position / 1000);
        });
        embedController.addListener('ready', function () {
          part.api.classList.add('is-ready');
          if (part.fallback) part.fallback.remove();
          playButtons.forEach(function (entry) {
            if (entry.part === index) entry.button.disabled = false;
          });
        });
      });
    });
  };
}());
