const TIMEBOMB_LICENSES_URL =
  'https://developer.atlassian.com/platform/marketplace/timebomb-licenses-for-testing-server-apps/';
const LICENSE_LABEL = '10 user Jira Software Data Center license, expires in 3 hours';
// Literal backslash+n — that's how the license string is wrapped in the page's JSON payload
// (not an actual newline, but two characters: "\" and "n")
const NL = '\\n';

// Fallback copy in case the page is unavailable or Atlassian changed the markup — taken
// from there manually. Not tied to a date: the 3-hour validity period starts from when
// Jira validates it, not from the copy's publish/capture date.
const FALLBACK_LICENSE_KEY =
  'AAAB8w0ODAoPeNp9Uk2P2jAQvedXWOoNydmELVKLFKlL4u7SLglKQj+27cEkA3gb7GjssMu/rwnQls9DDvHMvPfmvXmTN0BGfE08n3jdftfv927J/SgnXc9/58wRQC5UXQO6j6IAqYGVwgglAxbnLB2nw4w5cbOcAiaziQbUge85oZKGFybmSwjKmiMKvfjATcW1Fly6hVo64waLBdcQcQPBhot6Per5zo4lX9fQjofJaMTScHj3uC+x11rgup0b3z7sudiIi+oSWQa4AhxGweD+fU6/Tb68pZ+fnh7owPO/Os8CuVujKpvCuJsfqtXMvHAE1+KKFQQGG3A+2cp412XJeQjSHLVkzVQXKOrWn/bljH/nNmslXPa30+nESU4/Jikdp0k0CfNhEtNJxmwhCBGsFSWZrolZANmhECYLVQISu9gzFIb8WBhT/+zf3MyVe2DOTbWdoLCd+OWSSBGpDCmFNiimjQGLLDQxihSNNmppU3Yd67c0ILksjhOxqsKU3eUsooPvG4kXUrli/MlF7dayEU7kb6lepJOxOLAf7XneFmkfCuCp95nh+LdwhfegL8E5l0LzNo4IVlApi0Vy0GZvs9O6b+vHZxzBv0toB3Yuk5lCwuualHs8fSD0/3NqdZ48nBd+5bjYilfNdokZr6zmP7TmY5YwLAIUNq8MbmR8GfaV9ulfLz1K+3g9j1YCFDeq7aYROMQbwMIvHimNt7/bJCCIX02nj';

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
 * Fetches the current public "timebomb" Jira Software Data Center license from the
 * Atlassian page, so we don't depend on a hardcoded copy if Atlassian ever replaces
 * the key. On any error (network unavailable, page markup changed) — falls back to
 * the last known copy without failing the stack startup.
 */
export async function getJiraLicenseKey(): Promise<string> {
  if (process.env.JIRA_LICENSE_KEY) {
    return process.env.JIRA_LICENSE_KEY;
  }

  try {
    const response = await fetch(TIMEBOMB_LICENSES_URL, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const key = extractLicenseKey(await response.text());
    console.log('[jira] License fetched from the Atlassian page');
    return key;
  } catch (error) {
    console.warn(
      `[jira] Failed to fetch the license from the Atlassian page (${
        error instanceof Error ? error.message : String(error)
      }) — using the last known copy`,
    );
    return FALLBACK_LICENSE_KEY;
  }
}
