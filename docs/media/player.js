const video = document.querySelector('#film');
const chapters = [...document.querySelectorAll('[data-time]')];
const formatTime = value => {
  const seconds = Number.isFinite(value) ? value : 0;
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
};
function updateProgress() {
  document.querySelector('#time').textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration || 48)}`;
  chapters.forEach((button, index) => {
    const start = Number(button.dataset.time);
    const end = index + 1 < chapters.length ? Number(chapters[index + 1].dataset.time) : Infinity;
    button.setAttribute('aria-current', String(video.currentTime >= start && video.currentTime < end));
  });
}
chapters.forEach(button => {
  button.addEventListener('click', () => {
    video.currentTime = Number(button.dataset.time);
    video.play().catch(() => {});
    updateProgress();
  });
});
document.querySelector('#speed').addEventListener('change', event => {
  video.playbackRate = Number(event.target.value);
});
video.addEventListener('timeupdate', updateProgress);
video.addEventListener('loadedmetadata', updateProgress);
updateProgress();
document.addEventListener('keydown', event => {
  if (event.target.closest('button,input,select,video,a')) return;
  if (event.code === 'Space') {
    event.preventDefault();
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  } else if (event.code === 'ArrowRight') {
    event.preventDefault();
    video.currentTime = Math.min(video.duration || 48, video.currentTime + 5);
  } else if (event.code === 'ArrowLeft') {
    event.preventDefault();
    video.currentTime = Math.max(0, video.currentTime - 5);
  } else if (event.key.toLowerCase() === 'f') {
    video.requestFullscreen?.().catch(() => {});
  }
});
