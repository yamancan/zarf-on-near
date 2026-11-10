// Files the sender saves locally (recovery file, link list). Nothing is published: each claim link
// carries its own leaf and proof (spec "claim link").

export function saveFile(name: string, text: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
