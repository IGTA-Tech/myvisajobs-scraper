import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

/**
 * Generic browser-based fetcher for myvisajobs pages that require a real
 * Chromium fingerprint (TLS / HTTP/2 / cookie rolling). Native fetch + a
 * static cookie returns degraded "logged-in but no premium" content for
 * /h1b-visa/lcafull.aspx and similar premium-gated pages, even with the
 * full Chrome 147 header set, because myvisajobs gates on browser-only
 * signals we can't replicate from server-side fetch.
 *
 * One session per task run. Cookies are loaded from MYVISAJOBS_COOKIE on
 * open and Playwright handles all rolling Set-Cookie automatically.
 */

export type BrowserSession = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  fetchedCount: number;
};

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

const PAGE_RECYCLE_EVERY = 10;

function parseCookieHeader(cookie: string, domain = ".myvisajobs.com") {
  return cookie
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf("=");
      const name = i === -1 ? pair : pair.slice(0, i);
      const value = i === -1 ? "" : pair.slice(i + 1);
      return {
        name,
        value,
        domain,
        path: "/",
        secure: true,
        httpOnly: false,
        sameSite: "Lax" as const,
      };
    });
}

export async function openMyvisajobsSession(): Promise<BrowserSession> {
  const cookie = process.env.MYVISAJOBS_COOKIE;
  if (!cookie) {
    throw new Error("MYVISAJOBS_COOKIE is not set");
  }

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1366, height: 800 },
  });
  await context.addCookies(parseCookieHeader(cookie));
  const page = await context.newPage();

  return { browser, context, page, fetchedCount: 0 };
}

export async function closeMyvisajobsSession(session: BrowserSession): Promise<void> {
  await session.page.close().catch(() => {});
  await session.context.close().catch(() => {});
  await session.browser.close().catch(() => {});
}

/**
 * Navigate to a URL and return the rendered HTML. Recycles the page every
 * PAGE_RECYCLE_EVERY navigations to keep DOM/JS heap from accumulating.
 * Cookies persist on the BrowserContext so a fresh page stays authenticated.
 */
export async function fetchPageInBrowser(
  session: BrowserSession,
  url: string,
): Promise<string> {
  if (session.fetchedCount > 0 && session.fetchedCount % PAGE_RECYCLE_EVERY === 0) {
    await session.page.close().catch(() => {});
    session.page = await session.context.newPage();
  }
  await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  const html = await session.page.content();
  session.fetchedCount++;
  return html;
}
