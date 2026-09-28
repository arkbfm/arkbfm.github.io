(function () {
  var article = document.querySelector('.article .markdown');
  if (!article) return;

  var player = document.getElementById('episode-player');
  var apiElement = document.getElementById('episode-spotify-api');
  var fallback = document.getElementById('episode-spotify-fallback');
  var controller = null;
  var playButtons = [];
  var headings = Array.prototype.filter.call(article.querySelectorAll('h2'), function (heading) {
    return /^\d{1,2}:\d{2}:\d{2}\s/.test(heading.textContent.trim());
  });

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

    headings.forEach(function (heading, index) {
      var label = heading.textContent.trim();
      var match = label.match(/^(\d{1,2}):(\d{2}):(\d{2})\s+(.+)$/);
      if (!match) return;
      if (!heading.id) heading.id = 'chapter-' + (index + 1);
      var seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
      var item = document.createElement('li');
      var link = document.createElement('a');
      link.href = '#' + heading.id;
      var time = document.createElement('time');
      time.textContent = match[1] + ':' + match[2] + ':' + match[3];
      link.appendChild(time);
      link.appendChild(document.createTextNode(match[4]));
      item.appendChild(link);

      if (apiElement) {
        var button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'ここから聴く';
        button.setAttribute('aria-label', time.textContent + ' ' + match[4] + ' から聴く');
        button.disabled = true;
        button.addEventListener('click', function () {
          if (!controller) return;
          // Loading with startAt preserves the chapter position when playback starts.
          // Calling seek before the first play is ignored by Spotify's Embed.
          controller.loadEntity('spotify:episode:' + apiElement.dataset.spotifyId, false, seconds);
          controller.play();
          player.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        item.appendChild(button);
        playButtons.push(button);
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
