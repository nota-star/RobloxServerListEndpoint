// fetch_servers.js
// Node 18+ (works on GitHub Actions runner)
// Uses proxies from proxy_output/proxies_good.txt (one per line) if available.
// Uses a proxy for pages 3,6,9,... i.e. when (pageIndex+1) % 3 === 0
// MAX_PAGES and PAGE_LIMIT can be set via env vars.

const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const util = require("util");
const execP = util.promisify(exec);

const PLACE_ID = 109983668079237;
const PAGE_LIMIT = parseInt(process.env.PAGE_LIMIT || "100", 10);
const OUTPUT_FILE = path.join(__dirname, "server_list.json");
const RAW_DIR = path.join(__dirname, "raw_responses");
if (!fs.existsSync(RAW_DIR)) fs.mkdirSync(RAW_DIR, { recursive: true });

let pageCount = 0;
const MAX_PAGES = parseInt(process.env.MAX_PAGES || "20", 10); // default 20

// Load proxies from proxy_output/proxies_good.txt (if exists)
const PROXY_FILE = path.join(__dirname, "proxy_output", "proxies_good.txt");
const PROXIES = (() => {
  try {
    if (fs.existsSync(PROXY_FILE)) {
      const txt = fs.readFileSync(PROXY_FILE, "utf8");
      return txt
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(Boolean);
    }
  } catch (e) {
    console.warn("Failed reading proxies:", e.message);
  }
  return [];
})();

console.log(`Loaded ${PROXIES.length} validated proxies (will use one every 3rd page).`);

const doFetch = globalThis.fetch;
if (typeof doFetch !== "function") {
  console.error("fetch is not available in this environment. Node 18+ required.");
  process.exit(1);
}

// Use curl for proxied fetches (supports http/https/socks5)
async function fetchWithCurl(url, proxy) {
  const proxyArg = proxy ? `--proxy '${proxy}'` : "";
  const cmd = `curl -s --fail --max-time 30 ${proxyArg} "${url}"`;
  try {
    const { stdout } = await execP(cmd, { timeout: 35 * 1000 });
    return stdout;
  } catch (err) {
    const stdout = err.stdout || "";
    const stderr = err.stderr || "";
    const message = `curl failed: ${err.code || "unknown"}. stderr: ${stderr.slice(0,500)}`;
    const e = new Error(message);
    e.stdout = stdout;
    throw e;
  }
}

async function fetchPage(cursor, proxy) {
  let url = `https://games.roblox.com/v1/games/${PLACE_ID}/servers/Public?sortOrder=Asc&limit=${PAGE_LIMIT}&excludeFullGames=true`;
  if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;

  if (proxy) {
    const text = await fetchWithCurl(url, proxy);
    return JSON.parse(text);
  }

  const res = await doFetch(url);
  const text = await res.text();
  if (!res.ok) {
    const preview = text.length > 1000 ? text.slice(0, 1000) + "..." : text;
    const err = new Error(`Roblox API error: ${res.status}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return JSON.parse(text);
}

function writeIfDifferent(filepath, contentStr) {
  if (fs.existsSync(filepath)) {
    const existing = fs.readFileSync(filepath, "utf8");
    if (existing === contentStr) {
      console.log("No change to", filepath, "- skipping write.");
      return false;
    }
  }
  fs.writeFileSync(filepath, contentStr, "utf8");
  return true;
}

(async () => {
  try {
    pageCount = 0;
    const servers = [];
    let cursor = null;
    let tries = 0;

    while (true) {
      let data;
      // Decide whether to use a proxy for this page: use proxy on pages 3,6,9,... (1-indexed)
      const shouldProxy = PROXIES.length > 0 && ((pageCount + 1) % 3 === 0);
      const proxy = shouldProxy ? PROXIES[Math.floor(pageCount / 3) % PROXIES.length] : null;

      try {
        console.log(`Fetching page ${pageCount + 1}${proxy ? ` via proxy ${proxy}` : ""}`);
        data = await fetchPage(cursor, proxy);
      } catch (err) {
        tries++;
        const status = err && err.status;
        if (tries > 6) throw err;
        const baseDelay = status === 429 ? 60 : 10;
        const delay = baseDelay * tries;
        console.warn(`Fetch page failed (status ${status || "unknown"}). Retrying after ${delay}s (attempt ${tries})`);
        await new Promise(r => setTimeout(r, delay * 1000));
        continue;
      }

      // Save raw
      try {
        const rawFilename = path.join(RAW_DIR, `page_${pageCount + 1}.json`);
        fs.writeFileSync(rawFilename, JSON.stringify(data, null, 2), "utf8");
        console.log(`Saved raw response to ${rawFilename}`);
      } catch (e) {
        console.warn("Failed saving raw response:", e.message);
      }

      tries = 0;
      const list = Array.isArray(data.data) ? data.data : [];

      // Push all servers
      for (const s of list) {
        if (s && typeof s.id === "string" && s.playing < s.maxPlayers) {
          servers.push({
            id: s.id,
            playing: s.playing || 0,
            maxPlayers: s.maxPlayers || 0,
            created: s.created || null
          });
        }
      }

      pageCount++;
      if (pageCount >= MAX_PAGES) {
        console.log("Reached MAX_PAGES:", MAX_PAGES);
        break;
      }

      cursor = data.nextPageCursor;
      if (!cursor) {
        console.log("No nextPageCursor, stopping pagination.");
        break;
      }

      // polite short pause
      await new Promise(r => setTimeout(r, 500));
    }

    const payload = {
      fetched_at: Math.floor(Date.now() / 1000),
      placeId: Number(PLACE_ID),
      servers: servers
    };

    const outStr = JSON.stringify(payload, null, 2);
    const wrote = writeIfDifferent(OUTPUT_FILE, outStr);
    if (wrote) {
      console.log(`Wrote ${servers.length} servers to ${OUTPUT_FILE}`);
    } else {
      console.log("server_list.json unchanged.");
    }

    process.exit(0);
  } catch (err) {
    console.error("Fatal:", err && err.message || err);
    if (err && err.body) {
      const preview = err.body && err.body.slice ? err.body.slice(0, 800) : String(err.body);
      console.error("Response body preview:", preview);
    }
    process.exit(1);
  }
})();
