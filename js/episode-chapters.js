// Episode page: a table of contents from the timed chapter headings, quotes moved under their chapters,
// and "listen from here" links. Everything that starts at a moment plays in the listening feed
// (/listen/), which has captions, speed and lock-screen controls and follows the subject on to other
// episodes; the Spotify embed on this page is for hearing the whole episode from the start.
(function () {
  var article = document.querySelector('.article .markdown');
  if (!article) return;

  var player = document.getElementById('episode-player');
  var listenBase = player ? player.getAttribute('data-listen') : null;
  var partCount = document.querySelectorAll('.episode-player-part').length;
  var episodeSlug = player ? player.getAttribute('data-slug') : '';
  var chapters = [];
  var headings = Array.prototype.filter.call(article.querySelectorAll('h2'), function (heading) {
    return /^\d{1,2}:\d{2}:\d{2}\s/.test(heading.textContent.trim());
  });

  function formatTime(seconds) {
    var pad = function (value) { return (value < 10 ? '0' : '') + value; };
    return pad(Math.floor(seconds / 3600)) + ':' + pad(Math.floor(seconds % 3600 / 60)) + ':' + pad(seconds % 60);
  }

  function partLabel(part) {
    return partCount > 1 ? 'パート' + (part + 1) + ' ' : '';
  }

  // GA4 events (see _includes/analytics.html); a no-op without a measurement ID.
  function track(name, params) {
    if (window.arkbfmTrack) window.arkbfmTrack(name, params);
  }

  // The feed plays a question by its id, or any span of this episode: ?ep=&t=&e=&p=&title=.
  function listenUrl(spot) {
    if (spot.clip) return listenBase + '?c=' + encodeURIComponent(spot.clip);
    return listenBase + '?ep=' + encodeURIComponent(episodeSlug) + '&t=' + spot.start +
      (spot.end ? '&e=' + spot.end : '') + (spot.part ? '&p=' + (spot.part + 1) : '') +
      (spot.title ? '&title=' + encodeURIComponent(spot.title) : '');
  }

  // Returns null without a feed (or for a part with no audio), so callers simply skip the link.
  function playLink(spot, text, label, kind) {
    if (!listenBase || spot.part >= partCount) return null;
    var link = document.createElement('a');
    link.className = 'ep-play';
    link.href = listenUrl(spot);
    link.textContent = text;
    link.setAttribute('aria-label', label);
    link.addEventListener('click', function () { track('episode_play', { episode: episodeSlug, kind: kind }); });
    return link;
  }

  function chapterAt(seconds, part) {
    var found = null;
    chapters.forEach(function (chapter) {
      if (chapter.part === part && chapter.seconds <= seconds) found = chapter;
    });
    return found;
  }

  // Where the chapter holding this moment ends: the next chapter in the same part, if any.
  function chapterEnd(chapter) {
    var following = chapters[chapters.indexOf(chapter) + 1];
    return following && following.part === chapter.part ? following.seconds : null;
  }

  if (headings.length) {
    var part = 0;
    headings.forEach(function (heading, index) {
      var match = heading.textContent.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})\s+(.+)$/);
      if (!match) return;
      if (!heading.id) heading.id = 'chapter-' + (index + 1);
      var seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
      // Multi-part episodes restart their timestamps with each audio file.
      if (chapters.length && seconds < chapters[chapters.length - 1].seconds) part += 1;
      chapters.push({ heading: heading, seconds: seconds, part: part, title: match[4], time: match[1] + ':' + match[2] + ':' + match[3] });
    });

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
    summary.textContent = '残り' + (chapters.length - 3) + '章を見る';
    details.appendChild(summary);
    var remainingList = document.createElement('ol');

    chapters.forEach(function (chapter, index) {
      var item = document.createElement('li');
      var link = document.createElement('a');
      link.href = '#' + chapter.heading.id;
      var time = document.createElement('time');
      time.textContent = chapter.time;
      link.appendChild(time);
      link.appendChild(document.createTextNode(chapter.title));
      item.appendChild(link);
      var listen = playLink({ start: chapter.seconds, end: chapterEnd(chapter), part: chapter.part, title: chapter.title },
        'ここから聴く', partLabel(chapter.part) + chapter.time + ' ' + chapter.title + ' から聴く', 'chapter');
      if (listen) item.appendChild(listen);
      (index < 3 ? previewList : remainingList).appendChild(item);
    });

    nav.appendChild(previewList);
    if (chapters.length > 3) {
      details.appendChild(remainingList);
      nav.appendChild(details);
    }
    // Chapters come before the full-episode player: jumping to a moment is what most visitors want.
    if (player) player.insertAdjacentElement('beforebegin', nav);
    else headings[0].parentNode.insertBefore(nav, headings[0]);
  }

  // Quotes are listed together without JavaScript; with it, each moves under its chapter.
  var quotesSection = article.querySelector('.ep-quotes');
  if (quotesSection) {
    Array.prototype.forEach.call(quotesSection.querySelectorAll('.ep-quote'), function (quote) {
      var seconds = Number(quote.getAttribute('data-seconds'));
      var chapter = chapterAt(seconds, 0);
      var listen = playLink({ start: seconds, end: chapter ? chapterEnd(chapter) : null, part: 0, title: chapter ? chapter.title : '' },
        '▶ この発言から聴く', formatTime(seconds) + ' の発言から聴く', 'quote');
      if (listen) quote.querySelector('figcaption').appendChild(listen);
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

  // Accepts plain seconds or HH:MM:SS (question times).
  function parseTime(value) {
    if (!value || !/^\d+(:\d{1,2}){0,2}$/.test(value)) return null;
    return value.split(':').reduce(function (total, part) { return total * 60 + Number(part); }, 0);
  }

  // Each question plays the part of the talk that answers it (data-clip is its id in the feed).
  var questions = Array.prototype.map.call(article.querySelectorAll('.ep-questions li'), function (item, index) {
    var question = { item: item, text: item.textContent.trim(), clip: item.getAttribute('data-clip'), part: (Number(item.getAttribute('data-part')) || 1) - 1 };
    var listen = question.clip && playLink(question, '▶ ここから聴く', question.text + ' の答えから聴く', 'question');
    if (listen) item.appendChild(listen);
    return question;
  });

  // The full question list (headline and chapter questions) reads in the order of the talk:
  // the template lists the headline questions first.
  var allQuestions = article.querySelector('.ep-all-questions ol');
  if (allQuestions) {
    Array.prototype.slice.call(allQuestions.children).map(function (item) {
      return { item: item, order: (Number(item.getAttribute('data-part')) || 1) * 1e6 + (parseTime(item.getAttribute('data-time')) || 0) };
    }).sort(function (a, b) { return a.order - b.order; }).forEach(function (entry) { allQuestions.appendChild(entry.item); });
    Array.prototype.forEach.call(allQuestions.children, function (item) {
      var text = item.querySelector('a').textContent;
      var listen = playLink({ clip: item.getAttribute('data-clip'), part: (Number(item.getAttribute('data-part')) || 1) - 1 }, '▶', text + ' の答えを聴く', 'all_questions');
      if (listen) item.insertBefore(listen, item.firstChild);
    });
  }

  // Older links open this page at a moment (?t=, ?p= the 1-based audio part, ?q= the question's 1-based
  // position, ?e= where the topic ends): offer that moment in the feed.
  var query = window.location.search;
  var requested = parseTime((query.match(/[?&]t=([\d:]+)/) || [])[1]);
  var requestedEnd = parseTime((query.match(/[?&]e=([\d:]+)/) || [])[1]);
  var requestedPart = (Number((query.match(/[?&]p=(\d+)/) || [])[1]) || 1) - 1;
  var requestedQuestion = questions[Number((query.match(/[?&]q=(\d+)/) || [])[1]) - 1] || null;
  var requestedChapter = requested !== null ? chapterAt(requested, requestedPart) : null;
  if (requested !== null && player) {
    var banner = document.createElement('div');
    banner.className = 'ep-scene-banner';
    var text = document.createElement('p');
    var label = document.createElement('span');
    var strong = document.createElement('strong');
    label.textContent = (requestedQuestion ? 'Q この問いの答えから ' : 'この場面から ') + partLabel(requestedPart) + formatTime(requested) +
      (requestedChapter ? '（' + requestedChapter.title + '）' : '');
    strong.textContent = requestedQuestion ? requestedQuestion.text : requestedChapter ? requestedChapter.title : 'この場面';
    if (requestedQuestion) requestedQuestion.item.classList.add('is-requested');
    text.appendChild(label);
    text.appendChild(strong);
    banner.appendChild(text);
    var spot = requestedQuestion && requestedQuestion.clip ? requestedQuestion : {
      start: requested, part: requestedPart, title: requestedChapter ? requestedChapter.title : '',
      end: requestedEnd !== null ? requestedEnd : requestedChapter ? chapterEnd(requestedChapter) : null
    };
    var listen = playLink(spot, '▶ ここから聴く', partLabel(requestedPart) + formatTime(requested) + ' から聴く', 'banner');
    if (listen) banner.appendChild(listen);
    if (requestedChapter) {
      var jump = document.createElement('a');
      jump.href = '#' + requestedChapter.heading.id;
      jump.textContent = 'ショーノートで見る';
      banner.appendChild(jump);
      requestedChapter.heading.classList.add('is-requested');
    }
    (article.querySelector('.episode-toc') || player).insertAdjacentElement('beforebegin', banner);
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
}());
