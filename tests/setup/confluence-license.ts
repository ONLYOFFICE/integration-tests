const TIMEBOMB_LICENSES_URL =
  'https://developer.atlassian.com/platform/marketplace/timebomb-licenses-for-testing-server-apps/';
const LICENSE_LABEL = '10 user Confluence Data Center license, expires in 3 hours';
// Literal backslash+n — that's how the license string is wrapped in the page's JSON payload
// (not an actual newline, but two characters: "\" and "n")
const NL = '\\n';

// Fallback copy in case the page is unavailable or Atlassian changed the markup — taken
// from there manually. Not tied to a date: the 3-hour validity period starts from when
// Confluence validates it, not from the copy's publish/capture date.
const FALLBACK_LICENSE_KEY =
  'AAABtQ0ODAoPeNp9kV9v0zAUxd/9Ka7EWyWnTmESqxSJNQlbxdJUTbLBgAfXuV0NqR3ZTqHfHjdpYVSCB7/4/jm/e86rR6wh4wdgE2Bsyq6nLITbrIQJC9+SRbdbo8k3lUVjo5CRWCvHhVvwHUZ1y42RdvuOu4ZbK7kKhN4RodUm8D1yj5EzHZJlZ8SWW0y4w+i4lrIrykJyLwUqi+WhxX5fnGdZuornN/fnUvqzlebQzy1f353F04zL5l/qBZo9mnkSzW6vS/qxenhDPzw93dEZCx8HtBeyLyX7mpfiMSqHZkAvurUVRrZOajX8jEajRV7S9/mKLld5UsXlPF/Qqkh9IYoNetYa1gdwW4STEqRK6BoNtEZ/Q+Hg89a59st0PH7WwV/042aYoDhMfA0g0aC0g1paZ+S6c+g3SwtOg+is0zufS0C8IZ5ZcSUuLfNU8Sq9KdOEzj4dEf8XWuG4+X36Cd47WanvSv9QpEgXkX/0ijGSm2eupOW9MQnusdGtv7BE685nk94NX7/M/TKFy/BPJjz4047bJyTBPyH0CqcO2GgDvG2hPgNYku550w1YG954il/X0fxXMC0CFQCRUd9kwqDYeFIFJyQmlQPeMMYDLQIUYpH3kyyXea6e1PzAN2rpSuuUl4M=X02l1';

/**
 * The license key on this page lives inside a JSON payload (not in the rendered
 * <pre>/<code>), as "...label**\n\n```bash\n<key lines, separated by \n>\n```...".
 * We look for literal \n separators directly instead of regex — on this specific
 * payload a regex with `\\n` in the pattern behaved unreliably (matched on hand-crafted
 * strings but not on the real file).
 */
function extractLicenseKey(html: string): string {
  const labelIndex = html.indexOf(LICENSE_LABEL);
  if (labelIndex === -1) {
    throw new Error(`could not find "${LICENSE_LABEL}" on the page`);
  }

  const chunk = html.slice(labelIndex, labelIndex + 2000);
  const fenceStart = chunk.indexOf('```', chunk.indexOf(NL + NL));
  if (fenceStart === -1) {
    throw new Error('could not find the start of the key block near the license heading');
  }

  const afterFence = chunk.slice(fenceStart);
  const bodyStart = afterFence.indexOf(NL) + NL.length; // end of the ``` bash / ```bash line
  const bodyEnd = afterFence.indexOf(NL + '```', bodyStart);
  if (bodyStart === -1 || bodyEnd === -1) {
    throw new Error('could not find the end of the key block');
  }

  const key = afterFence.slice(bodyStart, bodyEnd).split(NL).join('');
  if (!key.startsWith('AAAB')) {
    throw new Error('the result does not look like a license key — the page markup may have changed');
  }
  return key;
}

/**
 * Fetches the current public "timebomb" Confluence Data Center license from the
 * Atlassian page, so we don't depend on a hardcoded copy if Atlassian ever replaces
 * the key. On any error (network unavailable, page markup changed) — falls back to
 * the last known copy without failing the stack startup.
 */
export async function getConfluenceLicenseKey(): Promise<string> {
  if (process.env.CONFLUENCE_LICENSE_KEY) {
    return process.env.CONFLUENCE_LICENSE_KEY;
  }

  try {
    const response = await fetch(TIMEBOMB_LICENSES_URL, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const key = extractLicenseKey(await response.text());
    console.log('[confluence] License fetched from the Atlassian page');
    return key;
  } catch (error) {
    console.warn(
      `[confluence] Failed to fetch the license from the Atlassian page (${
        error instanceof Error ? error.message : String(error)
      }) — using the last known copy`,
    );
    return FALLBACK_LICENSE_KEY;
  }
}
