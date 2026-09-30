(function () {
  var button = document.querySelector('[data-random-scene]');
  if (!button || !window.fetch) return;

  // site.github.url is http://, so fetching it from the https page is blocked as mixed content.
  // Use only the path so the index and the episode page share the current page's origin.
  var indexPath = new URL(button.getAttribute('data-index'), window.location.href).pathname;
  var root = indexPath.replace(/\/episode-index\.json$/, '');

  button.addEventListener('click', function (event) {
    event.preventDefault();
    button.classList.add('is-rolling');
    fetch(indexPath)
      .then(function (response) { return response.json(); })
      .then(function (episodes) {
        var episode = episodes[Math.floor(Math.random() * episodes.length)];
        var scene = episode.scenes[Math.floor(Math.random() * episode.scenes.length)];
        window.location.href = root + '/episode/' + encodeURIComponent(episode.slug) + '?t=' + scene[0];
      })
      .catch(function () {
        window.location.href = button.href;
      });
  });
}());
