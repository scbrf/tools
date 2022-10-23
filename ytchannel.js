import { parseFeed } from "https://deno.land/x/rss@0.5.6/mod.ts";
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

const NAMESPACE_URL = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const TEMPLATE_URL = "https://github.com/scbrf/tools/raw/main/template.zip";

/**
 * Maintain a planet based on and itunes podcast RSS link
 */

const url = Deno.args[0];
const target_root = Deno.args[1] || ".";

console.log("Youtube channel to Planet convert is running ...");

try {
  Deno.statSync(join(target_root, "template"));
} catch (_) {
  const result = await unZipFromURL(TEMPLATE_URL, target_root);
  console.log("unzip resource return", result);
}

const response = await fetch(url);
const xml = await response.text();
const feed = await parseFeed(xml);
const uuid = (
  await generate(NAMESPACE_URL, new TextEncoder().encode(feed.id))
).toUpperCase();
const ipfsExe = "ipfs";

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

async function ytDown(url, local) {
  try {
    Deno.statSync(local);
    console.log(`local file ${local} exists return!`);
    return;
  } catch {
    console.log(`local file ${local} not exists!`);
  }
  const p = Deno.run({
    cmd: ["yt-dlp", url, "-o", local, "-f", "mp4"],
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
  });
  await p.status();
  console.log(`file ${local} download succ!`);
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
  about: feed.title.value,
  created: timeIntervalSinceReferenceDate("2022-10-17"),
  id: uuid,
  ipns,
  name: feed.title.value,
  templateName: "Plain",
  updated: timeIntervalSinceReferenceDate("2022-10-17"),
  articles: await Promise.all(
    feed.entries.map(async (e) => {
      const id = (
        await generate(NAMESPACE_URL, new TextEncoder().encode(e.id))
      ).toUpperCase();
      await ensureDir(join(target_root, uuid, id));
      const local = join(target_root, uuid, id, "video.mp4");
      await ytDown(e.links[0].href, local);
      return {
        id,
        title: e.title.value,
        content: e["media:group"]["media:description"]
          ? e["media:group"]["media:description"].value
          : "",
        attachments: [],
        hasVideo: true,
        hasAudio: false,
        videoFilename: "video.mp4",
        created: timeIntervalSinceReferenceDate(e.published),
        link: `/${id}/`,
      };
    })
  ),
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
  build_timestamp: new Date().getTime(),
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
    build_timestamp: new Date().getTime(),
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
