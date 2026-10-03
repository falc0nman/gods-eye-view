/** Fixed upstream request URLs; callers own validation, credentials and transport. */
export function celestrakTleUrl(group) {
  const url = new URL('https://celestrak.org/NORAD/elements/gp.php');
  url.searchParams.set('GROUP', group);
  url.searchParams.set('FORMAT', 'tle');
  return url;
}
