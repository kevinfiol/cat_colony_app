const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

// "5 minutes ago" for recent times, otherwise a date in the viewer's own time zone.
function friendly(date) {
  const minutes = Math.round((date - Date.now()) / 60000);
  if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relative.format(hours, 'hour');
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// The database stores UTC times like "2026-11-08 14:22:01"; show them in local time.
function localTimes(root = document) {
  for (const time of root.querySelectorAll('time[datetime]')) {
    const date = new Date(time.dateTime.replace(' ', 'T') + 'Z');
    if (Number.isNaN(date.getTime())) continue;
    time.title = date.toLocaleString();
    time.textContent = friendly(date);
  }
}

localTimes();

// Asks before a button marked data-confirm submits, for actions that can't be undone.
document.addEventListener('submit', (event) => {
  const message = event.submitter?.dataset.confirm;
  if (message && !confirm(message)) event.preventDefault();
});

// Admin pages share one update stream; volunteer chats never request this feed.
const notifications = document.getElementById('notifications');
const adminEvents = notifications ? new EventSource('/admin/events') : null;

if (notifications) {
  const bell = notifications.querySelector('summary');
  const panel = document.getElementById('notifications-panel');
  const content = document.getElementById('notifications-content');
  const error = document.getElementById('notifications-error');
  let refreshing = false;
  let queued = false;

  async function refreshNotifications() {
    queued = true;
    if (refreshing) return;
    refreshing = true;
    try {
      // An update arriving during a fetch must trigger another fetch afterwards.
      while (queued) {
        queued = false;
        const response = await fetch('/admin/notifications', { cache: 'no-store' });
        if (!response.ok) throw new Error(response.statusText);
        const page = new DOMParser().parseFromString(await response.text(), 'text/html');
        const next = page.getElementById('notifications');
        const focusedId = content.contains(document.activeElement)
          ? document.activeElement.id
          : null;
        const scrollTop = content.scrollTop;

        bell.setAttribute('aria-label', next.querySelector('summary').getAttribute('aria-label'));
        const count = notifications.querySelector('.notification-count');
        const nextCount = next.querySelector('.notification-count');
        count.textContent = nextCount.textContent;
        count.hidden = nextCount.hidden;
        panel.querySelector('.notifications-header p').textContent =
          next.querySelector('.notifications-header p').textContent;
        content.innerHTML = next.querySelector('#notifications-content').innerHTML;
        localTimes(content);
        // Preserve keyboard focus and scroll while the list updates in place.
        if (focusedId) (document.getElementById(focusedId) || bell).focus({ preventScroll: true });
        content.scrollTop = scrollTop;
        error.hidden = true;
      }
    } catch {
      error.hidden = false;
    } finally {
      refreshing = false;
    }
  }

  adminEvents.addEventListener('message', refreshNotifications);
  adminEvents.addEventListener('open', refreshNotifications);
  adminEvents.addEventListener('error', () => (error.hidden = false));
  notifications.addEventListener('toggle', () => {
    if (notifications.open) refreshNotifications();
  });
  window.addEventListener('online', refreshNotifications);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshNotifications();
  });
  document.addEventListener('click', (event) => {
    if (!notifications.contains(event.target) || event.target.closest('.notifications-panel a')) {
      notifications.open = false;
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && notifications.open) {
      notifications.open = false;
      bell.focus();
      event.preventDefault();
    }
  });
  notifications.addEventListener('focusout', (event) => {
    if (event.relatedTarget && !notifications.contains(event.relatedTarget))
      notifications.open = false;
  });
}
