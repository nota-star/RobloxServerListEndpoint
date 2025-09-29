// fetch_proxies.js
// Node 18+ on GitHub Actions. Minimal deps

const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const util = require("util");
const execP = util.promisify(exec);

const OUT_DIR = path.join(__dirname, "proxy_output");
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const SOURCES = [
  "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all",
  "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=https&timeout=10000&country=all&ssl=all&anonymity=all",
  "https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt",
  "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
  "https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks5.txt"
];

// timeout for curl test (seconds)
const CURL_TIMEOUT = 8;
// concurrency when validating proxies
const CONCURRENCY = 12;

async function runCmd(cmd) {
  try {
    const { stdout } = await execP(cmd, { timeout: (CURL_TIMEOUT + 3) * 1000 });
    return stdout.trim();
  } catch (err) {
    return { error: err };
  }
}

function normalizeLine(line) {
  // Remove whitespace, comments
  line = line.trim();
  if (!line) return null;
  if (line.startsWith("#")) return null;
  // If line already has scheme, keep it
  if (line.match(/^[a-zA-Z]+:\/\//)) return line;
  // If it looks like host:port
  if (line.match(/^[0-9.]+:\d+$/) || line.match(/^[\w\.-]+:\d+$/)) {
    return "http://" + line; // default to http if unknown
  }
  // If other formats, ignore
  return null;
}

async function fetchSource(url) {
  try {
    const res = await fetch(url, { method: "GET", redirect: "follow", timeout: 15000 });
    if (!res.ok) {
      console.warn(`Source ${url} returned ${res.status}`);
      return "";
    }
    return await res.text();
  } catch (e) {
    console.warn(`Failed to fetch ${url}: ${e.message}`);
    return "";
  }
}

async function validateProxy(proxyUrl) {
  const proxyArg = `--proxy '${proxyUrl}'`;
  const cmd = `curl -s --max-time ${CURL_TIMEOUT} ${proxyArg} "https://api.ipify.org?format=json"`;
  try {
    const { stdout } = await execP(cmd, { timeout: (CURL_TIMEOUT + 2) * 1000 });
    if (!stdout) return false;
    // quick JSON check
    try {
      const obj = JSON.parse(stdout);
      return !!obj.ip;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

async function main() {
  const all = new Set();

  console.log("Fetching sources...");
  await Promise.all(SOURCES.map(async (src) => {
    const txt = await fetchSource(src);
    if (!txt) return;
    const lines = txt.split(/\r?\n/);
    for (let l of lines) {
      const norm = normalizeLine(l);
      if (norm) all.add(norm);
    }
  }));

  // set -> array
  const candidates = Array.from(all).slice(0, 750); // cap
  console.log(`Collected ${candidates.length} candidate proxies.`);

  // Validate
  const good = [];
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= candidates.length) break;
      const p = candidates[i];
      process.stdout.write(`\rValidating ${i + 1}/${candidates.length} `);
      try {
        const ok = await validateProxy(p);
        if (ok) {
          console.log(`\nOK: ${p}`);
          good.push(p);
        }
      } catch (e) {
        // ignore
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, () => worker());
  await Promise.all(workers);
  console.log(`\nValidation complete. Good proxies: ${good.length}`);

  fs.writeFileSync(path.join(OUT_DIR, "proxies_all.txt"), candidates.join("\n"), "utf8");
  fs.writeFileSync(path.join(OUT_DIR, "proxies_good.txt"), good.join("\n"), "utf8");

  console.log("Top good proxies (first 20):");
  good.slice(0, 20).forEach(p => console.log("  " + p));
}

main().catch(err => {
  console.error("Fatal in fetch_proxies:", err && err.stack || err);
  process.exit(1);
});
