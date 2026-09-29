(function () {
  var article = document.querySelector('.article .markdown');
  if (!article) return;

  var player = document.getElementById('episode-player');
  var apiElement = document.getElementById('episode-spotify-api');
  var fallback = document.getElementById('episode-spotify-fallback');
  var controller = null;
  var playButtons = [];
  var chapters = [];
  var headings = Array.prototype.filter.call(article.querySelectorAll('h2'), function (heading) {
    return /^\d{1,2}:\d{2}:\d{2}\s/.test(heading.textContent.trim());
  });

  function formatTime(seconds) {
    var pad = function (value) { return (value < 10 ? '0' : '') + value; };
    return pad(Math.floor(seconds / 3600)) + ':' + pad(Math.floor(seconds % 3600 / 60)) + ':' + pad(seconds % 60);
  }

  function playFrom(seconds) {
    if (!controller) return;
    // Loading with startAt preserves the chapter position when playback starts.
    // Calling seek before the first play is ignored by Spotify's Embed.
    controller.loadEntity('spotify:episode:' + apiElement.dataset.spotifyId, false, seconds);
    controller.play();
    player.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function playButton(seconds, text, label) {
    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.setAttribute('aria-label', label);
    button.disabled = true;
    button.addEventListener('click', function () { playFrom(seconds); });
    playButtons.push(button);
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
      // Multi-part episodes restart their timestamps; only the first part is in the controllable player.
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

      if (apiElement && part === 0) {
        item.appendChild(playButton(seconds, 'ここから聴く', time.textContent + ' ' + match[4] + ' から聴く'));
      }
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

  function chapterAt(seconds) {
    var found = null;
    chapters.forEach(function (chapter) {
      if (chapter.part === 0 && chapter.seconds <= seconds) found = chapter;
    });
    return found;
  }

  // Quotes are listed together without JavaScript; with it, each moves under its chapter.
  var quotesSection = article.querySelector('.ep-quotes');
  if (quotesSection) {
    Array.prototype.forEach.call(quotesSection.querySelectorAll('.ep-quote'), function (quote) {
      var seconds = Number(quote.getAttribute('data-seconds'));
      if (apiElement) {
        var caption = quote.querySelector('figcaption');
        caption.appendChild(playButton(seconds, '▶ この発言から聴く', formatTime(seconds) + ' の発言から聴く'));
      }
      var chapter = chapterAt(seconds);
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

  // ?t=seconds comes from the random scene button on the home page.
  var requested = Number((window.location.search.match(/[?&]t=(\d+)/) || [])[1]);
  var requestedChapter = requested ? chapterAt(requested) : null;
  if (requestedChapter && player) {
    var banner = document.createElement('div');
    banner.className = 'ep-scene-banner';
    var text = document.createElement('p');
    text.innerHTML = '<span>🎲 ランダムに選んだ場面</span>';
    var strong = document.createElement('strong');
    strong.textContent = formatTime(requestedChapter.seconds) + ' ' + requestedChapter.title;
    text.appendChild(strong);
    banner.appendChild(text);
    if (apiElement) banner.appendChild(playButton(requestedChapter.seconds, '▶ ここから聴く', 'この場面から聴く'));
    var jump = document.createElement('a');
    jump.href = '#' + requestedChapter.heading.id;
    jump.textContent = 'ショーノートで見る';
    banner.appendChild(jump);
    player.insertAdjacentElement('beforebegin', banner);
    requestedChapter.heading.classList.add('is-requested');
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

  if (!apiElement || !fallback) return;

  window.onSpotifyIframeApiReady = function (IFrameAPI) {
    IFrameAPI.createController(apiElement, {
      uri: 'spotify:episode:' + apiElement.dataset.spotifyId,
      width: '100%',
      height: 204
    }, function (embedController) {
      controller = embedController;
      controller.addListener('ready', function () {
        apiElement.classList.add('is-ready');
        fallback.remove();
        playButtons.forEach(function (button) { button.disabled = false; });
      });
    });
  };
}());
