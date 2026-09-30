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

  function playFrom(seconds, part) {
    var target = parts[part];
    if (!target || !target.controller) return;
    parts.forEach(function (other) {
      if (other !== target && other.controller) other.controller.pause();
    });
    // Loading with startAt preserves the chapter position when playback starts.
    // Calling seek before the first play is ignored by Spotify's Embed.
    target.controller.loadEntity('spotify:episode:' + target.spotifyId, false, seconds);
    target.controller.play();
    target.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // Returns null when the part has no player, so callers simply skip the button.
  function playButton(seconds, part, text, label) {
    if (!parts[part]) return null;
    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.setAttribute('aria-label', label);
    button.disabled = true;
    button.addEventListener('click', function () { playFrom(seconds, part); });
    playButtons.push({ button: button, part: part });
    return button;
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

  // Each question plays from the part of the talk that answers it.
  var questions = Array.prototype.map.call(article.querySelectorAll('.ep-questions li'), function (item) {
    var question = {
      item: item,
      text: item.textContent.trim(),
      seconds: parseTime(item.getAttribute('data-time')),
      part: (Number(item.getAttribute('data-part')) || 1) - 1
    };
    var button = question.seconds !== null && playButton(question.seconds, question.part, '▶ ここから聴く', question.text + ' の答えから聴く');
    if (button) item.appendChild(button);
    return question;
  });

  // ?t= comes from the random scene button and from question links
  // (?p= is the 1-based audio part, ?q= the question's 1-based position).
  var requested = parseTime((window.location.search.match(/[?&]t=([\d:]+)/) || [])[1]);
  var requestedPart = (Number((window.location.search.match(/[?&]p=(\d+)/) || [])[1]) || 1) - 1;
  var requestedQuestion = questions[Number((window.location.search.match(/[?&]q=(\d+)/) || [])[1]) - 1] || null;
  var requestedChapter = requested !== null ? chapterAt(requested, requestedPart) : null;
  if (requested !== null && player && (requestedQuestion || requestedChapter)) {
    var banner = document.createElement('div');
    banner.className = 'ep-scene-banner';
    var text = document.createElement('p');
    var label = document.createElement('span');
    var strong = document.createElement('strong');
    if (requestedQuestion) {
      label.textContent = 'Q この問いの答えから ' + partLabel(requestedPart) + formatTime(requested) + (requestedChapter ? '（' + requestedChapter.title + '）' : '');
      strong.textContent = requestedQuestion.text;
      requestedQuestion.item.classList.add('is-requested');
    } else {
      label.textContent = '🎲 ランダムに選んだ場面';
      strong.textContent = formatTime(requestedChapter.seconds) + ' ' + requestedChapter.title;
    }
    text.appendChild(label);
    text.appendChild(strong);
    banner.appendChild(text);
    var bannerButton = playButton(requested, requestedPart, '▶ ここから聴く', partLabel(requestedPart) + formatTime(requested) + ' から聴く');
    if (bannerButton) banner.appendChild(bannerButton);
    if (requestedChapter) {
      var jump = document.createElement('a');
      jump.href = '#' + requestedChapter.heading.id;
      jump.textContent = 'ショーノートで見る';
      banner.appendChild(jump);
      requestedChapter.heading.classList.add('is-requested');
    }
    player.insertAdjacentElement('beforebegin', banner);
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
