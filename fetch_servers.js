// fetch_servers.js
// Node 18+ (works on GitHub Actions runner)

const fs = require("fs");
const path = require("path");

const PLACE_ID = 109983668079237;
const PAGE_LIMIT = 100;
const OUTPUT_FILE = path.join(__dirname, "server_list.json");
const RAW_DIR = path.join(__dirname, "raw_responses");

if (!fs.existsSync(RAW_DIR)) {
  fs.mkdirSync(RAW_DIR, { recursive: true });
}

// wipe old raw responses
for (const f of fs.readdirSync(RAW_DIR)) {
  try {
    fs.unlinkSync(path.join(RAW_DIR, f));
  } catch (e) {
    console.warn("Could not remove old file:", f, e.message);
  }
}

let pageCount = 0;
const MAX_PAGES = 3;

const doFetch = globalThis.fetch;
if (typeof doFetch !== "function") {
  console.error("fetch is not available in this environment. Node 18+ required.");
  process.exit(1);
}

async function fetchPage(cursor) {
  let url = `https://games.roblox.com/v1/games/${PLACE_ID}/servers/Public?sortOrder=Desc&limit=${PAGE_LIMIT}`;
  if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
  const res = await doFetch(url);
  const text = await res.text();
  if (!res.ok) {
    const preview = text.length > 1000 ? text.slice(0, 1000) + "..." : text;
    console.error("API error response preview:", preview);
    const err = new Error(`Roblox API error: ${res.status}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    console.error("Failed to parse JSON. Preview:", text.slice(0, 200));
    throw e;
  }
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
      try {
        data = await fetchPage(cursor);
      } catch (err) {
        tries++;
        const status = err && err.status;
        if (tries > 6) throw err;
        const baseDelay = status === 429 ? 60 : 10;
        const delay = baseDelay * tries;
        console.warn(
          `Fetch page failed (status ${status || "unknown"}). Retrying after ${delay}s (attempt ${tries})`
        );
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
        if (s && typeof s.id === "string") {
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
      const preview = err.body.slice ? err.body.slice(0, 800) : String(err.body);
      console.error("Response body preview:", preview);
    }
    process.exit(1);
  }
})();
