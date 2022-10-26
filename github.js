/**
 * Build Planet from a github repo which containers latest release file
 * and has an altstore channel file
 */

import { v5 } from "https://deno.land/std@0.159.0/uuid/mod.ts?s=v5.generate";
import { Marked } from "https://deno.land/x/markdown@v2.0.0/mod.ts";
import nunjucks from "https://deno.land/x/nunjucks@3.2.3/mod.js";
import moment from "https://deno.land/x/momentjs@2.29.1-deno/mod.ts";
const { generate } = v5;
import {
  ensureDir,
  copySync,
} from "https://deno.land/std@0.159.0/fs/mod.ts?s=ensureDir";
import { join } from "https://deno.land/std@0.159.0/path/mod.ts?s=joinGlobs";
import { unZipFromURL } from "https://deno.land/x/zip@v1.1.0/unzip.ts?s=unZipFromURL";
import { basename } from "https://deno.land/std@0.97.0/path/win32.ts";
import { writableStreamFromWriter } from "https://deno.land/std@0.159.0/streams/mod.ts";

const NAMESPACE_URL = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const TEMPLATE_URL = "https://github.com/scbrf/tools/raw/main/template.zip";

/**
 * Maintain a planet based on and itunes podcast RSS link
 */

const repos = Deno.args.slice(0, -1);
const target_root = Deno.args[Deno.args.length - 1] || ".";

console.log("github release to Planet convert is running ...");

try {
  Deno.statSync(join(target_root, "template"));
} catch (_) {
  const result = await unZipFromURL(TEMPLATE_URL, target_root);
  console.log("unzip resource return", result);
}
const uuid = (
  await generate(NAMESPACE_URL, new TextEncoder().encode(repos.join(":")))
).toUpperCase();
const ipfsExe = "ipfs";

const releases = [];
for (const repo of repos) {
  const json = await (
    await fetch(`https://api.github.com/repos/${repo}/releases`)
  ).json();
  const release = json[0];
  const id = (
    await generate(NAMESPACE_URL, new TextEncoder().encode(release.node_id))
  ).toUpperCase();
  await ensureDir(join(target_root, uuid, id));
  release.id = id;
  release.repo = repo;
  releases.push(release);
  for (const asset of release.assets) {
    const local = join(
      target_root,
      uuid,
      id,
      basename(asset.browser_download_url)
    );
    if (await fetchTo(asset.browser_download_url, local)) {
      if (local.endsWith(".ipa")) {
        const ipaInfo = await run(
          "npx",
          "app-info-parser",
          "-f",
          local,
          "-o",
          "/dev/stdout"
        );
        const ipa = JSON.parse(ipaInfo);
        release.ipa = ipa;
        const file = await Deno.stat(local);
        release.ipa.size = file.size;
      }
    }
  }
}

async function run() {
  const p = Deno.run({
    cmd: arguments,
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
  });
  await p.status();
  return new TextDecoder().decode(await p.output()).trim();
}

async function ipfscmd() {
  const p = Deno.run({
    cmd: [ipfsExe, ...arguments],
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
  });
  await p.status();
  return new TextDecoder().decode(await p.output()).trim();
}

const ReferenceDate = new Date("2001-01-01").getTime();
function timeIntervalSinceReferenceDate(v) {
  return (new Date(v).getTime() - ReferenceDate) / 1000.0;
}

function timeFromReferenceDate(v) {
  return Math.round(v * 1000 + ReferenceDate);
}

function getEnv() {
  const env = new nunjucks.Environment(
    new nunjucks.FileSystemLoader(join(target_root, "template", "templates")),
    {
      autoescape: false,
    }
  );
  env.addFilter("escapejs", function (str) {
    return str;
  });
  env.addFilter("formatDate", function (str) {
    return moment(timeFromReferenceDate(parseFloat(str))).format(
      "MMM D,YYYY [at] h:mm:ss A"
    );
  });
  env.addFilter("ymd", function (str) {
    return moment(timeFromReferenceDate(parseFloat(str))).format("YYYY-MM-DD");
  });
  return env;
}

