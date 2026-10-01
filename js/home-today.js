// Home page: three questions of the day (the same for everyone on a given day) and, for a returning
// listener, a way back to where the listening feed stopped.
(function () {
  var box = document.querySelector('[data-home-today]');
  if (!box || !window.fetch) return;
  var listen = box.getAttribute('data-listen');

  function track(name, params) {
    if (window.arkbfmTrack) window.arkbfmTrack(name, params);
  }

  // A small seeded generator, so the day's picks do not depend on who opens the page.
  function seeded(text) {
    var seed = 2166136261;
    for (var i = 0; i < text.length; i += 1) seed = Math.imul(seed ^ text.charCodeAt(i), 16777619);
    return function () {
      seed = Math.imul(seed ^ (seed >>> 15), 2246822507);
      seed = Math.imul(seed ^ (seed >>> 13), 3266489909);
      return ((seed ^= seed >>> 16) >>> 0) / 4294967296;
    };
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function seconds(hms) {
    return hms.split(':').reduce(function (total, part) { return total * 60 + Number(part); }, 0);
  }

  // 00:33:05 -> 33:05, 01:02:00 -> 1:02:00.
  function clock(hms) {
    return hms.replace(/^00:/, '').replace(/^0(\d)/, '$1');
  }

  // The first words said in the answer, with who says them: from the episode's caption file, fetched once the
  // rest of the page is in (one episode's file, about 100 KB).
  function openingLine(item, target) {
    var base = box.getAttribute('data-captions');
    if (!base || !item[4]) return;
    var slug = item[0].slice(0, item[0].lastIndexOf('.'));
    var start = seconds(item[4]);
    var part = (item[6] || 1) - 1;
    var load = function () {
      fetch(base + encodeURIComponent(slug) + '.json').then(function (response) { return response.ok ? response.json() : null; }).then(function (file) {
        var said = file && (file.lines || []).filter(function (entry) { return entry[0] === part && entry[1] >= start - 2; })[0];
        if (!said) return;
        var speaker = (file.speakers || {})[said[2]];
        if (speaker && speaker[1]) {
          var face = element('img');
          face.src = speaker[1].replace('/images/actors/', '/images/actors/s/');
          face.alt = '';
          target.appendChild(face);
        }
        if (speaker) target.appendChild(element('b', '', speaker[0]));
        target.appendChild(element('span', '', '「' + said[3].split('|').join('') + '…」'));
        target.hidden = false;
      }).catch(function () { /* the card reads fine without it */ });
    };
    if (document.readyState === 'complete') load(); else window.addEventListener('load', load);
  }

  // "つづきから" first: it is the one thing that is only for this listener.
  try {
    var resume = JSON.parse(localStorage.getItem('arkbfm-listen-resume') || 'null');
    if (resume && Date.now() - resume.t < 14 * 864e5) {
      var back = element('a', 'home-resume', '▶ つづきから聴く');
      back.href = listen + '?resume=1';
      back.addEventListener('click', function () { track('home_resume_click', {}); });
      box.appendChild(back);
      box.hidden = false;
    }
  } catch (error) { /* storage can be unavailable */ }

  fetch(box.getAttribute('data-headlines')).then(function (response) { return response.json(); }).then(function (items) {
    // Japan's date, so the questions change at midnight for the show's listeners.
    var today = new Date(Date.now() + 9 * 36e5).toISOString().slice(0, 10);
    var random = seeded(today);
    var picks = [];
    var episodes = {};
    var pool = items.slice();
    while (picks.length < 3 && pool.length) {
      var item = pool.splice(Math.floor(random() * pool.length), 1)[0];
      var slug = item[0].slice(0, item[0].lastIndexOf('.'));
      if (episodes[slug]) continue;
      episodes[slug] = true;
      picks.push(item);
    }
    box.appendChild(element('p', 'home-today-label', '今日の3問'));
    var href = function (item) { return listen + '?c=' + encodeURIComponent(item[0]) + '&from=today'; };
    var onClick = function (item) { return function () { track('home_today_click', { clip_id: item[0] }); }; };

    // The first question as a card from the feed: faces, where in the episode it is, and the words it opens on.
    var first = picks[0];
    var card = element('a', 'home-today-card');
    card.href = href(first);
    card.addEventListener('click', onClick(first));
    var faces = element('span', 'home-today-faces');
    (first[7] || []).forEach(function (src) {
      var face = element('img');
      face.src = src;
      face.alt = '';
      face.width = 36;
      face.height = 36;
      faces.appendChild(face);
    });
    card.appendChild(faces);
    card.appendChild(element('span', 'home-today-ep', 'Ep.' + first[2] + ' ' + first[3]));
    card.appendChild(element('strong', 'home-today-question', first[1]));
    var line = element('span', 'home-today-line');
    line.hidden = true;
    card.appendChild(line);
    var length = first[4] && first[5] ? Math.max(1, Math.round((seconds(first[5]) - seconds(first[4])) / 60)) : 0;
    var foot = element('span', 'home-today-foot');
    foot.appendChild(element('span', 'home-today-play', '▶ ここから混ざる'));
    if (first[4]) foot.appendChild(element('span', 'home-today-where', clock(first[4]) + '〜' + (length ? ' · 約' + length + '分' : '')));
    card.appendChild(foot);
    box.appendChild(card);
    openingLine(first, line);

    var list = element('ol', 'home-today-list');
    picks.slice(1).forEach(function (item) {
      var entry = element('li');
      var link = element('a');
      link.href = href(item);
      link.appendChild(element('strong', '', item[1]));
      link.appendChild(element('span', '', 'Ep.' + item[2] + ' ' + item[3]));
      link.addEventListener('click', onClick(item));
      entry.appendChild(link);
      list.appendChild(entry);
    });
    box.appendChild(list);
    box.hidden = false;
  }).catch(function () { /* the rest of the page does not depend on it */ });
}());
