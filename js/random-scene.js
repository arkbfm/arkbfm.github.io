(function () {
  var button = document.querySelector('[data-random-scene]');
  if (!button || !window.fetch) return;

  var root = button.getAttribute('data-index').replace(/\/episode-index\.json$/, '');

  button.addEventListener('click', function (event) {
    event.preventDefault();
    button.classList.add('is-rolling');
    fetch(button.getAttribute('data-index'))
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
