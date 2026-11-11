import type { HandleClientError } from '@sveltejs/kit';

// A mistyped URL is a normal outcome with its own page (+error.svelte), not a console error.
export const handleError: HandleClientError = ({ error, status, message }) => {
  if (status !== 404) console.error(error);
  return { message };
};
