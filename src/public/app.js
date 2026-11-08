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
