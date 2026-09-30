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
    var list = element('ol', 'home-today-list');
    picks.forEach(function (item) {
      var entry = element('li');
      var link = element('a');
      link.href = listen + '?c=' + encodeURIComponent(item[0]) + '&from=today';
      link.appendChild(element('strong', '', item[1]));
      link.appendChild(element('span', '', 'Ep.' + item[2] + ' ' + item[3]));
      link.addEventListener('click', function () { track('home_today_click', { clip_id: item[0] }); });
      entry.appendChild(link);
      list.appendChild(entry);
    });
    box.appendChild(list);
    box.hidden = false;
  }).catch(function () { /* the rest of the page does not depend on it */ });
}());
