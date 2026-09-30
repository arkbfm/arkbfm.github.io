// Cycles each card's questions like a flip board, one card at a time so the page never flickers all at once.
(function () {
  var boxes = Array.prototype.slice.call(document.querySelectorAll('[data-question-flip]')).filter(function (box) {
    return box.querySelectorAll('.ep-card-q-item').length > 1;
  });
  if (!boxes.length) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var visible = new Set();
  if ('IntersectionObserver' in window) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) visible.add(entry.target);
        else visible.delete(entry.target);
      });
    });
    boxes.forEach(function (box) { observer.observe(box); });
  } else {
    boxes.forEach(function (box) { visible.add(box); });
  }

  var paused = new Set();
  boxes.forEach(function (box) {
    var card = box.closest('.ep-card') || box;
    card.addEventListener('mouseenter', function () { paused.add(box); });
    card.addEventListener('mouseleave', function () { paused.delete(box); });
    card.addEventListener('focusin', function () { paused.add(box); });
    card.addEventListener('focusout', function () { paused.delete(box); });
  });

  function flip(box) {
    var items = box.querySelectorAll('.ep-card-q-item');
    var current = box.querySelector('.ep-card-q-item.is-active');
    var index = Array.prototype.indexOf.call(items, current);
    var next = items[(index + 1) % items.length];
    current.classList.remove('is-active');
    current.classList.add('is-leaving');
    next.classList.add('is-active');
    // The box links to the showing question's answer, so a click always plays what the reader just read.
    if (next.hasAttribute('data-href')) box.href = next.getAttribute('data-href');
    setTimeout(function () { current.classList.remove('is-leaving'); }, 450);
  }

  var turn = 0;
  setInterval(function () {
    if (document.hidden) return;
    var candidates = boxes.filter(function (box) { return visible.has(box) && !paused.has(box); });
    if (!candidates.length) return;
    flip(candidates[turn % candidates.length]);
    turn += 1;
  }, 1800);
}());
