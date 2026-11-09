// Where the leaf list goes. Hosting is not decided yet, so the default hands the file to the sender.

import type { LeafList } from '../services';

export interface LeafPublisher {
  /** Returns where the claim app will look for the file, and what the sender must do (if anything). */
  publish(file: LeafList): Promise<{ expectedUrl: string | null; todo: string | null }>;
}

export function saveFile(name: string, text: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Default: download `<campaign_id>.json` and say where it must be served. */
export const downloadPublisher = (leavesBaseUrl: string | undefined, save = saveFile): LeafPublisher => ({
  async publish(file) {
    const name = `${file.campaign_id}.json`;
    save(name, JSON.stringify(file, null, 2));
    const expectedUrl = leavesBaseUrl ? `${leavesBaseUrl}/${name}` : null;
    return {
      expectedUrl,
      todo: expectedUrl
        ? `Upload ${name} so it is served at ${expectedUrl}. Recipients cannot claim until it is.`
        : `Serve ${name} at <PUBLIC_LEAVES_URL>/${name}; PUBLIC_LEAVES_URL is not configured on this site.`,
    };
  },
});
