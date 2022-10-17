import { parseFeed } from "https://deno.land/x/rss@0.5.6/mod.ts";
import { v5 } from "https://deno.land/std@0.159.0/uuid/mod.ts?s=v5.generate";
import { Marked } from "https://deno.land/x/markdown@v2.0.0/mod.ts";
import nunjucks from "https://deno.land/x/nunjucks@3.2.3/mod.js";
import moment from "https://deno.land/x/momentjs@2.29.1-deno/mod.ts";
import { resize } from "https://deno.land/x/deno_image@0.0.4/mod.ts";
import { writableStreamFromWriter } from "https://deno.land/std@0.159.0/streams/mod.ts";
const { generate } = v5;
import {
  existsSync,
  ensureDir,
  copySync,
} from "https://deno.land/std@0.159.0/fs/mod.ts?s=ensureDir";
import {
  join,
  basename,
} from "https://deno.land/std@0.159.0/path/mod.ts?s=joinGlobs";

const NAMESPACE_URL = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

/**
 * Maintain a planet based on and itunes podcast RSS link
 */

const url = Deno.args[0];
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

function timeIntervalSinceReferenceDate(v) {
  const ReferenceDate = new Date("2001-01-01").getTime();
  return (new Date(v).getTime() - ReferenceDate) / 1000.0;
}

function getEnv() {
  const env = new nunjucks.Environment(
    new nunjucks.FileSystemLoader(join("plain", "templates")),
    {
      autoescape: false,
    }
  );
  env.addFilter("escapejs", function (str) {
    return str;
  });
  env.addFilter("formatDate", function (str) {
    return moment(parseFloat(str)).format("MMM D,YYYY [at] h:mm:ss A");
  });
  env.addFilter("ymd", function (str) {
    return moment(parseFloat(str)).format("YYYY-MM-DD");
  });
  return env;
}

async function fetchTo(url, local) {
  // const fileResponse = await fetch(url);
  // if (fileResponse.body) {
  //   const file = await Deno.open(local, { write: true, create: true });
  //   const writableStream = writableStreamFromWriter(file);
  //   await fileResponse.body.pipeTo(writableStream);
  // }
}

const result = JSON.parse(await ipfscmd("key", "list", "--encoding=json"));
let ipns;
if (!result.Keys.filter((a) => a.Name === uuid)[0]) {
  ipns = await ipfscmd("key", "gen", uuid);
} else {
  ipns = result.Keys.filter((a) => a.Name === uuid)[0].Id;
}

// console.log(JSON.stringify(feed));

await ensureDir(uuid);
const planet = {
  about: feed.description,
  created: timeIntervalSinceReferenceDate(feed.created),
  id: uuid,
  ipns,
  name: feed.title.value,
  templateName: "Plain",
  updated: timeIntervalSinceReferenceDate(feed.updateDate),
  articles: await Promise.all(
    feed.entries.map(async (e) => {
      const id = (
        await generate(NAMESPACE_URL, new TextEncoder().encode(e.id))
      ).toUpperCase();
      await ensureDir(join(uuid, id));
      const local = join(uuid, id, basename(e.attachments[0].url));
      if (!existsSync(local)) {
        await fetchTo(e.attachments[0].url, local);
      }
      return {
        id,
        title: e.title.value,
        content: e.content.value,
        attachments: [],
        hasVideo: false,
        hasAudio: true,
        audioFilename: basename(e.attachments[0].url),
        created: timeIntervalSinceReferenceDate(e.published),
        link: `/${id}/`,
      };
    })
  ),
};
await Deno.writeTextFile(join(uuid, "planet.json"), JSON.stringify(planet));
await copySync(join("plain", "assets"), join(uuid, "assets"), {
  overwrite: true,
});

const pageAboutHTML = Marked.parse(planet.about);
const html = getEnv(planet).render("index.html", {
  assets_prefix: "./",
  page_title: planet.name,
  has_avatar: true,
  page_description: pageAboutHTML.content,
  page_description_html: pageAboutHTML.content,
  build_timestamp: new Date().getTime(),
});
await Deno.writeTextFile(join(uuid, "index.html"), html);
await fetchTo(feed.image.url, join(uuid, "avatar.png"));
const img = await resize(Deno.readFileSync(join(uuid, "avatar.png")), {
  width: 256,
  height: 256,
});

Deno.writeFileSync(join(uuid, "avatar.png"), img);

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
  await Deno.writeTextFile(join(uuid, article.id, "index.html"), html);
}

const cid = await ipfscmd("add", "-r", uuid, "--cid-version=1", "--quieter");
await ipfscmd("name", "publish", `--key=${planet.id}`, `/ipfs/${cid}`);
console.log(`done to ${planet.ipns}`);