async function fetchTo(url, local) {
  const head = await fetch(url, { method: "HEAD" });
  const size = head.headers.get("content-length");
  try {
    const info = Deno.statSync(local);
    if (info.size == size) {
      console.log(`already there,skip download ${local}`);
    }
    return true;
  } catch (_) {
    console.log(`not exist ${local}, do download ...`);
  }
  const MaxRetryTimes = 3;
  for (let i = 0; i < MaxRetryTimes; i++) {
    const fileResponse = await fetch(url);
    if (fileResponse.body) {
      const totalBytes = fileResponse.headers.get("content-length");
      const file = await Deno.open(local, { write: true, create: true });
      const writableStream = writableStreamFromWriter(file);
      await fileResponse.body.pipeTo(writableStream);
      try {
        const info = Deno.statSync(local);
        if (info.size != totalBytes) {
          console.log(
            `fetch size mismatch ${local} want: ${totalBytes} got ${info.size}`
          );
          continue;
        }
        console.log(`donwload done succ ${local}!`);
        return true;
      } catch (_) {
        continue;
      }
    }
  }
  console.log(`fetch fail ${local} after ${MaxRetryTimes} retries!`);
}

const result = JSON.parse(await ipfscmd("key", "list", "--encoding=json"));
let ipns;
if (!result.Keys.filter((a) => a.Name === uuid)[0]) {
  ipns = await ipfscmd("key", "gen", uuid);
} else {
  ipns = result.Keys.filter((a) => a.Name === uuid)[0].Id;
}

await ensureDir(join(target_root, uuid));
const planet = {
  about: `Auto genurated by planetbot!`,
  created: timeIntervalSinceReferenceDate("2022-10-17"),
  id: uuid,
  ipns,
  name: `Releases for ${repos.join(" ")}`,
  templateName: "Plain",
  updated: timeIntervalSinceReferenceDate("2022-10-17"),
  articles: releases.map((e) => ({
    id: e.id,
    title: `${e.repo} ${e.name}`,
    content: e.body,
    attachments: e.assets.map((a) => basename(a.browser_download_url)),
    hasVideo: false,
    hasAudio: false,
    author: e.repo,
    version: e.ipa ? e.ipa.CFBundleShortVersionString : "unknown",
    bundleid: e.ipa ? e.ipa.CFBundleIdentifier : "unknown",
    bundlename: e.ipa ? e.ipa.CFBundleDisplayName : "unknown",
    icon: e.ipa ? e.ipa.icon : "",
    ipaSize: e.ipa ? e.ipa.size : -1,
    created: timeIntervalSinceReferenceDate(e.published_at),
    link: `/${e.id}/`,
  })),
};
await Deno.writeTextFile(
  join(target_root, uuid, "planet.json"),
  JSON.stringify(planet)
);
await copySync(
  join(target_root, "template", "assets"),
  join(target_root, uuid, "assets"),
  {
    overwrite: true,
  }
);

const pageAboutHTML = Marked.parse(planet.about);
const html = getEnv(planet).render("index.html", {
  assets_prefix: "./",
  page_title: planet.name,
  has_avatar: false,
  articles: planet.articles,
  page_description: pageAboutHTML.content,
  page_description_html: pageAboutHTML.content,
  build_timestamp: new Date("2022-10-17").getTime(),
});
await Deno.writeTextFile(join(target_root, uuid, "index.html"), html);

for (const article of planet.articles) {
  const content_html = Marked.parse(article.content);
  const html = getEnv(planet).render("blog.html", {
    planet,
    planet_ipns: planet.ipns,
    assets_prefix: "../",
    article: {
      ...article,
      author: "",
    },
    article_title: article.title,
    page_title: article.title,
    content_html: content_html.content,
    build_timestamp: new Date("2022-10-17").getTime(),
  });
  await Deno.writeTextFile(
    join(target_root, uuid, article.id, "index.html"),
    html
  );
}

const cid = await ipfscmd(
  "add",
  "-r",
  join(target_root, uuid),
  "--cid-version=1",
  "--quieter"
);
await ipfscmd("name", "publish", `--key=${planet.id}`, `/ipfs/${cid}`);
console.log(`done to ${planet.ipns} cid is ${cid}`);
