(function () {
  var resultsContainer = document.getElementById('search-results');
  var params = new URLSearchParams(window.location.search);
  var query = (params.get('q') || '').trim();

  if (!query) {
    resultsContainer.innerHTML = '<p class="search-message">検索キーワードを入力してください。</p>';
    return;
  }

  // Reflect query in the header search input if present
  var headerInput = document.querySelector('.header-search-input');
  if (headerInput) {
    headerInput.value = query;
  }

  document.title = '「' + query + '」の検索結果';

  var searchJsonUrl = document.currentScript
    ? document.currentScript.src.replace('/js/search.js', '/search.json')
    : '/search.json';

  fetch(searchJsonUrl)
    .then(function (response) { return response.json(); })
    .then(function (posts) {
      var lowerQuery = query.toLowerCase();
      var results = posts.filter(function (post) {
        return (post.title && post.title.toLowerCase().includes(lowerQuery)) ||
               (post.description && post.description.toLowerCase().includes(lowerQuery)) ||
               (post.content && post.content.toLowerCase().includes(lowerQuery));
      });

      if (results.length === 0) {
        resultsContainer.innerHTML = '<p class="search-message">「' + escapeHtml(query) + '」に一致するエピソードは見つかりませんでした。</p>';
        return;
      }

      var html = '';
      results.forEach(function (post) {
        html += '<article class="list-group-element">' +
          '<h1 class="list-group-element-heading"><a href="' + escapeHtml(post.url) + '">' + escapeHtml(post.title) + '</a></h1>' +
          '<footer class="list-group-element-footer">' + escapeHtml(post.date) + '</footer>' +
          '<p>' + escapeHtml(post.description) + '</p>' +
          '</article>';
      });

      resultsContainer.innerHTML = html;
    })
    .catch(function () {
      resultsContainer.innerHTML = '<p class="search-message">検索データの読み込みに失敗しました。</p>';
    });

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
})();
